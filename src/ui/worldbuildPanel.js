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
import {
  parseNotes, serializeNotes, updateNote, updateIntro, addNote, removeNote,
  noteEdges, hierarchyEdges, noteStats, countWords, DEFAULT_LEVEL,
  normalizeTag, addNoteTags, removeNoteTag, tagRecord,
  RELATION_KINDS, DEFAULT_RELATION, relationOf, relationKind, groupEndpoint,
  groupRelationEdges, bondEdges,
  NODE_TYPES, nodeType, nodeTypeOf, nodeFields, nodeFieldOf, fieldRangeHint,
  clampView, zoomViewAt, anchorOfView, viewOfAnchor,
} from '../lib/worldbuild.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

// Card geometry lives here *and* in styles.css (`.wb-card`). Keep them equal.
const CARD_W = 300;
const CARD_H = 260;
const GAP_X = 96;
const GAP_Y = 76;
const PAD = 26;
const INTRO_H = 150;

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
  const stage = el('div', { class: 'wb-stage' });
  const canvas = el('div', { class: 'wb-canvas' });
  const edgeSvg = svgNode('svg', { class: 'wb-edges', 'aria-hidden': 'true' });
  const cards = el('div', { class: 'wb-cards' });
  const statsBar = el('div', { class: 'wb-stats' });

  canvas.append(edgeSvg, cards);
  stage.append(canvas);
  root.append(toolbar, stage, statsBar);

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
  // Which parts of each card are folded, by anchor: `card` or `links`.
  let folded = {};
  // Canvas edit history, per vein, so switching veins keeps each one's steps.
  // It covers only what the canvas owns — positions, groups, relationships and
  // folds — and never joins the vein's own undo of its markdown.
  const historyByPath = new Map();
  const HISTORY_LIMIT = 60;
  // Taken when a drag starts, pushed on release: a whole drag is one step.
  let dragSnapshot = null;
  let nodeTypes = {};
  let fieldValues = {};
  let groups = {};
  let marked = false;
  // The relationship the next link from each card asserts, by note index.
  let linkKinds = new Map();
  let cardEls = [];
  let layout = { cols: 1, top: PAD };
  let dragging = null;
  // The group a dragged card would join if released where it is — lit while
  // the card is over its box, null the rest of the time.
  let dropTargetId = null;
  let edgeFrame = 0;
  // Nodes picked with Ctrl+click on the head, by anchor. Transient UI state:
  // the canvas groups them, then the selection is spent.
  let selected = new Set();
  let menuEl = null;
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
      mounted = false;
      model = null;
      currentPath = null;
      lastText = null;
      clear(toolbar);
      clear(statsBar);
      clear(cards);
      return;
    }

    const text = sourceText(doc);
    if (mounted && currentPath === doc.path && text === lastText) return;

    currentPath = doc.path;
    lastText = text;
    model = parseNotes(text);
    const record = app.worldRecord?.(doc.path) ?? null;
    marked = Boolean(record?.marked);
    positions = new Map(Object.entries(record?.positions ?? {}));
    relations = record?.relations ?? {};
    folded = record?.folded ?? {};
    nodeTypes = record?.types ?? {};
    fieldValues = record?.fields ?? {};
    groups = record?.groups ?? {};
    // The saved view: the canvas point in the viewport's top-left corner at
    // the zoom it was left at, so the graph reopens exactly as it was left.
    view = viewOfAnchor(record?.view) ?? { x: 0, y: 0, s: 1 };
    linkKinds = new Map();
    mounted = true;
    build();
  }

  function build() {
    renderToolbar();
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
      el('span', { class: 'wb-hint', text: 'Each card is a heading of this vein — typing here edits the markdown, and cards can be tagged #like this' }),
      el('div', { class: 'spacer' }),
      undoBtn,
      redoBtn,
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
        class: 'btn btn-ghost btn-mini', type: 'button', text: 'Arrange',
        title: 'Tidy the cards back into a grid — groups move as one unit',
        onclick: () => step(() => {
          arrangeAll();
          view = { x: 0, y: 0, s: 1 };
          savePositions();
          persistView();
          build();
        }),
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

  /** Persist the card positions, so the graph reappears as it was left. */
  function savePositions() {
    if (!currentPath) return;
    app.saveWorldLayout(currentPath, Object.fromEntries(positions));
  }

  /**
   * A fold toggle for one part of a card. It shows the part's open/closed
   * glyph and writes the state through, so the vein reopens as it was left.
   */
  function foldToggle(anchor, part, label) {
    const button = el('button', { class: 'wb-fold-toggle', type: 'button' });
    const paint = () => {
      const closed = isFolded(anchor, part);
      button.textContent = `${closed ? '▸' : '▾'}${label ? ` ${label}` : ''}`;
      button.title = `${closed ? 'Expand' : 'Fold'} ${label || 'section'} for ${endpointTitle(anchor)}`;
      button.setAttribute('aria-label', button.title);
      button.setAttribute('aria-expanded', closed ? 'false' : 'true');
    };
    paint();
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      step(() => {
        folded = app.setWorldFold(currentPath, anchor, part, !isFolded(anchor, part)) ?? folded;
        paint();
        // A fold changes a card's height, and with it every edge that meets it.
        applyFolds();
      });
    });
    return button;
  }

  function isFolded(anchor, part) {
    const entry = folded[anchor];
    // `true` is the older shape, from when a card's own fold was the only one.
    return entry === true ? part === 'card' : Boolean(entry?.[part]);
  }

  /** Put every card's current fold classes on screen, then redraw to fit. */
  function applyFolds() {
    (model?.notes ?? []).forEach((note, index) => {
      const card = cardEls[index];
      if (!card) return;
      card.classList.toggle('is-folded', isFolded(note.anchor, 'card'));
      card.querySelector('.wb-link-section')?.classList.toggle('is-collapsed', isFolded(note.anchor, 'links'));
    });
    sizeCanvas();
    drawEdges();
  }

  /* -------------------------------------------------------------- history -- */

  /**
   * The canvas state an undo step puts back, as a comparable string: the four
   * slices of the vein record the canvas itself owns. The markdown — titles,
   * prose, links — is edited by the vein's own undo, so it never appears here.
   */
  function canvasSnapshot() {
    return JSON.stringify({
      positions: Object.fromEntries(positions),
      groups,
      relations,
      folded,
    });
  }

  /** This vein's steps; kept per path, so switching veins keeps each one's. */
  function historyFor(path) {
    if (!path) return { past: [], future: [] };
    if (!historyByPath.has(path)) historyByPath.set(path, { past: [], future: [] });
    return historyByPath.get(path);
  }

  /** Record one canvas change, unless it left the canvas exactly as it was. */
  function pushStep(before) {
    if (before === canvasSnapshot()) return false;
    const stack = historyFor(currentPath);
    stack.past.push(before);
    if (stack.past.length > HISTORY_LIMIT) stack.past.shift();
    // A new change is a new branch: whatever could have been redone is gone.
    stack.future.length = 0;
    syncHistoryButtons();
    return true;
  }

  /** Run one canvas change as a single undoable step. */
  function step(change) {
    const before = canvasSnapshot();
    const result = change();
    pushStep(before);
    return result;
  }

  /** Open the step a drag closes: the record as it stood before the first move. */
  function beginStep() {
    dragSnapshot = canvasSnapshot();
  }

  function commitStep() {
    const before = dragSnapshot;
    dragSnapshot = null;
    if (before) pushStep(before);
  }

  /** Put a snapshot back on screen and in the record. */
  function restoreCanvas(snap) {
    const saved = JSON.parse(snap);
    positions = new Map(Object.entries(saved.positions ?? {}));
    groups = saved.groups ?? {};
    relations = saved.relations ?? {};
    folded = saved.folded ?? {};
    // Anchors come and go with the steps; a selection would outlive them.
    selected = new Set();
    app.restoreWorldCanvas(currentPath, {
      positions: saved.positions ?? {},
      groups,
      relations,
      folded,
    });
    build();
  }

  function undoCanvas() {
    const stack = historyFor(currentPath);
    const before = stack.past.pop();
    if (!before) return;
    stack.future.push(canvasSnapshot());
    restoreCanvas(before);
    syncHistoryButtons();
  }

  function redoCanvas() {
    const stack = historyFor(currentPath);
    const after = stack.future.pop();
    if (!after) return;
    stack.past.push(canvasSnapshot());
    restoreCanvas(after);
    syncHistoryButtons();
  }

  /** Undo and redo offer only what is there, and say how much there is. */
  function syncHistoryButtons() {
    const stack = historyFor(currentPath);
    undoBtn.disabled = !stack.past.length;
    redoBtn.disabled = !stack.future.length;
    undoBtn.title = stack.past.length
      ? `Undo the last canvas change (Ctrl+Z) — ${stack.past.length} back`
      : 'Nothing to undo on this canvas';
    redoBtn.title = stack.future.length
      ? `Redo the last canvas change (Ctrl+Shift+Z) — ${stack.future.length} forward`
      : 'Nothing to redo on this canvas';
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
    appendAll(clear(statsBar), [
      el('span', { class: 'wb-stat', text: `${stats.notes} notes` }),
      el('span', { class: 'wb-stat', text: `${stats.associations} associations` }),
      el('span', { class: 'wb-stat', text: `${stats.links} links` }),
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
      el('span', { class: 'wb-legend', text: 'solid: links in the prose · dotted: section outline' }),
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
    return { x, y, width: CARD_W, height: cardEls[index]?.offsetHeight || CARD_H };
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
    for (const field of schema) {
      // A numeric field's declared range reaches the input, so its spinners,
      // steppers and validation all work from the same numbers the model
      // clamps to.
      const range = field.kind === 'number'
        ? { min: field.min, max: field.max, step: field.step }
        : {};
      const hint = fieldRangeHint(field);
      const input = el('input', {
        class: 'wb-field-input',
        type: field.kind,
        value: nodeFieldOf(fieldValues, note.anchor, field.id),
        placeholder: field.label,
        spellcheck: 'false',
        title: hint ? `Allowed range: ${hint}` : undefined,
        'aria-label': `${type.label} ${field.label.toLowerCase()}${hint ? ` (${hint})` : ''} for ${note.title || 'this note'}`,
        ...range,
      });
      // Numbers commit on change, not per keystroke: clamping mid-typing
      // would fight the user ("12" against a max of 10). The stored —
      // clamped — value is read back into the box afterwards.
      inputs.set(field.id, input);
      input.addEventListener(field.kind === 'number' ? 'change' : 'input', () => {
        fieldValues = app.setWorldNodeField(currentPath, note.anchor, type.id, field.id, input.value) ?? fieldValues;
        // Read back every box in the row: committing one end of a min/max
        // pair can move the other end with it.
        for (const [fieldId, box] of inputs) box.value = nodeFieldOf(fieldValues, note.anchor, fieldId);
      });
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
    const card = el('article', {
      class: `wb-card wb-level-${note.level}${selected.has(note.anchor) ? ' is-selected' : ''}${isFolded(note.anchor, 'card') ? ' is-folded' : ''}`,
      style: `left:${pos.x}px; top:${pos.y}px; border-left-color:${accent};`,
      'data-note': String(index),
    });

    // The chip is the type's icon in its colour; the heading level survives
    // only as a tooltip now that the icon stands in for it.
    const typeChip = el('span', { class: 'wb-level' });
    const paintTypeChip = (typeId) => {
      const record0 = NODE_TYPES.find((t) => t.id === typeId) ?? NODE_TYPES[0];
      typeChip.textContent = record0.icon ?? '';
      typeChip.style.color = record0.color ?? '';
      typeChip.title = `${record0.label} · heading level ${note.level}`;
    };
    paintTypeChip(type.id);
    const typeSelect = el('select', {
      class: 'wb-type',
      style: type.color ? `color:${type.color}` : undefined,
      'aria-label': `Type of ${note.title || 'this note'}`,
      title: 'What this node is (a note holds markdown, diagrams included)',
    });
    for (const candidate of NODE_TYPES) {
      typeSelect.append(el('option', { value: candidate.id, text: candidate.label }));
    }
    typeSelect.value = type.id;
    typeSelect.addEventListener('change', () => {
      nodeTypes = app.setWorldNodeType(currentPath, note.anchor, typeSelect.value) ?? nodeTypes;
      const chosen = NODE_TYPES.find((t) => t.id === typeSelect.value);
      typeSelect.style.color = chosen?.color ?? '';
      paintTypeChip(typeSelect.value);
      const prior = card.querySelector('.wb-fields');
      const fresh = buildFieldsRow(note, typeSelect.value);
      if (fresh) prior ? prior.replaceWith(fresh) : card.insertBefore(fresh, head.nextSibling);
      else prior?.remove();
      renderStats();
      const label = NODE_TYPES.find((t) => t.id === typeSelect.value)?.label ?? typeSelect.value;
      app.toast(`“${note.title || 'note'}” is a ${label.toLowerCase()}`, 'ok', 1500);
    });
    const title = el('input', {
      class: 'wb-card-title',
      value: note.title,
      spellcheck: 'false',
      'aria-label': `Note title: ${note.title}`,
    });
    const fold = foldToggle(note.anchor, 'card', '');
    const remove = el('button', {
      class: 'wb-card-del', type: 'button', title: 'Delete this note', text: '✕',
    });
    const head = el('div', { class: 'wb-card-head' }, [
      fold,
      el('span', { class: 'wb-grip', text: '⠿', title: 'Drag to move this note' }),
      typeChip,
      typeSelect,
      title,
      remove,
    ]);
    const fieldsRow = buildFieldsRow(note, type.id);

    const body = el('textarea', {
      class: 'wb-card-body',
      spellcheck: 'false',
      'aria-label': `Prose for ${note.title}`,
    });
    body.value = note.body;

    const linkRow = el('div', { class: 'wb-links' });
    const tagsRow = el('div', { class: 'wb-tags' });
    const relator = el('select', {
      class: 'wb-relator',
      'aria-label': 'What relationship the next link from this note asserts',
      title: 'The relationship the next link asserts (Associate is the weakest, merely co-occurring)',
    });
    for (const kind of RELATION_KINDS) {
      relator.append(el('option', { value: kind.id, text: kind.label }));
    }
    relator.value = linkKinds.get(index) ?? DEFAULT_RELATION;
    const linker = el('select', { class: 'wb-linker', 'aria-label': 'Associate this note with another note' });
    const words = el('span', { class: 'wb-words' });
    const linksSection = el('section', {
      class: `wb-link-section${isFolded(note.anchor, 'links') ? ' is-collapsed' : ''}`,
      'aria-label': 'Link to section',
    }, [
      foldToggle(note.anchor, 'links', 'Link to'),
      el('div', { class: 'wb-link-section-body' }, [
        linkRow,
        el('div', { class: 'wb-card-tools' }, [relator, linker, el('span', { class: 'spacer' }), words]),
      ]),
    ]);
    const foot = el('div', { class: 'wb-card-foot' }, [linksSection, tagsRow]);

    // appendAll, not append: a note's fields row is null, and `append(null)`
    // inserts the literal text "null" (dom.js says so itself).
    appendAll(card, [head, fieldsRow, body, foot]);

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
          groups = moved.groups ?? groups;
        }
        savePositions();
      }
      commit();
      refreshLinks();
    });

    body.addEventListener('input', () => {
      model = updateNote(model, index, { body: body.value });
      commit();
      refreshLinks();
      refreshTags();
    });

    relator.addEventListener('change', () => linkKinds.set(index, relator.value));

    linker.addEventListener('change', () => {
      if (linker.value === '__new__') {
        linker.value = '';
        createLinkedNote(index);
        return;
      }
      const kind = relator.value || DEFAULT_RELATION;
      const live = model.notes[index];
      if (linker.value.startsWith('group:')) {
        const group = groups[linker.value.slice('group:'.length)];
        if (!group) return;
        step(() => {
          relations = app.setWorldRelation(currentPath, live.anchor, linker.value, kind) ?? relations;
          drawEdges();
        });
        linker.value = '';
        const label = RELATION_KINDS.find((k) => k.id === kind)?.label ?? kind;
        app.toast(`“${live.title || 'note'}” ${label.toLowerCase()} “${group.name || 'Group'}”`, 'ok', 1800);
        return;
      }
      const target = model.notes[Number(linker.value)];
      if (!target) return;
      // Linking again to an already-linked note does not duplicate the link
      // in the prose — it re-asserts the relationship instead.
      const alreadyLinked = (live.links ?? []).some((l) => l.samePage && l.anchor === target.anchor);
      if (!alreadyLinked) {
        const link = `[[#${target.title}]]`;
        const nextBody = `${live.body}${live.body ? '\n\n' : ''}${link}`;
        model = updateNote(model, index, { body: nextBody });
        body.value = model.notes[index].body;
        commit();
      }
      // The bond is the canvas's, the link above is the vein's: an undo here
      // restores the kind and leaves the prose to the vein's own undo.
      step(() => {
        relations = app.setWorldRelation(currentPath, model.notes[index].anchor, target.anchor, kind) ?? relations;
        drawEdges();
      });
      refreshLinks();
      linker.value = '';
      const label = RELATION_KINDS.find((k) => k.id === kind)?.label ?? kind;
      app.toast(`“${live.title || 'note'}” ${label.toLowerCase()} “${target.title}”`, 'ok', 1800);
    });

    // Deleting a note deletes its prose from the file, so it asks once.
    let armed = 0;
    remove.addEventListener('click', () => {
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
      model = removeNote(model, index);
      if (gone) {
        positions.delete(gone);
        relations = app.dropWorldRelations(currentPath, gone) ?? relations;
        fieldValues = app.dropWorldFields(currentPath, gone) ?? fieldValues;
        groups = app.dropWorldGroups(currentPath, gone) ?? groups;
        savePositions();
      }
      commit();
      build();
    });

    head.addEventListener('pointerdown', (event) => {
      if (event.target.closest?.('input, button, select, textarea')) return;
      // Ctrl+click picks the node (again to unpick); it never starts a drag.
      if (event.ctrlKey) {
        selected.has(note.anchor) ? selected.delete(note.anchor) : selected.add(note.anchor);
        card.classList.toggle('is-selected', selected.has(note.anchor));
        event.preventDefault();
        return;
      }
      const outer = outermostOf(note.anchor);
      dragMembers(outer ? [...effectiveMembers(outer)] : [note.anchor], event, card, { joinable: !outer });
    });

    function refreshLinks() {
      const live = model.notes[index];
      if (!live) return;
      const resolvedLinks = [];
      for (const link of live.links) {
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
        const asserted = relationOf(relations, live.anchor, targetAnchor);
        const assertText = asserted.id !== DEFAULT_RELATION ? ` — ${asserted.label.toLowerCase()}` : '';
        resolvedLinks.push(el('button', {
          class: `wb-link ${resolved.ghost ? 'ghost' : ''}${asserted.id === 'ally' || asserted.id === 'foe' ? ` wb-rel-${asserted.id}` : ''}`,
          type: 'button',
          text: (link.alias || (link.samePage
            ? `§ ${link.section || 'this page'}`
            : `${link.target}${link.section ? ` › ${link.section}` : ''}`)) + assertText,
          title: (resolved.ghost ? `Not written yet: ${link.target || link.section}` : (resolved.path ?? '')) + assertText,
          onclick: () => {
            if (resolved.ghost) app.createFromGhost(link.target || link.section, resolved.suggestedPath);
            else app.openPath(resolved.path, { anchor: resolved.anchor, via: currentPath });
          },
        }));
      }

      appendAll(clear(linkRow), resolvedLinks.length
        ? resolvedLinks
        : [el('span', { class: 'wb-links-empty', text: 'no links yet' })]);

      clear(linker);
      linker.append(el('option', { value: '', text: 'Link to…' }));
      (model.notes ?? []).forEach((other, j) => {
        if (j === index) return;
        linker.append(el('option', { value: String(j), text: other.title || `Note ${j + 1}` }));
      });
      // A group can take the same definitive relationship as a note.
      for (const group of Object.values(groups ?? {})) {
        linker.append(el('option', { value: `group:${group.id}`, text: `Group: ${group.name || 'Group'}` }));
      }
      // Creating from the same menu: the new note is written into this vein and
      // linked back, so the user never has to leave the canvas to start one.
      linker.append(el('option', { value: '__new__', text: '+ New Note' }));

      words.textContent = `${countWords(live.title) + countWords(live.body)} words`;
    }

    /** The note's tags as chips, with a field for tagging the note. */
    function refreshTags() {
      const live = model.notes[index];
      if (!live) return;
      clear(tagsRow);

      for (const tag of live.tags ?? []) {
        tagsRow.append(el('span', { class: 'wb-tag', title: `Tag: ${tag}` }, [
          el('span', { text: `#${tag}` }),
          el('button', {
            class: 'wb-tag-x', type: 'button', text: '✕',
            title: `Remove #${tag} from this note`,
            onclick: () => {
              model = removeNoteTag(model, index, tag);
              // The textarea is the body: it must show what the model holds, or
              // the next keystroke would resurrect the tag just removed.
              body.value = model.notes[index].body;
              commit();
              refreshTags();
              refreshLinks();
            },
          }),
        ]));
      }

      const input = el('input', {
        class: 'wb-tag-input',
        placeholder: '#add tag',
        spellcheck: 'false',
        'aria-label': `Add a tag to ${live.title || 'this note'}`,
      });
      const addFromInput = () => {
        const parts = input.value.split(/\s+/).filter(Boolean);
        if (!parts.length) return;
        const invalid = parts.filter((part) => !normalizeTag(part));
        if (invalid.length) {
          app.toast(`Not a tag: ${invalid.slice(0, 3).join(', ')}`, 'warn', 1800);
        }
        const before = (model.notes[index].tags ?? []).length;
        model = addNoteTags(model, index, parts);
        const added = (model.notes[index].tags ?? []).length - before;
        if (added > 0) {
          body.value = model.notes[index].body;
          commit();
          refreshTags();
          refreshLinks();
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

    refreshLinks();
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
    const nextBody = `${live.body}${live.body ? '\n\n' : ''}[[#${target.title}]]`;
    model = updateNote(model, fromIndex, { body: nextBody });
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
    (model?.notes ?? []).forEach((_, index) => {
      const rect = rectOf(index);
      maxX = Math.max(maxX, rect.x + rect.width);
      maxY = Math.max(maxY, rect.y + rect.height);
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

  /** Put the current view on the canvas, clamped so it never shows void. */
  function applyView() {
    view = clampView(view, canvas.clientWidth, canvas.clientHeight, stage.clientWidth, stage.clientHeight);
    canvas.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.s})`;
  }

  /** Remember the view for this vein; the writer debounces underneath. */
  function persistView() {
    if (currentPath) app.saveWorldView(currentPath, anchorOfView(view));
  }

  /**
   * Tidy every unit onto a grid, group boundaries included: a group is one
   * unit in the grid, and its members keep the offsets they already had from
   * the unit's first card, so a column stays a column.
   */
  function arrangeAll() {
    const notes = model?.notes ?? [];
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
        return { anchor: notes[i].anchor, dx: pos.x - first.x, dy: pos.y - first.y };
      });
      return {
        members,
        width: Math.max(...members.map((m) => m.dx)) + CARD_W,
        height: Math.max(...members.map((m) => m.dy)) + CARD_H,
      };
    });
    positions = new Map();
    const cols = Math.max(1, Math.min(3, Math.ceil(Math.sqrt(Math.max(1, shapes.length)))));
    let rowTop = layout.top;
    let rowHeight = 0;
    const origins = shapes.map((shape, unitIndex) => {
      const col = unitIndex % cols;
      if (col === 0 && unitIndex > 0) {
        rowTop += rowHeight + GAP_Y;
        rowHeight = 0;
      }
      rowHeight = Math.max(rowHeight, shape.height);
      return { x: PAD + col * (CARD_W + GAP_X), y: rowTop };
    });
    for (const [shapeIndex, shape] of shapes.entries()) {
      const origin = origins[shapeIndex];
      for (const member of shape.members) {
        positions.set(member.anchor, { x: origin.x + member.dx, y: origin.y + member.dy });
      }
    }
    untangle(shapes, origins);
  }

  /**
   * Where a connector leaves one box's side and meets the other's: a cubic
   * that only ever curves sideways, so it reads as a wire between cards.
   * Both control points share their endpoint's height, which makes the curve
   * symmetric about t = 0.5 — its halfway point is also its visual centre.
   */
  function curveOf(from, to) {
    const y1 = from.y + from.height / 2;
    const y2 = to.y + to.height / 2;
    const rightward = to.x + to.width / 2 >= from.x + from.width / 2;
    const x1 = rightward ? from.x + from.width : from.x;
    const x2 = rightward ? to.x : to.x + to.width;
    const bend = Math.max(36, Math.abs(x2 - x1) * 0.45);
    return [
      { x: x1, y: y1 },
      { x: rightward ? x1 + bend : x1 - bend, y: y1 },
      { x: rightward ? x2 - bend : x2 + bend, y: y2 },
      { x: x2, y: y2 },
    ];
  }

  /** One point along a curve, at t from 0 (its start) to 1 (its end). */
  function pointOnCurve([a, b, c, d], t) {
    const m = 1 - t;
    const w = [m ** 3, 3 * m * m * t, 3 * m * t * t, t ** 3];
    return {
      x: w[0] * a.x + w[1] * b.x + w[2] * c.x + w[3] * d.x,
      y: w[0] * a.y + w[1] * b.y + w[2] * c.y + w[3] * d.y,
    };
  }

  /** The SVG path for a curve. */
  function pathOf([a, b, c, d]) {
    return `M ${a.x} ${a.y} C ${b.x} ${b.y} ${c.x} ${c.y} ${d.x} ${d.y}`;
  }

  /**
   * Sampled points along a connector, so the untangling below scores the curve
   * the reader actually sees. A plain card's box is the yardstick there, folds
   * included, because that is the grid the arrangement is packed on.
   */
  function curvePoints(from, to, steps = 16) {
    const curve = curveOf(
      { ...from, width: CARD_W, height: CARD_H },
      { ...to, width: CARD_W, height: CARD_H },
    );
    return Array.from({ length: steps + 1 }, (_, i) => pointOnCurve(curve, i / steps));
  }

  /**
   * Hill-climb the units' grid slots so relationships stop passing behind
   * cards. The score counts, for every drawn relationship, how many sampled
   * points of its curve lie inside some other card; a swap is only kept when
   * it strictly lowers the total, so the grid is only ever improved.
   */
  function untangle(shapes, origins) {
    const notes = model.notes ?? [];
    if (shapes.length < 2 || notes.length < 2) return;
    const unitOf = new Map();
    shapes.forEach((shape, unitIndex) => {
      shape.members.forEach((member) => {
        const index = notes.findIndex((n) => n.anchor === member.anchor);
        if (index >= 0) unitOf.set(index, unitIndex);
      });
    });
    const positionsByIndex = new Array(notes.length);
    const place = (unitIndex) => {
      const origin = origins[unitIndex];
      for (const member of shapes[unitIndex].members) {
        const index = notes.findIndex((n) => n.anchor === member.anchor);
        if (index >= 0) positionsByIndex[index] = { x: origin.x + member.dx, y: origin.y + member.dy };
      }
    };
    shapes.forEach((_, unitIndex) => place(unitIndex));
    // Every drawn connector scores: the relationships and the dotted outline
    // spine alike, since both pass visibly behind cards.
    const edges = [
      ...noteEdges(model, relations),
      ...hierarchyEdges(model),
      ...groupRelationEdges(model, groups, relations).map((edge) => ({
        from: edge.fromIndex,
        to: edge.toIndex,
      })),
    ].filter((edge) => edge.from >= 0 && edge.to >= 0 && edge.from !== edge.to).map((edge) => ({
      ...edge,
      fromUnit: unitOf.get(edge.from) ?? -1,
      toUnit: unitOf.get(edge.to) ?? -1,
    }));
    if (!edges.length) return;
    // Occlusion of some edges under a candidate set of positions.
    const score = (subset, lookup) => {
      let total = 0;
      for (const edge of subset) {
        for (const point of curvePoints(lookup(edge.from), lookup(edge.to))) {
          for (let j = 0; j < positionsByIndex.length; j += 1) {
            if (j === edge.from || j === edge.to) continue;
            const rect = lookup(j);
            if (point.x >= rect.x && point.x <= rect.x + CARD_W && point.y >= rect.y && point.y <= rect.y + CARD_H) {
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

  /** Begin dragging a set of notes (one card, or a whole group) from a grab. */
  function dragMembers(anchors, event, el, { joinable = false } = {}) {
    // One drag is one step, however many frames it takes: the snapshot is
    // taken here and pushed when the pointer comes up.
    beginStep();
    const rect = canvas.getBoundingClientRect();
    dragging = {
      el,
      // Only a single ungrouped card can be dropped onto a group's box; a
      // group drag moves a nest, which is not a membership change.
      joinable,
      moved: false,
      grab: {
        x: (event.clientX - rect.left) / view.s,
        y: (event.clientY - rect.top) / view.s,
      },
      members: anchors.map((anchor) => {
        const i = model.notes.findIndex((n) => n.anchor === anchor);
        return { anchor, el: cardEls[i], start: i >= 0 ? positionOf(i) : { x: 0, y: 0 } };
      }).filter((member) => member.el),
    };
    el?.classList.add('is-dragging');
    event.preventDefault();
  }

  const GROUP_COLORS = ['#58a6ff', '#57d364', '#da70d6', '#d29922', '#f97066', '#45c4b0', '#f778ba', '#8b949e'];
  const GROUP_DEFAULT_COLOR = '#58a6ff';

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

  /** The outermost group containing a note — drags act on the whole nest. */
  function outermostOf(anchor) {
    let group = groupOf(anchor);
    if (!group) return null;
    const parents = parentOf();
    let id = group.id;
    while (parents.has(id)) id = parents.get(id);
    return groups[id] ?? group;
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

  /** Stack the selected nodes into a column at the first one's position, and
   * open a coloured box around them. A grouping that covers a whole group
   * nests it instead of dissolving it; partial picks are pulled out of
   * their groups, which dissolve below two members left behind. */
  function groupSelected() {
    const picked = (model?.notes ?? []).filter((note) => selected.has(note.anchor));
    if (picked.length < 2) return;
    step(() => groupPicked(picked));
  }

  function groupPicked(picked) {
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
      picked.forEach((note, i) => {
        positions.set(note.anchor, { x: origin.x, y: origin.y + i * (CARD_H + GAP_Y) });
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
        });
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
    });
  }

  function closeMenu() {
    if (!menuEl) return;
    menuEl.remove();
    menuEl = null;
    document.removeEventListener('pointerdown', dismissMenu, true);
    document.removeEventListener('keydown', escapeMenu);
  }

  // Outside the menu, the next pointer-down — or Escape — dismisses it.
  // Clicks *inside* the menu must reach their buttons, so the closer
  // ignores them rather than closing on the first press.
  function dismissMenu(event) {
    if (!event.target.closest?.('.wb-menu')) closeMenu();
  }

  function escapeMenu(event) {
    if (event.key === 'Escape') closeMenu();
  }

  function setGroupColor(id, color) {
    step(() => {
      groups = { ...groups, [id]: { ...groups[id], color } };
      app.saveWorldGroups(currentPath, groups);
      drawEdges();
    });
    closeMenu();
  }

  /**
   * Ungroup: a nested group detaches into the world on its own; a top-level
   * group dissolves back into its cards, orphaning any children it had.
   */
  function ungroup(id) {
    step(() => ungroupNow(id));
    closeMenu();
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
      const box = groupBox(group);
      if (!box) continue;
      if (point.x < box.x - BOX_PAD || point.x > box.x + box.width + BOX_PAD) continue;
      if (point.y < box.y - BOX_PAD || point.y > box.y + box.height + BOX_PAD) continue;
      // Nested boxes overlap by design: the innermost one wins the drop.
      if (!hit || (depths.get(group.id) ?? 0) > (depths.get(hit.id) ?? 0)) hit = group;
    }
    return hit;
  }

  /** The group a dragging card would join if released here, or null. */
  function joinTargetId() {
    if (!dragging?.joinable || !dragging.moved) return null;
    const index = model.notes.findIndex((note) => note.anchor === dragging.members[0]?.anchor);
    if (index < 0) return null;
    const box = rectOf(index);
    return groupAtPoint({ x: box.x + box.width / 2, y: box.y + box.height / 2 })?.id ?? null;
  }

  /**
   * A drag that ends with its card's middle inside a group's box makes the
   * card a member of that group. Nothing is restacked: the card keeps the
   * place it was dropped in and every card already in the group stays put.
   */
  function joinOnDrop(drop) {
    if (!drop.joinable || !drop.moved) return;
    const anchor = drop.members[0]?.anchor;
    const index = model.notes.findIndex((note) => note.anchor === anchor);
    if (index < 0) return;
    const box = rectOf(index);
    const target = groupAtPoint({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
    if (!target) return;
    const joined = joinGroup(anchor, target.id);
    if (!joined) return;
    savePositions();
    build();
    app.toast(`Added “${noteTitle(anchor)}” to ${joined.name || 'the group'}`, 'ok', 1600);
  }

  /**
   * Put one note into a group where it sits. A note belongs to one group at a
   * time, so this also takes it out of the one it had, dropping that group
   * when it no longer has the two cards a box needs. No card is moved — the
   * box simply grows around the arrangement it finds.
   */
  function joinGroup(anchor, id) {
    const target = groups[id];
    if (!target || effectiveMembers(target).has(anchor)) return null;
    const next = {};
    for (const [otherId, group] of Object.entries(groups)) {
      const rest = group.members.filter((member) => member !== anchor);
      if (rest.length === group.members.length || rest.length >= 2 || (group.children ?? []).length) {
        next[otherId] = rest.length === group.members.length ? group : { ...group, members: rest };
      }
      // Below two cards and with no children a group has no box left to draw,
      // so it is gone; groups it nested surface as top-level groups.
    }
    next[id] = { ...target, members: [...target.members, anchor] };
    groups = app.saveWorldGroups(currentPath, next) ?? next;
    return groups[id] ?? target;
  }

  /** Take one note out of its group, leaving every other card where it is. */
  function removeFromGroup(anchor) {
    const group = groupOf(anchor);
    if (!group) return null;
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
    const options = Object.values(groups ?? {}).filter((group) => !effectiveMembers(group).has(anchor));
    if (!anchor || !options.length) return [];
    return [
      el('span', { class: 'wb-menu-label', text: 'Add to group' }),
      ...options.map((group) => el('button', {
        class: 'wb-menu-item',
        type: 'button',
        text: group.name || 'Group',
        title: `Add “${noteTitle(anchor)}” to ${group.name || 'this group'} where it sits`,
        onclick: () => {
          let joined = null;
          step(() => {
            joined = joinGroup(anchor, group.id);
            if (!joined) return;
            savePositions();
            build();
          });
          closeMenu();
          if (joined) app.toast(`Added “${noteTitle(anchor)}” to ${joined.name || 'the group'}`, 'ok', 1600);
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
   * The relationship block for one endpoint — a note or a group. Its bonds come
   * first, every stored one whichever way it points and each removable by
   * clicking it, then the pickers for asserting another; the ends on offer are
   * every other card and every group.
   */
  function relationshipItems(own, label) {
    const items = [];
    for (const bond of bondRows(own)) {
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
          });
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
        });
        closeMenu();
        app.toast(`${endpointTitle(own)} ${relationKind(kind.value).label.toLowerCase()} ${endpointTitle(target.value)}`, 'ok', 1800);
      },
    })]));
    return items;
  }

  /** The right-click menu: a selection groups, a grouped node recolors. */
  function openMenu(event) {
    if (event.target.closest?.('input, textarea, select')) return;
    closeMenu();
    if (!model) return;
    const cardEl = event.target.closest?.('.wb-card');
    const anchor = cardEl ? model.notes[Number(cardEl.dataset.note)]?.anchor : null;
    // Right-clicking the handle or name reaches the same menu as a member.
    const marked = event.target.closest?.('[data-group-id]')?.getAttribute('data-group-id');
    const group = (anchor ? groupOf(anchor) : null) ?? (marked ? groups[marked] ?? null : null);
    // A lone card still has membership to offer, so a card is worth a menu.
    if (!selected.size && !group && !anchor) return;
    event.preventDefault();
    const items = [];
    // The card you clicked gets its own bonds, whether or not it is grouped:
    // a bond is stated here, no prose link needed.
    if (anchor) items.push(...relationshipItems(anchor, 'Relate this note'));
    if (group) {
      items.push(el('span', { class: 'wb-menu-label', text: 'Group colour' }));
      items.push(el('div', { class: 'wb-menu-swatches' }, GROUP_COLORS.map((color) => el('button', {
        class: 'wb-menu-swatch',
        type: 'button',
        style: `background:${color}`,
        'aria-label': `Group colour ${color}`,
        onclick: () => setGroupColor(group.id, color),
      }))));
      items.push(el('button', {
        class: 'wb-menu-item', type: 'button', text: 'Rename group',
        onclick: () => { closeMenu(); renameGroup(group.id); },
      }));
      items.push(el('button', {
        class: 'wb-menu-item', type: 'button', text: 'Ungroup',
        title: 'Dissolve the whole group, leaving its cards where they are',
        onclick: () => ungroup(group.id),
      }));
      // A member card can move to another group, or simply leave this one.
      items.push(...addToGroupItems(anchor));
      if (anchor) {
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
            });
            closeMenu();
            if (left) app.toast(`“${noteTitle(anchor)}” left ${left.name || 'the group'}`, 'ok', 1600);
          },
        }));
      }

      items.push(...relationshipItems(groupEndpoint(group.id), 'Relate this group'));
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
    if (selected.size) {
      items.push(el('button', {
        class: 'wb-menu-item', type: 'button', text: 'Clear selection',
        onclick: () => { selected = new Set(); closeMenu(); build(); },
      }));
    }
    menuEl = el('div', { class: 'wb-menu', role: 'menu' }, items);
    document.body.append(menuEl);
    menuEl.style.left = `${Math.min(event.clientX, window.innerWidth - menuEl.offsetWidth - 8)}px`;
    menuEl.style.top = `${Math.min(event.clientY, window.innerHeight - menuEl.offsetHeight - 8)}px`;
    document.addEventListener('pointerdown', dismissMenu, true);
    document.addEventListener('keydown', escapeMenu);
  }

  stage.addEventListener('contextmenu', openMenu);

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
      return group ? groupBox(group) : null;
    }
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
    });
    app.toast(`“${endpointTitle(from)}” ${next.label.toLowerCase()} “${endpointTitle(to)}”`, 'ok', 1800);
  }

  /** The coloured box around a group: the tightest rect over its cards. */
  function drawGroupBoxes() {
    // Tabs live in the DOM cards layer, not the SVG that drawEdges clears —
    // remove them first or every draw (every drag frame!) stacks another.
    cards.querySelectorAll('.wb-group-tab').forEach((tab) => tab.remove());
    // Parents first, so nested boxes draw over the fill of their parents.
    const depths = groupDepths();
    const ordered = Object.values(groups ?? {}).sort((a, b) => depths.get(a.id) - depths.get(b.id));
    for (const group of ordered) {
      const box = groupBox(group);
      if (!box) continue;
      const indexes = box.indexes;
      const pad = 12;
      const color = group.color || GROUP_DEFAULT_COLOR;
      const boxX = box.x - pad;
      const boxY = box.y - pad;
      edgeSvg.append(svgNode('rect', {
        class: `wb-box${dropTargetId === group.id ? ' is-drop-target' : ''}`,
        x: boxX,
        y: boxY,
        width: box.width + pad * 2,
        height: box.height + pad * 2,
        rx: 10,
        fill: color,
        'fill-opacity': 0.07,
        stroke: color,
        'stroke-opacity': 0.75,
        'stroke-width': 2,
      }));
      // The title: a mini node header straddling the box's top-left corner —
      // grip, accent edge, name — and it grabs the whole group to drag.
      const name = group.name || 'Group';
      const tab = el('div', {
        class: 'wb-group-tab',
        dataset: { groupId: group.id },
        title: `${name} — drag to move the group`,
      }, [
        el('span', { class: 'wb-grip', text: '⠿' }),
        el('span', { class: 'wb-card-title static', text: name }),
      ]);
      tab.style.left = `${boxX}px`;
      tab.style.top = `${boxY - 12}px`;
      tab.style.borderLeft = `3px solid ${color}`;
      tab.addEventListener('pointerdown', (event) => {
        event.stopPropagation();
        dragMembers([...effectiveMembers(group)], event, cardEls[indexes[0]]);
      });
      // Double-clicking the name edits it in place, like a card's title.
      const nameEl = tab.querySelector('.wb-card-title');
      nameEl.addEventListener('dblclick', (event) => {
        event.stopPropagation();
        inlineGroupRename(nameEl, group);
      });
      cards.append(tab);
    }
  }

  function drawEdges() {
    clear(edgeSvg);
    if (!model) return;
    drawGroupBoxes();

    // Every connector names its ends the same way — a note anchor or a group
    // endpoint — so prose links, the outline spine and group bonds all draw
    // and label through one path.
    const notes = model.notes ?? [];
    const anchorOf = (index) => notes[index]?.anchor ?? null;
    const connectors = [
      ...hierarchyEdges(model).map((edge) => ({ from: anchorOf(edge.from), to: anchorOf(edge.to), kind: 'contains' })),
      ...noteEdges(model, relations).map((edge) => ({ from: anchorOf(edge.from), to: anchorOf(edge.to), kind: edge.kind, relation: edge.relation })),
      // Bonds stated on the canvas itself: no prose link behind them.
      ...bondEdges(model, relations).map((edge) => ({ from: edge.from, to: edge.to, kind: 'bond', relation: edge.relation })),
      ...groupRelationEdges(model, groups, relations),
    ].filter((edge) => edge.from && edge.to && edge.from !== edge.to);

    // Where one end carries several bonds, fan them out so no two lie on top
    // of each other: each takes its own lane, centred on the box's middle.
    const bonds = new Map();
    for (const edge of connectors) {
      bonds.set(edge.from, (bonds.get(edge.from) ?? 0) + 1);
      bonds.set(edge.to, (bonds.get(edge.to) ?? 0) + 1);
    }
    const lanes = new Map();
    const laneRect = (rect, endpoint) => {
      const total = bonds.get(endpoint) ?? 1;
      const taken = lanes.get(endpoint) ?? 0;
      lanes.set(endpoint, taken + 1);
      const shift = (taken - (total - 1) / 2) * 12;
      return shift ? { ...rect, y: rect.y + shift } : rect;
    };

    // Words are placed once every wire is drawn: each sits on its own lane's
    // curve, and neighbours that would collide slide apart along it.
    const labels = [];
    for (const edge of connectors) {
      const from = endpointRect(edge.from);
      const to = endpointRect(edge.to);
      if (!from || !to) continue;
      const isGroup = edge.from.startsWith('group:') || edge.to.startsWith('group:');
      const relation = edge.relation ? relationKind(edge.relation) : null;
      const curve = curveOf(laneRect(from, edge.from), laneRect(to, edge.to));
      const line = svgNode('path', {
        class: `wb-edge wb-edge-${isGroup ? 'group' : edge.kind}${relation ? ` wb-rel-${relation.id}` : ''}`,
        d: pathOf(curve),
        fill: 'none',
        'data-from': edge.from,
        'data-to': edge.to,
      });
      const title = svgNode('title');
      title.textContent = relation
        ? `${endpointTitle(edge.from)} ${relation.label.toLowerCase()} ${endpointTitle(edge.to)}`
        : `${endpointTitle(edge.from)} → ${endpointTitle(edge.to)}`;
      line.append(title);
      edgeSvg.append(line);
      // The asserted kind, read right on the line; Associate stays unlabelled
      // because it is the default every plain link already has.
      if (!relation || relation.id === DEFAULT_RELATION) continue;
      const text = svgNode('text', {
        class: `wb-edge-label wb-rel-${relation.id}`,
        'text-anchor': 'middle',
        'dominant-baseline': 'central',
      });
      text.textContent = relation.label.toLowerCase();
      // The word is the handle: click it and the asserted kind steps to the
      // next one in the scale (weakest to strongest, then wraps).
      const tip = svgNode('title');
      tip.textContent = 'Click to change this relationship';
      text.append(tip);
      text.addEventListener('click', (event) => {
        event.stopPropagation();
        cycleRelation(edge);
      });
      edgeSvg.append(text);
      labels.push({ text, curve });
    }
    placeLabels(labels);
  }

  // Where along the wire a word may sit, nearest to the middle first. Labels
  // first try the halfway point; a crowded one slides outwards to the closest
  // free place, then the next, so its neighbours stay readable.
  const LABEL_SLOTS = [0.5, 0.41, 0.59, 0.32, 0.68, 0.24, 0.76];

  /**
   * Lay each label on its own lane's curve, and keep the words from colliding:
   * a label takes the nearest free slot along its curve, so a shared end fans
   * its words out over its wires instead of stacking them at one point.
   */
  function placeLabels(labels) {
    const taken = [];
    const overlaps = (a, b) => a.left < b.left + b.width && a.left + a.width > b.left
      && a.top < b.top + b.height && a.top + a.height > b.top;
    for (const { text, curve } of labels) {
      const box = text.getBBox();
      // A little air around the word, so two labels never touch.
      const areaAt = (point) => ({
        left: point.x - (box.width + 8) / 2,
        top: point.y - (box.height + 4) / 2,
        width: box.width + 8,
        height: box.height + 4,
      });
      let spot = null;
      for (const t of LABEL_SLOTS) {
        const at = pointOnCurve(curve, t);
        if (taken.every((other) => !overlaps(areaAt(at), other))) {
          spot = at;
          break;
        }
      }
      // Every wire is crowded by its full set of slots: keep the middle, and
      // still claim the space so nothing later lands on top of it.
      spot ??= pointOnCurve(curve, 0.5);
      taken.push(areaAt(spot));
      text.setAttribute('x', spot.x);
      text.setAttribute('y', spot.y);
    }
  }

  function scheduleEdges() {
    if (edgeFrame) return;
    edgeFrame = requestAnimationFrame(() => {
      edgeFrame = 0;
      drawEdges();
    });
  }

  stage.addEventListener('pointerdown', (event) => {
    // Cards handle their own drags and their own controls; everything else in
    // the stage is background, and grabbing it pans.
    if (event.target.closest?.('.wb-card, button, input, select, textarea')) return;
    panning = { startX: event.clientX, startY: event.clientY, viewX: view.x, viewY: view.y };
    stage.classList.add('is-panning');
    event.preventDefault();
  });

  window.addEventListener('resize', applyView);

  window.addEventListener('pointermove', (event) => {
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
    const dx = Math.max(4 - minStartX, point.x - dragging.grab.x);
    const dy = Math.max(4 - minStartY, point.y - dragging.grab.y);
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) dragging.moved = true;
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
    if (panning) {
      panning = null;
      stage.classList.remove('is-panning');
      persistView();
    }
    if (!dragging) return;
    const drop = dragging;
    dragging = null;
    dropTargetId = null;
    drop.el.classList.remove('is-dragging');
    sizeCanvas();
    drawEdges();
    savePositions();
    // Joining on drop is part of the drag, so one undo puts the card back
    // where it came from and out of the group again.
    joinOnDrop(drop);
    commitStep();
  });

  return {
    render,
    refresh: () => (model ? build() : null),
    get stage() {
      return stage;
    },
  };
}
