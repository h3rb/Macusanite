/**
 * Worldbuilding: a vein read as notes instead of lines.
 *
 * The worldbuilding view edits *the same markdown file* the reader sees: every
 * heading becomes a note card holding its own prose, and the canvas is only a
 * second way of looking at the source. So this module is the whole contract
 * between them — `parseNotes` turns a vein into cards, `serializeNotes` writes
 * the cards back out, and {@link noteEdges} says which notes point at which by
 * the wiki links and heading levels already in the text.
 *
 * Everything here is pure: no DOM, no filesystem, no colour. That is what makes
 * "did the file survive a round trip through the canvas?" a unit test.
 */
import { parseFrontmatter } from './frontmatter.js';
import { parseTags, parseWikiLinks } from './wikilinks.js';
import { slugify } from './path.js';

const HEADING_RE = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const FENCE_RE = /^[ \t]*(`{3,}|~{3,})/;

/** Level of a note created on the canvas: a section, not a new document title. */
export const DEFAULT_LEVEL = 2;

/** Drop the blank lines around a block without touching the ones inside it. */
function trimBlock(text) {
  return String(text ?? '')
    .replace(/^(?:[ \t]*\r?\n)+/, '')
    .replace(/\s+$/, '');
}

/** The links and tags inside one note's prose, in source order. */
function describeBody(body) {
  const text = String(body ?? '');
  return {
    tags: parseTags(text),
    links: parseWikiLinks(text).map((link) => ({
      target: link.target,
      section: link.section,
      alias: link.alias,
      samePage: link.samePage,
      anchor: link.anchor,
    })),
  };
}

/**
 * Split a document body into an intro and one chunk per heading.
 *
 * Fences are respected, so a `# comment` inside a shell block is prose rather
 * than a new note. Anchors are de-duplicated the way the graph does it, so a
 * `[[#Repeat]]` link and the canvas agree on which note it means.
 */
function scanSections(body) {
  const intro = [];
  const sections = [];
  const seen = new Map();
  let current = null;
  let inFence = false;
  let fenceMarker = '';

  for (const line of String(body ?? '').split(/\r?\n/)) {
    const fence = FENCE_RE.exec(line);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fence[1][0];
      } else if (fence[1][0] === fenceMarker) {
        inFence = false;
      }
      (current ? current.lines : intro).push(line);
      continue;
    }

    const heading = inFence ? null : HEADING_RE.exec(line);
    if (!heading) {
      (current ? current.lines : intro).push(line);
      continue;
    }

    const text = heading[2].trim();
    const base = slugify(text) || `section-${sections.length + 1}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    current = {
      level: heading[1].length,
      title: text,
      anchor: count === 0 ? base : `${base}-${count}`,
      lines: [],
    };
    sections.push(current);
  }

  return { intro: trimBlock(intro.join('\n')), sections };
}

/**
 * Read a vein as notes.
 *
 * @param {string} text the markdown source, front matter included
 * @returns {{frontmatter: string, frontmatterData: object, hasFrontmatter: boolean,
 *            intro: string, notes: Array<object>}}
 */
export function parseNotes(text) {
  const src = String(text ?? '');
  const { data, body, raw, present } = parseFrontmatter(src);
  const { intro, sections } = scanSections(body);

  const notes = sections.map((section, index) => {
    const noteBody = trimBlock(section.lines.join('\n'));
    return {
      index,
      level: section.level,
      title: section.title,
      anchor: section.anchor,
      body: noteBody,
      ...describeBody(noteBody),
    };
  });

  return {
    frontmatter: raw,
    frontmatterData: data,
    hasFrontmatter: present,
    intro,
    notes,
  };
}

/** Write notes back out as a markdown vein, front matter and intro included. */
export function serializeNotes(model = {}) {
  const parts = [];
  const frontmatter = String(model.frontmatter ?? '').replace(/\s+$/, '');
  if (frontmatter) parts.push(frontmatter);
  if (String(model.intro ?? '').trim()) parts.push(trimBlock(model.intro));

  for (const note of model.notes ?? []) {
    const level = Math.min(6, Math.max(1, Number(note.level) || DEFAULT_LEVEL));
    const heading = `${'#'.repeat(level)} ${String(note.title ?? '').trim()}`.trimEnd();
    const body = trimBlock(note.body);
    parts.push(body ? `${heading}\n\n${body}` : heading);
  }

  const text = parts.join('\n\n');
  return text ? `${text}\n` : '';
}

/** Replace one note's fields, re-reading its links and tags from the new prose. */
export function updateNote(model, index, patch = {}) {
  const notes = (model.notes ?? []).map((note, i) => {
    if (i !== index) return note;
    const next = { ...note, ...patch };
    if (patch.title !== undefined) {
      // A renamed note takes a fresh anchor, so links written after the rename
      // resolve to what the reader can see on the card.
      next.anchor = slugify(String(next.title ?? '')) || note.anchor;
    }
    if (patch.body !== undefined) Object.assign(next, describeBody(next.body));
    return next;
  });
  return { ...model, notes };
}

/**
 * Append a note to the end of the vein.
 * @returns {{model: object, index: number}}
 */
export function addNote(model, { title = 'New note', level = DEFAULT_LEVEL, body = '' } = {}) {
  const notes = [...(model.notes ?? [])];
  const note = {
    index: notes.length,
    level,
    title: String(title),
    anchor: slugify(String(title)) || `section-${notes.length + 1}`,
    body: trimBlock(body),
    ...describeBody(body),
  };
  notes.push(note);
  return { model: { ...model, notes }, index: notes.length - 1 };
}

/** Remove a note. Its heading and prose leave the file with it. */
export function removeNote(model, index) {
  const notes = (model.notes ?? []).filter((_, i) => i !== index);
  return { ...model, notes };
}

/** Replace the prose that sits before the first heading. */
export function updateIntro(model, intro) {
  return { ...model, intro: trimBlock(intro) };
}

/**
 * Associations written in the prose: a note linking `[[#Heading]]` points at
 * that note, and `[[Note title]]` points at the note with that title.
 *
 * @returns {Array<{id: string, from: number, to: number, kind: string, label: string}>}
 */
export function noteEdges(model = {}) {
  const notes = model.notes ?? [];
  const byAnchor = new Map(notes.map((note, i) => [note.anchor, i]));
  const byTitle = new Map(notes.map((note, i) => [String(note.title).toLowerCase(), i]));
  const edges = [];
  const seen = new Set();

  notes.forEach((note, from) => {
    for (const link of note.links ?? []) {
      let to = null;
      let kind = '';
      if (link.samePage) {
        to = byAnchor.get(link.anchor) ?? null;
        kind = 'section';
      } else if (link.target) {
        to = byTitle.get(String(link.target).toLowerCase()) ?? null;
        kind = 'mention';
      }
      if (to === null || to === from) continue;
      const id = `${from}->${to}`;
      if (seen.has(id)) continue;
      seen.add(id);
      edges.push({
        id,
        from,
        to,
        kind,
        label: link.section || link.alias || '',
      });
    }
  });

  return edges;
}

/**
 * The outline: each note's nearest shallower predecessor contains it. Drawn as
 * the dotted spine of the canvas, it is what keeps the document's shape visible
 * once the cards have been dragged around.
 *
 * @returns {Array<{id: string, from: number, to: number, kind: string}>}
 */
export function hierarchyEdges(model = {}) {
  const notes = model.notes ?? [];
  const edges = [];
  const stack = [];

  notes.forEach((note, index) => {
    while (stack.length && notes[stack[stack.length - 1]].level >= note.level) stack.pop();
    if (stack.length) {
      const from = stack[stack.length - 1];
      edges.push({ id: `contains:${from}->${index}`, from, to: index, kind: 'contains' });
    }
    stack.push(index);
  });

  return edges;
}

/** Word count of a block of prose, for the card footers and the toolbar. */
export function countWords(text) {
  const trimmed = String(text ?? '').trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

/** Everything the canvas header reports, computed once per change. */
export function noteStats(model = {}) {
  const notes = model.notes ?? [];
  const tags = new Set();
  let links = 0;
  let words = countWords(model.intro);
  for (const note of notes) {
    links += (note.links ?? []).length;
    words += countWords(note.title) + countWords(note.body);
    for (const tag of note.tags ?? []) tags.add(tag);
  }
  return {
    notes: notes.length,
    associations: noteEdges(model).length,
    links,
    tags: tags.size,
    words,
  };
}
