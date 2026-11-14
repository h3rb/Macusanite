/**
 * Worldbuilding view: the open vein as notes on a canvas.
 *
 * Each heading of the document becomes a card holding that section's prose. The
 * cards are edited in place — typing in one rewrites the vein's markdown through
 * `app.setDraft`, so the file stays a plain markdown file and the usual autosave
 * and undo apply. Cards are joined by the associations already written in the
 * text (`[[#Heading]]`, `[[Another note]]`), with the heading outline drawn as a
 * dotted spine, which is what makes it a map of the vein rather than a list.
 */
import { el, clear, appendAll, askText } from './dom.js';
import { renderMarkdown, renderMermaidIn } from './markdown.js';
import {
  parseNotes, serializeNotes, updateNote, updateIntro, addNote, removeNote,
  noteEdges, noteStats, countWords, DEFAULT_LEVEL,
  normalizeTag, addNoteTags, removeNoteTag, tagRecord, tagTarget,
  RELATION_KINDS, DEFAULT_RELATION, relationOf, relationKind, relationKey, groupEndpoint,
  bondEdges,
  NODE_TYPES, nodeType, nodeTypeOf, nodeFields, nodeFieldOf, fieldRangeHint, unitSuggestions,
  dropMembershipKind,
  clampView, zoomViewAt, fitView, centreView, snapDelta, canvasHealth, layoutSelection, arrangeCandidateOrigins, findArrangeOrigin, anchorOfView, viewOfAnchor,
  normalizeRouting, prepareConnectorGeometry, cleanAnnotations, makeAnnotationId,
  placeConnectorLabels,
  NODE_IMAGES_DIR, isInlineImage, nodeImageRef, nodeImageMetaName,
  nodeImageMetaNames, referencedNodeImageMetaNames, orphanedNodeImageMetaNames,
  NODE_IMAGE_MAX_SIDE, NODE_IMAGE_QUALITY, nodeImageSize,
  nodeFileRef, nodeFileMetaName, cleanNodeResources, normalizeWebUrl,
  referencedNodeFileMetaNames, orphanedNodeFileMetaNames, NODE_FILE_MAX_BYTES, NODE_RESOURCE_LIMIT,
  canvasSnapshot as snapshotCanvas, renameHistoryAnchor, pruneHistoryStack,
  connectedAnchors, lineageAnchors, anchorsInRect, relationshipDepths, canvasSearch,
  connectorList, connectorKey, pathAnchors, effectiveRouting, spreadConnectorCurves, cleanCardModes, cleanCardSizes, cleanCollapsedGroups, proseLinkBetween, unlinkProseBetween,
  progressionColumns,
  DEFAULT_STEP_NAME, cleanHistoryStack, historyJump, historyKey,
  restoreSnapshot, pushHistoryStep,
} from '../lib/worldbuild.js';
import { buildCanvasSvg, buildCanvasMermaid, canvasExportName } from '../lib/worldbuildExport.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

// Card geometry lives here *and* in styles.css (`.wb-card`). Keep them equal.
const CARD_W = 300;
const CARD_H = 260;
const ANNOTATION_W = 220;
const ANNOTATION_H = 120;
const GAP_X = 96;
const GAP_Y = 76;
const PAD = 26;
const INTRO_H = 150;
// A stacked pair leaves a short wire between them — tight enough that the
// folded card and the card under it read as one stack, not two neighbours.
const STACK_GAP = 8;
// How unaligned a folded-above-a-link pair may be and still read as a stack.
const STACK_TOLERANCE = 2;

/** A file size as the card shows it: bytes, KB or MB, one decimal at most. */
function formatBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function svgNode(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined) continue;
    node.setAttribute(key, String(value));
  }
  return node;
}

