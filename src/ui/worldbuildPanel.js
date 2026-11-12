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
import { el, clear, appendAll } from './dom.js';
import {
  parseNotes, serializeNotes, updateNote, updateIntro, addNote, removeNote,
  noteEdges, hierarchyEdges, noteStats, countWords, DEFAULT_LEVEL,
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
  // Where the reader dragged each card, by note index. Absent means "the grid".
  let positions = new Map();
  let cardEls = [];
  let layout = { cols: 1, top: PAD };
  let dragging = null;
  let edgeFrame = 0;

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
    positions = new Map();
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
      el('span', { class: 'wb-hint', text: 'Each card is a heading of this vein — typing here edits the markdown' }),
      el('div', { class: 'spacer' }),
      el('button', {
        class: 'btn btn-ghost btn-mini', type: 'button', text: '+ Note',
        title: 'Add a note to this vein', onclick: addNewNote,
      }),
      el('button', {
        class: 'btn btn-ghost btn-mini', type: 'button', text: 'Arrange',
        title: 'Tidy the cards back into a grid',
        onclick: () => { positions = new Map(); build(); },
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
  }

  function renderStats() {
    const stats = noteStats(model ?? {});
    appendAll(clear(statsBar), [
      el('span', { class: 'wb-stat', text: `${stats.notes} notes` }),
      el('span', { class: 'wb-stat', text: `${stats.associations} associations` }),
      el('span', { class: 'wb-stat', text: `${stats.links} links` }),
      stats.tags ? el('span', { class: 'wb-stat', text: `${stats.tags} tags` }) : null,
      el('span', { class: 'wb-stat', text: `${stats.words} words` }),
      el('span', { class: 'wb-legend', text: 'solid: links in the prose · dotted: section outline' }),
    ]);
  }

  /* -------------------------------------------------------------- cards -- */

  function positionOf(index) {
    const known = positions.get(index);
    if (known) return known;
    const col = index % layout.cols;
    const row = Math.floor(index / layout.cols);
    return {
      x: PAD + col * (CARD_W + GAP_X),
      y: layout.top + row * (CARD_H + GAP_Y),
    };
  }

  function buildCard(note, index) {
    const pos = positionOf(index);
    const accent = app.colorFor('section', { path: currentPath, anchor: note.anchor });
    const card = el('article', {
      class: `wb-card wb-level-${note.level}`,
      style: `left:${pos.x}px; top:${pos.y}px; border-left-color:${accent};`,
      'data-note': String(index),
    });

    const levelChip = el('span', { class: 'wb-level', text: `H${note.level}` });
    const title = el('input', {
      class: 'wb-card-title',
      value: note.title,
      spellcheck: 'false',
      'aria-label': `Note title: ${note.title}`,
    });
    const remove = el('button', {
      class: 'wb-card-del', type: 'button', title: 'Delete this note', text: '✕',
    });
    const head = el('div', { class: 'wb-card-head' }, [
      el('span', { class: 'wb-grip', text: '⠿', title: 'Drag to move this note' }),
      levelChip,
      title,
      remove,
    ]);

    const body = el('textarea', {
      class: 'wb-card-body',
      spellcheck: 'false',
      'aria-label': `Prose for ${note.title}`,
    });
    body.value = note.body;

    const linkRow = el('div', { class: 'wb-links' });
    const linker = el('select', { class: 'wb-linker', 'aria-label': 'Associate this note with another note' });
    const words = el('span', { class: 'wb-words' });
    const foot = el('div', { class: 'wb-card-foot' }, [
      linkRow,
      el('div', { class: 'wb-card-tools' }, [linker, el('span', { class: 'spacer' }), words]),
    ]);

    card.append(head, body, foot);

    title.addEventListener('input', () => {
      model = updateNote(model, index, { title: title.value });
      levelChip.textContent = `H${model.notes[index].level}`;
      commit();
      refreshLinks();
    });

    body.addEventListener('input', () => {
      model = updateNote(model, index, { body: body.value });
      commit();
      refreshLinks();
    });

    linker.addEventListener('change', () => {
      const target = model.notes[Number(linker.value)];
      if (!target) return;
      const live = model.notes[index];
      const link = `[[#${target.title}]]`;
      const nextBody = `${live.body}${live.body ? '\n\n' : ''}${link}`;
      model = updateNote(model, index, { body: nextBody });
      body.value = model.notes[index].body;
      commit();
      refreshLinks();
      linker.value = '';
      app.toast(`Linked “${live.title || 'note'}” to “${target.title}”`, 'ok', 1800);
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
      model = removeNote(model, index);
      commit();
      positions = new Map();
      build();
    });

    head.addEventListener('pointerdown', (event) => {
      if (event.target.closest?.('input, button')) return;
      const rect = canvas.getBoundingClientRect();
      const pos = positionOf(index);
      dragging = {
        index,
        el: card,
        offX: event.clientX - rect.left - pos.x,
        offY: event.clientY - rect.top - pos.y,
      };
      card.classList.add('is-dragging');
      event.preventDefault();
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
        resolvedLinks.push(el('button', {
          class: `wb-link ${resolved.ghost ? 'ghost' : ''}`,
          type: 'button',
          text: link.alias || (link.samePage
            ? `§ ${link.section || 'this page'}`
            : `${link.target}${link.section ? ` › ${link.section}` : ''}`),
          title: resolved.ghost ? `Not written yet: ${link.target || link.section}` : (resolved.path ?? ''),
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

      words.textContent = `${countWords(live.title) + countWords(live.body)} words`;
    }

    refreshLinks();
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

  /* -------------------------------------------------------------- canvas -- */

  function sizeCanvas() {
    let maxX = PAD + CARD_W;
    let maxY = layout.top + CARD_H;
    (model?.notes ?? []).forEach((_, index) => {
      const pos = positionOf(index);
      maxX = Math.max(maxX, pos.x + CARD_W);
      maxY = Math.max(maxY, pos.y + CARD_H);
    });
    if (model?.intro) maxY = Math.max(maxY, PAD + INTRO_H);

    const width = Math.max(stage.clientWidth || 0, maxX + PAD);
    const height = maxY + PAD + 40;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    edgeSvg.setAttribute('width', String(width));
    edgeSvg.setAttribute('height', String(height));
    edgeSvg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  }

  function connect(from, to) {
    const a = { x: from.x + CARD_W / 2, y: from.y + CARD_H / 2 };
    const b = { x: to.x + CARD_W / 2, y: to.y + CARD_H / 2 };
    const rightward = b.x >= a.x;
    const x1 = rightward ? from.x + CARD_W : from.x;
    const y1 = a.y;
    const x2 = rightward ? to.x : to.x + CARD_W;
    const y2 = b.y;
    const bend = Math.max(36, Math.abs(x2 - x1) * 0.45);
    const c1 = rightward ? x1 + bend : x1 - bend;
    const c2 = rightward ? x2 - bend : x2 + bend;
    return `M ${x1} ${y1} C ${c1} ${y1} ${c2} ${y2} ${x2} ${y2}`;
  }

  function drawEdges() {
    clear(edgeSvg);
    if (!model) return;

    const path = (edge, kind) => {
      const from = positionOf(edge.from);
      const to = positionOf(edge.to);
      const line = svgNode('path', {
        class: `wb-edge wb-edge-${kind}`,
        d: connect(from, to),
        fill: 'none',
        'data-from': edge.from,
        'data-to': edge.to,
      });
      if (edge.label) {
        const title = svgNode('title');
        title.textContent = edge.label;
        line.append(title);
      }
      edgeSvg.append(line);
    };

    for (const edge of hierarchyEdges(model)) path(edge, 'contains');
    for (const edge of noteEdges(model)) path(edge, edge.kind);
  }

  function scheduleEdges() {
    if (edgeFrame) return;
    edgeFrame = requestAnimationFrame(() => {
      edgeFrame = 0;
      drawEdges();
    });
  }

  window.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    const rect = canvas.getBoundingClientRect();
    const x = Math.max(4, event.clientX - rect.left - dragging.offX);
    const y = Math.max(4, event.clientY - rect.top - dragging.offY);
    positions.set(dragging.index, { x, y });
    dragging.el.style.left = `${x}px`;
    dragging.el.style.top = `${y}px`;
    scheduleEdges();
  });

  window.addEventListener('pointerup', () => {
    if (!dragging) return;
    dragging.el.classList.remove('is-dragging');
    dragging = null;
    sizeCanvas();
    drawEdges();
  });

  return {
    render,
    refresh: () => (model ? build() : null),
    get stage() {
      return stage;
    },
  };
}