export function createWorldbuildPanel({ app, root }) {
  const toolbar = el('div', { class: 'wb-toolbar' });
  // The canvas's own undo pair: steps taken on the graph, not the vein's edits.
  const undoBtn = el('button', {
    class: 'btn btn-ghost btn-mini', type: 'button', text: '↶', onclick: () => undoCanvas(),
  });
  const redoBtn = el('button', {
    class: 'btn btn-ghost btn-mini', type: 'button', text: '↷', onclick: () => redoCanvas(),
  });
  // The history browser: name every step, and jump to any of them.
  const historyBtn = el('button', {
    class: 'btn btn-ghost btn-mini', type: 'button', text: 'History',
    'data-history-toggle': '',
    title: 'Browse this vein’s canvas history — undo or redo several steps at once',
    'aria-haspopup': 'dialog',
    'aria-expanded': 'false',
    onclick: (event) => toggleHistory(event.currentTarget),
  });
  // Canvas health: orphans and thin groups, with a jump to each.
  const healthBtn = el('button', {
    class: 'btn btn-ghost btn-mini', type: 'button', text: 'Health',
    'data-health-toggle': '',
    title: 'Canvas health — cards with nothing connected to them, groups too thin to mean anything',
    'aria-haspopup': 'dialog',
    'aria-expanded': 'false',
    onclick: (event) => toggleHealth(event.currentTarget),
  });
  const stage = el('div', { class: 'wb-stage' });
  const canvas = el('div', { class: 'wb-canvas' });
  const edgeSvg = svgNode('svg', { class: 'wb-edges', 'aria-hidden': 'true' });
  const cards = el('div', { class: 'wb-cards' });
  const annotationsLayer = el('div', { class: 'wb-annotations', 'aria-hidden': 'false' });
  // Smart guides, drawn over the cards while a drag aligns with them.
  const guideV = el('div', { class: 'wb-guide wb-guide-v' });
  const guideH = el('div', { class: 'wb-guide wb-guide-h' });
  const guides = el('div', { class: 'wb-guides', 'aria-hidden': 'true' }, [guideV, guideH]);
  // The marquee box, in stage coordinates: Shift+drag on the background.
  const marqueeBox = el('div', { class: 'wb-marquee hidden', 'aria-hidden': 'true' });
  const statsBar = el('div', { class: 'wb-stats' });

  canvas.append(edgeSvg, cards, annotationsLayer, guides);
  stage.append(canvas, marqueeBox);
  // Canvas search: titles, types, fields, colours and group names in this
  // vein, with jump-to, highlight, select-all-matches and isolate.
  const searchInput = el('input', {
    class: 'wb-search-input', type: 'search', spellcheck: 'false', autocomplete: 'off',
    placeholder: 'Search titles, types, fields, colours, groups…',
    'aria-label': 'Search this canvas',
    oninput: () => runCanvasSearch(),
    onkeydown: (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        jumpToSearchMatch(searchCurrent + 1);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        clearCanvasSearch();
        searchBar.classList.add('hidden');
      }
    },
  });
  const searchCount = el('span', { class: 'wb-search-count', text: '' });
  const searchResults = el('div', { class: 'wb-search-results hidden', role: 'listbox', 'aria-label': 'Canvas search results' });
  const searchBar = el('div', { class: 'wb-search hidden' }, [
    searchInput,
    el('button', { class: 'btn btn-ghost btn-mini', type: 'button', text: '‹', title: 'Previous match', onclick: () => jumpToSearchMatch(searchCurrent - 1) }),
    el('button', { class: 'btn btn-ghost btn-mini', type: 'button', text: '›', title: 'Next match', onclick: () => jumpToSearchMatch(searchCurrent + 1) }),
    searchCount,
    el('button', { class: 'btn btn-ghost btn-mini', type: 'button', text: 'Select all', title: 'Select every match', onclick: selectAllSearchMatches }),
    el('button', { class: 'btn btn-ghost btn-mini', type: 'button', text: 'Isolate', title: 'Dim everything outside the connected subgraph of the matches', onclick: isolateSearchMatches }),
    el('button', { class: 'btn btn-ghost btn-mini', type: 'button', text: 'Clear', onclick: () => clearCanvasSearch() }),
    searchResults,
  ]);
  // Connector selection bar: batch routing/arrowheads, path tracing, and
  // clearing — shown while connectors are selected.
  const connectorLabel = el('span', { class: 'wb-connector-count', text: '' });
  const connectorBar = el('div', { class: 'wb-connector-bar hidden' }, [
    connectorLabel,
    el('button', { class: 'btn btn-ghost btn-mini', type: 'button', text: 'Elbow', title: 'Make the selected connectors right-angle elbows (or curves when all are elbows)', onclick: () => batchRouting('elbow') }),
    el('button', { class: 'btn btn-ghost btn-mini', type: 'button', text: 'Arrows', title: 'Toggle arrowheads on the selected connectors', onclick: () => batchRouting('arrows') }),
    el('button', { class: 'btn btn-ghost btn-mini', type: 'button', text: 'Trim', title: 'Cut off long selected wires at a diamond, or draw them full length again', onclick: () => batchRouting('cut') }),
    el('button', { class: 'btn btn-ghost btn-mini', type: 'button', text: 'Trace upstream', title: 'Select every card that feeds into the selected connectors, following the arrows backwards', onclick: () => traceSelectedConnectors('upstream') }),
    el('button', { class: 'btn btn-ghost btn-mini', type: 'button', text: 'Trace downstream', title: 'Select every card the selected connectors lead to, following the arrows forwards', onclick: () => traceSelectedConnectors('downstream') }),
    el('button', { class: 'btn btn-ghost btn-mini', type: 'button', text: 'Clear', onclick: () => clearConnectorSelection() }),
  ]);
  root.append(toolbar, searchBar, connectorBar, stage, statsBar);

  let model = null;
  let currentPath = null;
  // The text this canvas last put on screen. A save re-renders the vein, and
  // re-parsing our own edit would only throw the caret away.
  let lastText = null;
  let mounted = false;
  // Where the reader dragged each card, by note anchor. Absent means "the grid".
  // Anchor-keyed (rather than index-keyed) so inserting a note does not knock
  // every card below it off its place; renaming one forfeits its position,
  // the same bargain the section colours make.
  let positions = new Map();
  // The relationships asserted for this vein, keyed by anchor pair, the note
  // types keyed by anchor, the structured fields keyed by anchor, the groups
  // (id → {members, color}), and whether the vein is marked as a
  // worldbuilding graph — all from the saved record.
  let relations = {};
  // Which cards are folded to their header, by anchor. A record may also
  // still carry the retired `links` part beside it; nothing reads it.
  let folded = {};
  // Display mode per card (`compact`/`thumbnail`; full is absence) and each
  // group's collapse to a summary card, by id.
  let cardModes = {};
  // Card heights: `fixed` (the vault default, an override when stored) or
  // `content`, which grows a full card to its prose instead of scrolling it.
  let cardSizes = {};
  // The vault's default card height last built with, so a change in Settings
  // rebuilds the canvas even though the vein's text did not change.
  let lastVaultCardSize = null;
  let collapsedGroups = {};
  // Canvas edit history, per vein within the open vault, so switching veins
  // keeps each one's steps while identical paths in different vaults stay
  // apart. It covers only what the canvas owns — positions, groups,
  // relationships and folds — and never joins the vein's own undo of its
  // markdown.
  const historyByPath = new Map();
  const HISTORY_LIMIT = 60;
  // Taken when a drag starts, pushed on release: a whole drag is one step.
  let dragSnapshot = null;
  let nodeTypes = {};
  let fieldValues = {};
  // A node's explicit colour, overriding its type's: set from the context
  // menu like a group's, and forgettable back to the type's colour.
  let nodeColors = {};
  // A node's embedded image, by vault-relative file reference (older
  // records may still hold a data URL inline) — drawn as a medium-sized
  // icon in its head. File contents are cached per path as they load.
  let nodeImages = {};
  const nodeImageCache = new Map();
  // Every image file this session has seen referenced: a replaced or removed
  // image's file is swept once no node — and no undo/redo snapshot — names
  // it any more, so undo still finds the file it restores.
  const seenNodeImageRefs = new Set();
  // Files attached to a node and the web URLs beside them, by anchor. The
  // files are references into `.macusanite/node-files/`; both are cleaned on
  // the way in, so a record cannot point at a foreign path or a non-web URL.
  let nodeResources = {};
  // Every attachment file this session has seen referenced: removing or
  // deleting a node sweeps the file once no record or snapshot names it.
  const seenAttachmentRefs = new Set();
  // Notes pinned in place: Arrange must work around them, though a pinned
  // note can still be dragged by hand. Groups pin through their own flag.
  let pinned = {};
  // Nodes whose content is locked read-only: the markdown, type, fields,
  // colour and image cannot change, but the card can still be moved (when
  // not pinned) and linked. Group locks block movement as well.
  let nodeLocked = {};
  let groups = {};
  // Free-floating margin notes, keyed by annotation id and stored with the
  // vein — independent of the heading cards they sit beside.
  let annotations = {};
  // The fold state to restore when the Overview button is clicked again.
  // Transient and scoped to the current vein; normal canvas history remains
  // the durable record of each Overview toggle.
  let overviewFolded = null;
  let overviewButton = null;
  // Connector display: bezier wires by default, optionally right-angle
  // elbows, and optionally arrowheads showing each wire's direction.
  let routing = normalizeRouting(null);
  let marked = false;
  // The relationship the next link from each card asserts, by note index.
  let linkKinds = new Map();
  let cardEls = [];
  // Watchers on content-sized cards: their height follows their prose (and
  // any image or diagram inside it), so connectors and the canvas keep up.
  let contentObservers = [];
  let layout = { cols: 1, top: PAD };
  let dragging = null;
  // The group a dragged card would join if released where it is — lit while
  // the card is over its box, null the rest of the time.
  let dropTargetId = null;
  let edgeFrame = 0;
  // Nodes picked with Ctrl+click or a Shift+drag marquee, by anchor.
  // Transient UI state: they can be grouped, moved together, fitted,
  // aligned, and distributed.
  let selected = new Set();
  // An in-progress marquee: screen start, the selection to start from, and
  // whether it has grown past a click.
  let marquee = null;
  let selectMenuEl = null;
  let arrangeMenuEl = null;
  // Canvas search state: matches, the current jump target, and — while
  // isolated — the connected subgraph kept bright.
  let searchMatches = [];
  let searchCurrent = -1;
  let isolatedAnchors = null;
  // Connectors picked on the canvas, by connector key. Transient, like
  // card selection: they batch routing/arrowheads and seed path tracing.
  let selectedEdges = new Set();
  let arrangeButton = null;
  let menuEl = null;
  let submenuEl = null;
  // The viewport's view of the canvas: a translate in px and a zoom scale.
  // Transient — saved card positions live in canvas coordinates, so zooming
  // never touches them. A new vein (or tidying the grid) starts at 1:1.
  let view = { x: 0, y: 0, s: 1 };
  let panning = null;

  /* ------------------------------------------------------------ content -- */

  /** The vein's text as the reader currently holds it (an unsaved draft wins). */
  function sourceText(doc) {
    const draft = app.state.draft;
    return typeof draft === 'string' && draft ? draft : (doc.text ?? '');
  }

  function render(doc) {
    if (!doc) {
      // Leaving the mode must not leave a floating menu behind over it.
      closeMenu();
      closeSelectMenu();
      closeArrangeMenu();
      mounted = false;
      model = null;
      currentPath = null;
      lastText = null;
      for (const observer of contentObservers) observer.disconnect();
      contentObservers = [];
      clear(toolbar);
      clear(statsBar);
      clear(cards);
      clear(annotationsLayer);
      return;
    }

    const text = sourceText(doc);
    const vaultSize = vaultCardSize();
    if (mounted && currentPath === doc.path && text === lastText && vaultSize === lastVaultCardSize) return;
    lastVaultCardSize = vaultSize;

    if (currentPath !== doc.path) {
      overviewFolded = null;
      selected = new Set();
      searchMatches = [];
      searchCurrent = -1;
      isolatedAnchors = null;
      searchInput.value = '';
    }
    if (currentPath === doc.path && lastText !== null && text !== lastText) overviewFolded = null;
    currentPath = doc.path;
    lastText = text;
    model = parseNotes(text);
    const record = app.worldRecord?.(doc.path) ?? null;
    marked = Boolean(record?.marked);
    positions = new Map(Object.entries(record?.positions ?? {}));
    relations = record?.relations ?? {};
    folded = record?.folded ?? {};
    cardModes = cleanCardModes(record?.cardModes);
    cardSizes = cleanCardSizes(record?.cardSizes);
    collapsedGroups = cleanCollapsedGroups(record?.collapsedGroups);
        nodeTypes = record?.types ?? {};
    fieldValues = record?.fields ?? {};
    nodeColors = record?.colors ?? {};
    nodeImages = record?.images ?? {};
    for (const ref of Object.values(nodeImages)) seenNodeImageRefs.add(ref);
    nodeResources = cleanNodeResources(record?.resources);
    for (const entry of Object.values(nodeResources)) {
      for (const file of entry.files ?? []) seenAttachmentRefs.add(file.ref);
    }
    pinned = record?.pinned ?? {};
    nodeLocked = record?.locked ?? {};
    groups = record?.groups ?? {};
    annotations = cleanAnnotations(record?.annotations);
    routing = normalizeRouting(record?.routing);
    // The saved view: the canvas point in the viewport's top-left corner at
    // the zoom it was left at, so the graph reopens exactly as it was left.
    view = viewOfAnchor(record?.view) ?? { x: 0, y: 0, s: 1 };
    linkKinds = new Map();
    mounted = true;
    build();
  }

  function build() {
    renderToolbar();
    for (const observer of contentObservers) observer.disconnect();
    contentObservers = [];
    clear(cards);
    cardEls = [];

    const notes = model.notes ?? [];
    const cols = Math.max(1, Math.min(3, Math.ceil(Math.sqrt(Math.max(1, notes.length)))));
    layout = { cols, top: model.intro ? PAD + INTRO_H + GAP_Y : PAD };

    if (model.intro) cards.append(buildIntro());

    notes.forEach((note, index) => {
      const card = buildCard(note, index);
      cardEls[index] = card;
      cards.append(card);
    });

    if (!notes.length) cards.append(emptyState());
    clear(annotationsLayer);
    Object.values(annotations).forEach((annotation) => annotationsLayer.append(buildAnnotation(annotation)));
    sizeCanvas();
    drawEdges();
    renderStats();
  }

  function commit() {
    if (!model) return;
    const text = serializeNotes(model);
    lastText = text;
    app.setDraft(text);
    drawEdges();
    renderStats();
  }

  /* ------------------------------------------------------------ toolbar -- */

  function renderToolbar() {
    clear(toolbar).append(
      el('div', { class: 'wb-title' }, [
        el('span', { class: 'wb-dot' }),
        el('strong', { text: 'Worldbuilding' }),
      ]),
      el('span', { class: 'wb-hint', text: 'Each card is a heading of this vein — typing here edits the markdown. Shift+drag on the background to box-select, Ctrl+click to pick, Select for quick picks' }),
      el('div', { class: 'spacer' }),
      undoBtn,
      redoBtn,
      historyBtn,
      healthBtn,
      el('button', {
        class: `btn ${marked ? 'btn-primary' : 'btn-ghost'} btn-mini`,
        type: 'button',
        text: marked ? '★ Marked' : '☆ Mark',
        title: marked
          ? 'This vein opens as a worldbuilding graph — click to unmark it (the layout and relationships are kept)'
          : 'Mark this vein as Worldbuilding: it will open as a graph, with these card positions',
        onclick: toggleMark,
      }),
      el('button', {
        class: 'btn btn-ghost btn-mini', type: 'button', text: '+ Note',
        title: 'Add a note to this vein', onclick: addNewNote,
      }),
      el('button', {
        class: 'btn btn-ghost btn-mini', type: 'button', text: '+ Annotation',
        title: 'Add a free-floating margin note — not tied to a heading',
        onclick: () => addAnnotation(),
      }),
      el('button', {
        class: 'btn btn-ghost btn-mini', type: 'button', text: 'Arrange ▾',
        'data-arrange-toggle': '',
        'aria-haspopup': 'menu',
        'aria-expanded': 'false',
        title: 'Arrange the selection, a group, a connected component, or one type — grid, rows, columns, cascade, layered, or progression columns. Pinned and locked cards stay put.',
        onclick: (event) => toggleArrangeMenu(event.currentTarget),
      }),
      (overviewButton = el('button', {
        class: 'btn btn-ghost btn-mini', type: 'button', text: 'Overview',
        title: overviewFolded
          ? 'Restore the folding state from before Overview'
          : 'Fold every card and link section, then zoom to fit — click again to restore the previous folding state',
        onclick: overview,
      })),
      el('button', {
        class: 'btn btn-ghost btn-mini', type: 'button', text: 'Cards ▾',
        'data-cards-toggle': '',
        'aria-haspopup': 'menu',
        'aria-expanded': 'false',
        title: 'Card display modes and heights for the selection — full, compact, thumbnail, fixed or content height',
        onclick: (event) => toggleCardsMenu(event.currentTarget),
      }),
      el('button', {
        class: 'btn btn-ghost btn-mini', type: 'button', text: '⤢ Fit',
        title: 'Zoom to fit every card on screen — no more hunting for edges off-screen',
        onclick: zoomToFit,
      }),
      el('button', {
        class: `btn ${routing.elbow ? 'btn-primary' : 'btn-ghost'} btn-mini`, type: 'button', text: 'Elbow',
        'aria-pressed': routing.elbow ? 'true' : 'false',
        title: 'Route connectors as right-angle elbows instead of curves — applies to the selected connectors when any are selected',
        onclick: () => toggleRouting('elbow'),
      }),
      el('button', {
        class: `btn ${routing.arrows ? 'btn-primary' : 'btn-ghost'} btn-mini`, type: 'button', text: 'Arrows',
        'aria-pressed': routing.arrows ? 'true' : 'false',
        title: 'Show arrowheads on connectors — applies to the selected connectors when any are selected',
        onclick: () => toggleRouting('arrows'),
      }),
      el('button', {
        class: `btn ${routing.cut ? 'btn-primary' : 'btn-ghost'} btn-mini`, type: 'button', text: 'Trim',
        'aria-pressed': routing.cut ? 'true' : 'false',
        title: 'Cut off wires longer than a screen at a diamond — click it to reveal the far card if it is inside a collapsed group, then centre the view there',
        onclick: () => toggleRouting('cut'),
      }),
      el('button', {
        class: 'btn btn-ghost btn-mini', type: 'button', text: 'Search',
        title: 'Search this canvas — titles, types, fields, colours and group names',
        onclick: () => toggleSearchBar(),
      }),
      el('button', {
        class: 'btn btn-ghost btn-mini', type: 'button', text: 'Select ▾',
        'data-select-toggle': '',
        'aria-haspopup': 'menu',
        'aria-expanded': 'false',
        title: 'Quick selections — connected, ancestors, descendants, same type or colour, group members, pinned, locked, untyped, imageless',
        onclick: (event) => toggleSelectMenu(event.currentTarget),
      }),
      el('button', {
        class: 'btn btn-ghost btn-mini', type: 'button', text: 'Fit selection',
        'data-fit-selection': '',
        title: 'Zoom to fit the selection',
        disabled: selected.size ? false : true,
        onclick: zoomToFitSelection,
      }),
      el('button', {
        class: 'btn btn-ghost btn-mini', type: 'button', text: 'Legend ▾',
        'data-legend-toggle': '',
        title: 'What the lines, colours and icons mean',
        'aria-haspopup': 'dialog',
        'aria-expanded': 'false',
        onclick: (event) => toggleLegend(event.currentTarget),
      }),
      el('button', {
        class: 'btn btn-ghost btn-mini', type: 'button', text: 'Export ▾',
        'data-export-toggle': '',
        'aria-haspopup': 'menu',
        'aria-expanded': 'false',
        title: 'Export this canvas as a standalone SVG, a PNG image, or Mermaid markdown',
        onclick: (event) => toggleExportMenu(event.currentTarget),
      }),
      el('button', {
        class: 'btn btn-ghost btn-mini', type: 'button', text: '?',
        'data-help-toggle': '',
        title: 'Canvas gestures — selecting, grouping, renaming, cycling bonds and Fold',
        'aria-haspopup': 'dialog',
        'aria-expanded': 'false',
        onclick: (event) => toggleHelp(event.currentTarget),
      }),
      el('button', {
        class: 'btn btn-ghost btn-mini', type: 'button', text: 'Markdown',
        title: 'Edit this vein as markdown source', onclick: () => app.setMode('edit'),
      }),
      el('button', {
        class: 'btn btn-primary btn-mini', type: 'button', text: 'Save',
        onclick: () => app.saveCurrent(),
      }),
    );
    syncHistoryButtons();
  }

  /** Mark or unmark this vein; the head chip follows via a re-render. */
  function toggleMark() {
    if (!currentPath) return;
    marked = !marked;
    app.markWorld(currentPath, marked);
    renderToolbar();
    app.setMode(app.state.ui.mode);
    app.toast(marked ? 'Marked as Worldbuilding — it opens as a graph' : 'Unmarked', 'ok', 1800);
  }

  /** Toggle a connector display preference, keeping it with this vein. */
  function toggleRouting(kind) {
    if (!currentPath) return;
    if (selectedEdges.size) {
      batchRouting(kind);
      return;
    }
    routing = normalizeRouting({ ...routing, [kind]: !routing[kind] });
    app.saveWorldRouting?.(currentPath, routing);
    renderToolbar();
    drawEdges();
  }

  /**
   * Batch routing/arrowheads over the selected connectors: when every one
   * already has it on, they all go off; otherwise they all go on. Each
   * connector keeps its own override beside the vein default, so clearing
   * a selection never loses what was set.
   */
  function batchRouting(kind) {
    if (!currentPath || !selectedEdges.size) return;
    const keys = [...selectedEdges];
    const allOn = keys.every((key) => effectiveRouting(routing, key)[kind]);
    const next = !allOn;
    const edges = { ...(routing.edges ?? {}) };
    for (const key of keys) {
      edges[key] = { ...(edges[key] ?? {}), [kind]: next };
    }
    routing = normalizeRouting({ ...routing, edges });
    app.saveWorldRouting?.(currentPath, routing);
    drawEdges();
    const what = kind === 'elbow'
      ? (next ? 'elbows' : 'curves')
      : kind === 'cut'
        ? (next ? 'cut off at a diamond' : 'drawn full length')
        : (next ? 'arrows on' : 'arrows off');
    app.toast(`${keys.length} connector${keys.length === 1 ? '' : 's'}: ${what}`, 'ok', 1500);
  }

  /** Pick (or, with Ctrl, toggle) one connector. */
  function toggleConnectorSelection(key, additive) {
    if (additive) {
      const next = new Set(selectedEdges);
      next.has(key) ? next.delete(key) : next.add(key);
      selectedEdges = next;
    } else {
      selectedEdges = new Set([key]);
    }
    syncConnectorUi();
    drawEdges();
  }

  /** Put the connector bar on screen while connectors are selected. */
  function syncConnectorUi() {
    connectorBar.classList.toggle('hidden', !selectedEdges.size);
    connectorLabel.textContent = selectedEdges.size
      ? `${selectedEdges.size} connector${selectedEdges.size === 1 ? '' : 's'} selected`
      : '';
  }

  function clearConnectorSelection() {
    selectedEdges = new Set();
    isolatedAnchors = null;
    syncConnectorUi();
    syncSearchUi();
    drawEdges();
  }

  /**
   * Trace a path from the selected connectors: select every card upstream
   * or downstream of their ends, and dim everything else so the path
   * stands out. Group ends trace from their members.
   */
  function traceSelectedConnectors(direction) {
    if (!model || !selectedEdges.size) return;
    const seeds = new Set();
    for (const edge of connectorList(model, groups, relations)) {
      if (!selectedEdges.has(connectorKey(edge))) continue;
      for (const endpoint of [edge.from, edge.to]) {
        if (endpoint.startsWith('group:')) {
          const group = groups[endpoint.slice('group:'.length)];
          if (group) for (const anchor of effectiveMembers(group)) seeds.add(anchor);
        } else {
          seeds.add(endpoint);
        }
      }
    }
    const traced = pathAnchors(model, relations, seeds, direction);
    if (!traced.size) {
      app.toast(`No ${direction === 'upstream' ? 'upstream' : 'downstream'} cards from the selected connectors`, 'warn', 2000);
      return;
    }
    setSelection(traced);
    isolatedAnchors = new Set([...seeds, ...traced]);
    syncSearchUi();
    app.toast(`${traced.size} ${direction} card${traced.size === 1 ? '' : 's'} traced`, 'ok', 1800);
  }

  /** Select every connector touching one endpoint — a card or a group. */
  function selectRelationsFor(endpoint) {
    if (!model || !endpoint) return;
    const hits = connectorList(model, groups, relations)
      .filter((edge) => edge.from === endpoint || edge.to === endpoint)
      .map(connectorKey);
    if (!hits.length) {
      app.toast('No connectors touch this card', 'warn', 1800);
      return;
    }
    selectedEdges = new Set(hits);
    syncConnectorUi();
    drawEdges();
    app.toast(`${hits.length} connector${hits.length === 1 ? '' : 's'} selected`, 'ok', 1500);
  }

  /** Persist the card positions, so the graph reappears as it was left. */
  function savePositions() {
    if (!currentPath) return;
    app.saveWorldLayout(currentPath, Object.fromEntries(positions));
  }

  function saveAnnotations() {
    if (!currentPath) return;
    annotations = app.saveWorldAnnotations?.(currentPath, annotations) ?? cleanAnnotations(annotations);
  }

  /** A free-floating margin note, placed at the centre of the viewport. */
  function addAnnotation(at = null, text = '') {
    if (!currentPath) return;
    const id = makeAnnotationId(annotations);
    const x = at?.x ?? (stage.clientWidth / 2 - view.x) / view.s - ANNOTATION_W / 2;
    const y = at?.y ?? (stage.clientHeight / 2 - view.y) / view.s - ANNOTATION_H / 2;
    step(() => {
      annotations = { ...annotations, [id]: { id, x: Math.round(x), y: Math.round(y), text: text || 'Check this later…' } };
      saveAnnotations();
      build();
    }, 'Add annotation');
    const input = annotationsLayer.querySelector(`[data-annotation-id="${id}"] textarea`);
    input?.focus();
    input?.select();
    return id;
  }

  function setAnnotationColor(id, color) {
    step(() => {
      const annotation = annotations[id];
      if (!annotation) return;
      const next = { ...annotations, [id]: { ...annotation } };
      if (color) next[id].color = color;
      else delete next[id].color;
      annotations = next;
      saveAnnotations();
      const note = annotationsLayer.querySelector(`[data-annotation-id="${id}"]`);
      if (note) {
        note.style.setProperty('--wb-annotation-color', color || '#fff3a6');
        note.style.setProperty('--wb-annotation-border', color
          ? `color-mix(in srgb, ${color} 70%, #000)`
          : '#d8c94c');
      }
    }, 'Change annotation colour');
    closeMenu();
  }

  function buildAnnotation(annotation) {
    const note = el('div', {
      class: 'wb-annotation',
      dataset: { annotationId: annotation.id },
      style: `left:${annotation.x}px; top:${annotation.y}px; width:${ANNOTATION_W}px; --wb-annotation-color:${annotation.color || '#fff3a6'}; --wb-annotation-border:${annotation.color ? `color-mix(in srgb, ${annotation.color} 70%, #000)` : '#d8c94c'};`,
    });
    const head = el('div', { class: 'wb-annotation-head', title: 'Drag to move this annotation' }, [
      el('span', { class: 'wb-annotation-grip', text: '⠿' }),
      el('span', { class: 'wb-annotation-title', text: 'Annotation' }),
      el('button', {
        class: 'wb-annotation-remove', type: 'button', text: '✕', title: 'Delete this annotation',
        'aria-label': 'Delete this annotation',
        onclick: () => step(() => {
          const next = { ...annotations };
          delete next[annotation.id];
          annotations = next;
          saveAnnotations();
          build();
        }, 'Delete annotation'),
      }),
    ]);
    const body = el('textarea', {
      class: 'wb-annotation-text', rows: 3, maxlength: 1000,
      placeholder: 'Margin scribble…',
      'aria-label': 'Annotation text',
    });
    body.value = annotation.text;
    body.addEventListener('focus', () => beginStep('Edit annotation'));
    body.addEventListener('input', () => {
      annotations = { ...annotations, [annotation.id]: { ...annotations[annotation.id], text: body.value } };
    });
    body.addEventListener('change', () => {
      commitStep('Edit annotation');
      saveAnnotations();
      if (!annotations[annotation.id]) build();
    });
    head.addEventListener('pointerdown', (event) => {
      if (event.target.closest('button')) return;
      beginStep('Move annotation');
      const startX = event.clientX;
      const startY = event.clientY;
      const startAnnotation = annotations[annotation.id];
      const move = (moveEvent) => {
        annotations = {
          ...annotations,
          [annotation.id]: {
            ...annotations[annotation.id],
            x: Math.round(startAnnotation.x + (moveEvent.clientX - startX) / view.s),
            y: Math.round(startAnnotation.y + (moveEvent.clientY - startY) / view.s),
          },
        };
        note.style.left = `${annotations[annotation.id].x}px`;
        note.style.top = `${annotations[annotation.id].y}px`;
      };
      const end = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', end);
        commitStep('Move annotation');
        saveAnnotations();
        sizeCanvas();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', end);
      event.preventDefault();
    });
    appendAll(note, [head, body]);
    return note;
  }

  /**
   * The card's fold toggle: it shows the card's open/closed glyph and writes
   * the state through, so the vein reopens as it was left.
   */
  function foldToggle(anchor) {
    const button = el('button', { class: 'wb-fold-toggle', type: 'button' });
    const paint = () => {
      const closed = isFolded(anchor);
      button.textContent = closed ? '▸' : '▾';
      button.title = `${closed ? 'Expand' : 'Fold'} section for ${endpointTitle(anchor)}`;
      button.setAttribute('aria-label', button.title);
      button.setAttribute('aria-expanded', closed ? 'false' : 'true');
    };
    paint();
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      overviewFolded = null;
      if (overviewButton) overviewButton.title = 'Fold every card and link section, then zoom to fit — click again to restore the previous folding state';
      const closed = isFolded(anchor);
      step(() => {
        folded = app.setWorldFold(currentPath, anchor, !closed) ?? folded;
        paint();
        // A fold changes a card's height, and with it every edge that meets it.
        applyFolds();
        // Only this folded card can cause a stack to move.
        restackFoldedCards([anchor]);
      }, `${closed ? 'Expand' : 'Fold'} “${noteTitle(anchor)}”`);
    });
    return button;
  }

  /** Whether a card is folded to its header. */
  function isFolded(anchor) {
    const entry = folded[anchor];
    // `true` is the older shape, from when a card's own fold was the only one;
    // a record may also still carry the retired `links` part, which is ignored.
    return entry === true || Boolean(entry?.card);
  }

  /** Put every card's current fold classes on screen, then redraw to fit. */
  function applyFolds() {
    (model?.notes ?? []).forEach((note, index) => {
      const card = cardEls[index];
      if (!card) return;
      card.classList.toggle('is-folded', isFolded(note.anchor));
    });
    sizeCanvas();
    drawEdges();
  }

  /**
   * A folded card above a node it has a direct link with stacks with it:
   * every linked partner already below it — roughly in its column, in the
   * same group — is pulled directly under it, in order. Their wire then
   * runs bottom-to-top and the pair (or chain) takes up less room than two
   * free cards. Returns whether anything moved; nothing is saved here, so
   * the caller decides when the whole pass persists.
   */
  function restackAround(anchor) {
    const notes = model?.notes ?? [];
    const index = notes.findIndex((note) => note.anchor === anchor);
    if (index < 0) return false;
    const foldedBox = rectOf(index);
    const foldedCx = foldedBox.x + foldedBox.width / 2;
    const foldedMiddle = foldedBox.y + foldedBox.height / 2;
    const sameGroup = (otherAnchor) => (groupOf(anchor)?.id ?? null) === (groupOf(otherAnchor)?.id ?? null);
    const partnerIdx = new Set();
    for (const edge of [...noteEdges(model, relations), ...bondEdges(model, relations)]) {
      if (edge.fromIndex === index && edge.toIndex !== index) partnerIdx.add(edge.toIndex);
      if (edge.toIndex === index && edge.fromIndex !== index) partnerIdx.add(edge.fromIndex);
    }
    const below = [...partnerIdx]
      .map((other) => ({ other, box: rectOf(other) }))
      .filter(({ other, box }) => {
        // “Appears above”: the partner’s middle sits below the folded
        // card’s, and its centre is within the folded card’s own span.
        const cx = box.x + box.width / 2;
        return box.y + box.height / 2 > foldedMiddle && Math.abs(cx - foldedCx) <= CARD_W / 2 && sameGroup(notes[other]?.anchor);
      })
      .sort((a, b) => a.box.y - b.box.y || a.other - b.other);
    if (!below.length) return false;
    let cursor = foldedBox.y + foldedBox.height + STACK_GAP;
    let moved = false;
    for (const { other, box } of below) {
      const target = { x: foldedBox.x, y: cursor };
      const current = positionOf(other);
      if (current.x !== target.x || current.y !== target.y) {
        positions.set(notes[other].anchor, target);
        moved = true;
      }
      cursor += box.height + STACK_GAP;
    }
    return moved;
  }

  /** Stack only folded cards involved in this change. */
  function restackFoldedCards(anchors) {
    let moved = false;
    for (const anchor of anchors) {
      if (isFolded(anchor) && restackAround(anchor)) moved = true;
    }
    if (moved) {
      savePositions();
      build();
    }
  }

  /* -------------------------------------------------------------- history -- */

  // The canvas state an undo step puts back: every slice the canvas owns is
  // in it, so an undo of any change — a drag, an arrange, a type — brings the
  // whole record back as it was. The snapshots are pruned at each rename and
  // at each restore (see the lib helpers they call).
  function canvasSnapshot() {
    return snapshotCanvas({
      positions: Object.fromEntries(positions),
      groups,
      relations,
      folded,
      types: nodeTypes,
      fields: fieldValues,
      colors: nodeColors,
      images: nodeImages,
      resources: nodeResources,
      pinned,
      locked: nodeLocked,
      cardModes,
      cardSizes,
      collapsedGroups,
      annotations,
      view: { ...view },
    });
  }

  /** Rewrite a card rename through every undo and redo snapshot. */
  function renameHistorySnapshots(before, after) {
    renameHistoryAnchor(historyFor(currentPath), before, after);
    saveHistory(currentPath);
  }

  /** Keep deleted cards and dissolved groups out of all stored snapshots. */
  function pruneHistorySnapshots(liveAnchors) {
    pruneHistoryStack(historyFor(currentPath), liveAnchors);
    saveHistory(currentPath);
  }

  /**
   * This vein's steps; kept per vault-and-path, so switching veins keeps
   * each one's, and seeded from the vein's saved record, so the stacks
   * survive a reload and reopening the vein.
   */
  function historyFor(path) {
    if (!path) return { past: [], future: [] };
    const key = historyKey(app.state?.vault?.path, path);
    let stack = historyByPath.get(key);
    if (!stack) {
      stack = cleanHistoryStack(app.worldRecord?.(path)?.history, HISTORY_LIMIT);
      historyByPath.set(key, stack);
    }
    return stack;
  }

  /** Write one vein's canvas stacks into its saved record, so they survive. */
  function saveHistory(path) {
    if (!path) return;
    const stack = historyFor(path);
    app.saveWorldHistory?.(path, { past: stack.past, future: stack.future });
  }

  /**
   * Record one canvas change, unless it left the canvas exactly as it was.
   * A step wears the name of the change that made it, for the undo button and
   * the history browser.
   */
  function pushStep(before, name = DEFAULT_STEP_NAME) {
    const pushed = pushHistoryStep(historyFor(currentPath), canvasSnapshot(), before, name, HISTORY_LIMIT);
    if (!pushed) return false;
    saveHistory(currentPath);
    syncHistoryButtons();
    // A pushed step may have dropped a snapshot (the limit, or the redo
    // branch a new step clears): if that was the last reference to an image
    // or attachment file, the file goes now. Best-effort — a failed sweep
    // never breaks the step that landed.
    void cleanupOrphanedNodeImages().catch(() => {});
    void cleanupOrphanedAttachments().catch(() => {});
    return true;
  }

  /**
   * Delete the files of images this session replaced or removed, once no
   * node and no undo/redo snapshot — here or in any other vein — still
   * references them. A failed delete leaves the file (never the record)
   * and is reported once, not raised into the canvas change.
   */
  async function cleanupOrphanedNodeImages(candidates) {
    const referenced = referencedNodeImageMetaNames({
      images: nodeImages,
      history: historyFor(currentPath),
      worlds: {},
    });
    for (const metaName of app.referencedNodeImageMetaNames?.() ?? []) referenced.add(metaName);
    const orphans = orphanedNodeImageMetaNames(candidates ?? seenNodeImageRefs, referenced);
    let failed = 0;
    for (const metaName of orphans) {
      try {
        await app.deleteNodeImageFile?.(metaName);
        nodeImageCache.delete(nodeImageRef(metaName.slice('node-images/'.length)));
      } catch {
        failed += 1;
      }
    }
    if (failed) app.toast(`Could not delete ${failed} orphaned node image${failed === 1 ? '' : 's'}`, 'warn', 2200);
  }

  /**
   * Delete attachment files this session removed, once no node and no
   * undo/redo snapshot — here or in any other vein — still names them, so an
   * undo that brings an attachment back still finds its file.
   */
  async function cleanupOrphanedAttachments(candidates) {
    const referenced = referencedNodeFileMetaNames({
      resources: nodeResources,
      history: historyFor(currentPath),
      worlds: {},
    });
    for (const metaName of app.referencedNodeFileMetaNames?.() ?? []) referenced.add(metaName);
    const orphans = orphanedNodeFileMetaNames(candidates ?? seenAttachmentRefs, referenced);
    let failed = 0;
    for (const metaName of orphans) {
      try {
        await app.deleteNodeAttachmentFile?.(metaName);
      } catch {
        failed += 1;
      }
    }
    if (failed) app.toast(`Could not delete ${failed} orphaned attachment${failed === 1 ? '' : 's'}`, 'warn', 2200);
  }

  /** Run one canvas change as a single named undoable step. */
  function step(change, name = DEFAULT_STEP_NAME) {
    const before = canvasSnapshot();
    const result = change();
    pushStep(before, name);
    return result;
  }

  /**
   * Open the step a drag (or a text-field session) closes: the record as it
   * stood before the first move. The name it lands with may be decided later,
   * by what the drop did — the name given here is the fallback.
   */
  function beginStep(name = DEFAULT_STEP_NAME) {
    dragSnapshot = { snap: canvasSnapshot(), name };
  }

  function commitStep(name) {
    const begun = dragSnapshot;
    dragSnapshot = null;
    if (!begun) return;
    pushStep(begun.snap, name ?? begun.name);
  }

  /** Put a snapshot back on screen and in the record, and never write it back
   * with an anchor the vein has no card for: the stored snapshots are pruned
   * at each rename in this panel, and this checks the cards actually on
   * screen as well, for edits made outside it (deletions in edit mode, a
   * revert). */
  function restoreCanvas(snap) {
    overviewFolded = null;
    if (overviewButton) overviewButton.title = 'Fold every card and link section, then zoom to fit — click again to restore the previous folding state';
    // Types, fields and colours come with the rest — an undo of a type or
    // colour change puts the old one back. Snapshots written before they
    // existed leave them be, and the camera comes back with the rest too:
    // a step that moved it (Arrange resets it) returns with the view the
    // user was looking through.
    const saved = restoreSnapshot(snap, new Set((model?.notes ?? []).map((note) => note.anchor)), {
      types: nodeTypes,
      fields: fieldValues,
      colors: nodeColors,
      images: nodeImages,
      resources: nodeResources,
      pinned,
      locked: nodeLocked,
      cardModes,
      cardSizes,
      collapsedGroups,
      annotations,
      view,
    });
    if (!saved) return;
    positions = new Map(Object.entries(saved.positions));
    groups = saved.groups;
    relations = saved.relations;
    folded = saved.folded;
    cardModes = saved.cardModes ?? {};
    cardSizes = saved.cardSizes ?? {};
    collapsedGroups = saved.collapsedGroups ?? {};
    nodeTypes = saved.types;
    fieldValues = saved.fields;
    nodeColors = saved.colors;
    nodeImages = saved.images;
    nodeResources = saved.resources ?? {};
    annotations = saved.annotations ?? {};
    pinned = saved.pinned ?? {};
    nodeLocked = saved.locked ?? {};
    view = saved.view ?? view;
    // Anchors come and go with the steps; a selection would outlive them.
    selected = new Set();
    app.restoreWorldCanvas(currentPath, {
      positions: saved.positions,
      groups,
      relations,
      folded,
      types: nodeTypes,
      fields: fieldValues,
      colors: nodeColors,
      images: nodeImages,
      resources: nodeResources,
      pinned,
      locked: nodeLocked,
      cardModes,
      cardSizes,
      collapsedGroups,
      annotations,
      view: anchorOfView(view),
    });
    build();
  }

  // Single steps are one-step jumps: the lib walks them the same way the
  // history browser does, so the two can never drift apart.
  function undoCanvas() {
    const stack = historyFor(currentPath);
    const jumped = historyJump(stack, 'undo', 1, canvasSnapshot());
    if (!jumped) return;
    stack.past = jumped.past;
    stack.future = jumped.future;
    restoreCanvas(jumped.restore);
    saveHistory(currentPath);
    syncHistoryButtons();
  }

  function redoCanvas() {
    const stack = historyFor(currentPath);
    const jumped = historyJump(stack, 'redo', 1, canvasSnapshot());
    if (!jumped) return;
    stack.past = jumped.past;
    stack.future = jumped.future;
    restoreCanvas(jumped.restore);
    saveHistory(currentPath);
    syncHistoryButtons();
  }

  /** Undo and redo offer only what is there, and name what it would do. */
  function syncHistoryButtons() {
    const stack = historyFor(currentPath);
    undoBtn.disabled = !stack.past.length;
    redoBtn.disabled = !stack.future.length;
    undoBtn.title = stack.past.length
      ? `Undo: ${stack.past[stack.past.length - 1].name} (Ctrl+Z) — ${stack.past.length} steps back`
      : 'Nothing to undo on this canvas';
    redoBtn.title = stack.future.length
      ? `Redo: ${stack.future[stack.future.length - 1].name} (Ctrl+Shift+Z) — ${stack.future.length} steps forward`
      : 'Nothing to redo on this canvas';
  }

  /** Jump to a history entry in one restore, rewiring both stacks. */
  function jumpHistory(kind, index) {
    const stack = historyFor(currentPath);
    const jumped = historyJump(stack, kind, index + 1, canvasSnapshot());
    if (!jumped) return;
    stack.past = jumped.past;
    stack.future = jumped.future;
    restoreCanvas(jumped.restore);
    saveHistory(currentPath);
    syncHistoryButtons();
    closeMenu();
  }

  // While the canvas is the visible view it owns Ctrl+Z outright — even with
  // an empty stack, which does nothing. The app's own undo reverts file
  // writes, and a stray Ctrl+Z on a graph must never rewrite the vein. Text
  // boxes are the exception: those edits are markdown, so they keep their
  // native undo and the vein's own history.
  document.addEventListener('keydown', (event) => {
    if (!model) return;
    if (!(event.ctrlKey || event.metaKey)) return;
    const key = event.key.toLowerCase();
    if (key !== 'z' && key !== 'y') return;
    if (event.target instanceof HTMLElement
      && event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
    event.preventDefault();
    event.stopPropagation();
    if ((key === 'z' && event.shiftKey) || key === 'y') redoCanvas();
    else undoCanvas();
  }, true);

  function renderStats() {
    const stats = noteStats(model ?? {}, nodeTypes);
    // The vault-wide tag record: every tag the vault index knows about, read
    // from the same live index as search and the graph, most-used first.
    const record = tagRecord(app.state?.index ?? []);
    const limit = 24;
    const health = canvasHealth(model ?? {}, { relations, groups });
    appendAll(clear(statsBar), [
      el('span', { class: 'wb-stat', text: `${stats.notes} notes` }),
      el('span', { class: 'wb-stat', text: `${stats.associations} associations` }),
      el('span', { class: 'wb-stat', text: `${stats.links} links` }),
      health.orphans.length ? el('span', {
        class: 'wb-stat wb-stat-warn',
        text: `${health.orphans.length} orphan${health.orphans.length === 1 ? '' : 's'}`,
        title: 'Cards with nothing connected to them — see Health in the toolbar',
      }) : null,
      stats.tags ? el('span', { class: 'wb-stat', text: `${stats.tags} tags` }) : null,
      ...Object.entries(stats.types).map(([type, count]) => el('span', {
        class: 'wb-stat',
        text: `${count} ${type}${count === 1 ? '' : 's'}`,
      })),
      el('span', { class: 'wb-stat', text: `${stats.words} words` }),
      record.length ? (
        el('span', { class: 'wb-vault-tags' }, [
          el('span', { class: 'wb-stat-label', text: 'vault tags' }),
          ...record.slice(0, limit).map((row) => el('span', {
            class: 'wb-vault-tag',
            text: `#${row.tag} ×${row.count}`,
            title: `${row.count} vein${row.count === 1 ? '' : 's'}: ${row.veins.join(', ')}`,
          })),
          record.length > limit ? el('span', { class: 'wb-stat', text: `+${record.length - limit} more` }) : null,
        ])
      ) : null,
      el('span', { class: 'wb-legend-key', text: 'solid: links in the prose · dotted: section outline' }),
    ]);
  }

  /* -------------------------------------------------------------- cards -- */

  function positionOf(index) {
    const anchor = model.notes[index]?.anchor;
    const known = anchor ? positions.get(anchor) : null;
    if (known) return known;
    const col = index % layout.cols;
    const row = Math.floor(index / layout.cols);
    return {
      x: PAD + col * (CARD_W + GAP_X),
      y: layout.top + row * (CARD_H + GAP_Y),
    };
  }

  /** A card's box on the canvas. A folded card is shorter; edges meet its middle. */
  function rectOf(index) {
    const { x, y } = positionOf(index);
    return { x, y, width: cardEls[index]?.offsetWidth || CARD_W, height: cardEls[index]?.offsetHeight || CARD_H };
  }

  function cardModeOf(anchor) {
    return cardModes[anchor] ?? 'full';
  }

  /** The vault's default card height, from Settings → Worldbuilding. */
  function vaultCardSize() {
    return app.state?.settings?.worldbuild?.cardSize === 'content' ? 'content' : 'fixed';
  }

  /** A node's height: its own override, else the vault's default. */
  function cardSizeOf(anchor) {
    return cardSizes[anchor] ?? vaultCardSize();
  }

  /** Only a full card has prose to grow to; compact and thumbnails stay boxes. */
  function isContentSized(anchor) {
    return cardModeOf(anchor) === 'full' && cardSizeOf(anchor) === 'content';
  }

  /** A card hidden inside a collapsed group's summary. */
  function isGroupHidden(anchor) {
    const group = groupOf(anchor);
    return Boolean(group && (collapsedGroups[group.id] || hasCollapsedAncestor(group.id)));
  }

  /** True when a collapsed ancestor already covers this group's display. */
  function hasCollapsedAncestor(groupId) {
    const parents = parentOf();
    const seen = new Set([groupId]);
    let current = parents.get(groupId);
    while (current && !seen.has(current)) {
      if (collapsedGroups[current]) return true;
      seen.add(current);
      current = parents.get(current);
    }
    return false;
  }

  /** Collapsed groups whose summary card is the visible group surface. */
  function summaryGroups() {
    return Object.values(groups ?? {}).filter(
      (group) => collapsedGroups[group.id] && !hasCollapsedAncestor(group.id),
    );
  }

  /** The rect a group actually occupies on screen: summary or member box. */
  function groupDisplayRect(group) {
    if (!group || hasCollapsedAncestor(group.id)) return null;
    return collapsedGroups[group.id] ? summaryRect(group) : groupBox(group);
  }

  /**
   * Set one card's (or every selected card's) display mode — full, compact,
   * or thumbnail — as one undoable step.
   */
  function setCardMode(anchor, mode) {
    const targets = selected.size ? [...selected] : [anchor];
    if (!targets.length || !model) return;
    const already = targets.every((target) => cardModeOf(target) === mode);
    step(() => {
      cardModes = app.setWorldCardMode(currentPath, anchor, mode) ?? cardModes;
      // setWorldCardMode writes one anchor; write the rest of the selection
      // through it too, so the record matches the step.
      for (const target of targets) {
        if (target !== anchor) cardModes = app.setWorldCardMode(currentPath, target, mode) ?? cardModes;
      }
      applyCardModes();
      drawEdges();
    }, `${mode === 'full' ? 'Expand' : `Set ${mode} mode on`} ${targets.length === 1 ? `“${noteTitle(targets[0])}”` : `${targets.length} cards`}`);
    // Nothing changed on screen (and so no undo step was recorded): say the
    // mode was already in effect instead of letting the menu close silently.
    if (already) {
      app.toast(
        targets.length === 1
          ? `“${noteTitle(targets[0])}” is already ${mode === 'full' ? 'a full card' : mode}`
          : `All ${targets.length} cards are already ${mode === 'full' ? 'full cards' : mode}`,
        'info',
        1800,
      );
    }
  }

  /**
   * Fit one card's height to its prose — or back to the standard box — for
   * the selection, as one undoable step. Content height needs full cards, so
   * compact and thumbnail cards keep their designed boxes.
   */
  function setCardSize(anchor, size) {
    const targets = selected.size ? [...selected] : [anchor];
    if (!targets.length || !model) return;
    const only = targets.length === 1;
    const already = targets.every((target) => cardSizeOf(target) === size);
    step(() => {
      cardSizes = app.setWorldCardSize(currentPath, anchor, size) ?? cardSizes;
      // setWorldCardSize writes one anchor; write the rest of the selection
      // through it too, so the record matches the step.
      for (const target of targets) {
        if (target !== anchor) cardSizes = app.setWorldCardSize(currentPath, target, size) ?? cardSizes;
      }
      build();
    }, `${size === 'content' ? 'Fit to content' : 'Fixed height on'} ${only ? `“${noteTitle(targets[0])}”` : `${targets.length} cards`}`);
    // Content height is the only one that needs a full card; fixed height is
    // what compact and thumbnail cards already are.
    if (size === 'content' && targets.some((target) => cardModeOf(target) !== 'full')) {
      app.toast('Content height applies to full cards', 'warn', 2000);
      return;
    }
    if (already) {
      app.toast(
        only
          ? `“${noteTitle(targets[0])}” is already ${size === 'content' ? 'fit to its content' : 'a fixed-height card'}`
          : `All ${targets.length} cards are already ${size === 'content' ? 'fit to their content' : 'fixed-height'}`,
        'info',
        1800,
      );
    }
  }

  /** Sync mode classes and hidden members without rebuilding the cards. */
  function applyCardModes() {
    (model?.notes ?? []).forEach((note, index) => {
      const card = cardEls[index];
      if (!card) return;
      card.classList.toggle('is-mode-compact', cardModeOf(note.anchor) === 'compact');
      card.classList.toggle('is-mode-thumbnail', cardModeOf(note.anchor) === 'thumbnail');
      card.classList.toggle('is-group-hidden', isGroupHidden(note.anchor));
    });
  }

  /** Collapse or expand one group to its summary card, as one step. */
  function setGroupCollapsed(groupId, collapsed) {
    if (!currentPath || !groups[groupId]) return;
    step(() => {
      collapsedGroups = app.setWorldGroupCollapsed(currentPath, groupId, collapsed) ?? collapsedGroups;
      build();
    }, `${collapsed ? 'Collapse' : 'Expand'} group “${groups[groupId].name || 'Group'}”`);
  }

  // The structured row for a typed node — a stat's value, a skill's level, an
  // attribute's key/value — or null for notes, whose prose is their content.
  // The prose textarea below stays for every type: links and tags live in it.
  function buildFieldsRow(note, typeId) {
    const schema = nodeFields(typeId);
    if (!schema.length) return null;
    const type = nodeType(typeId);
    const row = el('div', { class: 'wb-fields' });
    const inputs = new Map();
    // The unit autocomplete: predetermined units, the vault's learned units,
    // and every unit currently stored anywhere in this vault. Refreshed on
    // focus and after each commit, so a hand-typed unit joins the list at once.
    let unitList = null;
    const refreshUnitList = () => {
      if (!unitList) return;
      const records = [fieldValues, ...Object.values(app.state?.world ?? {}).map((record) => record?.fields).filter(Boolean)];
      clear(unitList);
      const learned = app.state?.settings?.worldbuild?.units ?? [];
      for (const unit of unitSuggestions(records, learned)) unitList.append(el('option', { value: unit }));
    };
    for (const field of schema) {
      // A numeric field's declared range reaches the input, so its spinners,
      // steppers and validation all work from the same numbers the model
      // clamps to.
      const range = field.kind === 'number'
        ? { min: field.min, max: field.max, step: field.step }
        : {};
      const hint = fieldRangeHint(field);
      const isUnit = field.kind === 'unit';
      const stored = nodeFieldOf(fieldValues, note.anchor, field.id);
      let lastUnit = stored;
      // Seed the vault vocabulary from units that were already on cards, so
      // clearing one or deleting the card later cannot lose it.
      if (isUnit) app.rememberWorldUnit?.(stored);
      if (isUnit && !unitList) {
        unitList = el('datalist', { id: `wb-units-${note.anchor}` });
        refreshUnitList();
        row.append(unitList);
      }
      const input = el('input', {
        class: `wb-field-input${isUnit ? ' wb-unit-input' : ''}`,
        type: isUnit ? 'text' : field.kind,
        value: stored,
        placeholder: field.label,
        spellcheck: 'false',
        list: isUnit ? `wb-units-${note.anchor}` : undefined,
        title: isUnit ? 'Pick a unit, or type your own — it joins the list' : (hint ? `Allowed range: ${hint}` : undefined),
        'aria-label': `${type.label} ${field.label.toLowerCase()}${hint ? ` (${hint})` : ''} for ${note.title || 'this note'}`,
        disabled: isContentLocked(note.anchor) ? true : undefined,
        ...range,
      });
      // Numbers commit on change, not per keystroke: clamping mid-typing
      // would fight the user ("12" against a max of 10). The stored —
      // clamped — value is read back into the box afterwards. Values ride
      // in canvas history too, so a change is one undoable step — for text,
      // bracketed by focus/blur so typing is one step, not one per key.
      inputs.set(field.id, input);
      const commit = () => {
        if (isUnit) {
          if (input.value.trim()) lastUnit = input.value;
          // Clearing removes the only stored copy; keep the last value typed.
          else app.rememberWorldUnit?.(lastUnit);
        }
        fieldValues = app.setWorldNodeField(currentPath, note.anchor, type.id, field.id, input.value) ?? fieldValues;
        // Read back every box in the row: committing one end of a min/max
        // pair can move the other end with it.
        for (const [fieldId, box] of inputs) box.value = nodeFieldOf(fieldValues, note.anchor, fieldId);
        refreshUnitList();
      };
      const fieldName = `Set ${field.label.toLowerCase()} on “${note.title}”`;
      let fieldBefore = null;
      const finishFieldEdit = () => {
        // Blur is the point a hand-typed unit is complete. Remembering it here
        // keeps partial keystrokes out of the suggestions and still records
        // the unit before a later clear or card deletion.
        if (isUnit) app.rememberWorldUnit?.(input.value || lastUnit);
        if (fieldBefore === null) return;
        const before = fieldBefore;
        fieldBefore = null;
        pushStep(before, fieldName);
      };
      input.addEventListener('focus', () => {
        if (isUnit) {
          if (input.value.trim()) lastUnit = input.value;
          app.rememberWorldUnit?.(lastUnit);
        }
        refreshUnitList();
        fieldBefore = canvasSnapshot();
      });
      input.addEventListener('blur', finishFieldEdit);
      if (field.kind === 'number') {
        input.addEventListener('change', () => {
          const before = fieldBefore ?? canvasSnapshot();
          fieldBefore = null;
          commit();
          pushStep(before, fieldName);
        });
      } else {
        input.addEventListener('input', commit);
      }
      row.append(el('label', { class: 'wb-field' }, [
        el('span', { text: `${field.label}:` }),
        input,
        // The allowed range, visible beside the box — never a secret.
        hint ? el('span', { class: 'wb-field-range', text: hint }) : null,
      ]));
    }
    return row;
  }

  function buildCard(note, index) {
    const pos = positionOf(index);
    const accent = app.colorFor('section', { path: currentPath, anchor: note.anchor });
    const type = nodeTypeOf(nodeTypes, note.anchor);
    const lockedGroup = lockedGroupOf(note.anchor);
    const locked = Boolean(lockedGroup);
    const noteLocked = isNodeLocked(note.anchor);
    const contentLocked = locked || noteLocked;
    const notePinned = isAnchorPinned(note.anchor);
    const lockTitle = locked
      ? `“${note.title || 'This note'}” is in locked group “${lockedGroup.name || 'Group'}” — links can still be added`
      : noteLocked
        ? `“${note.title || 'This note'}” is locked read-only — unlock it to change its content`
        : undefined;
    const mode = cardModeOf(note.anchor);
    const card = el('article', {
      class: `wb-card wb-level-${note.level}${mode === 'compact' ? ' is-mode-compact' : ''}${mode === 'thumbnail' ? ' is-mode-thumbnail' : ''}${isContentSized(note.anchor) ? ' is-content-sized' : ''}${isGroupHidden(note.anchor) ? ' is-group-hidden' : ''}${selected.has(note.anchor) ? ' is-selected' : ''}${locked ? ' is-locked' : ''}${notePinned ? ' is-pinned' : ''}${isFolded(note.anchor) ? ' is-folded' : ''}${searchMatches.some((m) => m.anchor === note.anchor) ? ' is-search-hit' : ''}${searchMatches[searchCurrent]?.anchor === note.anchor ? ' is-search-current' : ''}${isolatedAnchors && !isolatedAnchors.has(note.anchor) ? ' is-dimmed' : ''}`,
      style: `left:${pos.x}px; top:${pos.y}px; border-left-color:${accent};`,
      'data-note': String(index),
      title: mode === 'thumbnail' ? note.title : undefined,
    });

    // The chip is the type's icon in its colour — the node's explicit
    // colour, when it has one, in its type's — and the heading level
    // survives only as a tooltip now that the icon stands in for it.
    const typeChip = el('span', { class: 'wb-level' });
    const paintTypeChip = (typeId) => {
      const record0 = NODE_TYPES.find((t) => t.id === typeId) ?? NODE_TYPES[0];
      typeChip.textContent = record0.icon ?? '';
      typeChip.style.color = nodeColors[note.anchor] ?? record0.color ?? '';
      typeChip.title = `${record0.label} · heading level ${note.level}`;
    };
    paintTypeChip(type.id);
    const typeSelect = el('select', {
      class: 'wb-type',
      style: (nodeColors[note.anchor] ?? type.color) ? `color:${nodeColors[note.anchor] ?? type.color}` : undefined,
      'aria-label': `Type of ${note.title || 'this note'}`,
      title: contentLocked ? lockTitle : 'What this node is (a note holds markdown, diagrams included)',
      disabled: contentLocked ? true : undefined,
    });
    for (const candidate of NODE_TYPES) {
      typeSelect.append(el('option', { value: candidate.id, text: candidate.label }));
    }
    typeSelect.value = type.id;
    typeSelect.addEventListener('change', () => {
      const label = NODE_TYPES.find((t) => t.id === typeSelect.value)?.label ?? typeSelect.value;
      // A type change is a canvas change like any other: one undo puts the
      // old type (and its field values) back.
      step(() => {
        nodeTypes = app.setWorldNodeType(currentPath, note.anchor, typeSelect.value) ?? nodeTypes;
        const chosen = NODE_TYPES.find((t) => t.id === typeSelect.value);
        typeSelect.style.color = nodeColors[note.anchor] ?? chosen?.color ?? '';
        paintTypeChip(typeSelect.value);
        const prior = card.querySelector('.wb-fields');
        const fresh = buildFieldsRow(note, typeSelect.value);
        if (fresh) prior ? prior.replaceWith(fresh) : card.insertBefore(fresh, head.nextSibling);
        else prior?.remove();
        renderStats();
      }, `Set type on “${note.title || 'note'}” to ${label}`);
      app.toast(`“${note.title || 'note'}” is a ${label.toLowerCase()}`, 'ok', 1500);
    });
    // The node's embedded image, when it has one: a medium-sized icon in
    // the head, before the type chip — the face of the node. File-backed
    // references load once and cache; legacy inline data URLs draw as-is.
    const imageRef = nodeImages[note.anchor];
    let nodeImage = null;
    if (imageRef) {
      nodeImage = el('img', {
        class: 'wb-node-image',
        alt: `Image for ${note.title || 'this note'}`,
        draggable: 'false',
      });
      if (isInlineImage(imageRef)) {
        nodeImage.src = imageRef;
      } else if (nodeImageCache.has(imageRef)) {
        nodeImage.src = nodeImageCache.get(imageRef);
      } else {
        const metaName = nodeImageMetaName(imageRef);
        if (metaName) {
          app.readNodeImageFile?.(metaName).then((dataUrl) => {
            if (typeof dataUrl === 'string' && dataUrl) {
              nodeImageCache.set(imageRef, dataUrl);
              if (nodeImage.isConnected) nodeImage.src = dataUrl;
            }
          }).catch(() => {});
        }
      }
    }
    const title = el('input', {
      class: 'wb-card-title',
      value: note.title,
      spellcheck: 'false',
      'aria-label': `Note title: ${note.title}`,
      disabled: contentLocked ? true : undefined,
    });
    const fold = foldToggle(note.anchor);
    const remove = el('button', {
      class: 'wb-card-del', type: 'button', title: locked ? lockTitle : 'Delete this note', text: '✕',
      disabled: locked ? true : undefined,
    });
    const head = el('div', { class: 'wb-card-head' }, [
      fold,
      el('span', { class: 'wb-grip', text: '⠿', title: locked ? lockTitle : 'Drag to move this note' }),
      notePinned ? el('span', { class: 'wb-pin', text: '📌', title: 'Pinned — Arrange works around this card' }) : null,
      noteLocked ? el('span', { class: 'wb-pin', text: '🔒', title: lockTitle ?? 'Content locked read-only — unlock from the right-click menu' }) : null,
      nodeImage,
      typeChip,
      typeSelect,
      title,
      remove,
    ]);
    const fieldsRow = buildFieldsRow(note, type.id);

    const body = el('textarea', {
      class: 'wb-card-body hidden',
      spellcheck: 'false',
      'aria-label': `Prose for ${note.title}`,
      disabled: contentLocked ? true : undefined,
    });
    body.value = note.body;

    // The prose rendered the way the reader shows it, until it is clicked.
    // Clicking (when not locked) swaps in the source textarea; leaving the
    // textarea swaps back, so the card reads as markdown at rest.
    const rendered = el('div', {
      class: 'wb-card-rendered markdown-body',
      'aria-label': `Rendered prose for ${note.title}`,
      tabindex: contentLocked ? undefined : '0',
      title: contentLocked ? lockTitle : 'Click to edit',
    });
    const paintRendered = () => {
      const live = model.notes[index];
      const text = live ? live.body : note.body;
      const out = renderMarkdown(text, {
        currentPath,
        resolveLink: (link) => app.resolveLink(link, currentPath),
        colorFor: (kind, parts) => app.colorFor(kind, parts),
      });
      clear(rendered).innerHTML = out.html;
      renderMermaidIn(rendered, out.mermaid, app.mermaid);
    };
    paintRendered();
    // A content-sized card has no fixed box: while its textarea is on screen
    // it carries the prose, so it grows to its scroll height and the card
    // follows. At rest the rendered prose sets the height instead.
    const growBody = () => {
      if (!isContentSized(note.anchor) || body.classList.contains('hidden')) return;
      body.style.height = 'auto';
      body.style.height = `${body.scrollHeight}px`;
      sizeCanvas();
      scheduleEdges();
    };
    const editBody = () => {
      if (contentLocked) {
        contentLockedToast(note.anchor);
        return;
      }
      rendered.classList.add('hidden');
      body.classList.remove('hidden');
      body.focus();
      growBody();
    };
    const doneEditing = () => {
      body.style.height = '';
      paintRendered();
      body.classList.add('hidden');
      rendered.classList.remove('hidden');
    };
    rendered.addEventListener('click', (event) => {
      // A wiki link still navigates; the rest of the rendered prose edits.
      if (event.target.closest('a')) return;
      editBody();
    });
    rendered.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        editBody();
      }
    });
    body.addEventListener('blur', () => {
      if (!body.classList.contains('hidden')) doneEditing();
    });
    body.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') body.blur();
    });

    const tagsRow = el('div', { class: 'wb-tags' });
    const words = el('span', { class: 'wb-words' });
    // Links live in the node's right-click menu now — the card itself keeps no
    // "Link to" chrome, just its tags and word count.
    const foot = el('div', { class: 'wb-card-foot' }, [tagsRow, words]);
    const refreshWords = () => {
      const live = model.notes[index];
      if (live) words.textContent = `${countWords(live.title) + countWords(live.body)} words`;
    };

    // Thumbnail mode's face: the node's image full-bleed, or its initial
    // when it has none — compact mode instead keeps a one-line meta row.
    let thumb = null;
    if (mode === 'thumbnail') {
      thumb = el('div', { class: 'wb-thumb' });
      if (imageRef) {
        const cover = el('img', { class: 'wb-thumb-img', alt: '', draggable: 'false' });
        if (isInlineImage(imageRef)) {
          cover.src = imageRef;
        } else if (nodeImageCache.has(imageRef)) {
          cover.src = nodeImageCache.get(imageRef);
        } else {
          const metaName = nodeImageMetaName(imageRef);
          if (metaName) {
            app.readNodeImageFile?.(metaName).then((dataUrl) => {
              if (typeof dataUrl === 'string' && dataUrl) {
                nodeImageCache.set(imageRef, dataUrl);
                if (cover.isConnected) cover.src = dataUrl;
              }
            }).catch(() => {});
          }
        }
        thumb.append(cover);
      } else {
        thumb.append(el('span', { class: 'wb-thumb-initial', text: (note.title ?? '?').trim().charAt(0).toUpperCase() || '?', style: `color:${accent}` }));
      }
      thumb.append(el('span', { class: 'wb-thumb-title', text: note.title }));
    }
    const metaLine = mode === 'compact'
      ? el('div', { class: 'wb-meta-line' }, [
          el('span', { class: 'wb-meta-type', text: type.label, style: `color:${nodeColors[note.anchor] ?? type.color ?? ''}` }),
          el('span', { text: `· ${note.links?.length ?? 0} link${(note.links?.length ?? 0) === 1 ? '' : 's'}` }),
          el('span', { text: `· ${note.body?.trim() ? `${note.body.trim().split(/\s+/).length} words` : 'no prose'}` }),
        ])
      : null;

    // appendAll, not append: a note's fields row is null, and `append(null)`
    // inserts the literal text "null" (dom.js says so itself).
    // Attachments and URLs sit under the prose, above the tags, as part of
    // the card's content: they open on click and are removed in place.
    const resourceStrip = (() => {
      const entry = nodeResources[note.anchor];
      const files = entry?.files ?? [];
      const urls = entry?.urls ?? [];
      if (!files.length && !urls.length) return null;
      const wrap = el('div', { class: 'wb-resources' });
      for (const file of files) {
        wrap.append(el('div', { class: 'wb-resource' }, [
          el('button', {
            class: 'wb-resource-link',
            type: 'button',
            title: `Open “${file.name}”${file.size ? ` (${formatBytes(file.size)})` : ''}`,
            onclick: () => {
              const metaName = nodeFileMetaName(file.ref);
              if (!metaName) return;
              void app.openNodeAttachmentFile?.(metaName, file.name)?.catch((error) => {
                app.toast(`Could not open “${file.name}”: ${error.message}`, 'warn', 2400);
              });
            },
          }, [
            el('span', { class: 'wb-resource-icon', text: '📎' }),
            el('span', { class: 'wb-resource-name', text: file.name }),
          ]),
          file.size ? el('span', { class: 'wb-resource-meta', text: formatBytes(file.size) }) : null,
          contentLocked ? null : el('button', {
            class: 'wb-resource-x',
            type: 'button',
            text: '✕',
            title: 'Remove this attachment',
            onclick: () => removeNodeResource(note.anchor, 'files', file.ref),
          }),
        ]));
      }
      for (const link of urls) {
        wrap.append(el('div', { class: 'wb-resource' }, [
          el('button', {
            class: 'wb-resource-link',
            type: 'button',
            title: link.url,
            onclick: () => app.openExternal(link.url),
          }, [
            el('span', { class: 'wb-resource-icon', text: '↗' }),
            el('span', { class: 'wb-resource-name', text: link.label }),
          ]),
          contentLocked ? null : el('button', {
            class: 'wb-resource-x',
            type: 'button',
            text: '✕',
            title: 'Remove this URL',
            onclick: () => removeNodeResource(note.anchor, 'urls', link.url),
          }),
        ]));
      }
      return wrap;
    })();

    appendAll(card, [head, fieldsRow, metaLine, rendered, body, resourceStrip, foot, thumb]);

    // A content-sized card's height is whatever its prose makes it — a
    // diagram, an image or a tag can change that after paint. Watch the card
    // itself so the canvas edge and every connector follows.
    if (isContentSized(note.anchor) && typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(() => {
        if (!card.isConnected) return;
        sizeCanvas();
        scheduleEdges();
      });
      observer.observe(card);
      contentObservers.push(observer);
    }

    title.addEventListener('input', () => {
      const before = model.notes[index]?.anchor;
      model = updateNote(model, index, { title: title.value });
      // A rename changes the anchor: follow the card's place to the new name.
      // Bonds named the old anchor are dropped with it, like section colours.
      const after = model.notes[index]?.anchor;
      if (before && after && before !== after) {
        if (positions.has(before)) positions.set(after, positions.get(before));
        positions.delete(before);
        relations = app.dropWorldRelations(currentPath, before) ?? relations;
        const moved = app.renameWorldAnchor(currentPath, before, after);
        if (moved) {
          nodeTypes = moved.types;
          fieldValues = moved.fields;
          folded = moved.folded ?? folded;
          nodeColors = moved.colors ?? nodeColors;
          nodeImages = moved.images ?? nodeImages;
          pinned = moved.pinned ?? pinned;
          nodeLocked = moved.locked ?? nodeLocked;
          cardModes = moved.cardModes ?? cardModes;
          cardSizes = moved.cardSizes ?? cardSizes;
          nodeResources = moved.resources ?? nodeResources;
          groups = moved.groups ?? groups;
        }
        savePositions();
        renameHistorySnapshots(before, after);
      }
      commit();
      refreshWords();
    });

    body.addEventListener('input', () => {
      model = updateNote(model, index, { body: body.value });
      commit();
      refreshWords();
      refreshTags();
      growBody();
    });

    // Deleting a note deletes its prose from the file, so it asks once.
    let armed = 0;
    remove.addEventListener('click', () => {
      if (isContentLocked(note.anchor)) {
        contentLockedToast(note.anchor);
        return;
      }
      if (!armed) {
        remove.classList.add('is-armed');
        remove.textContent = 'Delete?';
        remove.title = 'Click again to delete this note';
        armed = setTimeout(() => {
          armed = 0;
          remove.classList.remove('is-armed');
          remove.textContent = '✕';
          remove.title = 'Delete this note';
        }, 3000);
        return;
      }
      clearTimeout(armed);
      armed = 0;
      const gone = model.notes[index]?.anchor;
      if (gone && nodeImages[gone]) seenNodeImageRefs.add(nodeImages[gone]);
      if (gone) {
        for (const file of nodeResources[gone]?.files ?? []) seenAttachmentRefs.add(file.ref);
      }
      model = removeNote(model, index);
      if (gone) {
        positions.delete(gone);
        relations = app.dropWorldRelations(currentPath, gone) ?? relations;
        fieldValues = app.dropWorldFields(currentPath, gone) ?? fieldValues;
        delete nodeResources[gone];
        delete pinned[gone];
        nodeColors = app.setWorldNodeColor(currentPath, gone, null) ?? nodeColors;
        nodeImages = app.setWorldNodeImage(currentPath, gone, null) ?? nodeImages;
        groups = app.dropWorldGroups(currentPath, gone) ?? groups;
        pruneHistorySnapshots(new Set(model.notes.map((liveNote) => liveNote.anchor)));
        savePositions();
      }
      commit();
      build();
              // Deleting a note is not a canvas step, so it sweeps for itself: the
        // files go once no snapshot here or in another vein names them.
        void cleanupOrphanedNodeImages().catch(() => {});
        void cleanupOrphanedAttachments().catch(() => {});
    });

    head.addEventListener('pointerdown', (event) => {
      if (event.target.closest?.('input, button, select, textarea')) return;
      // Ctrl+click picks the node (again to unpick); it never starts a drag.
      if (event.ctrlKey) {
        const next = new Set(selected);
        next.has(note.anchor) ? next.delete(note.anchor) : next.add(note.anchor);
        setSelection(next);
        event.preventDefault();
        return;
      }
      // A picked card can carry the whole selection with it; a solo card
      // moves on its own, and dropping it inside or outside a group's box
      // decides its membership. The tab is the handle that moves a nest.
      // Locked cards never move: a selection drag carries only its free
      // cards, and dragging a locked card itself is refused.
      const pickingSelection = selected.has(note.anchor) && selected.size > 1;
      const anchors = (pickingSelection ? [...selected] : [note.anchor])
        .filter((anchor) => !isAnchorLocked(anchor));
      if (!anchors.length) {
        lockedToast(note.anchor);
        event.preventDefault();
        return;
      }
      dragMembers(anchors, event, card, { joinable: !pickingSelection, selection: pickingSelection });
    });
    // Double-click the head to centre the card in the viewport.
    head.addEventListener('dblclick', (event) => {
      if (event.target.closest?.('input, button, select, textarea')) return;
      centreOn(index);
    });

    /** The note's tags as chips, with a field for tagging the note. */
    function refreshTags() {
      const live = model.notes[index];
      if (!live) return;
      clear(tagsRow);
      // Tags write into the note's markdown, so they are content like title,
      // body, type, fields, colour and image: a content-locked node (group or
      // node lock) gets no ✕ and no add field. Linking stays allowed.
      const locked = isContentLocked(live.anchor);

      for (const tag of live.tags ?? []) {
        // A tag that names a card is a way there: it can be screens away on
        // the canvas, so clicking it flies the camera to that node. A tag
        // naming the card it sits on has nowhere to go — flying there would
        // only re-centre the card under the reader's nose — so it stays
        // plain text instead of becoming a door.
        const target = tagTarget(tag, model.notes ?? []);
        const here = Boolean(target && target.anchor === live.anchor);
        const label = target && !here
          ? el('button', {
              class: 'wb-tag-link', type: 'button', text: `#${tag}`,
              title: `#${tag} names “${target.title || target.anchor}” — click to fly there`,
              onclick: (event) => {
                event.stopPropagation();
                focusEndpoint(target.anchor);
              },
            })
          : el('span', { text: `#${tag}` });
        tagsRow.append(el('span', {
          class: `wb-tag${target && !here ? ' is-node-link' : ''}`,
          title: here ? `#${tag} names this card` : target ? undefined : `Tag: ${tag}`,
        }, [
          label,
          locked ? null : el('button', {
            class: 'wb-tag-x', type: 'button', text: '✕',
            title: `Remove #${tag} from this note`,
            onclick: () => {
              model = removeNoteTag(model, index, tag, { locked: isContentLocked(live.anchor) });
              // The textarea is the body: it must show what the model holds, or
              // the next keystroke would resurrect the tag just removed.
              body.value = model.notes[index].body;
              commit();
              refreshTags();
              refreshWords();
            },
          }),
        ]));
      }

      const input = el('input', {
        class: 'wb-tag-input',
        placeholder: '#add tag',
        spellcheck: 'false',
        'aria-label': `Add a tag to ${live.title || 'this note'}`,
        disabled: locked ? true : undefined,
      });
      const addFromInput = () => {
        const parts = input.value.split(/\s+/).filter(Boolean);
        if (!parts.length) return;
        const invalid = parts.filter((part) => !normalizeTag(part));
        if (invalid.length) {
          app.toast(`Not a tag: ${invalid.slice(0, 3).join(', ')}`, 'warn', 1800);
        }
        const before = (model.notes[index].tags ?? []).length;
        model = addNoteTags(model, index, parts, { locked: isContentLocked(live.anchor) });
        const added = (model.notes[index].tags ?? []).length - before;
        if (added > 0) {
          body.value = model.notes[index].body;
          commit();
          refreshTags();
          refreshWords();
          tagsRow.querySelector('.wb-tag-input')?.focus();
        } else if (!invalid.length) {
          app.toast('That note already has those tags', 'info', 1800);
        }
        input.value = '';
      };
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') addFromInput();
      });
      // Clicking a tag's ✕ inside the same row should not commit half a tag.
      input.addEventListener('blur', (event) => {
        if (!event.relatedTarget?.closest?.('.wb-tags')) addFromInput();
      });
      tagsRow.append(input);
    }

    refreshWords();
    refreshTags();
    return card;
  }

  function buildIntro() {
    const card = el('article', {
      class: 'wb-card wb-intro',
      style: `left:${PAD}px; top:${PAD}px; width:${CARD_W + 160}px; height:${INTRO_H}px;`,
    });
    const area = el('textarea', {
      class: 'wb-card-body',
      spellcheck: 'false',
      'aria-label': 'Prose before the first heading',
    });
    area.value = model.intro;
    area.addEventListener('input', () => {
      model = updateIntro(model, area.value);
      commit();
    });
    card.append(
      el('div', { class: 'wb-card-head' }, [
        el('span', { class: 'wb-level', text: 'intro' }),
        el('span', { class: 'wb-card-title static', text: 'Before the first heading' }),
      ]),
      area,
    );
    return card;
  }

  function emptyState() {
    return el('div', {
      class: 'wb-empty',
      style: `left:${PAD}px; top:${layout.top}px;`,
    }, [
      el('strong', { text: 'This vein has no headings yet' }),
      el('p', { text: 'A note is a heading plus its prose. Add one and it is written into the markdown for you.' }),
      el('button', { class: 'btn btn-primary', type: 'button', text: '+ First note', onclick: addNewNote }),
    ]);
  }

  function addNewNote() {
    if (!model) return;
    const added = addNote(model, { title: 'New note', level: DEFAULT_LEVEL });
    model = added.model;
    commit();
    build();
    const input = cardEls[added.index]?.querySelector('.wb-card-title');
    input?.focus();
    input?.select();
  }

  /**
   * The "Link to… + New Note" path: create a note in this vein and link the
   * current card to it, in one step.
   */
  function createLinkedNote(fromIndex) {
    if (!model) return;
    const added = addNote(model, { title: 'New note', level: DEFAULT_LEVEL });
    model = added.model;
    const target = model.notes[added.index];
    const live = model.notes[fromIndex];
    // As above: a locked card gains the bond, never a prose link.
    if (!isContentLocked(live.anchor)) {
      const nextBody = `${live.body}${live.body ? '\n\n' : ''}[[#${target.title}]]`;
      model = updateNote(model, fromIndex, { body: nextBody });
    }
    const kind = linkKinds.get(fromIndex) ?? DEFAULT_RELATION;
    relations = app.setWorldRelation(currentPath, model.notes[fromIndex].anchor, target.anchor, kind) ?? relations;
    commit();
    build();
    const input = cardEls[added.index]?.querySelector('.wb-card-title');
    input?.focus();
    input?.select();
    const label = RELATION_KINDS.find((k) => k.id === kind)?.label ?? kind;
    app.toast(`Created “${target.title}” — ${label.toLowerCase()} this note`, 'ok', 1800);
  }

  /* -------------------------------------------------------------- canvas -- */

  function sizeCanvas() {
    let maxX = PAD + CARD_W;
    let maxY = layout.top + CARD_H;
    const expand = (rect) => {
      if (!rect) return;
      maxX = Math.max(maxX, rect.x + rect.width);
      maxY = Math.max(maxY, rect.y + rect.height);
    };
    (model?.notes ?? []).forEach((note, index) => {
      // A hidden member's saved position is kept for expansion, but it must
      // not keep the visible canvas sized to the collapsed group's box.
      if (isGroupHidden(note.anchor)) return;
      expand(rectOf(index));
    });
    // A trimmed wire can reach a card hidden in a collapsed group; size the
    // canvas for that card's real place so its diamond is reachable, even
    // though the card itself stays hidden.
    if (routing.cut || Object.keys(routing.edges ?? {}).length) {
      for (const edge of connectorList(model, groups, relations)) {
        if (edge.kind === 'contains' || !isGroupHidden(edge.to)) continue;
        if (!effectiveRouting(routing, connectorKey(edge)).cut) continue;
        const index = model.notes.findIndex((note) => note.anchor === edge.to);
        if (index >= 0) expand(rectOf(index));
      }
    }
    for (const group of summaryGroups()) expand(summaryRect(group));
    Object.values(annotations).forEach((annotation) => {
      maxX = Math.max(maxX, annotation.x + ANNOTATION_W);
      maxY = Math.max(maxY, annotation.y + ANNOTATION_H);
    });
    if (model?.intro) maxY = Math.max(maxY, PAD + INTRO_H);

    const width = Math.max(stage.clientWidth || 0, maxX + PAD);
    const height = maxY + PAD + 40;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    edgeSvg.setAttribute('width', String(width));
    edgeSvg.setAttribute('height', String(height));
    edgeSvg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    applyView();
  }

  /** Put the current view on the canvas, clamped to the viewport with a
   * slight overpan past the canvas edges so wires there stay reachable. */
  function applyView() {
    view = clampView(view, canvas.clientWidth, canvas.clientHeight, stage.clientWidth, stage.clientHeight);
    canvas.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.s})`;
  }

  /** Draw the smart guides a drag matched, or hide them when it matched
   * nothing. Lines are in canvas coordinates, inside the transformed canvas. */
  function paintGuides(lines) {
    const vertical = lines.find((line) => line.axis === 'x');
    const horizontal = lines.find((line) => line.axis === 'y');
    guideV.style.display = vertical ? 'block' : 'none';
    if (vertical) guideV.style.left = `${vertical.at}px`;
    guideH.style.display = horizontal ? 'block' : 'none';
    if (horizontal) guideH.style.top = `${horizontal.at}px`;
  }

  /** Remember the view for this vein; the writer debounces underneath. */
  function persistView() {
    if (currentPath) app.saveWorldView(currentPath, anchorOfView(view));
  }

  /** The bounds of the given cards (all of them by default), plus the intro
   * card and every group's frame around its cards — so fitting the canvas
   * never clips a wire's endpoint. */
  function contentBounds(indexes = null) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const expand = (rect) => {
      minX = Math.min(minX, rect.x);
      minY = Math.min(minY, rect.y);
      maxX = Math.max(maxX, rect.x + rect.width);
      maxY = Math.max(maxY, rect.y + rect.height);
    };
    const notes = model?.notes ?? [];
    const wanted = indexes ?? notes.map((_, index) => index);
    const wantedAnchors = new Set(wanted.map((index) => notes[index]?.anchor).filter(Boolean));
    wanted.forEach((index) => {
      const note = notes[index];
      if (note && !isGroupHidden(note.anchor)) expand(rectOf(index));
    });
    if (!indexes && model?.intro) expand({ x: PAD, y: PAD, width: CARD_W, height: INTRO_H });
    if (!indexes) {
      for (const group of Object.values(groups ?? {})) {
        const rect = groupDisplayRect(group);
        if (rect) expand(rect);
      }
    } else {
      // Fitting a hidden member fits the summary that represents it.
      for (const group of summaryGroups()) {
        if ([...effectiveMembers(group)].some((anchor) => wantedAnchors.has(anchor))) {
          expand(summaryRect(group));
        }
      }
    }
    return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
  }

  /**
   * Overview toggles every note to its header, then fits the whole canvas.
   * The prior fold state is kept so the next click restores it; each direction
   * is also a normal canvas-history step.
   */
  function overview() {
    const notes = model?.notes ?? [];
    if (!notes.length) {
      overviewFolded = null;
      zoomToFit();
      return;
    }
    const restoreFolds = overviewFolded;
    overviewFolded = restoreFolds ? null : { ...folded };
    if (overviewButton) {
      overviewButton.title = overviewFolded
        ? 'Restore the folding state from before Overview'
        : 'Fold every card and link section, then zoom to fit — click again to restore the previous folding state';
    }
    step(() => {
      for (const note of notes) {
        const saved = restoreFolds?.[note.anchor];
        const shouldFold = restoreFolds ? (saved === true || Boolean(saved?.card)) : true;
        folded = app.setWorldFold(currentPath, note.anchor, shouldFold) ?? folded;
      }
      build();
      zoomToFit();
    }, restoreFolds ? 'Restore folds after Overview' : 'Fold all cards — Overview');
  }

  /**
   * Fit every card into the viewport, centred: cards dragged far apart stop
   * hiding their wires off-screen. Like panning and wheel zoom this is a
   * view, not a canvas change — it persists the anchor and takes no undo
   * step.
   */
  function zoomToFit() {
    const fitted = fitView(contentBounds(), stage.clientWidth, stage.clientHeight);
    if (!fitted) return;
    view = fitted;
    persistView();
    applyView();
  }

  /** Fit just the Ctrl-clicked selection into the viewport. */
  function zoomToFitSelection() {
    const indexes = (model?.notes ?? [])
      .map((note, index) => (selected.has(note.anchor) ? index : -1))
      .filter((index) => index >= 0);
    if (!indexes.length) return;
    const fitted = fitView(contentBounds(indexes), stage.clientWidth, stage.clientHeight);
    if (!fitted) return;
    view = fitted;
    persistView();
    applyView();
  }

  /** Centre one card in the viewport at the current zoom. */
  function centreOn(index) {
    const centred = centreView(rectOf(index), stage.clientWidth, stage.clientHeight, view.s);
    if (!centred) return;
    view = centred;
    persistView();
    applyView();
  }

  /**
   * Fly the camera to one end of a relationship, keeping the zoom: the far
   * card of a cut-off wire can be screens away, so its diamond is a door to
   * it. A group end lands on the group's box. A card hidden inside a
   * collapsed group is revealed first, and when it cannot be revealed the
   * reason is said out loud rather than the click quietly doing nothing.
   */
  function focusEndpoint(endpoint) {
    if (!model || !endpoint) return;
    if (!endpoint.startsWith('group:')) {
      const index = model.notes.findIndex((note) => note.anchor === endpoint);
      if (index < 0) {
        app.toast(`“${endpointTitle(endpoint)}” is no longer on this canvas`, 'warn', 2400);
        return;
      }
      const blocked = revealCard(endpoint);
      if (blocked) {
        app.toast(blocked, 'warn', 2800);
        return;
      }
      centreOn(index);
      return;
    }
    const rect = endpointRect(endpoint);
    if (!rect) {
      app.toast(`“${endpointTitle(endpoint)}” has no place on this canvas to fly to`, 'warn', 2400);
      return;
    }
    const centred = centreView(rect, stage.clientWidth, stage.clientHeight, view.s);
    if (!centred) return;
    view = centred;
    persistView();
    applyView();
  }

  /**
   * Bring a card out of the collapsed groups hiding it — innermost first, as
   * one undoable step — so the camera has somewhere to land. Returns why the
   * card still cannot be flown to, or null when it can (it may already be
   * on screen).
   */
  function revealCard(anchor) {
    const collapsed = collapsedGroupChain(anchor);
    if (collapsed.length) {
      step(() => {
        for (const id of collapsed) {
          collapsedGroups = app.setWorldGroupCollapsed(currentPath, id, false) ?? collapsedGroups;
        }
        build();
      }, `Reveal “${endpointTitle(anchor)}”`);
    }
    if (!isGroupHidden(anchor)) return null;
    // Still hidden with nothing left to expand: say what is holding it rather
    // than panning the camera to a card the reader cannot see.
    const group = groupOf(anchor);
    if (!group) return `“${endpointTitle(anchor)}” is hidden on this canvas, but no group holds it`;
    return `“${endpointTitle(anchor)}” is still hidden inside “${group.name || 'Group'}” — expand that group to fly there`;
  }

  /** The collapsed groups hiding one card, innermost first. */
  function collapsedGroupChain(anchor) {
    const out = [];
    const parents = parentOf();
    const seen = new Set();
    let group = groupOf(anchor);
    while (group && !seen.has(group.id)) {
      seen.add(group.id);
      if (collapsedGroups[group.id]) out.push(group.id);
      const parentId = parents.get(group.id);
      group = parentId ? groups[parentId] : null;
    }
    return out;
  }

  /**
   * Tidy every unit onto a grid, group boundaries included: a group is one
   * unit in the grid, and its members keep the offsets they already had from
   * the unit's first card, so a column stays a column.
   */
  function arrangeAll() {
    const notes = model?.notes ?? [];
    // Pinned notes and locked groups keep their cards where they are: capture
    // those places before the grid is rebuilt, keep them as obstacles while
    // other units flow into free cells, and put them back afterwards.
    const fixedBefore = new Map();
    notes.forEach((note, index) => {
      if (isAnchorPinned(note.anchor) || isAnchorLocked(note.anchor)) {
        fixedBefore.set(note.anchor, positionOf(index));
      }
    });
    const fixedAnchors = new Set(fixedBefore.keys());
    const overlaps = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
    const fixedRects = [];
    for (const group of Object.values(groups ?? {})) {
      if (!group.pinned) continue;
      const box = groupDisplayRect(group);
      if (box) fixedRects.push({ x: box.x - BOX_PAD, y: box.y - BOX_PAD, width: box.width + BOX_PAD * 2, height: box.height + BOX_PAD * 2 });
    }
    notes.forEach((note, index) => {
      if (fixedAnchors.has(note.anchor) && !isGroupHidden(note.anchor)) fixedRects.push(rectOf(index));
    });
    // Outermost groups are the units; a nested group rides inside its parent.
    const childIds = new Set(Object.values(groups ?? {}).flatMap((group) => group.children ?? []));
    const groupedFirst = new Map();
    for (const group of Object.values(groups ?? {})) {
      if (childIds.has(group.id)) continue;
      const indexes = [...effectiveMembers(group)]
        .map((anchor) => notes.findIndex((note) => note.anchor === anchor))
        .filter((index) => index >= 0);
      if (indexes.length >= 2) groupedFirst.set(Math.min(...indexes), indexes);
    }
    const units = [];
    const placed = new Set();
    notes.forEach((note, index) => {
      if (placed.has(index)) return;
      const unit = groupedFirst.get(index) ?? [index];
      unit.forEach((i) => placed.add(i));
      units.push(unit);
    });
    // Capture each unit's shape before the map is cleared.
    const shapes = units.map((unit) => {
      const first = positionOf(unit[0]);
      const members = unit.map((i) => {
        const pos = positionOf(i);
        return { anchor: notes[i].anchor, dx: pos.x - first.x, dy: pos.y - first.y, height: rectOf(i).height };
      });
      return {
        members,
        firstPos: first,
        fixed: unit.every((i) => fixedAnchors.has(notes[i].anchor)),
        width: Math.max(...members.map((m) => m.dx)) + CARD_W,
        height: Math.max(...members.map((m) => m.dy + m.height)),
      };
    });
    positions = new Map();
    const cols = Math.max(1, Math.min(3, Math.ceil(Math.sqrt(Math.max(1, shapes.length)))));
    let rowTop = layout.top;
    let rowHeight = 0;
    let col = 0;
    const origins = [];
    for (const shape of shapes) {
      if (shape.fixed) {
        origins.push(shape.firstPos);
        continue;
      }
      let origin = null;
      while (!origin) {
        const candidate = { x: PAD + col * (CARD_W + GAP_X), y: rowTop };
        const freeRects = shape.members
          .filter((member) => !fixedAnchors.has(member.anchor))
          .map((member) => ({ x: candidate.x + member.dx, y: candidate.y + member.dy, width: CARD_W, height: member.height }));
        if (freeRects.every((rect) => !fixedRects.some((blocker) => overlaps(rect, blocker)))) {
          origin = candidate;
          break;
        }
        col += 1;
        if (col >= cols) {
          col = 0;
          rowTop += rowHeight + GAP_Y;
          rowHeight = 0;
        }
      }
      origins.push(origin);
      rowHeight = Math.max(rowHeight, shape.height);
      col += 1;
      if (col >= cols) {
        col = 0;
        rowTop += rowHeight + GAP_Y;
        rowHeight = 0;
      }
    }
    for (const [shapeIndex, shape] of shapes.entries()) {
      const origin = origins[shapeIndex];
      for (const member of shape.members) {
        positions.set(
          member.anchor,
          fixedBefore.get(member.anchor) ?? { x: origin.x + member.dx, y: origin.y + member.dy },
        );
      }
    }
    untangle(shapes, origins, fixedBefore);
    for (const [anchor, at] of fixedBefore) positions.set(anchor, at);
  }

  /**
   * Whether two ends form a stack: a folded card directly above the card it
   * links to, in the same column. Only prose/bond links count — the outline
   * spine stays sideways. Holds only as long as the pair stays stacked.
   */
  function isStackedPair(from, to, boxAt = (index) => rectOf(index)) {
    if (from.startsWith('group:') || to.startsWith('group:')) return false;
    const notes = model?.notes ?? [];
    const fromIndex = notes.findIndex((note) => note.anchor === from);
    const toIndex = notes.findIndex((note) => note.anchor === to);
    if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return false;
    const a = boxAt(fromIndex);
    const b = boxAt(toIndex);
    const upper = a.y <= b.y ? { index: fromIndex, box: a } : { index: toIndex, box: b };
    const lower = upper.index === fromIndex ? { index: toIndex, box: b } : { index: fromIndex, box: a };
    if (!isFolded(notes[upper.index]?.anchor)) return false;
    return Math.abs(upper.box.x - lower.box.x) <= STACK_TOLERANCE;
  }

  /**
   * Hill-climb the units' grid slots so relationships stop passing behind
   * cards. The score counts, for every drawn relationship, how many sampled
   * points of its curve lie inside some other card; a swap is only kept when
   * it strictly lowers the total, so the grid is only ever improved.
   */
  function untangle(shapes, origins, fixedBefore = new Map()) {
    const notes = model.notes ?? [];
    if (shapes.length < 2 || notes.length < 2) return;
    const indexOf = new Map(notes.map((note, index) => [note.anchor, index]));
    const endpointIndex = (endpoint) => {
      const value = String(endpoint ?? '');
      if (value.startsWith('group:')) {
        const group = groups[value.slice('group:'.length)];
        for (const anchor of group?.members ?? []) {
          const index = indexOf.get(anchor);
          if (index !== undefined) return index;
        }
        return -1;
      }
      return indexOf.get(value) ?? -1;
    };
    const unitOf = new Map();
    shapes.forEach((shape, unitIndex) => {
      shape.members.forEach((member) => {
        const index = indexOf.get(member.anchor);
        if (index !== undefined) unitOf.set(index, unitIndex);
      });
    });
    const positionsByIndex = new Array(notes.length);
    notes.forEach((note, index) => {
      const fixed = fixedBefore.get(note.anchor);
      if (fixed) positionsByIndex[index] = fixed;
    });
    const place = (unitIndex) => {
      const origin = origins[unitIndex];
      for (const member of shapes[unitIndex].members) {
        const index = indexOf.get(member.anchor);
        if (index === undefined) continue;
        const fixed = fixedBefore.get(member.anchor);
        positionsByIndex[index] = fixed ?? { x: origin.x + member.dx, y: origin.y + member.dy };
      }
    };
    shapes.forEach((_, unitIndex) => place(unitIndex));
    // Actual on-screen card boxes: width and height both come from the card,
    // so a content-sized card's extra height counts. A candidate arrangement
    // only moves these boxes; it never resizes them.
    const widths = notes.map((_, index) => rectOf(index).width || CARD_W);
    const heights = notes.map((_, index) => rectOf(index).height || CARD_H);
    const box = (pos, index) => ({ ...pos, width: widths[index] ?? CARD_W, height: heights[index] ?? CARD_H });
    const cardBox = (lookup, index) => box(lookup(index), index);
    const endpointBox = (endpoint, lookup) => {
      const value = String(endpoint ?? '');
      if (value.startsWith('group:')) {
        const id = value.slice('group:'.length);
        const group = groups?.[id];
        if (!group) return null;
        const members = [...effectiveMembers(group)]
          .map((anchor) => indexOf.get(anchor))
          .filter((index) => index !== undefined)
          .map((index) => cardBox(lookup, index));
        if (members.length < 2) return null;
        const minX = Math.min(...members.map((rect) => rect.x));
        const minY = Math.min(...members.map((rect) => rect.y));
        const maxX = Math.max(...members.map((rect) => rect.x + rect.width));
        const maxY = Math.max(...members.map((rect) => rect.y + rect.height));
        const extent = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
        // A collapsed group is represented by the summary card at its corner.
        return collapsedGroups[id]
          ? { x: extent.x - 12, y: extent.y - 12, width: 280, height: 120 }
          : extent;
      }
      if (isGroupHidden(value)) return null;
      const index = indexOf.get(value);
      return index === undefined ? null : cardBox(lookup, index);
    };
    const isStackedAt = (from, to, lookup) => isStackedPair(
      from,
      to,
      (index) => cardBox(lookup, index),
    );
    // Every connector the canvas draws, in drawing order: the relationships,
    // the outline spine and group bonds alike. Keeping `kind` and both
    // endpoints lets the scorer use each edge's own routing and lanes.
    const edges = connectorList(model, groups, relations)
      .map((edge) => ({
        ...edge,
        fromIndex: endpointIndex(edge.from),
        toIndex: endpointIndex(edge.to),
      }))
      .filter((edge) => edge.fromIndex >= 0 && edge.toIndex >= 0 && edge.fromIndex !== edge.toIndex);
    if (!edges.length) return;
    for (const edge of edges) {
      edge.fromUnit = unitOf.get(edge.fromIndex) ?? -1;
      edge.toUnit = unitOf.get(edge.toIndex) ?? -1;
    }
    // Occlusion under a candidate set of positions, using the very same
    // preparation and spread pass as the canvas: actual rects, lanes, stacked
    // verticals, cut limits and per-edge elbow routing all included.
    const score = (subset, lookup) => {
      const prepared = prepareConnectorGeometry(edges, {
        rectFor: (endpoint) => endpointBox(endpoint, lookup),
        routing,
        isStacked: (from, to) => isStackedAt(from, to, lookup),
        proxyRectFor: (endpoint) => {
          if (!endpoint || endpoint.startsWith('group:') || !isGroupHidden(endpoint)) return null;
          const index = indexOf.get(endpoint);
          return index === undefined ? null : cardBox(lookup, index);
        },
      });
      const wires = spreadConnectorCurves(prepared);
      const wanted = new Set(subset);
      let total = 0;
      for (const wire of wires) {
        const edge = wire.edge;
        if (!wanted.has(edge)) continue;
        for (let step = 0; step <= 16; step += 1) {
          const point = wire.at(step / 16);
          for (let j = 0; j < positionsByIndex.length; j += 1) {
            if (j === edge.fromIndex || j === edge.toIndex) continue;
            const rect = cardBox(lookup, j);
            if (point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height) {
              total += 1;
              break;
            }
          }
        }
      }
      return total;
    };
    const startOrigins = origins.map((origin) => ({ ...origin }));
    const initial = score(edges, (index) => positionsByIndex[index]);
    let current = initial;
    for (let pass = 0; pass < 6 && current > 0; pass += 1) {
      let best = null;
      for (let a = 0; a < shapes.length; a += 1) {
        for (let b = a + 1; b < shapes.length; b += 1) {
          const affected = edges.filter((edge) => [edge.fromUnit, edge.toUnit].includes(a) || [edge.fromUnit, edge.toUnit].includes(b));
          if (!affected.length) continue;
          const [originA, originB] = [origins[a], origins[b]];
          const swapped = (index) => {
            const fixed = fixedBefore.get(notes[index]?.anchor);
            if (fixed) return fixed;
            const unit = unitOf.get(index);
            if (unit === a) return { ...positionsByIndex[index], x: positionsByIndex[index].x + originB.x - originA.x, y: positionsByIndex[index].y + originB.y - originA.y };
            if (unit === b) return { ...positionsByIndex[index], x: positionsByIndex[index].x + originA.x - originB.x, y: positionsByIndex[index].y + originA.y - originB.y };
            return positionsByIndex[index];
          };
          const delta = score(affected, swapped) - score(affected, (index) => positionsByIndex[index]);
          if (delta < 0 && (!best || delta < best.delta)) best = { a, b, delta };
        }
      }
      if (!best) break;
      // Keep the swap: exchange the units' grid origins.
      [origins[best.a], origins[best.b]] = [origins[best.b], origins[best.a]];
      [best.a, best.b].forEach((unit) => place(unit));
      current = score(edges, (index) => positionsByIndex[index]);
    }
    // A moved unit can occlude an edge between two others, which the
    // per-swap delta cannot see — never finish worse than the plain grid.
    if (current > initial) {
      origins.forEach((origin, i) => { origin.x = startOrigins[i].x; origin.y = startOrigins[i].y; });
      shapes.forEach((_, unitIndex) => place(unitIndex));
    }
    positionsByIndex.forEach((pos, index) => {
      if (pos && notes[index]) positions.set(notes[index].anchor, pos);
    });
  }

  /* ------------------------------------------------- selection & grouping -- */

    /** Begin dragging a set of notes (one card, the Ctrl-click selection, or
   * a whole group) from a grab. A solo card's drag can change membership;
   * a whole-nest drag from a tab can, too — its group can nest into another
   * or out of its parent. A selection drag moves its cards together without
   * changing anyone's group membership. */
  function dragMembers(anchors, event, el, { joinable = false, groupId = null, selection = false } = {}) {
    // One drag is one step, however many frames it takes: the snapshot is
    // taken here and pushed when the pointer comes up.
    beginStep();
    const rect = canvas.getBoundingClientRect();
    dragging = {
      el,
      // Only a single card's drag can join a box — a nest drag takes its
      // group, not a card, along, so its membership needs its own gate.
      joinable,
      groupId,
      selection,
      // How far the drag has carried the card so far, in canvas pixels.
      distance: 0,
      // The group the card (or nested group) started the drag sitting
      // inside, if any — an arrival only joins a box entered during the
      // drag, and a departure only leaves the one it started in.
      startGroupId: null,
      grab: {
        x: (event.clientX - rect.left) / view.s,
        y: (event.clientY - rect.top) / view.s,
      },
      members: [...new Set(anchors)].map((anchor) => {
        const i = model.notes.findIndex((n) => n.anchor === anchor);
        return { anchor, el: cardEls[i], start: i >= 0 ? positionOf(i) : { x: 0, y: 0 } };
      }).filter((member) => member.el),
    };
    if (groupId) {
      dragging.startGroupId = parentOf().get(groupId) ?? null;
    } else if (joinable) {
      const index = model.notes.findIndex((note) => note.anchor === anchors[0]?.anchor);
      if (index >= 0) {
        const box = rectOf(index);
        dragging.startGroupId = groupAtPoint({ x: box.x + box.width / 2, y: box.y + box.height / 2 })?.id ?? null;
      }
    }
    el?.classList.add('is-dragging');
    dragging.members.forEach((member) => member.el.classList.add('is-dragging'));
    event.preventDefault();
  }

  const GROUP_COLORS = ['#58a6ff', '#57d364', '#da70d6', '#d29922', '#f97066', '#45c4b0', '#f778ba', '#8b949e'];
  const GROUP_DEFAULT_COLOR = '#58a6ff';
  // What a group's tab may wear: a generic mark of a set, and every note type.
  const GROUP_GENERIC_ICON = '⁂';
  const GROUP_ICONS = [GROUP_GENERIC_ICON, ...NODE_TYPES.map((type) => type.icon)];

  /** The innermost group a note belongs to, if any. */
  function groupOf(anchor) {
    return Object.values(groups ?? {}).find((group) => group.members.includes(anchor)) ?? null;
  }

  /** child group id → parent group id, for every nested group. */
  function parentOf() {
    const map = new Map();
    for (const [id, group] of Object.entries(groups ?? {})) {
      for (const child of group.children ?? []) map.set(child, id);
    }
    return map;
  }

  /** The nearest ancestor group carrying a pin or lock for this group. */
  function restrictingParentGroup(id, property) {
    const parents = parentOf();
    const seen = new Set();
    let parentId = parents.get(id);
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      const parent = groups[parentId];
      if (!parent) return null;
      if (parent[property]) return parent;
      parentId = parents.get(parentId);
    }
    return null;
  }

  /**
   * A group is locked when it — or any group it is nested inside — carries
   * the lock. Locking guards the group's contents, not its relationships,
   * so a locked group can still receive or send links.
   */
  function isGroupLocked(group) {
    let current = typeof group === 'string' ? groups[group] : group;
    const parents = parentOf();
    const seen = new Set();
    while (current && !seen.has(current.id)) {
      if (current.locked) return true;
      seen.add(current.id);
      const parentId = parents.get(current.id);
      current = parentId ? groups[parentId] : null;
    }
    return false;
  }

  /** The innermost locked group containing a note, through nesting, if any. */
  function lockedGroupOf(anchor) {
    const locked = Object.values(groups ?? {}).filter(
      (group) => group.locked && effectiveMembers(group).has(anchor),
    );
    if (!locked.length) return null;
    const depths = groupDepths();
    return locked.sort((a, b) => (depths.get(b.id) ?? 0) - (depths.get(a.id) ?? 0))[0];
  }

  function isAnchorLocked(anchor) {
    return Boolean(lockedGroupOf(anchor));
  }

  /** This note's content is individually locked read-only. */
  function isNodeLocked(anchor) {
    return Boolean(nodeLocked[anchor]);
  }

  /**
   * Content locked either way — group or node: title, prose, type, fields,
   * colour, image and tags are all read-only, and the note cannot be removed.
   * Movement is a separate question: group locks block it, node locks don't.
   */
  function isContentLocked(anchor) {
    return isAnchorLocked(anchor) || isNodeLocked(anchor);
  }

  function contentLockedToast(anchor) {
    if (isAnchorLocked(anchor)) {
      lockedToast(anchor);
      return;
    }
    app.toast(
      `“${noteTitle(anchor)}” is locked — unlock it to change its content (it can still be moved and linked)`,
      'warn',
      2200,
    );
  }

  function lockedToast(anchor) {
    const group = lockedGroupOf(anchor);
    app.toast(
      `“${noteTitle(anchor)}” is in locked group “${group?.name || 'Group'}” — links can still be added`,
      'warn',
      2200,
    );
  }

  /** The pinned group holding a note in place, if one does. */
  function pinnedGroupOf(anchor) {
    return Object.values(groups ?? {}).find(
      (group) => group.pinned && effectiveMembers(group).has(anchor),
    ) ?? null;
  }

  /** A note is pinned when it is pinned itself or sits in a pinned group. */
  function isAnchorPinned(anchor) {
    if (pinned[anchor]) return true;
    return Boolean(pinnedGroupOf(anchor));
  }

  /** Every note a group contains: its own cards plus all descendants'. */
  function effectiveMembers(group, seen = new Set()) {
    const out = new Set();
    const visit = (id) => {
      if (seen.has(id)) return;
      seen.add(id);
      const current = groups[id];
      if (!current) return;
      current.members.forEach((anchor) => out.add(anchor));
      (current.children ?? []).forEach(visit);
    };
    visit(group.id);
    return out;
  }

  /** Each group's nesting depth, id → 0 at the top: inner boxes draw on top. */
  function groupDepths() {
    const parents = parentOf();
    const depths = new Map();
    const depthOf = (id) => {
      if (depths.has(id)) return depths.get(id);
      const depth = parents.has(id) ? depthOf(parents.get(id)) + 1 : 0;
      depths.set(id, depth);
      return depth;
    };
    for (const id of Object.keys(groups ?? {})) depthOf(id);
    return depths;
  }

  /** Put the selection on screen: card outlines and the Fit button. */
  function syncSelectionUi() {
    (model?.notes ?? []).forEach((note, index) => {
      cardEls[index]?.classList.toggle('is-selected', selected.has(note.anchor));
    });
    toolbar.querySelector('[data-fit-selection]')?.toggleAttribute('disabled', !selected.size);
  }

  /** Toggle the canvas search bar. */
  function toggleSearchBar() {
    searchBar.classList.toggle('hidden');
    if (!searchBar.classList.contains('hidden')) {
      searchInput.focus();
      searchInput.select();
    } else {
      clearCanvasSearch();
    }
  }

  /** Run the current query and put the matches on screen. */
  function runCanvasSearch() {
    const query = searchInput.value.trim();
    isolatedAnchors = null;
    if (!query || !model) {
      searchMatches = [];
      searchCurrent = -1;
      renderSearchResults();
      syncSearchUi();
      return;
    }
    searchMatches = canvasSearch(model, { types: nodeTypes, fields: fieldValues, colors: nodeColors, groups }, query);
    searchCurrent = searchMatches.length ? 0 : -1;
    renderSearchResults();
    syncSearchUi();
  }

  function renderSearchResults() {
    searchCount.textContent = searchMatches.length
      ? `${searchCurrent + 1} of ${searchMatches.length}`
      : (searchInput.value.trim() ? 'no matches' : '');
    searchResults.classList.toggle('hidden', !searchMatches.length);
    clear(searchResults);
    searchMatches.forEach((match, index) => {
      const chips = match.reasons.map((reason) => el('span', { class: 'wb-search-chip', text: reason }));
      searchResults.append(el('button', {
        class: `wb-search-result${index === searchCurrent ? ' is-active' : ''}`,
        type: 'button', role: 'option', 'aria-selected': index === searchCurrent ? 'true' : 'false',
        title: match.title,
        onclick: () => jumpToSearchMatch(index),
      }, [
        el('span', { class: 'wb-search-result-title', text: match.title }),
        ...chips,
      ]));
    });
  }

  /** Put search highlights, the current target, and dimming on screen. */
  function syncSearchUi() {
    const hits = new Set(searchMatches.map((match) => match.anchor));
    const currentAnchor = searchMatches[searchCurrent]?.anchor ?? null;
    (model?.notes ?? []).forEach((note, index) => {
      const card = cardEls[index];
      if (!card) return;
      card.classList.toggle('is-search-hit', hits.has(note.anchor));
      card.classList.toggle('is-search-current', note.anchor === currentAnchor);
      card.classList.toggle('is-dimmed', Boolean(isolatedAnchors) && !isolatedAnchors.has(note.anchor));
    });
    stage.classList.toggle('is-isolating', Boolean(isolatedAnchors));
  }

  /** Jump to one match: centre it, mark it current, and move the list. */
  function jumpToSearchMatch(index) {
    if (!searchMatches.length) return;
    searchCurrent = ((index % searchMatches.length) + searchMatches.length) % searchMatches.length;
    const match = searchMatches[searchCurrent];
    centreOn(match.index);
    renderSearchResults();
    syncSearchUi();
  }

  /** Select every match, so they can be grouped, arranged, or fitted. */
  function selectAllSearchMatches() {
    if (!searchMatches.length) return;
    setSelection(searchMatches.map((match) => match.anchor));
    app.toast(`${searchMatches.length} match${searchMatches.length === 1 ? '' : 'es'} selected`, 'ok', 1500);
  }

  /**
   * Isolate the connected subgraph of the matches: everything outside it
   * dims, and the view fits what stays bright.
   */
  function isolateSearchMatches() {
    if (!searchMatches.length || !model) return;
    isolatedAnchors = connectedAnchors(model, relations, searchMatches.map((match) => match.anchor));
    syncSearchUi();
    const indexes = (model.notes ?? [])
      .map((note, index) => (isolatedAnchors.has(note.anchor) ? index : -1))
      .filter((index) => index >= 0);
    fitIndexes(indexes);
    app.toast(`Isolated ${indexes.length} connected card${indexes.length === 1 ? '' : 's'}`, 'ok', 1800);
  }

  /** Forget the query, the matches, and any isolation. */
  function clearCanvasSearch() {
    searchInput.value = '';
    searchMatches = [];
    searchCurrent = -1;
    isolatedAnchors = null;
    renderSearchResults();
    syncSearchUi();
  }

  /** Replace the selection with the given anchors that still exist. */
  function setSelection(anchors) {
    const live = new Set((model?.notes ?? []).map((note) => note.anchor));
    selected = new Set([...(anchors ?? [])].filter((anchor) => live.has(anchor)));
    syncSelectionUi();
  }

  /**
   * Quick selections. Connected, lineage, same type/colour and group
   * members grow from the current selection; pinned, locked, untyped and
   * imageless gather every matching card in the vein. Selection only —
   * nothing here moves, locks, or rewires anything.
   */
  function quickSelect(kind) {
    if (!model) return;
    const notes = model.notes ?? [];
    if (!['pinned', 'locked', 'untyped', 'imageless'].includes(kind) && !selected.size) {
      app.toast('Select a card first — Ctrl+click or Shift+drag', 'warn', 2200);
      return;
    }
    const effectiveColor = (anchor) => nodeColors[anchor] ?? nodeTypeOf(nodeTypes, anchor).color ?? '';
    let next = new Set();
    if (kind === 'pinned') {
      next = new Set(notes.filter((note) => isAnchorPinned(note.anchor)).map((note) => note.anchor));
    } else if (kind === 'locked') {
      next = new Set(notes.filter((note) => isContentLocked(note.anchor)).map((note) => note.anchor));
    } else if (kind === 'untyped') {
      next = new Set(notes.filter((note) => !nodeTypes[note.anchor]).map((note) => note.anchor));
    } else if (kind === 'imageless') {
      next = new Set(notes.filter((note) => !nodeImages[note.anchor]).map((note) => note.anchor));
    } else if (kind === 'connected') {
      next = connectedAnchors(model, relations, selected);
    } else if (kind === 'ancestors') {
      next = lineageAnchors(model, selected, 'ancestors');
    } else if (kind === 'descendants') {
      next = lineageAnchors(model, selected, 'descendants');
    } else if (kind === 'same-type') {
      const types = new Set([...selected].map((anchor) => nodeTypeOf(nodeTypes, anchor).id));
      next = new Set(notes.filter((note) => types.has(nodeTypeOf(nodeTypes, note.anchor).id)).map((note) => note.anchor));
    } else if (kind === 'same-colour') {
      const colors = new Set([...selected].map(effectiveColor).filter(Boolean));
      if (!colors.size) {
        app.toast('The selected cards have no colour to match', 'warn', 2200);
        return;
      }
      next = new Set(notes.filter((note) => colors.has(effectiveColor(note.anchor))).map((note) => note.anchor));
    } else if (kind === 'group-members') {
      for (const anchor of selected) {
        const group = groupOf(anchor);
        if (group) for (const member of effectiveMembers(group)) next.add(member);
      }
    }
    setSelection(next);
    app.toast(next.size ? `${next.size} card${next.size === 1 ? '' : 's'} selected` : 'No matching cards', 'ok', 1500);
  }

  /** The Select menu: quick picks, seeded by the current selection. */
  let cardsMenuEl = null;

  function cardsEscape(event) {
    if (event.key !== 'Escape' || !cardsMenuEl) return;
    event.stopPropagation();
    closeCardsMenu({ returnFocus: true });
  }

  /** Close the Cards menu; a keyboard dismissal or choice hands focus back. */
  function closeCardsMenu({ returnFocus = 'auto' } = {}) {
    if (!cardsMenuEl) return;
    const trigger = cardsMenuEl._trigger ?? null;
    const hadFocus = cardsMenuEl.contains(document.activeElement);
    cardsMenuEl.remove();
    cardsMenuEl = null;
    toolbar.querySelector('[data-cards-toggle]')?.setAttribute('aria-expanded', 'false');
    document.removeEventListener('keydown', cardsEscape);
    if (returnFocus === true || (returnFocus === 'auto' && hadFocus)) focusMenuTrigger(trigger);
  }

  function toggleCardsMenu(button) {
    if (cardsMenuEl) {
      closeCardsMenu({ returnFocus: false });
      return;
    }
    const targets = selected.size ? [...selected] : null;
    const items = [
      ['Full cards', 'full', 'The whole node — prose, fields and links'],
      ['Compact cards', 'compact', 'Title, type, link and word counts only'],
      ['Thumbnail cards', 'thumbnail', 'Just the node’s image (or its initial)'],
    ].map(([label, mode, hint]) => el('button', {
      class: 'wb-menu-item',
      type: 'button',
      text: label,
      title: targets ? hint : `${hint} — select cards first`,
      onclick: () => {
        if (!targets) {
          app.toast('Select cards first to set their mode', 'warn', 1800);
          return;
        }
        const anchor = targets[0];
        setCardMode(anchor, mode);
        closeCardsMenu();
      },
    }));
    items.push(el('span', { class: 'wb-menu-label', text: 'Card height' }));
    for (const [label, size, hint] of [
      ['Fit cards to content', 'content', 'Grow each card to its prose so the whole note shows'],
      ['Fixed card height', 'fixed', 'Keep the standard box; prose scrolls'],
    ]) {
      items.push(el('button', {
        class: 'wb-menu-item',
        type: 'button',
        text: label,
        title: targets ? hint : `${hint} — select cards first`,
        onclick: () => {
          if (!targets) {
            app.toast('Select cards first to set their height', 'warn', 1800);
            return;
          }
          setCardSize(targets[0], size);
          closeCardsMenu();
        },
      }));
    }
    items.push(el('span', { class: 'wb-menu-label', text: 'Groups' }));
    items.push(el('button', {
      class: 'wb-menu-item', type: 'button', text: 'Collapse all groups to summaries',
      title: 'Every group becomes one summary card',
      onclick: () => {
        const all = Object.values(groups ?? {});
        if (!all.length) {
          app.toast('This canvas has no groups to collapse', 'info', 1800);
        } else {
          step(() => {
            for (const group of all) {
              collapsedGroups = app.setWorldGroupCollapsed(currentPath, group.id, true) ?? collapsedGroups;
            }
            build();
          }, 'Collapse all groups');
          if (all.every((group) => collapsedGroups[group.id])) {
            app.toast('Every group is already collapsed', 'info', 1800);
          }
        }
        closeCardsMenu();
      },
    }));
    items.push(el('button', {
      class: 'wb-menu-item', type: 'button', text: 'Expand all groups',
      title: 'Show every group’s cards again',
      onclick: () => {
        const all = Object.values(groups ?? {});
        if (!all.length) {
          app.toast('This canvas has no groups to expand', 'info', 1800);
        } else {
          step(() => {
            for (const group of all) {
              collapsedGroups = app.setWorldGroupCollapsed(currentPath, group.id, false) ?? collapsedGroups;
            }
            build();
          }, 'Expand all groups');
          if (all.every((group) => !collapsedGroups[group.id])) {
            app.toast('Every group is already expanded', 'info', 1800);
          }
        }
        closeCardsMenu();
      },
    }));
    cardsMenuEl = el('div', { class: 'wb-menu', role: 'menu' }, items);
    cardsMenuEl._trigger = button;
    button.setAttribute('aria-expanded', 'true');
    button.after(cardsMenuEl);
    document.addEventListener('keydown', cardsEscape);
    focusMenuStart(cardsMenuEl);
  }

  function toggleSelectMenu(anchorButton) {
    if (selectMenuEl) {
      closeSelectMenu();
      return;
    }
    const items = [
      ['Connected nodes', 'connected', 'Every card linked to the selection, through prose links and bonds'],
      ['Ancestors', 'ancestors', 'Cards above the selection in the heading outline'],
      ['Descendants', 'descendants', 'Cards below the selection in the heading outline'],
      ['Same type', 'same-type', 'Every card of the selected cards’ types'],
      ['Same colour', 'same-colour', 'Every card sharing the selected cards’ colours'],
      ['Group members', 'group-members', 'Every card in the selected cards’ groups'],
      ['Pinned', 'pinned', 'Every pinned card in this vein'],
      ['Locked', 'locked', 'Every locked card in this vein — group or node locks'],
      ['Untyped', 'untyped', 'Every card with no type chosen'],
      ['No image', 'imageless', 'Every card without an embedded image'],
    ].map(([label, kind, title]) => el('button', {
      class: 'wb-menu-item', type: 'button', text: label, title,
      onclick: () => {
        closeSelectMenu();
        quickSelect(kind);
      },
    }));
    items.push(el('button', {
      class: 'wb-menu-item', type: 'button', text: 'Clear selection',
      onclick: () => {
        closeSelectMenu();
        setSelection([]);
      },
    }));
    selectMenuEl = el('div', { class: 'wb-menu wb-select-menu', role: 'menu' }, items);
    selectMenuEl._trigger = anchorButton;
    document.body.append(selectMenuEl);
    const rect = anchorButton.getBoundingClientRect();
    selectMenuEl.style.left = `${Math.max(8, rect.left)}px`;
    selectMenuEl.style.top = `${rect.bottom + 6}px`;
    anchorButton.setAttribute('aria-expanded', 'true');
    const dismiss = (event) => {
      if (!selectMenuEl?.contains(event.target) && event.target !== anchorButton) closeSelectMenu({ returnFocus: false });
    };
    document.addEventListener('pointerdown', dismiss, true);
    selectMenuEl.addEventListener('pointerdown', (event) => event.stopPropagation());
    selectMenuEl._dismiss = dismiss;
    document.addEventListener('keydown', selectEscape);
    focusMenuStart(selectMenuEl);
  }

  function selectEscape(event) {
    if (event.key !== 'Escape' || !selectMenuEl) return;
    event.stopPropagation();
    closeSelectMenu({ returnFocus: true });
  }

  /** Close the Select menu; a keyboard dismissal or choice hands focus back. */
  function closeSelectMenu({ returnFocus = 'auto' } = {}) {
    if (!selectMenuEl) return;
    const trigger = selectMenuEl._trigger ?? null;
    const hadFocus = selectMenuEl.contains(document.activeElement);
    if (selectMenuEl._dismiss) document.removeEventListener('pointerdown', selectMenuEl._dismiss, true);
    document.removeEventListener('keydown', selectEscape);
    selectMenuEl.remove();
    selectMenuEl = null;
    toolbar.querySelector('[data-select-toggle]')?.setAttribute('aria-expanded', 'false');
    if (returnFocus === true || (returnFocus === 'auto' && hadFocus)) focusMenuTrigger(trigger);
  }

  /**
   * What an arrange scope means right now: concrete card indexes plus a
   * label for the undo step. Group, component and type grow from the
   * first selected card; without a selection they have nothing to grow
   * from and resolve to null.
   */
  function arrangeScope(scope) {
    const notes = model?.notes ?? [];
    if (scope === 'selection') {
      return { indexes: selectedIndexes(), label: 'selection' };
    }
    const firstIndex = selectedIndexes()[0];
    if (firstIndex === undefined) return null;
    const first = notes[firstIndex];
    if (scope === 'group') {
      const group = groupOf(first.anchor);
      if (!group) return null;
      const indexes = [...effectiveMembers(group)]
        .map((anchor) => notes.findIndex((note) => note.anchor === anchor))
        .filter((index) => index >= 0);
      return { indexes, label: `group “${group.name || 'Group'}”`, groupId: group.id };
    }
    if (scope === 'component') {
      const anchors = connectedAnchors(model, relations, selected);
      const indexes = notes.map((note, index) => (anchors.has(note.anchor) ? index : -1)).filter((index) => index >= 0);
      return { indexes, label: 'connected component' };
    }
    if (scope === 'type') {
      const type = nodeTypeOf(nodeTypes, first.anchor);
      const indexes = notes.map((note, index) => (nodeTypeOf(nodeTypes, note.anchor).id === type.id ? index : -1)).filter((index) => index >= 0);
      return { indexes, label: `type “${type.label}”` };
    }
    return null;
  }

  function fitIndexes(indexes) {
    if (!indexes?.length) return;
    const fitted = fitView(contentBounds(indexes), stage.clientWidth, stage.clientHeight);
    if (!fitted) return;
    view = fitted;
    persistView();
    applyView();
  }

  /**
   * Arrange the target cards with one layout. Units are whole outermost
   * groups fully inside the target (they keep their internal offsets);
   * everything else moves card by card. A unit holding a pinned or locked
   * card never moves, and free placements flow around every other card —
   * so an arrangement can neither tear a locked group nor land on top of
   * a neighbour.
   */
  function arrangeTargets(indexes, layout) {
    const notes = model?.notes ?? [];
    const targetIndexes = [...new Set(indexes ?? [])].filter((index) => notes[index] !== undefined).sort((a, b) => a - b);
    if (targetIndexes.length < 2) return;
    const targetSet = new Set(targetIndexes);
    const fixedAnchors = new Set(
      targetIndexes
        .map((index) => notes[index].anchor)
        .filter((anchor) => isAnchorPinned(anchor) || isAnchorLocked(anchor)),
    );
    // Whole groups fully inside the target move as one unit — outermost
    // first, so a parent claims its nested groups, but a nested group that
    // is itself the target (scope: group) still moves as one.
    const groupedFirst = new Map();
    const claimed = new Set();
    const depths = groupDepths();
    const orderedGroups = Object.values(groups ?? {}).sort(
      (a, b) => (depths.get(a.id) ?? 0) - (depths.get(b.id) ?? 0),
    );
    // Progression columns move cards one by one: a whole group kept as one
    // unit would keep its offsets and could never split across tiers.
    for (const group of layout === 'progression' ? [] : orderedGroups) {
      const memberIndexes = [...effectiveMembers(group)]
        .map((anchor) => notes.findIndex((note) => note.anchor === anchor))
        .filter((index) => index >= 0);
      if (memberIndexes.length < 2 || !memberIndexes.every((index) => targetSet.has(index))) continue;
      if (memberIndexes.some((index) => claimed.has(index))) continue;
      memberIndexes.forEach((index) => claimed.add(index));
      groupedFirst.set(Math.min(...memberIndexes), memberIndexes);
    }
    const units = [];
    const placed = new Set();
    targetIndexes.forEach((index) => {
      if (placed.has(index)) return;
      const unit = groupedFirst.get(index) ?? [index];
      unit.forEach((i) => placed.add(i));
      units.push(unit);
    });
    const shapes = units.map((unit) => {
      const first = positionOf(unit[0]);
      const members = unit.map((index) => {
        const pos = positionOf(index);
        return { anchor: notes[index].anchor, dx: pos.x - first.x, dy: pos.y - first.y, height: rectOf(index).height };
      });
      return {
        members,
        firstPos: first,
        fixed: unit.some((index) => fixedAnchors.has(notes[index].anchor)),
        minIndex: Math.min(...unit),
      };
    });
    const overlaps = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
    const blockers = [];
    notes.forEach((note, index) => {
      if (!targetSet.has(index) && !isGroupHidden(note.anchor)) blockers.push(rectOf(index));
    });
    // A collapsed group is represented by its summary wherever it is not
    // itself the arrangement target; hidden member boxes are not blockers.
    for (const group of summaryGroups()) {
      const memberIndexes = [...effectiveMembers(group)]
        .map((anchor) => notes.findIndex((note) => note.anchor === anchor))
        .filter((index) => index >= 0);
      if (memberIndexes.length && memberIndexes.every((index) => targetSet.has(index))) continue;
      const rect = summaryRect(group);
      if (rect) blockers.push(rect);
    }
    for (const shape of shapes) {
      if (!shape.fixed) continue;
      for (const member of shape.members) {
        const index = notes.findIndex((note) => note.anchor === member.anchor);
        if (index >= 0 && !isGroupHidden(member.anchor)) blockers.push(rectOf(index));
      }
    }
    for (const group of Object.values(groups ?? {})) {
      if (!group.pinned) continue;
      const memberIndexes = [...effectiveMembers(group)]
        .map((anchor) => notes.findIndex((note) => note.anchor === anchor))
        .filter((index) => index >= 0);
      if (memberIndexes.length >= 2 && memberIndexes.every((index) => targetSet.has(index))) continue;
      const box = groupDisplayRect(group);
      if (box) blockers.push({ x: box.x - BOX_PAD, y: box.y - BOX_PAD, width: box.width + BOX_PAD * 2, height: box.height + BOX_PAD * 2 });
    }
    const targetRects = targetIndexes
      .filter((index) => !isGroupHidden(notes[index].anchor))
      .map((index) => rectOf(index));
    for (const group of summaryGroups()) {
      const memberIndexes = [...effectiveMembers(group)]
        .map((anchor) => notes.findIndex((note) => note.anchor === anchor))
        .filter((index) => index >= 0);
      if (memberIndexes.some((index) => targetSet.has(index))) {
        const rect = summaryRect(group);
        if (rect) targetRects.push(rect);
      }
    }
    const origin = targetRects.length
      ? {
          x: Math.min(...targetRects.map((rect) => rect.x)),
          y: Math.min(...targetRects.map((rect) => rect.y)),
        }
      : { x: PAD, y: layout.top };
    const freeShapes = shapes.filter((shape) => !shape.fixed);
    if (layout === 'progression') {
      const columns = progressionColumns(model, targetIndexes.map((index) => notes[index].anchor));
      for (const shape of freeShapes) {
        shape.column = Math.min(...shape.members.map((member) => columns.get(member.anchor) ?? 0));
      }
      freeShapes.sort((a, b) => a.column - b.column || a.minIndex - b.minIndex);
    } else if (layout === 'layered') {
      const depths = relationshipDepths(model, relations, targetIndexes.map((index) => notes[index].anchor));
      for (const shape of freeShapes) {
        shape.layer = Math.min(...shape.members.map((member) => depths.get(member.anchor) ?? 0));
      }
      freeShapes.sort((a, b) => a.layer - b.layer || a.firstPos.x - b.firstPos.x || a.minIndex - b.minIndex);
    } else {
      freeShapes.sort((a, b) => a.minIndex - b.minIndex);
    }
    const cols = Math.max(1, Math.ceil(Math.sqrt(Math.max(1, freeShapes.length))));
    // Rows are spaced by the tallest target, so a content-sized card is not
    // walked into by the next row's candidate.
    const stepY = Math.max(CARD_H, ...targetRects.map((rect) => rect.height)) + GAP_Y;
    const candidatesFor = (shape) => arrangeCandidateOrigins(layout, origin, {
      columns: cols,
      stepX: CARD_W + GAP_X,
      stepY,
      layer: shape.layer ?? 0,
      column: shape.column ?? 0,
    });
    const placedRects = [];
    const fits = (at, shape) => shape.members.every((member) => {
      const rect = { x: at.x + member.dx, y: at.y + member.dy, width: CARD_W, height: member.height };
      return !blockers.some((blocker) => overlaps(rect, blocker)) && !placedRects.some((other) => overlaps(rect, other));
    });
    for (const shape of freeShapes) {
      // The candidate search is capped in the library. Keep the shape where
      // it stands rather than moving it to the arrangement origin, where it
      // could land on a blocker.
      shape.origin = findArrangeOrigin(candidatesFor(shape), (at) => fits(at, shape)) ?? { ...shape.firstPos };
      for (const member of shape.members) {
        placedRects.push({ x: shape.origin.x + member.dx, y: shape.origin.y + member.dy, width: CARD_W, height: member.height });
      }
    }
    for (const shape of freeShapes) {
      for (const member of shape.members) {
        positions.set(member.anchor, { x: shape.origin.x + member.dx, y: shape.origin.y + member.dy });
      }
    }
  }

  /** Run one arrange step and fit the result into view. */
  function runArrange(scope, layout) {
    const resolved = arrangeScope(scope);
    if (!resolved) {
      app.toast('Select a card first — Ctrl+click or Shift+drag', 'warn', 2200);
      return;
    }
    if (resolved.indexes.length < 2) {
      app.toast('Nothing to arrange — fewer than two cards in scope', 'warn', 1800);
      return;
    }
    const layoutLabel = { grid: 'Grid', rows: 'Rows', columns: 'Columns', cascade: 'Cascade', layered: 'Layered', progression: 'Progression columns' }[layout] ?? layout;
    step(() => {
      // A group split into progression columns keeps its board: the lanes
      // and tier headers are drawn from the flag, and a collapsed group
      // opens so its cards can be seen in their columns.
      if (layout === 'progression' && resolved.groupId && groups[resolved.groupId]) {
        if (collapsedGroups[resolved.groupId]) {
          collapsedGroups = app.setWorldGroupCollapsed(currentPath, resolved.groupId, false) ?? collapsedGroups;
        }
        groups = { ...groups, [resolved.groupId]: { ...groups[resolved.groupId], layout: 'progression' } };
        app.saveWorldGroups(currentPath, groups);
      }
      arrangeTargets(resolved.indexes, layout);
      savePositions();
      sizeCanvas();
      drawEdges();
      build();
      fitIndexes(resolved.indexes);
    }, `Arrange ${resolved.label} — ${layoutLabel}`);
  }

  /**
   * Split one group into progression columns: its cards re-laid by heading-
   * tree tier, top items left, deeper tiers right, as one undoable step —
   * the group's Arrange → Progression columns, aimed at the group itself.
   */
  function splitGroupProgression(groupId) {
    const group = groups[groupId];
    if (!group || !model) return;
    if (isGroupLocked(group)) {
      app.toast(`“${group.name || 'Group'}” is locked — unlock it before splitting it`, 'warn', 2200);
      return;
    }
    const notes = model.notes ?? [];
    const indexes = [...effectiveMembers(group)]
      .map((anchor) => notes.findIndex((note) => note.anchor === anchor))
      .filter((index) => index >= 0);
    if (indexes.length < 2) {
      app.toast('Nothing to split — fewer than two cards in the group', 'warn', 1800);
      return;
    }
    step(() => {
      if (collapsedGroups[groupId]) {
        collapsedGroups = app.setWorldGroupCollapsed(currentPath, groupId, false) ?? collapsedGroups;
      }
      groups = { ...groups, [groupId]: { ...groups[groupId], layout: 'progression' } };
      app.saveWorldGroups(currentPath, groups);
      arrangeTargets(indexes, 'progression');
      savePositions();
      sizeCanvas();
      drawEdges();
      build();
      fitIndexes(indexes);
    }, `Split “${group.name || 'Group'}” into progression columns`);
    app.toast(`“${group.name || 'Group'}” split into progression columns`, 'ok', 1800);
  }

  /** The Arrange menu: pick a scope, then a layout. */
  function toggleArrangeMenu(button) {
    if (arrangeMenuEl) {
      closeArrangeMenu();
      return;
    }
    arrangeButton = button;
    showArrangeScopes(button);
  }

  function arrangeMenuShell(button, children) {
    closeArrangeMenu({ returnFocus: false });
    arrangeButton = button;
    arrangeMenuEl = el('div', { class: 'wb-menu wb-arrange-menu', role: 'menu' }, children);
    document.body.append(arrangeMenuEl);
    const rect = button.getBoundingClientRect();
    arrangeMenuEl.style.left = `${Math.max(8, rect.left)}px`;
    arrangeMenuEl.style.top = `${rect.bottom + 6}px`;
    button.setAttribute('aria-expanded', 'true');
    const dismiss = (event) => {
      if (!arrangeMenuEl?.contains(event.target) && event.target !== button) closeArrangeMenu({ returnFocus: false });
    };
    document.addEventListener('pointerdown', dismiss, true);
    arrangeMenuEl.addEventListener('pointerdown', (event) => event.stopPropagation());
    arrangeMenuEl._dismiss = dismiss;
    arrangeMenuEl._trigger = button;
    document.addEventListener('keydown', arrangeEscape);
    focusMenuStart(arrangeMenuEl);
  }

  function arrangeEscape(event) {
    if (event.key !== 'Escape' || !arrangeMenuEl) return;
    event.stopPropagation();
    closeArrangeMenu({ returnFocus: true });
  }

  function showArrangeScopes(button) {
    const scopes = [
      ['selection', 'Selection'],
      ['group', 'Group'],
      ['component', 'Connected component'],
      ['type', 'One type'],
    ];
    const items = scopes.map(([scope, label]) => {
      const resolved = arrangeScope(scope);
      const ready = resolved && resolved.indexes.length >= 2;
      return el('button', {
        class: 'wb-menu-item', type: 'button', text: ready ? `${label} (${resolved.indexes.length})` : label,
        title: ready ? `Arrange ${resolved.label}` : (scope === 'selection' ? 'Select at least two cards first' : 'Select a card first — Ctrl+click or Shift+drag'),
        disabled: ready ? false : true,
        onclick: () => showArrangeLayouts(button, scope, resolved),
      });
    });
    items.push(el('button', {
      class: 'wb-menu-item', type: 'button', text: 'Whole vein (grid)',
      title: 'The original whole-canvas tidy',
      onclick: () => {
        closeArrangeMenu();
        step(() => {
          arrangeAll();
          view = { x: 0, y: 0, s: 1 };
          savePositions();
          persistView();
          build();
        }, 'Arrange whole vein — Grid');
      },
    }));
    arrangeMenuShell(button, items);
  }

  function showArrangeLayouts(button, scope, resolved) {
    const layouts = [
      ['grid', 'Grid', 'Rows of cards in a near-square block'],
      ['rows', 'Rows', 'One horizontal row'],
      ['columns', 'Columns', 'One vertical column'],
      ['cascade', 'Cascade', 'Each card offset down and right from the last'],
      ['layered', 'Layered', 'Relationship depth as rows, roots on top'],
      ['progression', 'Progression columns', 'Heading-tree tiers as columns, top items on the left, deeper tiers to the right'],
    ];
    const items = [el('span', { class: 'wb-menu-label', text: `Arrange ${resolved.label} (${resolved.indexes.length})` })];
    for (const [layout, label, title] of layouts) {
      items.push(el('button', {
        class: 'wb-menu-item', type: 'button', text: label, title,
        onclick: () => {
          closeArrangeMenu();
          runArrange(scope, layout);
        },
      }));
    }
    items.push(el('button', {
      class: 'wb-menu-item', type: 'button', text: '‹ Back',
      onclick: () => showArrangeScopes(button),
    }));
    arrangeMenuShell(button, items);
  }

  /** Close the Arrange menu; a keyboard dismissal or layout choice hands focus back. */
  function closeArrangeMenu({ returnFocus = 'auto' } = {}) {
    if (!arrangeMenuEl) return;
    const trigger = arrangeButton ?? arrangeMenuEl._trigger ?? null;
    const hadFocus = arrangeMenuEl.contains(document.activeElement);
    if (arrangeMenuEl._dismiss) document.removeEventListener('pointerdown', arrangeMenuEl._dismiss, true);
    document.removeEventListener('keydown', arrangeEscape);
    arrangeMenuEl.remove();
    arrangeMenuEl = null;
    arrangeButton?.setAttribute('aria-expanded', 'false');
    arrangeButton = null;
    if (returnFocus === true || (returnFocus === 'auto' && hadFocus)) focusMenuTrigger(trigger);
  }

  /** The note indexes in the current Ctrl-click selection, in card order. */
  function selectedIndexes() {
    return (model?.notes ?? [])
      .map((note, index) => (selected.has(note.anchor) ? index : -1))
      .filter((index) => index >= 0);
  }

  /** Align or distribute the Ctrl-click selection as one undoable layout. */
  function applySelectionLayout(mode, name) {
    const indexes = selectedIndexes().filter(
      (index) => !isAnchorLocked(model.notes[index].anchor),
    );
    if (indexes.length < 2) {
      if (selectedIndexes().length >= 2) {
        app.toast('Locked cards cannot be aligned or distributed', 'warn', 2200);
      }
      return;
    }
    const rects = indexes.map((index) => ({ key: model.notes[index].anchor, ...rectOf(index) }));
    const next = layoutSelection(rects, mode);
    step(() => {
      for (const index of indexes) {
        const anchor = model.notes[index].anchor;
        const at = next.get(anchor);
        if (!at) continue;
        positions.set(anchor, at);
        const card = cardEls[index];
        if (card) {
          card.style.left = `${at.x}px`;
          card.style.top = `${at.y}px`;
        }
      }
      savePositions();
      sizeCanvas();
      drawEdges();
    }, name);
  }

  /** Stack the selected nodes into a column at the first one's position, and
   * open a coloured box around them. A grouping that covers a whole group
   * nests it instead of dissolving it; partial picks are pulled out of
   * their groups, which dissolve below two members left behind. */
  function groupSelected() {
    const picked = (model?.notes ?? []).filter((note) => selected.has(note.anchor));
    if (picked.length < 2) return;
    step(() => groupPicked(picked), `Group ${picked.length} cards`);
  }

  function groupPicked(picked) {
    if (picked.some((note) => isAnchorLocked(note.anchor))) {
      app.toast('Locked group contents cannot be regrouped', 'warn', 2200);
      return;
    }
    const pickedAnchors = new Set(picked.map((note) => note.anchor));
    const claimed = new Set();
    const whole = [];
    for (const [id, group] of Object.entries(groups)) {
      if (group.members.every((a) => pickedAnchors.has(a))) {
        whole.push(id);
        group.members.forEach((a) => claimed.add(a));
      }
    }
    if (whole.length && whole.length + picked.length - claimed.size < 2) return; // already exactly this group
    const loose = picked.filter((note) => !claimed.has(note.anchor));
    if (whole.length && whole.length + loose.length >= 2) {
      // Nest the covered groups under the new one; loose picks join as the
      // parent's own cards. Nothing is restacked: these cards are already
      // arranged, and the new box is drawn around the arrangement as it is.
      // Loose picks are freed from any partial group they were drawn out of,
      // so no note ends up claimed by two groups.
      const next = {};
      for (const [id, group] of Object.entries(groups)) {
        if (whole.includes(id)) {
          next[id] = group;
          continue;
        }
        const rest = group.members.filter((a) => !pickedAnchors.has(a));
        if (rest.length >= 2 || (group.children ?? []).length) next[id] = { ...group, members: rest };
      }
      const id = `g${Date.now().toString(36)}`;
      next[id] = {
        id,
        color: GROUP_DEFAULT_COLOR,
        name: nextGroupName(),
        members: loose.map((note) => note.anchor),
        children: whole,
      };
      groups = app.saveWorldGroups(currentPath, next) ?? next;
    } else {
      // A flat group of loose cards stacks them into a column from the first
      // pick, so a fresh group reads as one column like a card's field list.
      const origin = positionOf(picked[0].index);
      let stackY = origin.y;
      picked.forEach((note) => {
        positions.set(note.anchor, { x: origin.x, y: stackY });
        stackY += (rectOf(note.index).height || CARD_H) + GAP_Y;
      });
      const next = {};
      for (const [id, group] of Object.entries(groups)) {
        const rest = group.members.filter((a) => !pickedAnchors.has(a));
        if (rest.length >= 2 || (group.children ?? []).length) next[id] = { ...group, members: rest };
      }
      const id = `g${Date.now().toString(36)}`;
      next[id] = { id, color: GROUP_DEFAULT_COLOR, name: nextGroupName(), members: picked.map((note) => note.anchor) };
      groups = app.saveWorldGroups(currentPath, next) ?? next;
    }
    selected = new Set();
    savePositions();
    build();
    app.toast(`Grouped ${picked.length} notes`, 'ok', 1500);
  }

  /** The lowest "Group N" no group is using, so no two groups share a name
   * in the menus that list them by name. */
  function nextGroupName() {
    const taken = new Set(Object.values(groups ?? {}).map((group) => group.name));
    let n = 1;
    while (taken.has(`Group ${n}`)) n += 1;
    return `Group ${n}`;
  }

  /** Rename a group by editing its name in place: Enter/blur commits, Escape leaves it. */
  function inlineGroupRename(span, group) {
    const current = group.name || 'Group';
    const input = el('input', {
      class: 'wb-card-title',
      value: current,
      size: String(Math.max(4, current.length)),
      spellcheck: 'false',
      'aria-label': 'Group name',
    });
    span.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      const value = input.value.trim();
      if (save && value && value !== current) {
        step(() => {
          groups = { ...groups, [group.id]: { ...group, name: value } };
          app.saveWorldGroups(currentPath, groups);
        }, `Rename group to “${value}”`);
      }
      drawEdges();
    };
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') finish(true);
      else if (event.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('pointerdown', (event) => event.stopPropagation());
  }

  async function renameGroup(id) {
    const group = groups[id];
    if (!group) return;
    const name = await askText({
      title: 'Rename group',
      label: 'Name',
      value: group.name || 'Group',
      confirmLabel: 'Rename',
    });
    const trimmed = String(name ?? '').trim();
    if (name === null || !trimmed) return;
    step(() => {
      groups = { ...groups, [id]: { ...group, name: trimmed } };
      app.saveWorldGroups(currentPath, groups);
      drawEdges();
    }, `Rename group to “${trimmed}”`);
  }

  /**
   * The first control a menu offers, so opening it by keyboard or click puts
   * focus inside. A menu with no control takes focus itself rather than
   * leaving it on the page behind.
   */
  function focusMenuStart(menu) {
    if (!menu) return;
    const first = menu.querySelector('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])');
    if (first) {
      first.focus();
      return;
    }
    menu.tabIndex = -1;
    menu.focus();
  }

  /** Hand focus back to the control that opened a menu, if it still exists. */
  function focusMenuTrigger(trigger) {
    if (trigger?.isConnected) trigger.focus();
  }

  /**
   * Close the shared dropdown. `returnFocus: 'auto'` hands focus back to the
   * toggle when the keyboard (or a menu choice) was in the menu, while an
   * outside press leaves focus to whatever the pointer lands on.
   */
  function closeMenu({ returnFocus = 'auto' } = {}) {
    if (!menuEl) return;
    const trigger = menuEl._trigger ?? null;
    const hadFocus = menuEl.contains(document.activeElement);
    closeSubmenu();
    menuEl.remove();
    menuEl = null;
    // A toggle may have been rebuilt since it opened; clear every one.
    document.querySelectorAll('[data-legend-toggle], [data-export-toggle], [data-help-toggle], [data-history-toggle], [data-health-toggle]')
      .forEach((button) => button.setAttribute('aria-expanded', 'false'));
    document.removeEventListener('pointerdown', dismissMenu, true);
    document.removeEventListener('keydown', escapeMenu);
    if (returnFocus === true || (returnFocus === 'auto' && hadFocus)) focusMenuTrigger(trigger);
  }

  function closeSubmenu() {
    if (!submenuEl) return;
    const trigger = submenuEl._trigger;
    trigger?.setAttribute('aria-expanded', 'false');
    submenuEl.remove();
    submenuEl = null;
  }

  function positionSubmenu(trigger, panel) {
    const rect = trigger.getBoundingClientRect();
    const width = panel.offsetWidth;
    const height = panel.offsetHeight;
    const left = rect.right + width + 8 <= window.innerWidth
      ? rect.right + 4
      : rect.left - width - 4;
    panel.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, left))}px`;
    panel.style.top = `${Math.max(8, Math.min(window.innerHeight - height - 8, rect.top))}px`;
  }

  function openSubmenu(trigger, label, children) {
    if (submenuEl?._trigger === trigger) {
      closeSubmenu();
      return;
    }
    closeSubmenu();
    const panel = el('div', {
      class: 'wb-menu wb-submenu-panel',
      role: 'menu',
      'aria-label': label,
    }, children);
    panel._trigger = trigger;
    document.body.append(panel);
    submenuEl = panel;
    trigger.setAttribute('aria-expanded', 'true');
    positionSubmenu(trigger, panel);
    focusMenuStart(panel);
  }

  function submenuItem(label, children, value = '') {
    const button = el('button', {
      class: 'wb-menu-item wb-submenu-trigger',
      type: 'button',
      'aria-haspopup': 'menu',
      'aria-expanded': 'false',
      title: value ? `${label}: ${value}` : label,
      'aria-label': value ? `${label}: ${value}` : label,
      onclick: () => openSubmenu(button, label, children),
      onkeydown: (event) => {
        if (event.key === 'ArrowRight') {
          event.preventDefault();
          if (submenuEl?._trigger !== button) openSubmenu(button, label, children);
        } else if (event.key === 'ArrowLeft' && submenuEl?._trigger === button) {
          event.preventDefault();
          closeSubmenu();
        }
      },
    }, [
      el('span', { class: 'wb-submenu-label', text: label }),
      value ? el('span', { class: 'wb-submenu-value', text: value }) : null,
      el('span', { class: 'wb-submenu-arrow', 'aria-hidden': 'true', text: '›' }),
    ]);
    return button;
  }

  /** Show a right-click menu at the cursor and keep it until dismissed. */
  function showMenu(event, items) {
    menuEl = el('div', { class: 'wb-menu', role: 'menu' }, items);
    document.body.append(menuEl);
    menuEl.style.left = `${Math.min(event.clientX, window.innerWidth - menuEl.offsetWidth - 8)}px`;
    menuEl.style.top = `${Math.min(event.clientY, window.innerHeight - menuEl.offsetHeight - 8)}px`;
    document.addEventListener('pointerdown', dismissMenu, true);
    document.addEventListener('keydown', escapeMenu);
  }

  // Outside the menu, the next pointer-down — or Escape — dismisses it.
  // Clicks *inside* the menu must reach their buttons, so the closer
  // ignores them rather than closing on the first press.
  function dismissMenu(event) {
    if (event.target.closest?.('.wb-menu')) return;
    // The dropdown buttons toggle, so their press must reach the handler;
    // dismissing here would close and reopen the menu at once.
    if (event.target.closest?.('[data-legend-toggle], [data-export-toggle], [data-help-toggle], [data-history-toggle], [data-health-toggle]')) return;
    // The pointer, not the menu, decides where focus goes next.
    closeMenu({ returnFocus: false });
  }

  function escapeMenu(event) {
    if (event.key !== 'Escape') return;
    if (submenuEl) {
      const trigger = submenuEl._trigger;
      closeSubmenu();
      trigger?.focus();
    } else {
      closeMenu({ returnFocus: true });
    }
  }

  /** A small drawn sample of one line style, so the legend shows the wire. */
  function legendSample(cls) {
    const svg = svgNode('svg', { width: 44, height: 12, viewBox: '0 0 44 12', 'aria-hidden': 'true' });
    svg.append(svgNode('path', { class: cls, d: 'M1 6 H43', fill: 'none' }));
    return svg;
  }

  /** One legend entry: a drawn wire or a glyph, then what it means. */
  function legendRow(mark, title, blurb) {
    return el('div', { class: 'wb-legend-row' }, [
      typeof mark === 'string' ? el('span', { class: 'wb-legend-glyph', text: mark }) : mark,
      el('span', { class: 'wb-legend-text' }, [el('strong', { text: title }), ` — ${blurb}`]),
    ]);
  }

  /** What each wire, its colour and the cards' icons stand for. */
  function legendRows() {
    return [
      el('div', { class: 'wb-menu-label', text: 'Lines' }),
      legendRow(legendSample('wb-edge wb-edge-contains'), 'Dotted', 'the vein’s outline: each card nested under its nearest shallower heading.'),
      legendRow(legendSample('wb-edge wb-edge-section'), 'Solid', 'a link in the prose — [[#Heading]] — between two notes.'),
      legendRow(legendSample('wb-edge wb-edge-mention'), 'Green and faint', 'a mention, [[Another note]], reaching across the vault.'),
      legendRow(legendSample('wb-edge wb-edge-section wb-rel-affects'), 'A word on the line', 'is its relationship: associate, member of, template, parent, child, contains, controls, affects, and on to ally and foe — thickening as it strengthens. Click the word to step it.'),
      legendRow(legendSample('wb-edge wb-edge-bond wb-rel-ally'), 'No prose link', 'a bond stated on the canvas itself, and drawn like any other bond of its kind.'),
      legendRow(legendSample('wb-edge wb-edge-group wb-rel-ally'), 'To a group', 'drawn at twice the weight of a note bond of the same kind, and coloured as it is.'),
      el('div', { class: 'wb-menu-label', text: 'Colour' }),
      legendRow(legendSample('wb-edge wb-rel-ally'), 'Green', 'ally, and mentions; red is a foe. Every other kind rides on the accent.'),
      el('div', { class: 'wb-menu-label', text: 'Icons' }),
      legendRow('⠿', 'The grip', 'drag it to move the card, or a group’s tab to move the whole group.'),
      legendRow('▾', 'Fold', 'collapse a card to its header.'),
      legendRow('✕', 'Delete', 'click once to arm, again to delete the note.'),
      legendRow('⌂', 'A type', 'a coloured icon — Place, Person, Thing, Scene, Stat, Skill, and more — chosen from the drop-down on the card.'),
      legendRow('⁂', 'A group icon', '⁂ until one is picked; then whatever the group’s menu set, in the group’s colour.'),
    ];
  }

  /** One toolbar dropdown: open its rows below `button`, or close it. It opens
   * below, scrolling in the room left, and closes on an outside press or Escape. */
  function toggleDropdown(button, name, label, rows) {
    const open = button.getAttribute('aria-expanded') === 'true';
    closeMenu();
    if (open) {
      button.setAttribute('aria-expanded', 'false');
      return;
    }
    button.setAttribute('aria-expanded', 'true');
    menuEl = el('div', { class: `wb-menu ${name}`, role: 'dialog', 'aria-label': label }, rows);
    menuEl._trigger = button;
    document.body.append(menuEl);
    const rect = button.getBoundingClientRect();
    menuEl.style.maxHeight = `${Math.max(0, window.innerHeight - rect.bottom - 14)}px`;
    menuEl.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - menuEl.offsetWidth - 8))}px`;
    menuEl.style.top = `${rect.bottom + 6}px`;
    document.addEventListener('pointerdown', dismissMenu, true);
    document.addEventListener('keydown', escapeMenu);
    focusMenuStart(menuEl);
  }

  /** The legend as a drop-down below the toolbar; it toggles from its button. */
  function toggleLegend(button) {
    toggleDropdown(button, 'wb-legend', 'Worldbuilding legend', legendRows());
  }

  /** The gestures the canvas runs on, one cheatsheet row each. */
  function helpRows() {
    return [
      el('div', { class: 'wb-menu-label', text: 'Selecting' }),
      legendRow('Click', 'A card', 'selects it; Ctrl+click toggles it in and out of the selection, and the set drags as a unit.'),
      legendRow('Shift+drag', 'The background', 'box-selects every card it touches. The Select ▾ menu offers quick picks — connected, ancestors, descendants, same type or colour, group members.'),
      el('div', { class: 'wb-menu-label', text: 'Grouping' }),
      legendRow('Right-click', 'A card', 'opens its menu: link it to another card or group, add a linked note, relate it, and set its colour, image, mode, pin or lock. On a selection it also groups or bonds it. Right-click a group to rename, fold, lock or split it.'),
      legendRow('2× click', 'A group’s tab', 'renames the group in place.'),
      el('div', { class: 'wb-menu-label', text: 'Connectors' }),
      legendRow('Click', 'The word on a line', 'steps its relationship to the next kind — associate, member of, template, parent, child, contains, controls, affects, ally, foe.'),
      legendRow('◇', 'A cut-off wire', 'a wire longer than a screen ends in a diamond; click it to reveal the far card if it is inside a collapsed group, then centre the view on it. Otherwise the view centres on the card directly. Trim on the toolbar switches this on.'),
      el('div', { class: 'wb-menu-label', text: 'Fold' }),
      legendRow('▾', 'A card’s Fold chevron', 'collapses the card to its header. Overview folds every card, then zooms to fit.'),
      el('div', { class: 'wb-menu-label', text: 'History' }),
      legendRow('↶ ↷', 'Undo and redo', 'one canvas step, named in the tooltip; Ctrl+Z and Ctrl+Shift+Z (or Ctrl+Y) work too, History lists every step to jump between them, each vein keeps its own stack, and typing in a card’s text boxes keeps the field’s own undo.'),
    ];
  }

  /** The gesture cheatsheet, on the legend's terms. */
  function toggleHelp(button) {
    toggleDropdown(button, 'wb-help', 'Canvas gestures', helpRows());
  }

  /* --------------------------------------------------------------- export -- */

  function toggleExportMenu(button) {
    toggleDropdown(button, 'wb-export', 'Export canvas', [
      el('div', { class: 'wb-menu-label', text: 'Export this canvas' }),
      el('button', {
        class: 'wb-menu-item', type: 'button', text: 'SVG — vector file',
        title: 'Download a standalone .svg of every card, wire, group and annotation',
        onclick: () => { closeMenu(); exportCanvasSvg(); },
      }),
      el('button', {
        class: 'wb-menu-item', type: 'button', text: 'SVG — Inkscape layers',
        title: 'Download a layered .svg that opens in Inkscape with Groups, Connectors, Cards and Annotations as separate editable layers',
        onclick: () => { closeMenu(); exportCanvasSvg({ inkscape: true }); },
      }),
      el('button', {
        class: 'wb-menu-item', type: 'button', text: 'PNG — image file',
        title: 'Download a PNG of the whole canvas at twice its size',
        onclick: () => { closeMenu(); void exportCanvasPng(); },
      }),
      el('button', {
        class: 'wb-menu-item', type: 'button', text: 'Mermaid — markdown file',
        title: 'Download a .md file holding the graph as a Mermaid flowchart',
        onclick: () => { closeMenu(); exportCanvasMermaid(); },
      }),
    ]);
  }

  /** The colours and fonts the canvas is wearing right now. */
  function exportTheme() {
    const styles = getComputedStyle(document.documentElement);
    const read = (name, fallback) => styles.getPropertyValue(name).trim() || fallback;
    return {
      bg: read('--bg', '#0d1117'),
      raised: read('--bg-raised', '#131a22'),
      border: read('--border-strong', '#2f4257'),
      text: read('--text', '#e6edf3'),
      textDim: read('--text-dim', '#9fb0c0'),
      textFaint: read('--text-faint', '#6f8296'),
      accent: read('--accent', '#58a6ff'),
      ok: read('--ok', '#56d364'),
      error: read('--error', '#ff6b6b'),
      sans: read('--sans', 'system-ui, sans-serif'),
    };
  }

  /**
   * The canvas as a plain scene: live card boxes, group frames, connector
   * paths and annotations, with the theme they are drawn in. Both exports read
   * this, so the file matches the screen instead of a second renderer.
   */
  function exportScene() {
    const theme = exportTheme();
    const notes = model?.notes ?? [];
    const cards = notes.map((note, index) => {
      const type = nodeTypeOf(nodeTypes, note.anchor);
      const links = note.links?.length ?? 0;
      const words = countWords(note.title) + countWords(note.body);
      return {
        anchor: note.anchor,
        title: note.title || note.anchor,
        typeLabel: type.label,
        typeIcon: type.icon,
        color: nodeColors[note.anchor] ?? type.color,
        mode: cardModeOf(note.anchor),
        folded: isFolded(note.anchor),
        meta: `${links} link${links === 1 ? '' : 's'} · ${words} words`,
        fields: nodeFields(type.id)
          .map((field) => ({ label: field.label, value: nodeFieldOf(fieldValues, note.anchor, field.id) }))
          .filter((field) => field.value),
        body: note.body,
        hidden: isGroupHidden(note.anchor),
        groupId: groupOf(note.anchor)?.id ?? null,
        ...rectOf(index),
      };
    });

    const groupsForExport = Object.values(groups ?? {}).map((group) => {
      const hidden = hasCollapsedAncestor(group.id);
      const summary = Boolean(collapsedGroups[group.id]) && !hidden;
      const members = [...effectiveMembers(group)];
      const links = members.reduce(
        (sum, anchor) => sum + (notes.find((note) => note.anchor === anchor)?.links?.length ?? 0),
        0,
      );
      let rect = null;
      if (summary) rect = summaryRect(group);
      else {
        const box = groupBox(group);
        if (box) {
          const pad = 12;
          const topPad = group.layout === 'progression' ? 30 : pad;
          rect = { x: box.x - pad, y: box.y - topPad, width: box.width + pad * 2, height: box.height + topPad + pad };
        }
      }
      return {
        id: group.id,
        name: group.name || 'Group',
        icon: group.icon,
        color: group.color,
        children: group.children ?? [],
        locked: isGroupLocked(group),
        hidden,
        summary,
        meta: `${members.length} card${members.length === 1 ? '' : 's'} · ${links} link${links === 1 ? '' : 's'}`,
        ...(rect ?? { x: 0, y: 0, width: 0, height: 0 }),
      };
    });

    const connectors = [];
    if (model) {
      const list = connectorList(model, groups, relations);
      // Fan several bonds at one end into lanes, exactly as the canvas does.
      const bonds = new Map();
      for (const edge of list) {
        bonds.set(edge.from, (bonds.get(edge.from) ?? 0) + 1);
        bonds.set(edge.to, (bonds.get(edge.to) ?? 0) + 1);
      }
      const lanes = new Map();
      const laneRect = (rect, endpoint) => {
        const total = bonds.get(endpoint) ?? 1;
        const taken = lanes.get(endpoint) ?? 0;
        lanes.set(endpoint, taken + 1);
        const shift = (taken - (total - 1) / 2) * LANE_PITCH;
        return shift ? { ...rect, y: rect.y + shift } : rect;
      };
      // The same spread pass the canvas uses: an export must not stack two
      // different relationships on one line either.
      const prepared = [];
      for (const edge of list) {
        const from = endpointRect(edge.from);
        const to = endpointRect(edge.to);
        if (!from || !to) continue;
        const key = connectorKey(edge);
        const eff = effectiveRouting(routing, key);
        const stacked = edge.kind !== 'contains' && isStackedPair(edge.from, edge.to);
        prepared.push({
          edge,
          eff,
          stacked,
          from: stacked ? from : laneRect(from, edge.from),
          to: stacked ? to : laneRect(to, edge.to),
          vertical: stacked,
          elbow: eff.elbow,
        });
      }
      for (const { edge, eff, stacked, path, at, head, headDir } of spreadConnectorCurves(prepared)) {
        const relation = edge.relation ? relationKind(edge.relation) : null;
        let color = theme.accent;
        let width = relation ? 1.6 + relation.rank * 0.22 : 1.6;
        let opacity = 0.55;
        let dashed = false;
        if (edge.kind === 'contains') {
          color = theme.textFaint;
          width = 1.2;
          dashed = true;
        } else if (edge.kind === 'mention') {
          color = theme.ok;
          opacity = 0.42;
        } else if (relation?.id === 'ally') color = theme.ok;
        else if (relation?.id === 'foe') color = theme.error;
        if (edge.kind === 'bond') opacity = 0.62;
        if (edge.kind === 'group') { width *= 2; opacity = 0.62; }
        const showLabel = relation && relation.id !== DEFAULT_RELATION && !stacked;
        connectors.push({
          from: edge.from,
          to: edge.to,
          kind: edge.kind,
          label: showLabel ? relation.label.toLowerCase() : '',
          labelAt: at(0.5),
          color,
          width,
          opacity,
          dashed,
          arrow: eff.arrows ? { x: head.x, y: head.y, angle: (Math.atan2(headDir.y, headDir.x) * 180) / Math.PI } : null,
          d: path,
        });
      }
    }

    const annotationsForExport = Object.values(annotations).map((annotation) => ({
      x: annotation.x,
      y: annotation.y,
      width: ANNOTATION_W,
      height: ANNOTATION_H,
      text: annotation.text,
    }));

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const include = (rect) => {
      if (!rect || !rect.width || !rect.height) return;
      minX = Math.min(minX, rect.x);
      minY = Math.min(minY, rect.y);
      maxX = Math.max(maxX, rect.x + rect.width);
      maxY = Math.max(maxY, rect.y + rect.height);
    };
    cards.filter((card) => !card.hidden).forEach(include);
    // A group frame's tab straddles its top edge.
    groupsForExport.filter((group) => !group.hidden).forEach((group) => include({
      ...group,
      y: group.y - 12,
      height: group.height + 12,
    }));
    annotationsForExport.forEach(include);
    const padding = 28;
    const bounds = Number.isFinite(minX)
      ? { x: minX - padding, y: minY - padding, width: maxX - minX + padding * 2, height: maxY - minY + padding * 2 }
      : { x: 0, y: 0, width: 800, height: 600 };

    return {
      title: `${String(currentPath ?? 'Vein').split('/').pop().replace(/\.md$/i, '')} — Worldbuilding canvas`,
      bounds,
      theme,
      cards,
      groups: groupsForExport,
      connectors,
      annotations: annotationsForExport,
    };
  }

  function downloadFile(blob, name) {
    const url = URL.createObjectURL(blob);
    const link = el('a', { href: url, download: name });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  function exportCanvasSvg({ inkscape = false } = {}) {
    if (!model) return;
    const scene = exportScene();
    const name = `${canvasExportName(currentPath, inkscape ? 'inkscape' : 'canvas')}.svg`;
    downloadFile(new Blob([buildCanvasSvg(scene, { inkscape })], { type: 'image/svg+xml' }), name);
    app.toast(inkscape ? 'Canvas exported as an Inkscape SVG' : 'Canvas exported as SVG', 'ok', 1600);
  }

  async function exportCanvasPng() {
    if (!model) return;
    const scene = exportScene();
    const url = URL.createObjectURL(new Blob([buildCanvasSvg(scene)], { type: 'image/svg+xml' }));
    try {
      const image = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('the SVG could not be drawn'));
        img.src = url;
      });
      const scale = Math.min(2, 8192 / Math.max(scene.bounds.width, scene.bounds.height));
      const target = document.createElement('canvas');
      target.width = Math.max(1, Math.round(scene.bounds.width * scale));
      target.height = Math.max(1, Math.round(scene.bounds.height * scale));
      target.getContext('2d').drawImage(image, 0, 0, target.width, target.height);
      const blob = await new Promise((resolve) => target.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('the PNG encoder returned nothing');
      downloadFile(blob, `${canvasExportName(currentPath)}.png`);
      app.toast('Canvas exported as PNG', 'ok', 1600);
    } catch (error) {
      app.toast(`Could not export PNG: ${error.message}`, 'warn', 2600);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function exportCanvasMermaid() {
    if (!model) return;
    const scene = exportScene();
    const markdown = `# ${scene.title}\n\n\`\`\`mermaid\n${buildCanvasMermaid(scene)}\`\`\`\n`;
    downloadFile(new Blob([markdown], { type: 'text/markdown' }), `${canvasExportName(currentPath, 'graph')}.md`);
    app.toast('Canvas exported as Mermaid markdown', 'ok', 1600);
  }
  /** One history entry, as a jump target. */
  function historyRow(entry, kind, glyph, steps) {
    return el('button', {
      class: 'wb-history-row',
      type: 'button',
      text: `${glyph} ${entry.name}`,
      title: `${kind === 'undo' ? 'Undo' : 'Redo'} ${steps} step${steps === 1 ? '' : 's'}: ${entry.name}`,
      onclick: () => jumpHistory(kind, steps - 1),
    });
  }

  /** Every step of this vein's canvas history, nearest to now first. */
  function historyRows() {
    const stack = historyFor(currentPath);
    const rows = [];
    if (stack.future.length) {
      rows.push(el('span', { class: 'wb-menu-label', text: 'Redo' }));
      [...stack.future].reverse().forEach((entry, i) => rows.push(historyRow(entry, 'redo', '↷', i + 1)));
    }
    rows.push(el('span', { class: 'wb-history-now', text: '⦿ now' }));
    if (stack.past.length) {
      rows.push(el('span', { class: 'wb-menu-label', text: 'Undo' }));
      [...stack.past].reverse().forEach((entry, i) => rows.push(historyRow(entry, 'undo', '↶', i + 1)));
    }
    if (!stack.future.length && !stack.past.length) {
      rows.push(el('span', { class: 'wb-history-empty', text: 'Nothing to undo on this canvas yet.' }));
    }
    return rows;
  }

  /** The history browser as a drop-down below the toolbar, on the menu's
   * own terms: dismissed by an outside press or Escape, and it toggles from
   * its button. Picking an entry undoes or redoes all the way to it. */
  function toggleHistory(button) {
    toggleDropdown(button, 'wb-history', 'Canvas history', historyRows());
  }

  /** The health panel as a drop-down below the toolbar, on the menu's own
   * terms: orphans centre on click, thin groups fit on click. */
  function toggleHealth(button) {
    const health = canvasHealth(model ?? {}, { relations, groups });
    const notes = model?.notes ?? [];
    const indexOf = (anchor) => notes.findIndex((note) => note.anchor === anchor);
    const rows = [
      el('span', {
        class: 'wb-menu-label',
        text: `${health.notes} notes · ${health.edges} connections · ${health.groups} groups`,
      }),
    ];
    if (health.orphans.length) {
      rows.push(el('span', { class: 'wb-menu-label', text: `Orphans (${health.orphans.length})` }));
      for (const orphan of health.orphans) {
        rows.push(el('button', {
          class: 'wb-menu-item',
          type: 'button',
          text: `◎ ${orphan.title}`,
          title: 'Nothing connects to this card — jump to it',
          onclick: () => {
            closeMenu();
            const index = indexOf(orphan.anchor);
            if (index >= 0) centreOn(index);
          },
        }));
      }
    }
    if (health.thinGroups.length) {
      rows.push(el('span', { class: 'wb-menu-label', text: `Thin groups (${health.thinGroups.length})` }));
      for (const thin of health.thinGroups) {
        rows.push(el('button', {
          class: 'wb-menu-item',
          type: 'button',
          text: `⁂ ${thin.name}`,
          title: 'Fewer than two cards — jump to it',
          onclick: () => {
            closeMenu();
            const group = groups[thin.id];
            if (!group) return;
            const indexes = [...effectiveMembers(group)]
              .map((anchor) => indexOf(anchor))
              .filter((index) => index >= 0);
            const fitted = fitView(contentBounds(indexes), stage.clientWidth, stage.clientHeight);
            if (fitted) {
              view = fitted;
              persistView();
              applyView();
            }
          },
        }));
      }
    }
    if (!health.orphans.length && !health.thinGroups.length) {
      rows.push(el('span', {
        class: 'wb-history-empty',
        text: 'Every card connects to something, and every group holds at least two cards.',
      }));
    }
    toggleDropdown(button, 'wb-health', 'Canvas health', rows);
  }

  function setGroupColor(id, color) {
    step(() => {
      groups = { ...groups, [id]: { ...groups[id], color } };
      app.saveWorldGroups(currentPath, groups);
      drawEdges();
    }, `Set colour on “${groups[id]?.name || 'group'}”`);
    closeMenu();
  }

  function setGroupIcon(id, icon) {
    step(() => {
      groups = { ...groups, [id]: { ...groups[id], icon } };
      app.saveWorldGroups(currentPath, groups);
      drawEdges();
    }, `Set group icon for “${groups[id]?.name || 'group'}”`);
    closeMenu();
  }

  /**
   * Repaint a card's chip and type text now that its explicit colour
   * changed — the rest of the card (type, fields) stands as it was set.
   */
  function repaintNodeColor(anchor) {
    const index = model?.notes.findIndex((note) => note.anchor === anchor) ?? -1;
    const card = cardEls[index];
    if (!card) return;
    const color = nodeColors[anchor] ?? nodeTypeOf(nodeTypes, anchor).color ?? '';
    card.querySelector('.wb-level')?.style.setProperty('color', color);
    const select = card.querySelector('.wb-type');
    if (select) select.style.color = color;
  }

  /** Set (or, with null, forget) one node's explicit colour: one undoable
   * canvas step, like a type or field change — the colour rides the
   * snapshot, so undo puts the old colour (or none) back. */
  function setNodeColor(anchor, color) {
    const name = color
      ? `Set colour on “${noteTitle(anchor)}”`
      : `Use type colour on “${noteTitle(anchor)}”`;
    step(() => {
      nodeColors = app.setWorldNodeColor(currentPath, anchor, color) ?? nodeColors;
      repaintNodeColor(anchor);
    }, name);
    closeMenu();
  }

  /**
   * The lossy codec node images are stored with: WebP where the browser
   * can encode it (usually the smallest file), JPEG otherwise. Probed
   * once — a browser that cannot encode the requested type quietly
   * hands back PNG instead.
   */
  let nodeImageEncodeType = null;
  function preferredNodeImageType() {
    if (nodeImageEncodeType) return nodeImageEncodeType;
    try {
      const probe = document.createElement('canvas').toDataURL('image/webp');
      nodeImageEncodeType = probe.startsWith('data:image/webp') ? 'image/webp' : 'image/jpeg';
    } catch {
      nodeImageEncodeType = 'image/jpeg';
    }
    return nodeImageEncodeType;
  }

  /**
   * Read an image file down to a small, compressed data URL for storage
   * as a vault file. The icon shows at 44px, so 320px on the longest
   * side is retina-sharp with room to spare. The image is always
   * re-encoded through a canvas — never stored as picked — so a large
   * PNG photograph becomes a small WebP/JPEG and camera metadata is
   * stripped. This only ever applies to node-graph icons; images a
   * writer embeds in markdown prose are their own files and are left
   * exactly as they are. Animated images keep their first frame.
   */
  async function readImageFile(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((resolve) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => resolve(null);
        image.src = url;
      });
      if (!img || !img.naturalWidth || !img.naturalHeight) return null;
      const [width, height] = nodeImageSize(img.naturalWidth, img.naturalHeight, NODE_IMAGE_MAX_SIDE);
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      const type = preferredNodeImageType();
      let dataUrl = canvas.toDataURL(type, NODE_IMAGE_QUALITY);
      if (!dataUrl.startsWith(`data:${type};`)) dataUrl = canvas.toDataURL('image/png');
      return typeof dataUrl === 'string' && dataUrl.startsWith('data:image/') ? dataUrl : null;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /** A unique file name for one node's image, from its anchor and format. */
  function nodeImageFileName(anchor, dataUrl) {
    const mime = /^data:image\/([a-z0-9.+-]+);/i.exec(dataUrl)?.[1] ?? 'png';
    const ext = mime === 'jpeg' ? 'jpg' : mime.replace(/[^a-z0-9]/gi, '') || 'png';
    const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    return `${String(anchor || 'node').replace(/[^a-z0-9]+/gi, '-').slice(0, 40) || 'node'}-${stamp}.${ext}`;
  }

  /** Pick an image file for a node, from the right-click menu. */
  function pickNodeImage(anchor) {
    closeMenu();
    const input = el('input', { type: 'file', accept: 'image/*' });
    input.style.display = 'none';
    document.body.append(input);
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) return;
      if (!file.type.startsWith('image/')) {
        app.toast('That is not an image file', 'warn', 1800);
        return;
      }
      const dataUrl = await readImageFile(file);
      if (!dataUrl) {
        app.toast('Could not read that image', 'warn', 1800);
        return;
      }
      const fileName = nodeImageFileName(anchor, dataUrl);
      try {
        await app.writeNodeImageFile(`node-images/${fileName}`, dataUrl);
      } catch (error) {
        app.toast(`Could not save that image: ${error.message}`, 'warn', 2200);
        return;
      }
      setNodeImage(anchor, nodeImageRef(fileName));
    });
    input.click();
  }

  /** Embed (or, with null, forget) one node's image: one undoable canvas
   * step, drawn as the node's medium-sized icon in its head. */
  function setNodeImage(anchor, ref) {
    const name = ref
      ? `Set image on “${noteTitle(anchor)}”`
      : `Remove image from “${noteTitle(anchor)}”`;
    if (ref) seenNodeImageRefs.add(ref);
    if (nodeImages[anchor]) seenNodeImageRefs.add(nodeImages[anchor]);
    step(() => {
      nodeImages = app.setWorldNodeImage(currentPath, anchor, ref) ?? nodeImages;
      // The head gains or loses an element, so the card rebuilds whole —
      // its height (and every wire) follows.
      build();
    }, name);
    closeMenu();
  }

  /** Read any file as a data URL, for storage beside node images. */
  function readFileDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
      reader.onerror = () => reject(reader.error ?? new Error('the file could not be read'));
      reader.readAsDataURL(file);
    });
  }

  /** A unique name for one attached file, keeping the original extension. */
  function attachmentFileName(anchor, original) {
    const ext = (/\.[A-Za-z0-9]{1,12}$/.exec(String(original ?? ''))?.[0] ?? '').toLowerCase().replace(/[^a-z0-9.]/g, '');
    const base = String(anchor || 'node').replace(/[^a-z0-9]+/gi, '-').slice(0, 40) || 'node';
    const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    return `${base}-${stamp}${ext}`;
  }

  /** Record one node's resources as one undoable canvas step. */
  function setNodeResourcesEntry(anchor, entry, name) {
    step(() => {
      nodeResources = app.setWorldNodeResources(currentPath, anchor, entry) ?? nodeResources;
      // The strip is part of the card's content: a rebuild carries its height
      // and every connector with it.
      build();
    }, name);
  }

  /** Pick a file for a node: copy it into the vault and attach the reference. */
  function attachFileToNode(anchor) {
    closeMenu();
    const current = nodeResources[anchor] ?? {};
    if ((current.files ?? []).length >= NODE_RESOURCE_LIMIT) {
      app.toast(`A node can hold ${NODE_RESOURCE_LIMIT} attachments`, 'warn', 2000);
      return;
    }
    const input = el('input', { type: 'file' });
    input.style.display = 'none';
    document.body.append(input);
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) return;
      if (file.size > NODE_FILE_MAX_BYTES) {
        app.toast(`“${file.name}” is larger than ${formatBytes(NODE_FILE_MAX_BYTES)}`, 'warn', 2600);
        return;
      }
      let dataUrl;
      try {
        dataUrl = await readFileDataUrl(file);
      } catch (error) {
        app.toast(`Could not read “${file.name}”: ${error.message}`, 'warn', 2400);
        return;
      }
      if (!dataUrl) {
        app.toast(`Could not read “${file.name}”`, 'warn', 2000);
        return;
      }
      const fileName = attachmentFileName(anchor, file.name);
      try {
        await app.writeNodeAttachmentFile(`node-files/${fileName}`, dataUrl);
      } catch (error) {
        app.toast(`Could not store “${file.name}”: ${error.message}`, 'warn', 2600);
        return;
      }
      const ref = nodeFileRef(fileName);
      seenAttachmentRefs.add(ref);
      const latest = nodeResources[anchor] ?? {};
      setNodeResourcesEntry(anchor, {
        files: [...(latest.files ?? []), { name: file.name, ref, size: file.size, type: file.type }],
        urls: latest.urls ?? [],
      }, `Attach “${file.name}” to “${noteTitle(anchor)}”`);
      app.toast(`Attached “${file.name}”`, 'ok', 1600);
    });
    input.click();
  }

  /** Ask for a web address and attach it to the node, opening externally. */
  async function addNodeUrl(anchor) {
    closeMenu();
    const current = nodeResources[anchor] ?? {};
    if ((current.urls ?? []).length >= NODE_RESOURCE_LIMIT) {
      app.toast(`A node can hold ${NODE_RESOURCE_LIMIT} URLs`, 'warn', 2000);
      return;
    }
    const raw = await askText({
      title: 'Attach a web URL',
      label: 'URL',
      hint: 'An http:// or https:// address — it opens in your browser.',
      confirmLabel: 'Attach',
    });
    if (!raw) return;
    const url = normalizeWebUrl(raw);
    if (!url) {
      app.toast('Only http:// and https:// web addresses can be attached', 'warn', 2400);
      return;
    }
    if ((current.urls ?? []).some((link) => link.url === url)) {
      app.toast('That URL is already attached', 'warn', 2000);
      return;
    }
    let label = url;
    try {
      label = new URL(url).hostname.replace(/^www\./i, '') || url;
    } catch {
      // normalizeWebUrl already parsed it; the fallback is the URL itself.
    }
    const latest = nodeResources[anchor] ?? {};
    setNodeResourcesEntry(anchor, {
      files: latest.files ?? [],
      urls: [...(latest.urls ?? []), { label: label.slice(0, 120), url }],
    }, `Attach a URL to “${noteTitle(anchor)}”`);
    app.toast(`Attached ${label}`, 'ok', 1600);
  }

  /** Remove one attachment or URL from a node, sweeping the file when free. */
  function removeNodeResource(anchor, kind, key) {
    const entry = nodeResources[anchor] ?? {};
    const files = (entry.files ?? []).filter((file) => file.ref !== key);
    const urls = (entry.urls ?? []).filter((link) => link.url !== key);
    if (kind === 'files') seenAttachmentRefs.add(key);
    setNodeResourcesEntry(anchor, { files, urls }, kind === 'files'
      ? `Remove attachment from “${noteTitle(anchor)}”`
      : `Remove URL from “${noteTitle(anchor)}”`);
    if (kind === 'files') void cleanupOrphanedAttachments().catch(() => {});
  }

  /**
   * Ungroup: a nested group detaches into the world on its own; a top-level
   * group dissolves back into its cards, orphaning any children it had.
   */
  function ungroup(id) {
    if (isGroupLocked(groups[id])) {
      app.toast(`“${groups[id]?.name || 'Group'}” is locked — unlock it before ungrouping`, 'warn', 2200);
      closeMenu();
      return;
    }
    step(() => ungroupNow(id), `Ungroup “${groups[id]?.name || 'group'}”`);
    closeMenu();
  }

  /** Lock a group's contents, or unlock them again. The lock itself is a
   * canvas change: one undo restores the earlier state. */
  function toggleGroupLock(id) {
    const group = groups[id];
    if (!group) return;
    const nextLocked = !group.locked;
    const parent = restrictingParentGroup(id, 'locked');
    step(() => {
      const next = { ...groups, [id]: { ...group, locked: nextLocked } };
      groups = app.saveWorldGroups(currentPath, next) ?? next;
      build();
    }, nextLocked ? `Lock “${group.name || 'group'}”` : `Unlock “${group.name || 'group'}”`);
    closeMenu();
    if (parent) {
      app.toast(
        nextLocked
          ? `“${group.name || 'Group'}” is already read-only inside locked group “${parent.name || 'Group'}” — locked on its own too`
          : `“${group.name || 'Group'}” is still read-only — locked group “${parent.name || 'Group'}” holds it`,
        'info',
        2600,
      );
    }
  }

  /**
   * Lock one note's content read-only, or unlock it again. The lock blocks
   * content changes only: the card can still be moved when not pinned, and
   * links in and out still work.
   */
  function toggleNodeLock(anchor) {
    const nextLocked = !nodeLocked[anchor];
    const group = lockedGroupOf(anchor);
    step(() => {
      nodeLocked = app.setWorldNodeLock(currentPath, anchor, nextLocked) ?? nodeLocked;
      build();
    }, nextLocked ? `Lock “${noteTitle(anchor)}” content` : `Unlock “${noteTitle(anchor)}” content`);
    closeMenu();
    // A lock a group already holds leaves the card looking exactly the same:
    // say which lock is doing the work, so the click does not read as ignored.
    if (group) {
      app.toast(
        nextLocked
          ? `“${noteTitle(anchor)}” is already read-only inside locked group “${group.name || 'Group'}” — locked on its own too`
          : `“${noteTitle(anchor)}” is still read-only — locked group “${group.name || 'Group'}” holds it`,
        'info',
        2600,
      );
    }
  }

  /** Pin one note where it stands, or unpin it again. */
  function toggleNodePin(anchor) {
    const nextPinned = !pinned[anchor];
    const group = pinnedGroupOf(anchor);
    step(() => {
      pinned = app.setWorldNodePin(currentPath, anchor, nextPinned) ?? pinned;
      build();
    }, nextPinned ? `Pin “${noteTitle(anchor)}”` : `Unpin “${noteTitle(anchor)}”`);
    closeMenu();
    // A pinned group already holds this card, so its own pin changes nothing
    // on screen: name the group rather than let the click look ignored.
    if (group) {
      app.toast(
        nextPinned
          ? `“${noteTitle(anchor)}” is already pinned by group “${group.name || 'Group'}” — pinned on its own too`
          : `“${noteTitle(anchor)}” is still pinned by group “${group.name || 'Group'}”`,
        'info',
        2600,
      );
    }
  }

  /** Pin a whole group where it stands, or unpin it again. */
  function toggleGroupPin(id) {
    const group = groups[id];
    if (!group) return;
    const nextPinned = !group.pinned;
    const parent = restrictingParentGroup(id, 'pinned');
    step(() => {
      const next = { ...groups, [id]: { ...group, pinned: nextPinned } };
      groups = app.saveWorldGroups(currentPath, next) ?? next;
      build();
    }, nextPinned ? `Pin “${group.name || 'group'}”` : `Unpin “${group.name || 'group'}”`);
    closeMenu();
    if (parent) {
      app.toast(
        nextPinned
          ? `“${group.name || 'Group'}” is already pinned by group “${parent.name || 'Group'}” — pinned on its own too`
          : `“${group.name || 'Group'}” is still pinned by group “${parent.name || 'Group'}”`,
        'info',
        2600,
      );
    }
  }

  function ungroupNow(id) {
    const parents = parentOf();
    const parentId = parents.get(id);
    const next = { ...groups };
    if (parentId && groups[parentId]) {
      const parent = groups[parentId];
      const children = (parent.children ?? []).filter((child) => child !== id);
      if (children.length || parent.members.length) next[parentId] = { ...parent, children };
      else delete next[parentId];
    } else {
      delete next[id];
      // A dissolved group leaves its relationships behind, exactly like a
      // deleted node.
      relations = app.dropWorldRelations(currentPath, groupEndpoint(id)) ?? relations;
    }
    groups = app.saveWorldGroups(currentPath, next) ?? next;
    drawEdges();
  }

  /* ---------------------------------------------- joining and leaving -- */

  // The padded border a group's box is drawn with: a drop is inside a box
  // when it is inside that border, exactly as the box looks on screen.
  const BOX_PAD = 12;

  /** The innermost group whose box covers a canvas point. */
  function groupAtPoint(point) {
    const depths = groupDepths();
    let hit = null;
    for (const group of Object.values(groups ?? {})) {
      if (isGroupLocked(group)) continue;
      const box = groupBox(group);
      if (!box) continue;
      if (point.x < box.x - BOX_PAD || point.x > box.x + box.width + BOX_PAD) continue;
      if (point.y < box.y - BOX_PAD || point.y > box.y + box.height + BOX_PAD) continue;
      // Nested boxes overlap by design: the innermost one wins the drop.
      if (!hit || (depths.get(group.id) ?? 0) > (depths.get(hit.id) ?? 0)) hit = group;
    }
    return hit;
  }

  /**
   * Where a dragged group's drop would land: the innermost group whose box
   * covers the point, never the dragged group itself nor anything nested
   * inside it — a group cannot be nested into itself.
   */
  function groupJoinTarget(point, selfId) {
    const excluded = new Set([selfId]);
    const visit = (id) => {
      for (const child of groups[id]?.children ?? []) {
        if (!excluded.has(child)) {
          excluded.add(child);
          visit(child);
        }
      }
    };
    visit(selfId);
    const depths = groupDepths();
    let hit = null;
    for (const group of Object.values(groups ?? {})) {
      if (excluded.has(group.id) || isGroupLocked(group)) continue;
      const box = groupBox(group);
      if (!box) continue;
      if (point.x < box.x - BOX_PAD || point.x > box.x + box.width + BOX_PAD) continue;
      if (point.y < box.y - BOX_PAD || point.y > box.y + box.height + BOX_PAD) continue;
      if (!hit || (depths.get(group.id) ?? 0) > (depths.get(hit.id) ?? 0)) hit = group;
    }
    return hit;
  }

  /**
   * Nest one group inside another (or, with null, out of its parent, making
   * it top-level): the group's own cards and nested groups stay with it, and
   * nothing dissolves — a drag never dissolves a group.
   */
  function nestGroup(groupId, targetId) {
    const group = groups[groupId];
    if (!group || groupId === targetId) return null;
    if (isGroupLocked(group) || (targetId && isGroupLocked(groups[targetId]))) return null;
    const oldParentId = parentOf().get(groupId) ?? null;
    if (oldParentId === targetId) return null;
    if (targetId && !groups[targetId]) return null;
    const next = { ...groups };
    if (oldParentId && groups[oldParentId]) {
      const parent = groups[oldParentId];
      next[oldParentId] = { ...parent, children: (parent.children ?? []).filter((child) => child !== groupId) };
    }
    if (targetId) {
      const target = groups[targetId];
      next[targetId] = { ...target, children: [...(target.children ?? []), groupId] };
    }
    groups = app.saveWorldGroups(currentPath, next) ?? next;
    return groups[groupId] ?? group;
  }

  /** The group whose box a card's middle sits inside right now, if any. */
  function groupUnder(anchor) {
    const index = model.notes.findIndex((note) => note.anchor === anchor);
    if (index < 0) return null;
    const box = rectOf(index);
    return groupAtPoint({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
  }

  /** The group a dragging card or group would join/nest into if released here. */
  function joinTargetId() {
    if (dragging?.groupId) {
      const group = groups[dragging.groupId];
      const box = group ? groupBox(group) : null;
      if (!box) return null;
      const target = groupJoinTarget({ x: box.x + box.width / 2, y: box.y + box.height / 2 }, dragging.groupId);
      return dropMembershipKind({ distance: dragging.distance, startGroupId: dragging.startGroupId, targetId: target?.id ?? null }) === 'join'
        ? target.id
        : null;
    }
    if (!dragging?.joinable) return null;
    const anchor = dragging.members[0]?.anchor;
    if (!anchor) return null;
    const target = groupUnder(anchor);
    return dropMembershipKind({ distance: dragging.distance, startGroupId: dragging.startGroupId, targetId: target?.id ?? null }) === 'join'
      ? target.id
      : null;
  }

  /**
   * What a solo card's drop does to its membership: dropped inside a box it
   * entered during this drag, it joins that group (leaving its old one
   * without dissolving it); dropped outside the group it started the drag
   * in, it leaves that group. Either way nothing is restacked — the card
   * keeps the place it was dropped in and every card already in either
   * group stays put.
   */
  // The drag's step wears the name of what its drop did — membership first,
  // a plain move otherwise. Returns the name, or null for no membership change.
  function dropMembership(drop) {
    if (drop.groupId) return dropGroup(drop);
    if (!drop.joinable) return null;
    const anchor = drop.members[0]?.anchor;
    if (!anchor) return null;
    const target = groupUnder(anchor);
    const kind = dropMembershipKind({ distance: drop.distance, startGroupId: drop.startGroupId, targetId: target?.id ?? null });
    if (kind === 'join' && target) {
      const joined = joinGroup(anchor, target.id, { keepThin: true });
      if (!joined) return null;
      savePositions();
      build();
      app.toast(`Added “${noteTitle(anchor)}” to ${joined.name || 'the group'}`, 'ok', 1600);
      return `Add “${noteTitle(anchor)}” to ${joined.name || 'the group'}`;
    } else if (kind === 'leave') {
      const left = leaveGroup(anchor);
      if (!left) return null;
      savePositions();
      build();
      app.toast(`“${noteTitle(anchor)}” left ${left.name || 'the group'}`, 'ok', 1600);
      return `Remove “${noteTitle(anchor)}” from ${left.name || 'the group'}`;
    }
    return null;
  }

  /**
   * What a dragged group's drop does to its nesting, gated the same way as
   * a card's: carried at least a deliberate move, the group's box inside a
   * box it did not start inside nests it there; outside the parent it
   * started the drag in, it un-nests and becomes top-level. It never nests
   * into itself or anything inside it, and nothing dissolves.
   */
  function dropGroup(drop) {
    const group = groups[drop.groupId];
    if (!group) return null;
    const box = groupBox(group);
    if (!box) return null;
    const target = groupJoinTarget({ x: box.x + box.width / 2, y: box.y + box.height / 2 }, drop.groupId);
    const kind = dropMembershipKind({ distance: drop.distance, startGroupId: drop.startGroupId, targetId: target?.id ?? null });
    if (kind === 'join' && target) {
      const nested = nestGroup(drop.groupId, target.id);
      if (!nested) return null;
      savePositions();
      build();
      app.toast(`Nested “${nested.name || 'the group'}” into ${target.name || 'the group'}`, 'ok', 1600);
      return `Nest “${nested.name || 'the group'}” into ${target.name || 'the group'}`;
    } else if (kind === 'leave') {
      const unnested = nestGroup(drop.groupId, null);
      if (!unnested) return null;
      savePositions();
      build();
      app.toast(`“${unnested.name || 'the group'}” left its group`, 'ok', 1600);
      return `Un-nest “${unnested.name || 'the group'}”`;
    }
    return null;
  }

  /**
   * Put one note into a group where it sits. A note belongs to one group at a
   * time, so this also takes it out of the one it had, dropping that group
   * when it no longer has the two cards a box needs — except when keepThin,
   * which lets the group it left survive however few cards it keeps (a
   * drag never dissolves a group). No card is moved — the box simply grows
   * around the arrangement it finds.
   */
  function joinGroup(anchor, id, { keepThin = false } = {}) {
    const target = groups[id];
    if (!target || effectiveMembers(target).has(anchor)) return null;
    if (isGroupLocked(target) || isAnchorLocked(anchor)) return null;
    const prevId = groupOf(anchor)?.id ?? null;
    const next = {};
    for (const [otherId, group] of Object.entries(groups)) {
      const rest = group.members.filter((member) => member !== anchor);
      if (rest.length === group.members.length || rest.length >= 2 || (group.children ?? []).length || (keepThin && otherId === prevId)) {
        next[otherId] = rest.length === group.members.length ? group : { ...group, members: rest };
      }
      // Below two cards and with no children a group has no box left to draw,
      // so it is gone; groups it nested surface as top-level groups.
    }
    next[id] = { ...target, members: [...target.members, anchor] };
    groups = app.saveWorldGroups(currentPath, next) ?? next;
    return groups[id] ?? target;
  }

  /**
   * Take one note out of its group without dissolving the group — even when
   * that leaves underneath two cards: a drag-out never dissolves anything.
   */
  function leaveGroup(anchor) {
    const group = groupOf(anchor);
    if (!group || isGroupLocked(group)) return null;
    const next = { ...groups, [group.id]: { ...group, members: group.members.filter((member) => member !== anchor) } };
    groups = app.saveWorldGroups(currentPath, next) ?? next;
    return group;
  }

  /** Take one note out of its group, leaving every other card where it is. */
  function removeFromGroup(anchor) {
    const group = groupOf(anchor);
    if (!group || isGroupLocked(group)) return null;
    const rest = group.members.filter((member) => member !== anchor);
    const next = { ...groups };
    if (rest.length >= 2 || (group.children ?? []).length) next[group.id] = { ...group, members: rest };
    else delete next[group.id];
    groups = app.saveWorldGroups(currentPath, next) ?? next;
    return group;
  }

  /** A note's title, for the menus and toasts about membership. */
  function noteTitle(anchor) {
    return (model?.notes ?? []).find((note) => note.anchor === anchor)?.title || 'note';
  }

  /** "Add to group" rows: every group that does not already hold this note. */
  function addToGroupItems(anchor) {
    if (!anchor || isAnchorLocked(anchor)) return [];
    const options = Object.values(groups ?? {}).filter(
      (group) => !isGroupLocked(group) && !effectiveMembers(group).has(anchor),
    );
    if (!anchor || !options.length) return [];
    return [
      el('span', { class: 'wb-menu-label', text: 'Add to group' }),
      ...options.map((group) => el('button', {
        class: 'wb-menu-item',
        type: 'button',
        text: group.name || 'Group',
        title: `Add “${noteTitle(anchor)}” to ${group.name || 'this group'} where it sits`,
        onclick: () => {
          const oldGroup = groupOf(anchor);
          let joined = null;
          step(() => {
            joined = joinGroup(anchor, group.id);
            if (!joined) return;
            savePositions();
            build();
          }, `Add “${noteTitle(anchor)}” to ${group.name || 'the group'}`);
          closeMenu();
          if (!joined) return;
          // The move emptied the card's old group, so that group dissolved:
          // it is gone from the record, and the toast says so.
          const dissolvedOld = Boolean(oldGroup) && !groups[oldGroup.id];
          app.toast(dissolvedOld
            ? `Added “${noteTitle(anchor)}” to ${joined.name || 'the group'} — ${oldGroup.name || 'the group'} is gone`
            : `Added “${noteTitle(anchor)}” to ${joined.name || 'the group'}`,
            'ok', 1600);
        },
      })),
    ];
  }

  /** What an end of a relationship is called: a note's title, or a group's name. */
  function endpointTitle(endpoint) {
    if (endpoint.startsWith('group:')) {
      const group = groups[endpoint.slice('group:'.length)];
      return group?.name || 'Group';
    }
    return model.notes.find((note) => note.anchor === endpoint)?.title || endpoint;
  }

  /** True when an endpoint still has a card or a box to sit on. */
  function endpointKnown(endpoint) {
    if (String(endpoint).startsWith('group:')) return Boolean(groups[endpoint.slice('group:'.length)]);
    return (model?.notes ?? []).some((note) => note.anchor === endpoint);
  }

  /** Every stored bond touching one endpoint, whichever way it points. */
  function bondRows(own) {
    const rows = [];
    for (const [key, kind] of Object.entries(relations ?? {})) {
      const [from, to] = String(key).split('->');
      if (!from || !to || (from !== own && to !== own)) continue;
      if (!endpointKnown(from) || !endpointKnown(to)) continue;
      const known = relationKind(kind) ?? relationKind(DEFAULT_RELATION);
      rows.push({ from, to, relation: known.id, rank: known.rank });
    }
    // Weakest first, so the meaning of the list grows as it is read.
    return rows.sort((a, b) => a.rank - b.rank);
  }

  /**
   * The relationship block for an endpoint — a note or a group — or for
   * both at once (a note's own bonds listed beside its group's, so a grouped
   * card reads as one control instead of two): every stored bond whichever
   * way it points, weakest first, deduped between endpoints, and each
   * removable by clicking it; then one set of pickers for asserting another
   * — for the first endpoint, the thing the menu opened on. The ends on
   * offer are every other card and every group.
   */
  function relationshipItems(owns, label) {
    const endpoints = [].concat(owns ?? []).filter(Boolean);
    const own = endpoints[0];
    const items = [];
    const bonds = new Map();
    for (const endpoint of endpoints) {
      for (const bond of bondRows(endpoint)) bonds.set(`${bond.from}->${bond.to}`, bond);
    }
    const rows = [...bonds.values()].sort((a, b) => a.rank - b.rank);
    for (const bond of rows) {
      items.push(el('button', {
        class: 'wb-menu-item',
        type: 'button',
        text: `${endpointTitle(bond.from)} ${relationKind(bond.relation).label.toLowerCase()} ${endpointTitle(bond.to)} ✕`,
        title: 'Remove this relationship — a prose link between the two notes stays',
        onclick: () => {
          step(() => {
            relations = app.removeWorldRelation(currentPath, bond.from, bond.to) ?? relations;
            drawEdges();
            build();
          }, `Remove “${endpointTitle(bond.from)}” ${relationKind(bond.relation).label.toLowerCase()} “${endpointTitle(bond.to)}”`);
          announceBondRemoved(bond.from, bond.to, relationKind(bond.relation).label);
          closeMenu();
        },
      }));
    }

    const kind = el('select', { class: 'wb-menu-select', 'aria-label': 'Relationship kind' }, RELATION_KINDS.map(
      (candidate) => el('option', { value: candidate.id, text: candidate.label }),
    ));
    const target = el('select', { class: 'wb-menu-select', 'aria-label': 'Relationship target' }, [
      el('option', { value: '', text: 'Relate to…' }),
      ...(model.notes ?? [])
        .filter((note) => note.anchor !== own)
        .map((note) => el('option', { value: note.anchor, text: note.title || note.anchor })),
      ...Object.values(groups ?? {})
        .filter((group) => groupEndpoint(group.id) !== own)
        .map((group) => el('option', { value: groupEndpoint(group.id), text: group.name || 'Group' })),
    ]);
    items.push(el('span', { class: 'wb-menu-label', text: label }));
    items.push(el('div', { class: 'wb-menu-relationship' }, [kind, target, el('button', {
      class: 'wb-menu-item',
      type: 'button',
      text: 'Add relationship',
      onclick: () => {
        if (!target.value) return;
        step(() => {
          relations = app.setWorldRelation(currentPath, own, target.value, kind.value) ?? relations;
          drawEdges();
          build();
        }, `Relate “${endpointTitle(own)}” to “${endpointTitle(target.value)}”: ${relationKind(kind.value).label}`);
        closeMenu();
        app.toast(`${endpointTitle(own)} ${relationKind(kind.value).label.toLowerCase()} ${endpointTitle(target.value)}`, 'ok', 1800);
      },
    })]));
    items.push(el('button', {
      class: 'wb-menu-item',
      type: 'button',
      text: 'Select all relations',
      title: 'Select every connector touching this card, for batch routing and path tracing',
      onclick: () => {
        selectRelationsFor(own);
        closeMenu();
      },
    }));
    return items;
  }

  /**
   * A note's prose links as the card's chips used to read them: the label, the
   * asserted relationship, where following the link goes, and whether it is a
   * ghost — a note nobody has written yet.
   */
  function noteLinkRows(note) {
    return (note.links ?? []).map((link) => {
      const resolved = app.resolveLink({
        target: link.target,
        section: link.section,
        alias: link.alias,
        samePage: link.samePage,
        anchor: link.anchor,
      }, currentPath);
      // What this connection asserts, when it asserts more than Associate.
      let targetAnchor = link.anchor;
      if (!link.samePage && link.target) {
        targetAnchor = (model.notes ?? []).find((n) => String(n.title).toLowerCase() === String(link.target).toLowerCase())?.anchor ?? link.anchor;
      }
      const asserted = relationOf(relations, note.anchor, targetAnchor);
      const assertText = asserted.id !== DEFAULT_RELATION ? ` — ${asserted.label.toLowerCase()}` : '';
      return {
        ghost: Boolean(resolved.ghost),
        text: (link.alias || (link.samePage
          ? `§ ${link.section || 'this page'}`
          : `${link.target}${link.section ? ` › ${link.section}` : ''}`)) + assertText,
        title: (resolved.ghost ? `Not written yet: ${link.target || link.section} — click to create it` : (resolved.path ?? '')) + assertText,
        open: () => {
          if (resolved.ghost) app.createFromGhost(link.target || link.section, resolved.suggestedPath);
          else app.openPath(resolved.path, { anchor: resolved.anchor, via: currentPath });
        },
      };
    });
  }

  /**
   * The node's "Link to" block, moved here from the card's foot: the links
   * already written in its prose (one click follows one), the picker that
   * writes another — another card, a group, or a brand-new note — and the
   * relationship it asserts. A locked node gains the bond without the prose,
   * exactly as linking always has.
   */
  function linkToItems(anchor) {
    const index = model.notes.findIndex((note) => note.anchor === anchor);
    const note = model.notes[index];
    if (!note) return [];
    const items = [el('span', { class: 'wb-menu-label', text: 'Link to' })];
    const rows = noteLinkRows(note);
    for (const row of rows) {
      items.push(el('button', {
        class: 'wb-menu-item',
        type: 'button',
        text: row.ghost ? `+ ${row.text}` : row.text,
        title: row.title,
        onclick: () => {
          closeMenu();
          row.open();
        },
      }));
    }
    if (!rows.length) items.push(el('span', { class: 'wb-menu-note', text: 'No links in this note’s prose yet' }));
    const kind = el('select', { class: 'wb-menu-select', 'aria-label': 'What the new link asserts' }, RELATION_KINDS.map(
      (candidate) => el('option', { value: candidate.id, text: candidate.label }),
    ));
    kind.value = linkKinds.get(index) ?? DEFAULT_RELATION;
    kind.addEventListener('change', () => linkKinds.set(index, kind.value));
    const target = el('select', { class: 'wb-menu-select', 'aria-label': 'Link this note to' }, [
      el('option', { value: '', text: 'Link to…' }),
      ...(model.notes ?? [])
        .filter((other) => other.anchor !== anchor)
        .map((other) => el('option', { value: other.anchor, text: other.title || other.anchor })),
      ...Object.values(groups ?? {})
        .map((group) => el('option', { value: groupEndpoint(group.id), text: `Group: ${group.name || 'Group'}` })),
    ]);
    items.push(el('div', { class: 'wb-menu-relationship' }, [kind, target, el('button', {
      class: 'wb-menu-item',
      type: 'button',
      text: 'Add link',
      onclick: () => {
        if (!target.value) return;
        closeMenu();
        linkNoteTo(anchor, target.value, kind.value);
      },
    })]));
    items.push(el('button', {
      class: 'wb-menu-item',
      type: 'button',
      text: '+ New linked note',
      title: 'Write a new note into this vein and link this one to it',
      onclick: () => {
        closeMenu();
        createLinkedNote(index);
      },
    }));
    return items;
  }

  /**
   * Link a note to another end from its menu: an existing card gains the prose
   * link (unless the source is locked) and the asserted relationship; a group
   * takes the relationship alone. A card that is already linked is not linked
   * twice — its relationship is re-asserted.
   */
  function linkNoteTo(anchor, target, kind) {
    if (!model || !target) return;
    const index = model.notes.findIndex((note) => note.anchor === anchor);
    if (index < 0) return;
    const live = model.notes[index];
    const label = RELATION_KINDS.find((candidate) => candidate.id === kind)?.label ?? kind;
    if (target.startsWith('group:')) {
      const group = groups[target.slice('group:'.length)];
      if (!group) return;
      step(() => {
        relations = app.setWorldRelation(currentPath, anchor, target, kind) ?? relations;
        drawEdges();
      }, `Relate “${live.title || 'note'}” to “${group.name || 'Group'}”: ${label}`);
      app.toast(`“${live.title || 'note'}” ${label.toLowerCase()} “${group.name || 'Group'}”`, 'ok', 1800);
      return;
    }
    const targetNote = model.notes.find((note) => note.anchor === target);
    if (!targetNote) return;
    const alreadyLinked = (live.links ?? []).some((link) => link.samePage && link.anchor === targetNote.anchor);
    // A locked source card keeps its prose untouched: the relationship still
    // lands as a canvas bond below, so locking never blocks links.
    if (!alreadyLinked && !isContentLocked(live.anchor)) {
      model = updateNote(model, index, { body: `${live.body}${live.body ? '\n\n' : ''}[[#${targetNote.title}]]` });
      commit();
      // The card shows the new link in its rendered prose and word count.
      build();
    }
    // The bond is the canvas's, the link above is the vein's: an undo here
    // restores the kind and leaves the prose to the vein's own undo.
    step(() => {
      relations = app.setWorldRelation(currentPath, model.notes[index].anchor, targetNote.anchor, kind) ?? relations;
      drawEdges();
    }, `Relate “${live.title || 'note'}” to “${targetNote.title}”: ${label}`);
    app.toast(`“${live.title || 'note'}” ${label.toLowerCase()} “${targetNote.title}”`, 'ok', 1800);
  }

  /** The connector currently drawn under a key, if it still exists. */
  function findConnector(key) {
    if (!model || !key) return null;
    return connectorList(model, groups, relations).find((edge) => connectorKey(edge) === key) ?? null;
  }

  function connectorKindLabel(edge) {
    if (edge.kind === 'contains') return 'Hierarchy';
    if (edge.kind === 'section') return 'Section link';
    if (edge.kind === 'mention') return 'Mention';
    if (edge.kind === 'group') return 'Group relationship';
    return 'Bond';
  }

  function selectConnectorEndpoint(endpoint) {
    if (!endpoint) return;
    if (endpoint.startsWith('group:')) {
      const group = groups[endpoint.slice('group:'.length)];
      setSelection(new Set(group ? effectiveMembers(group) : []));
    } else {
      setSelection(new Set([endpoint]));
    }
  }

  function setConnectorRelation(edge, kindId) {
    if (edge.kind === 'contains' || !currentPath) return;
    const kind = relationKind(kindId);
    if (!kind) return;
    step(() => {
      relations = app.setWorldRelation(currentPath, edge.from, edge.to, kind.id) ?? relations;
      drawEdges();
      build();
    }, `Relate “${endpointTitle(edge.from)}” to “${endpointTitle(edge.to)}”: ${kind.label}`);
    app.toast(`“${endpointTitle(edge.from)}” ${kind.label.toLowerCase()} “${endpointTitle(edge.to)}”`, 'ok', 1800);
  }

  function removeConnectorRelation(edge) {
    if (edge.kind === 'contains' || !currentPath) return;
    const key = relationKey(edge.from, edge.to);
    if (!(key in (relations ?? {}))) return;
    const current = relationOf(relations, edge.from, edge.to);
    step(() => {
      relations = app.removeWorldRelation(currentPath, edge.from, edge.to) ?? relations;
      drawEdges();
      build();
    }, `Remove “${endpointTitle(edge.from)}” ${current.label.toLowerCase()} “${endpointTitle(edge.to)}”`);
    announceBondRemoved(edge.from, edge.to, current.label);
  }

  /**
   * Say what removing a stated bond left behind. When the prose links the same
   * two notes, the wire is drawn from that markdown link and stays put — and a
   * silent click would read as one that did nothing, so it says so plainly,
   * and offers to take that link out too.
   */
  function announceBondRemoved(from, to, label) {
    if (!proseLinkBetween(model, from, to)) {
      app.toast(`Removed the “${label.toLowerCase()}” bond between “${endpointTitle(from)}” and “${endpointTitle(to)}”`, 'ok', 1800);
      return;
    }
    app.toast(
      `Removed the “${label.toLowerCase()}” bond — “${endpointTitle(from)}” and “${endpointTitle(to)}” are still joined by a markdown link in the prose, so the line stays.`,
      'info',
      6000,
      { label: 'Remove the link', onClick: () => unlinkBondProse(from, to) },
    );
  }

  /**
   * Take the markdown link between two cards out of the prose, keeping the
   * words the reader saw. That is a prose edit, not a canvas change: it
   * commits the way a title, body or tag edit does, so it takes no canvas undo
   * step and the vein's own undo brings the links back.
   */
  function unlinkBondProse(from, to) {
    if (!model) return;
    const { model: next, removed } = unlinkProseBetween(model, from, to);
    if (!removed) {
      app.toast(`No markdown link is left between “${endpointTitle(from)}” and “${endpointTitle(to)}”`, 'info', 2200);
      return;
    }
    model = next;
    commit();
    // The cards show the unlinked prose and their new word counts.
    build();
    app.toast(
      `Unlinked “${endpointTitle(from)}” and “${endpointTitle(to)}”${removed > 1 ? ` (${removed} links)` : ''} — the words stay, the line goes`,
      'ok',
      2600,
    );
  }

  function reverseConnectorRelation(edge) {
    if (edge.kind === 'contains' || !currentPath) return;
    const key = relationKey(edge.from, edge.to);
    const current = relationKind(relations?.[key]);
    const inverse = current?.inverse ? relationKind(current.inverse) : null;
    if (!current || !inverse) return;
    step(() => {
      relations = app.setWorldRelation(currentPath, edge.to, edge.from, inverse.id) ?? relations;
      relations = app.removeWorldRelation(currentPath, edge.from, edge.to) ?? relations;
      drawEdges();
      build();
    }, `Reverse “${endpointTitle(edge.from)}” ${current.label.toLowerCase()} “${endpointTitle(edge.to)}”`);
    app.toast(`Reversed: “${endpointTitle(edge.to)}” ${inverse.label.toLowerCase()} “${endpointTitle(edge.from)}”`, 'ok', 1800);
  }

  /** Set one routing preference on every selected connector, or clear it. */
  function setSelectedConnectorRouting(kind, value) {
    if (!currentPath || !selectedEdges.size) return;
    const keys = [...selectedEdges];
    const edges = { ...(routing.edges ?? {}) };
    for (const key of keys) {
      if (value === null) {
        const next = { ...(edges[key] ?? {}) };
        delete next[kind];
        if (Object.keys(next).length) edges[key] = next;
        else delete edges[key];
      } else {
        edges[key] = { ...(edges[key] ?? {}), [kind]: value };
      }
    }
    routing = normalizeRouting({ ...routing, edges });
    app.saveWorldRouting?.(currentPath, routing);
    drawEdges();
  }

  /**
   * The right-click menu for one connector: its relationship, its curve and
   * arrowhead, and the cards it touches. Routing controls follow the current
   * connector selection; relationship controls act on this connector only.
   */
  function connectorMenuItems(edge) {
    const key = connectorKey(edge);
    if (!selectedEdges.has(key)) {
      selectedEdges = new Set([key]);
      syncConnectorUi();
      drawEdges();
    }
    const items = [];
    const fromTitle = endpointTitle(edge.from);
    const toTitle = endpointTitle(edge.to);
    items.push(el('span', {
      class: 'wb-menu-label',
      text: `${fromTitle} → ${toTitle} · ${connectorKindLabel(edge)}`,
    }));

    if (edge.kind !== 'contains') {
      const current = edge.relation ? relationKind(edge.relation) : relationOf(relations, edge.from, edge.to);
      const relationshipItems = [];
      for (const kind of RELATION_KINDS) {
        relationshipItems.push(el('button', {
          class: `wb-menu-item wb-submenu-choice${current?.id === kind.id ? ' is-current' : ''}`,
          type: 'button',
          'aria-current': current?.id === kind.id ? 'true' : undefined,
          title: `Assert “${fromTitle}” ${kind.label.toLowerCase()} “${toTitle}”`,
          onclick: () => { setConnectorRelation(edge, kind.id); closeMenu(); },
        }, [
          el('span', { class: 'wb-submenu-choice-label', text: kind.label }),
          el('span', { class: 'wb-menu-check', 'aria-hidden': 'true', text: current?.id === kind.id ? '✓' : '' }),
        ]));
      }
      relationshipItems.push(el('button', {
        class: 'wb-menu-item', type: 'button', text: 'Cycle relationship',
        title: 'Step this relationship to the next kind in the strength scale',
        onclick: () => { cycleRelation(edge); closeMenu(); },
      }));
      const relationKeyValue = relationKey(edge.from, edge.to);
      const stored = relationKeyValue in (relations ?? {});
      const inverse = current?.inverse ? relationKind(current.inverse) : null;
      if (stored && inverse) {
        relationshipItems.push(el('button', {
          class: 'wb-menu-item', type: 'button', text: 'Reverse relationship',
          title: `Assert “${toTitle}” ${inverse.label.toLowerCase()} “${fromTitle}” instead`,
          onclick: () => { reverseConnectorRelation(edge); closeMenu(); },
        }));
      }
      const removeButton = el('button', {
        class: 'wb-menu-item', type: 'button', text: 'Remove asserted relationship',
        title: edge.kind === 'section' || edge.kind === 'mention'
          ? 'Drop the asserted kind — the prose link itself stays'
          : 'Delete this bond',
        disabled: stored ? undefined : true,
        onclick: () => { removeConnectorRelation(edge); closeMenu(); },
      });
      relationshipItems.push(removeButton);
      items.push(submenuItem('Relationship', relationshipItems, current?.label ?? 'Associate'));
    }

    const eff = effectiveRouting(routing, key);
    const selectedCount = selectedEdges.size;
    const selectedSuffix = selectedCount > 1 ? ` (${selectedCount} selected)` : '';
    const curveItems = [];
    curveItems.push(el('button', {
      class: `wb-menu-item${eff.elbow ? ' is-current' : ''}`, type: 'button', text: 'Elbow curve',
      title: 'Route as right-angle elbows',
      onclick: () => { setSelectedConnectorRouting('elbow', true); closeMenu(); },
    }));
    curveItems.push(el('button', {
      class: `wb-menu-item${!eff.elbow ? ' is-current' : ''}`, type: 'button', text: 'Smooth curve',
      title: 'Route as a smooth bezier curve',
      onclick: () => { setSelectedConnectorRouting('elbow', false); closeMenu(); },
    }));
    curveItems.push(el('button', {
      class: `wb-menu-item${eff.arrows ? ' is-current' : ''}`, type: 'button', text: eff.arrows ? 'Hide arrowhead' : 'Show arrowhead',
      title: 'Toggle the arrowhead on the selected connectors',
      onclick: () => { setSelectedConnectorRouting('arrows', !eff.arrows); closeMenu(); },
    }));
    curveItems.push(el('button', {
      class: `wb-menu-item${eff.cut ? ' is-current' : ''}`, type: 'button',
      text: eff.cut ? 'Draw long wires full length' : 'Cut off long wires',
      title: eff.cut
        ? 'Draw this connector whole, however far its ends are apart'
        : 'When its ends are far apart, draw only part of this connector and end it in a diamond that flies to the other card',
      onclick: () => { setSelectedConnectorRouting('cut', !eff.cut); closeMenu(); },
    }));
    curveItems.push(el('button', {
      class: 'wb-menu-item', type: 'button', text: 'Use vein default routing',
      title: 'Drop this connector’s routing override and follow the vein-wide Elbow/Arrows settings',
      onclick: () => {
        setSelectedConnectorRouting('elbow', null);
        setSelectedConnectorRouting('arrows', null);
        closeMenu();
      },
    }));
    items.push(submenuItem(`Curve${selectedSuffix}`, curveItems));

    const pathItems = [];
    pathItems.push(el('button', {
      class: 'wb-menu-item', type: 'button', text: `Select “${fromTitle}”`,
      onclick: () => { selectConnectorEndpoint(edge.from); closeMenu(); },
    }));
    pathItems.push(el('button', {
      class: 'wb-menu-item', type: 'button', text: `Select “${toTitle}”`,
      onclick: () => { selectConnectorEndpoint(edge.to); closeMenu(); },
    }));
    pathItems.push(el('button', {
      class: 'wb-menu-item', type: 'button', text: 'Select both ends',
      onclick: () => {
        const endpoints = [];
        for (const endpoint of [edge.from, edge.to]) {
          if (endpoint.startsWith('group:')) {
            const group = groups[endpoint.slice('group:'.length)];
            if (group) endpoints.push(...effectiveMembers(group));
          } else {
            endpoints.push(endpoint);
          }
        }
        setSelection(new Set(endpoints));
        closeMenu();
      },
    }));
    pathItems.push(el('button', {
      class: 'wb-menu-item', type: 'button', text: 'Trace upstream',
      title: 'Select every card that feeds into the selected connectors',
      onclick: () => { traceSelectedConnectors('upstream'); closeMenu(); },
    }));
    pathItems.push(el('button', {
      class: 'wb-menu-item', type: 'button', text: 'Trace downstream',
      title: 'Select every card the selected connectors lead to',
      onclick: () => { traceSelectedConnectors('downstream'); closeMenu(); },
    }));
    pathItems.push(el('button', {
      class: 'wb-menu-item', type: 'button', text: 'Select all connectors',
      title: 'Select every connector on this canvas',
      onclick: () => {
        selectedEdges = new Set(connectorList(model, groups, relations).map(connectorKey));
        syncConnectorUi();
        drawEdges();
        closeMenu();
      },
    }));
    items.push(submenuItem('Ends & Paths', pathItems));
    return items;
  }

  // A context-menu press focuses the field under it before the browser fires
  // contextmenu, so by then document.activeElement cannot say whether the
  // writer was already editing that field. macOS Ctrl+click arrives as a left
  // pointerdown, so remember it alongside a normal right-press.
  let contextMenuPressSeen = false;
  let contextMenuPressField = null;
  stage.addEventListener('pointerdown', (event) => {
    const contextMenuPress = event.button === 2 || (event.button === 0 && event.ctrlKey);
    if (!contextMenuPress) {
      contextMenuPressSeen = false;
      contextMenuPressField = null;
      return;
    }
    contextMenuPressSeen = true;
    const field = event.target.closest?.('input, textarea');
    contextMenuPressField = field && field === document.activeElement ? field : null;
  }, true);

  /**
   * The right-click menu: a selection groups, a grouped node recolors, and
   * every node relates itself. A field the writer was already editing keeps
   * its browser menu — cut, copy, paste and the spellchecker's menu belong to
   * the edit — and a dropdown keeps its own. A field the right-press merely
   * focused is still the node's menu: the head is mostly its title input, and
   * treating that as an edit swallowed the node's menu entirely.
   */
  function openMenu(event) {
    // The press that led here, if any: a keyboard menu key has no pointerdown
    // and keeps the old activeElement rule.
    const pressed = contextMenuPressSeen;
    const pressedField = contextMenuPressField;
    contextMenuPressSeen = false;
    contextMenuPressField = null;
    if (event.target.closest?.('select')) return;
    const field = event.target.closest?.('input, textarea');
    const editing = pressed ? field === pressedField : field === document.activeElement;
    if (field && editing) return;
    closeMenu();
    if (!model) return;
    const edgeEl = event.target.closest?.('[data-edge-key]');
    if (edgeEl) {
      const edge = findConnector(edgeEl.getAttribute('data-edge-key'));
      if (edge) {
        event.preventDefault();
        showMenu(event, connectorMenuItems(edge));
        return;
      }
    }
    const cardEl = event.target.closest?.('.wb-card');
    const anchor = cardEl ? model.notes[Number(cardEl.dataset.note)]?.anchor : null;
    // Right-clicking the handle or name reaches the same menu as a member.
    const marked = event.target.closest?.('[data-group-id]')?.getAttribute('data-group-id');
    const group = (anchor ? groupOf(anchor) : null) ?? (marked ? groups[marked] ?? null : null);
    // A lone card still has membership to offer, so a card is worth a menu.
    if (!selected.size && !group && !anchor) return;
    event.preventDefault();
    const items = [];
    // One relationship block: a card's own bonds beside its group's when it
    // has one, so a grouped card's menu is one control, not two blocks with
    // identical pickers. The pickers assert for the thing it opened on.
    if (anchor && group) {
      items.push(...relationshipItems([anchor, groupEndpoint(group.id)], 'Relate this note'));
    } else if (anchor) {
      items.push(...relationshipItems(anchor, 'Relate this note'));
    } else if (group) {
      items.push(...relationshipItems(groupEndpoint(group.id), 'Relate this group'));
    }
    if (anchor) {
      items.push(...linkToItems(anchor));
      const anchorLocked = isContentLocked(anchor);
      const lockNote = isNodeLocked(anchor) && !isAnchorLocked(anchor)
        ? 'This node’s content is locked — unlock it to change it'
        : 'Locked group contents cannot be recoloured';
      items.push(el('span', { class: 'wb-menu-label', text: 'Node colour' }));
      items.push(el('div', { class: 'wb-menu-swatches' }, GROUP_COLORS.map((color) => el('button', {
        class: `wb-menu-swatch${nodeColors[anchor] === color ? ' is-current' : ''}`,
        type: 'button',
        style: `background:${color}`,
        'aria-label': `Node colour ${color}`,
        disabled: anchorLocked ? true : undefined,
        title: anchorLocked ? lockNote : undefined,
        onclick: () => setNodeColor(anchor, color),
      }))));
      if (nodeColors[anchor]) {
        items.push(el('button', {
          class: 'wb-menu-item', type: 'button', text: 'Use the type colour',
          title: anchorLocked ? 'Locked group contents cannot be recoloured' : 'Drop this node’s custom colour, back to its type’s',
          disabled: anchorLocked ? true : undefined,
          onclick: () => setNodeColor(anchor, null),
        }));
      }
      items.push(el('span', { class: 'wb-menu-label', text: 'Node image' }));
      items.push(el('button', {
        class: 'wb-menu-item', type: 'button',
        text: nodeImages[anchor] ? 'Replace image…' : 'Add image…',
        title: anchorLocked ? 'Locked group contents cannot change image' : 'Use an image file as this node’s icon — stored with the vein, drawn in its head',
        disabled: anchorLocked ? true : undefined,
        onclick: () => pickNodeImage(anchor),
      }));
      if (nodeImages[anchor]) {
        items.push(el('button', {
          class: 'wb-menu-item', type: 'button', text: 'Remove image',
          title: anchorLocked ? 'Locked group contents cannot change image' : 'Take this node’s image back off',
          disabled: anchorLocked ? true : undefined,
          onclick: () => setNodeImage(anchor, null),
        }));
      }
      items.push(el('span', { class: 'wb-menu-label', text: 'Attachments' }));
      items.push(el('button', {
        class: 'wb-menu-item', type: 'button', text: 'Attach file…',
        title: anchorLocked ? lockNote : 'Copy a file into this vault and attach it to this node',
        disabled: anchorLocked ? true : undefined,
        onclick: () => attachFileToNode(anchor),
      }));
      items.push(el('button', {
        class: 'wb-menu-item', type: 'button', text: 'Add web URL…',
        title: anchorLocked ? lockNote : 'Attach an http(s) address to this node',
        disabled: anchorLocked ? true : undefined,
        onclick: () => addNodeUrl(anchor),
      }));
      items.push(el('button', {
        class: 'wb-menu-item', type: 'button', text: 'Rename node',
        title: anchorLocked ? 'Locked group contents cannot be renamed' : 'Edit this note’s title in place',
        disabled: anchorLocked ? true : undefined,
        onclick: () => {
          closeMenu();
          const index = model.notes.findIndex((note) => note.anchor === anchor);
          const input = cardEls[index]?.querySelector('.wb-card-title');
          if (!input) return;
          input.focus();
          input.select();
        },
      }));
      items.push(el('span', { class: 'wb-menu-label', text: 'Card mode' }));
      for (const [label, mode] of [['Full card', 'full'], ['Compact card', 'compact'], ['Card thumbnail', 'thumbnail']]) {
        items.push(el('button', {
          class: `wb-menu-item${cardModeOf(anchor) === mode ? ' is-current' : ''}`,
          type: 'button',
          text: label,
          title: mode === 'full' ? 'The whole node — prose, fields and links' : mode === 'compact' ? 'Title, type, link and word counts only' : 'Just the node’s image (or its initial)',
          onclick: () => { setCardMode(anchor, mode); closeMenu(); },
        }));
      }
      items.push(el('span', { class: 'wb-menu-label', text: 'Card height' }));
      for (const [label, size, hint] of [
        ['Fit to content', 'content', 'Grow this card to its prose — the whole note shows, no scrolling'],
        ['Fixed height', 'fixed', 'Keep the standard card box; its prose scrolls'],
      ]) {
        items.push(el('button', {
          class: `wb-menu-item${cardSizeOf(anchor) === size ? ' is-current' : ''}`,
          type: 'button',
          text: label,
          title: cardModeOf(anchor) === 'full' ? hint : `${hint} — full cards only`,
          onclick: () => { setCardSize(anchor, size); closeMenu(); },
        }));
      }
      items.push(el('button', {
        class: 'wb-menu-item', type: 'button', text: pinned[anchor] ? 'Unpin node' : 'Pin node',
        title: pinned[anchor]
          ? 'Unpin this node — Arrange may move it again'
          : 'Pin this node where it stands — Arrange works around it',
        onclick: () => toggleNodePin(anchor),
      }));
      items.push(el('button', {
        class: 'wb-menu-item', type: 'button', text: nodeLocked[anchor] ? 'Unlock node content' : 'Lock node content',
        title: nodeLocked[anchor]
          ? 'Unlock this node’s content so it can be edited again'
          : 'Lock this node’s content read-only — it can still be moved and linked',
        onclick: () => toggleNodeLock(anchor),
      }));
    }
    if (group) {
      items.push(el('span', { class: 'wb-menu-label', text: 'Group colour' }));
      items.push(el('div', { class: 'wb-menu-swatches' }, GROUP_COLORS.map((color) => el('button', {
        class: 'wb-menu-swatch',
        type: 'button',
        style: `background:${color}`,
        'aria-label': `Group colour ${color}`,
        onclick: () => setGroupColor(group.id, color),
      }))));
      items.push(el('span', { class: 'wb-menu-label', text: 'Group icon' }));
      const currentIcon = group.icon || GROUP_GENERIC_ICON;
      items.push(el('div', { class: 'wb-menu-icons' }, GROUP_ICONS.map((icon) => el('button', {
        class: `wb-menu-icon${icon === currentIcon ? ' is-current' : ''}`,
        type: 'button',
        text: icon,
        'aria-label': `Group icon ${icon}`,
        onclick: () => setGroupIcon(group.id, icon),
      }))));
      items.push(el('button', {
        class: 'wb-menu-item', type: 'button', text: 'Rename group',
        onclick: () => { closeMenu(); renameGroup(group.id); },
      }));
      items.push(el('button', {
        class: 'wb-menu-item', type: 'button', text: 'Split into progression columns',
        title: isGroupLocked(group)
          ? 'Locked group contents cannot be rearranged'
          : 'Lay the group out like a Kanban board: top items of the heading tree on the left, each deeper tier one column to the right',
        disabled: isGroupLocked(group) ? true : undefined,
        onclick: () => {
          closeMenu();
          splitGroupProgression(group.id);
        },
      }));
      items.push(el('button', {
        class: 'wb-menu-item', type: 'button', text: collapsedGroups[group.id] ? 'Expand group' : 'Collapse to summary',
        title: collapsedGroups[group.id]
          ? 'Show the group’s cards again'
          : 'Hide the group’s cards behind one summary card — name, count, types, links',
        onclick: () => { setGroupCollapsed(group.id, !collapsedGroups[group.id]); closeMenu(); },
      }));
      items.push(el('button', {
        class: 'wb-menu-item', type: 'button', text: group.locked ? 'Unlock group' : 'Lock group',
        title: group.locked
          ? 'Unlock this group’s contents — relationships to the group stay in place'
          : 'Lock this group’s contents against moving, regrouping, and removal — relationships in and out still work',
        onclick: () => toggleGroupLock(group.id),
      }));
      items.push(el('button', {
        class: 'wb-menu-item', type: 'button', text: group.pinned ? 'Unpin group' : 'Pin group',
        title: group.pinned
          ? 'Unpin this group — Arrange may move its contents again'
          : 'Pin this group where it stands — Arrange works around its contents',
        onclick: () => toggleGroupPin(group.id),
      }));
      const ungroupButton = el('button', {
        class: 'wb-menu-item', type: 'button', text: 'Ungroup',
        title: isGroupLocked(group) ? 'Locked group contents cannot be removed' : 'Dissolve the whole group, leaving its cards where they are',
        onclick: () => ungroup(group.id),
      });
      if (isGroupLocked(group)) ungroupButton.disabled = true;
      items.push(ungroupButton);
      // A member card can move to another group, or simply leave this one —
      // unless the group is locked, when its contents stay put.
      if (!isGroupLocked(group)) items.push(...addToGroupItems(anchor));
      if (anchor && !isGroupLocked(group)) {
        items.push(el('button', {
          class: 'wb-menu-item', type: 'button', text: `Remove from ${group.name || 'group'}`,
          title: 'Take this note out of the group — every other card stays put',
          onclick: () => {
            let left = null;
            step(() => {
              left = removeFromGroup(anchor);
              if (!left) return;
              savePositions();
              build();
            }, `Remove “${noteTitle(anchor)}” from ${group.name || 'the group'}`);
            closeMenu();
            if (!left) return;
            // Removing the last-but-one card dissolved the group: it is gone
            // from the record, and the toast says so.
            const dissolved = !groups[left.id];
            app.toast(dissolved
              ? `“${noteTitle(anchor)}” left ${left.name || 'the group'} — the group is gone`
              : `“${noteTitle(anchor)}” left ${left.name || 'the group'}`,
              'ok', 1600);
          },
        }));
      }
    } else {
      const groupButton = el('button', {
        class: 'wb-menu-item', type: 'button', text: 'Group',
        title: selected.size < 2 ? 'Select at least two nodes (Ctrl+click)' : `Stack ${selected.size} selected notes into a column`,
        onclick: () => { closeMenu(); groupSelected(); },
      });
      if (selected.size < 2) groupButton.disabled = true;
      items.push(groupButton);
      items.push(...addToGroupItems(anchor));
    }
    if (selected.size >= 2) {
      items.push(el('span', { class: 'wb-menu-label', text: `Align & distribute (${selected.size})` }));
      const layouts = [
        ['Align left', 'left'],
        ['Align centres', 'center-x'],
        ['Align right', 'right'],
        ['Align top', 'top'],
        ['Align vertical centres', 'center-y'],
        ['Align bottom', 'bottom'],
      ];
      if (selected.size >= 3) {
        layouts.push(['Distribute horizontally', 'distribute-x']);
        layouts.push(['Distribute vertically', 'distribute-y']);
      }
      for (const [label, mode] of layouts) {
        items.push(el('button', {
          class: 'wb-menu-item', type: 'button', text: label,
          title: `Lay out the ${selected.size} selected cards: ${label.toLowerCase()}`,
          onclick: () => { closeMenu(); applySelectionLayout(mode, label); },
        }));
      }
    }
    if (selected.size) {
      items.push(el('button', {
        class: 'wb-menu-item', type: 'button', text: 'Clear selection',
        onclick: () => { selected = new Set(); closeMenu(); build(); },
      }));
    }
    showMenu(event, items);
  }

  // A connector’s invisible hit path sits over its visible line, but a
  // click can still land on the painted stroke. Treat either as a wire
  // selection before the stage can treat it as background panning. Labels
  // are excluded: their click cycles the relationship instead.
  edgeSvg.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    // The diamond ending a cut-off wire is a shortcut to the card beyond it.
    const cut = event.target.closest?.('[data-cut-to]');
    if (cut) {
      event.stopPropagation();
      event.preventDefault();
      focusEndpoint(cut.getAttribute('data-cut-to'));
      return;
    }
    const target = event.target.closest?.('.wb-edge, .wb-edge-hit');
    const key = target?.getAttribute('data-edge-key');
    if (!key) return;
    event.stopPropagation();
    event.preventDefault();
    toggleConnectorSelection(key, event.ctrlKey || event.metaKey);
  });

      stage.addEventListener('contextmenu', (event) => {
      const annotation = event.target.closest?.('[data-annotation-id]');
      if (annotation) {
        const pressed = contextMenuPressSeen;
        const pressedField = contextMenuPressField;
        contextMenuPressSeen = false;
        contextMenuPressField = null;
        const field = event.target.closest?.('input, textarea');
        const editing = pressed ? field === pressedField : field === document.activeElement;
        if (field && editing) return;
        const id = annotation.getAttribute('data-annotation-id');
        const current = annotations[id];
        if (!current) return;
        event.preventDefault();
        closeMenu();
        const items = [
          el('span', { class: 'wb-menu-label', text: 'Annotation colour' }),
          el('div', { class: 'wb-menu-swatches' }, GROUP_COLORS.map((color) => el('button', {
            class: `wb-menu-swatch${current.color === color ? ' is-current' : ''}`,
            type: 'button',
            style: `background:${color}`,
            'aria-label': `Annotation colour ${color}`,
            onclick: () => setAnnotationColor(id, color),
          }))),
        ];
        if (current.color) {
          items.push(el('button', {
            class: 'wb-menu-item', type: 'button', text: 'Use default colour',
            title: 'Return this annotation to its default yellow',
            onclick: () => setAnnotationColor(id, null),
          }));
        }
        showMenu(event, items);
        return;
      }
      openMenu(event);
    });


  /** A DOM element's box in canvas coordinates, for the label clearance pass. */
  function canvasRectOf(element) {
    if (!element) return null;
    const stageBox = stage.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    if (!box.width || !box.height) return null;
    return {
      x: (box.left - stageBox.left - view.x) / view.s,
      y: (box.top - stageBox.top - view.y) / view.s,
      width: box.width / view.s,
      height: box.height / view.s,
    };
  }

  /**
   * The surfaces a connector word must not cover: every visible card, a
   * collapsed group's summary, a group's border stroke (its fill is only a
   * backdrop, so a word may sit inside the box), and a group's title tab.
   * Built once per draw and shared by every label.
   */
  function labelSurfaceRects() {
    const rects = [];
    if (model?.intro) rects.push({ x: PAD, y: PAD, width: CARD_W + 160, height: INTRO_H });
    (model?.notes ?? []).forEach((note, index) => {
      if (!isGroupHidden(note.anchor)) rects.push(rectOf(index));
    });
    const stroke = 4;
    for (const group of Object.values(groups ?? {})) {
      if (hasCollapsedAncestor(group.id)) continue;
      if (collapsedGroups[group.id]) {
        const summary = summaryRect(group);
        if (summary) rects.push(summary);
        continue;
      }
      const box = groupBox(group);
      if (!box) continue;
      const pad = 12;
      const topPad = group.layout === 'progression' ? 30 : pad;
      const x = box.x - pad;
      const y = box.y - topPad;
      const width = box.width + pad * 2;
      const height = box.height + topPad + pad;
      rects.push(
        { x, y: y - stroke, width, height: stroke * 2 },
        { x, y: y + height - stroke, width, height: stroke * 2 },
        { x: x - stroke, y, width: stroke * 2, height },
        { x: x + width - stroke, y, width: stroke * 2, height },
      );
    }
    cards.querySelectorAll('.wb-group-tab').forEach((tab) => {
      const rect = canvasRectOf(tab);
      if (rect) rects.push(rect);
    });
    return rects;
  }

  /** The smallest rectangle around a group's cards, plus those cards' indexes. */
  function groupBox(group) {
    const indexes = [...effectiveMembers(group)]
      .map((anchor) => model.notes.findIndex((note) => note.anchor === anchor))
      .filter((index) => index >= 0);
    if (indexes.length < 2) return null;
    const rects = indexes.map(rectOf);
    const minX = Math.min(...rects.map((rect) => rect.x));
    const minY = Math.min(...rects.map((rect) => rect.y));
    const maxX = Math.max(...rects.map((rect) => rect.x + rect.width));
    const maxY = Math.max(...rects.map((rect) => rect.y + rect.height));
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY, indexes };
  }

  /** Where one end of a relationship sits: a card's box, or a group's bounds. */
  function endpointRect(endpoint) {
    if (endpoint.startsWith('group:')) {
      const group = groups[endpoint.slice('group:'.length)];
      if (!group) return null;
      return collapsedGroups[group.id] ? summaryRect(group) : groupBox(group);
    }
    if (isGroupHidden(endpoint)) return null;
    const index = model.notes.findIndex((note) => note.anchor === endpoint);
    return index < 0 ? null : rectOf(index);
  }

  /**
   * A hidden card's real place, for a trimmed wire: the card is inside a
   * collapsed group, but its diamond must still point the way to it and be
   * clickable. Ordinary (short) wires keep the collapsed group clean and are
   * not drawn at all.
   */
  function hiddenCardRect(endpoint) {
    if (!endpoint || endpoint.startsWith('group:') || !isGroupHidden(endpoint)) return null;
    const index = model.notes.findIndex((note) => note.anchor === endpoint);
    return index < 0 ? null : rectOf(index);
  }

  /** Step one bond's asserted kind to the next in the scale, and persist it. */
  function cycleRelation({ from, to }) {
    if (!from || !to || !currentPath) return;
    const current = relationOf(relations, from, to);
    const index = RELATION_KINDS.findIndex((kind) => kind.id === current.id);
    const next = RELATION_KINDS[(index + 1) % RELATION_KINDS.length];
    step(() => {
      relations = app.setWorldRelation(currentPath, from, to, next.id) ?? relations;
      drawEdges();
      build();
    }, `Relate “${endpointTitle(from)}” to “${endpointTitle(to)}”: ${next.label}`);
    app.toast(`“${endpointTitle(from)}” ${next.label.toLowerCase()} “${endpointTitle(to)}”`, 'ok', 1800);
  }

  /** A collapsed group's summary card sits at its box's top-left. */
  function summaryRect(group) {
    const box = groupBox(group);
    if (!box) return null;
    return { x: box.x - 12, y: box.y - 12, width: 280, height: 120 };
  }

  function buildGroupSummary(group) {
    const rect = summaryRect(group);
    if (!rect) return null;
    const color = group.color || GROUP_DEFAULT_COLOR;
    const members = [...effectiveMembers(group)];
    const typeCounts = new Map();
    let links = 0;
    for (const anchor of members) {
      const note = (model.notes ?? []).find((n) => n.anchor === anchor);
      if (!note) continue;
      typeCounts.set(nodeTypeOf(nodeTypes, anchor).label, (typeCounts.get(nodeTypeOf(nodeTypes, anchor).label) ?? 0) + 1);
      links += note.links?.length ?? 0;
    }
    const breakdown = [...typeCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([label, count]) => `${count} ${label.toLowerCase()}${count === 1 ? '' : 's'}`).join(' · ');
    const summary = el('div', {
      class: `wb-group-summary${isGroupLocked(group) ? ' is-locked' : ''}${group.pinned ? ' is-pinned' : ''}`,
      dataset: { groupId: group.id },
      title: `${group.name || 'Group'} — ${members.length} cards · drag to move · double-click to expand`,
    }, [
      el('span', { class: 'wb-group-summary-icon', text: group.icon || GROUP_GENERIC_ICON, style: `color:${color}` }),
      el('span', { class: 'wb-group-summary-name', text: group.name || 'Group' }),
      el('span', { class: 'wb-group-summary-meta', text: `${members.length} card${members.length === 1 ? '' : 's'}${breakdown ? ` · ${breakdown}` : ''} · ${links} link${links === 1 ? '' : 's'}` }),
      el('span', { class: 'wb-group-summary-hint', text: 'Double-click to expand' }),
    ]);
    summary.style.left = `${rect.x}px`;
    summary.style.top = `${rect.y}px`;
    summary.style.borderLeftColor = color;
    summary.addEventListener('pointerdown', (event) => {
      event.stopPropagation();
      if (isGroupLocked(group)) {
        app.toast(`“${group.name || 'Group'}” is locked — unlock it before moving its contents`, 'warn', 2200);
        event.preventDefault();
        return;
      }
      const indexes = members
        .map((anchor) => model.notes.findIndex((note) => note.anchor === anchor))
        .filter((index) => index >= 0);
      if (!indexes.length) return;
      dragMembers(members, event, summary, { groupId: group.id });
    });
    summary.addEventListener('click', () => setSelection(new Set(members)));
    summary.addEventListener('dblclick', (event) => {
      event.stopPropagation();
      setGroupCollapsed(group.id, false);
    });
    return summary;
  }

  /** The coloured box around a group: the tightest rect over its cards. */
  function drawGroupBoxes() {
    // Tabs live in the DOM cards layer, not the SVG that drawEdges clears —
    // remove them first or every draw (every drag frame!) stacks another.
    cards.querySelectorAll('.wb-group-tab, .wb-group-summary').forEach((tab) => tab.remove());
    // Parents first, so nested boxes draw over the fill of their parents.
    const depths = groupDepths();
    const ordered = Object.values(groups ?? {}).sort((a, b) => depths.get(a.id) - depths.get(b.id));
    for (const group of ordered) {
      if (hasCollapsedAncestor(group.id)) continue;
      if (collapsedGroups[group.id]) {
        // A collapsed group is its summary card; its members hide beneath it.
        const summary = buildGroupSummary(group);
        if (summary) cards.append(summary);
        continue;
      }
      const box = groupBox(group);
      if (!box) continue;
      const indexes = box.indexes;
      const pad = 12;
      // A progression board reserves a header strip above its top cards:
      // the tier words sit there, in the box's own padding, instead of
      // under the cards that start each lane.
      const topPad = group.layout === 'progression' ? 30 : pad;
      const color = group.color || GROUP_DEFAULT_COLOR;
      const boxX = box.x - pad;
      const boxY = box.y - topPad;
      const boxHeight = box.height + topPad + pad;
      edgeSvg.append(svgNode('rect', {
        class: `wb-box${dropTargetId === group.id ? ' is-drop-target' : ''}${isGroupLocked(group) ? ' is-locked' : ''}${group.pinned ? ' is-pinned' : ''}`,
        x: boxX,
        y: boxY,
        width: box.width + pad * 2,
        height: boxHeight,
        rx: 10,
        fill: color,
        'fill-opacity': 0.07,
        stroke: color,
        'stroke-opacity': 0.75,
        'stroke-width': 2,
      }));
      const tierLabels = [];
      // A group split into progression columns wears its board: one lane per
      // heading-tree tier, labelled at the top, behind the cards.
      if (group.layout === 'progression') {
        const columns = progressionColumns(model, [...effectiveMembers(group)]);
        const byColumn = new Map();
        for (const index of indexes) {
          const column = columns.get(model.notes[index].anchor) ?? 0;
          const list = byColumn.get(column) ?? [];
          list.push(rectOf(index));
          byColumn.set(column, list);
        }
        for (const [column, rects] of [...byColumn.entries()].sort((a, b) => a[0] - b[0])) {
          const laneX = Math.min(...rects.map((rect) => rect.x)) - 8;
          const laneW = Math.max(...rects.map((rect) => rect.x + rect.width)) - laneX + 8;
          edgeSvg.append(svgNode('rect', {
            class: 'wb-column-lane',
            x: laneX,
            y: boxY,
            width: laneW,
            height: boxHeight,
            rx: 8,
            fill: color,
            'fill-opacity': column % 2 ? 0.04 : 0.1,
          }));
          const label = svgNode('text', {
            class: 'wb-column-label',
            x: laneX + 10,
            y: boxY + 21,
          });
          label.textContent = `Tier ${column + 1}`;
          edgeSvg.append(label);
          tierLabels.push(label);
        }
      }
      // The title: a mini node header straddling the box's top-left corner —
      // grip, accent edge, name — and it grabs the whole group to drag.
      const name = group.name || 'Group';
      const tab = el('div', {
        class: `wb-group-tab${isGroupLocked(group) ? ' is-locked' : ''}${group.pinned ? ' is-pinned' : ''}`,
        dataset: { groupId: group.id },
        title: isGroupLocked(group)
          ? `${name} — locked; unlock from its menu`
          : group.pinned ? `${name} — pinned; Arrange works around it` : `${name} — drag to move the group`,
      }, [
        el('span', {
          class: 'wb-grip',
          text: isGroupLocked(group) ? '🔒' : group.pinned ? '📌' : '⠿',
        }),
        el('span', {
          class: 'wb-group-icon',
          text: group.icon || GROUP_GENERIC_ICON,
          style: `color:${color}`,
          title: group.icon ? `Icon: ${group.icon}` : 'No icon set',
        }),
        el('span', { class: 'wb-card-title static', text: name }),
      ]);
      tab.style.left = `${boxX}px`;
      tab.style.top = `${boxY - 12}px`;
      tab.style.borderLeft = `3px solid ${color}`;
      tab.addEventListener('pointerdown', (event) => {
        event.stopPropagation();
        if (isGroupLocked(group)) {
          app.toast(`“${name}” is locked — unlock it before moving its contents`, 'warn', 2200);
          event.preventDefault();
          return;
        }
        dragMembers([...effectiveMembers(group)], event, cardEls[indexes[0]], { groupId: group.id });
      });
      // Double-clicking the name edits it in place, like a card's title.
      const nameEl = tab.querySelector('.wb-card-title');
      nameEl.addEventListener('dblclick', (event) => {
        event.stopPropagation();
        inlineGroupRename(nameEl, group);
      });
      cards.append(tab);
      // The tab straddles the box's top-left corner, exactly where Tier 1
      // would sit: nudge that one word right of the tab (in canvas units)
      // so the first header is not covered by the group's own title.
      if (tierLabels.length) {
        const first = tierLabels[0];
        const shift = (tab.getBoundingClientRect().right - first.getBoundingClientRect().left + 8) / view.s;
        if (shift > 0) first.setAttribute('x', String(Number(first.getAttribute('x')) + shift));
      }
    }
  }

  function drawEdges() {
    clear(edgeSvg);
    if (!model) return;
    const defs = svgNode('defs');
    const marker = svgNode('marker', {
      id: 'wb-arrow',
      markerWidth: 10,
      markerHeight: 10,
      refX: 8,
      refY: 5,
      orient: 'auto-start-reverse',
      markerUnits: 'userSpaceOnUse',
    });
    marker.append(svgNode('path', { d: 'M0,0 L10,5 L0,10 z', class: 'wb-arrowhead' }));
    defs.append(marker);
    edgeSvg.append(defs);
    drawGroupBoxes();

    // Every connector names its ends the same way — a note anchor or a group
    // endpoint — so prose links, the outline spine and group bonds all draw
    // and label through one path.
    const connectors = connectorList(model, groups, relations);
    // A selection outlives a redraw but not its connector: prune dead keys.
    const live = new Set(connectors.map(connectorKey));
    if ([...selectedEdges].some((key) => !live.has(key))) {
      selectedEdges = new Set([...selectedEdges].filter((key) => live.has(key)));
    }

    // Every connector keeps its own geometry: the shared preparation fans
    // bonds that share an end into lanes, keeps stacked pairs vertical, and
    // applies each edge's routing; the spread pass then separates whole wires
    // that would still land on one path. The scorer calls the same preparation
    // against its candidate boxes, so it scores what is drawn.
    const prepared = prepareConnectorGeometry(connectors, {
      rectFor: endpointRect,
      routing,
      isStacked: (from, to) => isStackedPair(from, to),
      proxyRectFor: hiddenCardRect,
    });

    // Words are placed once every wire is drawn: each sits on its own wire,
    // and moves along it to avoid neighbours, crossing wires, cards and group
    // borders.
    const labels = [];
    const surfaceRects = labelSurfaceRects();
    const drawnConnectors = spreadConnectorCurves(prepared);
    for (const { edge, key, eff, stacked, path, at, headAtStart, cut } of drawnConnectors) {
      const isGroup = edge.from.startsWith('group:') || edge.to.startsWith('group:');
      const relation = edge.relation ? relationKind(edge.relation) : null;
      const kindClass = `wb-edge-${isGroup ? 'group' : edge.kind}`;
      const line = svgNode('path', {
        class: `wb-edge ${kindClass}${relation ? ` wb-rel-${relation.id}` : ''}${selectedEdges.has(key) ? ' is-selected' : ''}`,
        d: path,
        fill: 'none',
        'data-from': edge.from,
        'data-to': edge.to,
        'data-edge-key': key,
        ...(eff.arrows && !cut
          ? headAtStart ? { 'marker-start': 'url(#wb-arrow)' } : { 'marker-end': 'url(#wb-arrow)' }
          : {}),
      });
      const title = svgNode('title');
      title.textContent = relation
        ? `${endpointTitle(edge.from)} ${relation.label.toLowerCase()} ${endpointTitle(edge.to)}`
        : `${endpointTitle(edge.from)} → ${endpointTitle(edge.to)}`;
      line.append(title);
      edgeSvg.append(line);
      // Put the invisible fat twin over the visible wire, so the whole wire
      // is a selection target rather than only its painted stroke.
      const hit = svgNode('path', {
        class: 'wb-edge-hit',
        d: path,
        fill: 'none',
        'data-edge-key': key,
      });
      edgeSvg.append(hit);
      if (cut) edgeSvg.append(cutMarker(edge, key, cut, relation, isGroup ? '' : kindClass));
      // The asserted kind, read right on the line; Associate stays unlabelled
      // because it is the default every plain link already has. A stacked
      // pair's wire is only STACK_GAP long — the word would sit on the cards
      // (and the slots near its ends land inside them), so stacked wires
      // carry no word; the kind is still on the wire's tooltip and in its
      // right-click menu.
      if (!relation || relation.id === DEFAULT_RELATION || stacked) continue;
      const text = svgNode('text', {
        class: `wb-edge-label wb-rel-${relation.id}`,
        'text-anchor': 'middle',
        'dominant-baseline': 'central',
        'data-edge-key': key,
      });
      text.textContent = relation.label.toLowerCase();
      // The word is the handle: click it and the asserted kind steps to the
      // next one in the scale (weakest to strongest, then wraps).
      const tip = svgNode('title');
      tip.textContent = 'Click to change this relationship — right-click for more connector options';
      text.append(tip);
      text.addEventListener('click', (event) => {
        event.stopPropagation();
        cycleRelation(edge);
      });
      edgeSvg.append(text);
      let box = null;
      try {
        box = text.getBBox();
      } catch {
        // A not-yet-laid-out SVG can refuse measurement; the helper falls
        // back to a conservative word-sized box in that case.
      }
      labels.push({
        text,
        at,
        label: relation.label.toLowerCase(),
        width: box?.width,
        height: box?.height,
        obstacles: drawnConnectors
          .filter((connector) => connector.key !== key)
          .map((connector) => connector.at),
        rects: surfaceRects,
      });
    }
    placeLabels(labels);
    syncConnectorUi();
  }

  /**
   * The geometric end of a cut-off wire: a diamond facing the far card, with
   * a chevron inside it. That card can be screens away, so the diamond is
   * also the way there — a click flies the camera to it.
   */
  function cutMarker(edge, key, cut, relation, kindClass = '') {
    const angle = (Math.atan2(cut.dir.y, cut.dir.x) * 180) / Math.PI;
    const marker = svgNode('g', {
      class: `wb-edge-cut${kindClass ? ` ${kindClass}` : ''}${relation ? ` wb-rel-${relation.id}` : ''}${selectedEdges.has(key) ? ' is-selected' : ''}`,
      transform: `translate(${cut.x} ${cut.y}) rotate(${angle})`,
      'data-cut-to': edge.to,
    });
    const tip = svgNode('title');
    tip.textContent = `“${endpointTitle(edge.to)}” is ${Math.round(cut.total - cut.length)}px beyond this cut — click to fly to it`;
    marker.append(tip);
    marker.append(svgNode('circle', { class: 'wb-edge-cut-hit', r: 15 }));
    marker.append(svgNode('path', { class: 'wb-edge-cut-shape', d: 'M 0 -10 L 10 0 L 0 10 L -10 0 Z' }));
    marker.append(svgNode('path', { class: 'wb-edge-cut-chevron', d: 'M -3 -5 L 3 0 L -3 5' }));
    return marker;
  }

  // Where along the wire a word may sit, nearest to the middle first: a crowded
  // word walks outwards in small steps instead of settling on a neighbour,
  // which is what keeps a hub's fan of kinds readable. The far ends are left
  // alone — a word nearer than a fifth of the way sits on the card it leaves.
  // The least daylight between two words, enough for the halo around each
  // one's glyphs. Connector lanes are only 16px apart, so words on neighbouring
  // wires often need to stagger along the wire to stay separate.
  const LANE_PITCH = 16;

  /** Lay labels at clear wire slots, or with a short leader when crowded. */
  function placeLabels(labels) {
    const positions = placeConnectorLabels(labels);
    labels.forEach(({ text }, index) => {
      const spot = positions[index];
      if (!spot) {
        text.remove();
        return;
      }
      if (spot.leader) {
        const leader = svgNode('path', {
          class: 'wb-edge-label-leader',
          d: `M ${spot.leader.x} ${spot.leader.y} L ${spot.x} ${spot.y}`,
          fill: 'none',
          'aria-hidden': 'true',
        });
        edgeSvg.insertBefore(leader, text);
      }
      text.setAttribute('x', spot.x);
      text.setAttribute('y', spot.y);
    });
  }

  function scheduleEdges() {
    if (edgeFrame) return;
    edgeFrame = requestAnimationFrame(() => {
      edgeFrame = 0;
      drawEdges();
    });
  }

  stage.addEventListener('pointerdown', (event) => {
    // Cards and annotations handle their own drags and controls; everything
    // else in the stage is background: dragging it pans, and Shift+dragging
    // it draws a marquee selection (Ctrl+Shift adds to the selection).
    if (event.target.closest?.('.wb-card, .wb-annotation, [data-edge-key], button, input, select, textarea')) return;
    if (event.shiftKey && event.button === 0) {
      const additive = event.ctrlKey || event.metaKey;
      marquee = {
        startX: event.clientX,
        startY: event.clientY,
        additive,
        base: additive ? new Set(selected) : new Set(),
        moved: false,
      };
      event.preventDefault();
      return;
    }
    panning = { startX: event.clientX, startY: event.clientY, viewX: view.x, viewY: view.y };
    stage.classList.add('is-panning');
    event.preventDefault();
  });

  stage.addEventListener('dblclick', (event) => {
    if (event.target.closest?.('.wb-card, .wb-annotation, button, input, select, textarea')) return;
    const rect = stage.getBoundingClientRect();
    addAnnotation({
      x: (event.clientX - rect.left - view.x) / view.s - ANNOTATION_W / 2,
      y: (event.clientY - rect.top - view.y) / view.s - ANNOTATION_H / 2,
    });
  });

  window.addEventListener('resize', applyView);
  // Words are placed from the glyphs' own measured boxes. A canvas that is
  // laid out while hidden — or before its font settles — measures nothing, so
  // every word degenerates to the middle of its wire and stays there. Lay the
  // words out again once the stage has a real size and once the fonts are
  // ready: the pane may be shown long after it was first drawn.
  if (typeof ResizeObserver === 'function') {
    const stageObserver = new ResizeObserver(() => {
      // Leaving Worldbuilding hides the stage with the pane, but the panel's
      // menus attach to the body: close them so none floats over the reader.
      if (!stage.offsetWidth) closeMenu();
      applyView();
      scheduleEdges();
    });
    stageObserver.observe(stage);
  }
  const relayoutLabels = () => scheduleEdges();
  document.fonts?.ready?.then(relayoutLabels);
  document.fonts?.addEventListener?.('loadingdone', relayoutLabels);

  window.addEventListener('pointermove', (event) => {
    if (marquee) {
      const rect = stage.getBoundingClientRect();
      const left = Math.min(marquee.startX, event.clientX) - rect.left;
      const top = Math.min(marquee.startY, event.clientY) - rect.top;
      const width = Math.abs(event.clientX - marquee.startX);
      const height = Math.abs(event.clientY - marquee.startY);
      if (Math.max(width, height) > 3) marquee.moved = true;
      marqueeBox.classList.toggle('hidden', !marquee.moved);
      if (marquee.moved) {
        marqueeBox.style.left = `${left}px`;
        marqueeBox.style.top = `${top}px`;
        marqueeBox.style.width = `${width}px`;
        marqueeBox.style.height = `${height}px`;
        const box = {
          x: (left - view.x) / view.s,
          y: (top - view.y) / view.s,
          width: width / view.s,
          height: height / view.s,
        };
        const rects = (model?.notes ?? []).map((note, index) => ({ anchor: note.anchor, ...rectOf(index) }));
        const hits = anchorsInRect(rects, box);
        setSelection(marquee.additive ? new Set([...marquee.base, ...hits]) : hits);
      }
      return;
    }
    if (panning) {
      view.x = panning.viewX + (event.clientX - panning.startX);
      view.y = panning.viewY + (event.clientY - panning.startY);
      applyView();
      return;
    }
    if (!dragging) return;
    const rect = canvas.getBoundingClientRect();
    const point = {
      x: (event.clientX - rect.left) / view.s,
      y: (event.clientY - rect.top) / view.s,
    };
    // One shared delta for every member (clamped so none leaves the canvas
    // at the top-left), so a group can never tear itself apart mid-drag.
    const minStartX = Math.min(...dragging.members.map((m) => m.start.x));
    const minStartY = Math.min(...dragging.members.map((m) => m.start.y));
    let dx = Math.max(4 - minStartX, point.x - dragging.grab.x);
    let dy = Math.max(4 - minStartY, point.y - dragging.grab.y);
    // Smart guides: line the dragged set up with every other card's edges
    // and centrelines when it comes within a few screen pixels, and draw
    // the lines it matched. The threshold is screen-space, so it grows in
    // canvas pixels as the canvas zooms out.
    const rects = dragging.members.map((member) => ({
      x: member.start.x + dx,
      y: member.start.y + dy,
      width: CARD_W,
      height: member.el.offsetHeight || CARD_H,
    }));
    const dragRect = {
      x: Math.min(...rects.map((rect) => rect.x)),
      y: Math.min(...rects.map((rect) => rect.y)),
      width: Math.max(...rects.map((rect) => rect.x + rect.width)) - Math.min(...rects.map((rect) => rect.x)),
      height: Math.max(...rects.map((rect) => rect.y + rect.height)) - Math.min(...rects.map((rect) => rect.y)),
    };
    const draggedAnchors = new Set(dragging.members.map((member) => member.anchor));
    const others = (model?.notes ?? [])
      .map((note, index) => ({ note, index }))
      .filter(({ note }) => !draggedAnchors.has(note.anchor))
      .map(({ index }) => rectOf(index));
    const snapped = snapDelta(dragRect, others, Math.min(16, Math.max(2, 8 / view.s)));
    dx = Math.max(4 - minStartX, dx + snapped.dx);
    dy = Math.max(4 - minStartY, dy + snapped.dy);
    paintGuides(snapped.guides);
    dragging.distance = Math.hypot(dx, dy);
    for (const member of dragging.members) {
      const x = member.start.x + dx;
      const y = member.start.y + dy;
      positions.set(member.anchor, { x, y });
      member.el.style.left = `${x}px`;
      member.el.style.top = `${y}px`;
    }
    // The box this card would join is drawn lit while it is over it.
    dropTargetId = joinTargetId();
    scheduleEdges();
  });

  // The wheel zooms the graph around the pointer — no modifier needed (a
  // trackpad pinch is just a ctrl+wheel, which zooms the same way). The stage
  // is a bounded viewport, so there is no scroll inside it to give up.
  stage.addEventListener('wheel', (event) => {
    event.preventDefault();
    const rect = stage.getBoundingClientRect();
    view = zoomViewAt(view, event.clientX - rect.left, event.clientY - rect.top, Math.exp(-event.deltaY * 0.002));
    applyView();
    // Zooming moves the saved anchor too; the save is debounced underneath,
    // so a pinch stream collapses into one write.
    persistView();
  }, { passive: false });

  window.addEventListener('pointerup', () => {
    if (marquee) {
      // A Shift+click on empty canvas clears the selection; a real drag
      // leaves whatever the marquee picked.
      if (!marquee.moved && !marquee.additive) setSelection([]);
      marquee = null;
      marqueeBox.classList.add('hidden');
    }
    if (panning) {
      panning = null;
      stage.classList.remove('is-panning');
      persistView();
    }
    if (!dragging) return;
    const drop = dragging;
    dragging = null;
    dropTargetId = null;
    paintGuides([]);
    drop.el.classList.remove('is-dragging');
    drop.members.forEach((member) => member.el.classList.remove('is-dragging'));
    sizeCanvas();
    drawEdges();
    savePositions();
    // A drop's membership change is part of the drag, so one undo puts the
    // card back where it came from and out of the group again. A folded card
    // dropped above a node it links to stacks with it, in the same step.
    const dropName = dropMembership(drop);
    restackFoldedCards(drop.members.map((member) => member.anchor));
    commitStep(dropName ?? (drop.groupId ? 'Move group' : drop.selection ? `Move ${drop.members.length} cards` : 'Move card'));
  });

  return {
    render,
    refresh: () => (model ? build() : null),
    get stage() {
      return stage;
    },
  };
}
