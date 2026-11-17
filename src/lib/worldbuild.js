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
 * The relationship a connection can assert, weakest first. Every connection
 * is *definitively* one of these — a plain link with no asserted kind is an
 * Associate — and the rank says how much each step commits to: an Associate
 * merely co-occurs, while Controls reads as command over the other note.
 * Inverse pairs name the same bond from the other side.
 */
export const RELATION_KINDS = [
  { id: 'associate', label: 'Associate', rank: 0 },
  // Citation, the lightest committed bond: a note points at another without
  // claiming authority over it, so it sits beside Member Of at the low rank.
  { id: 'references', label: 'References', inverse: 'referenced-by', rank: 1 },
  { id: 'referenced-by', label: 'Referenced By', inverse: 'references', rank: 1 },
  { id: 'member-of', label: 'Member Of', rank: 1 },
  // A tab is one pane of the thing it belongs to: a structural bond that
  // claims no authority, so it sits with Member Of at the low rank.
  { id: 'tab', label: 'Tab', inverse: 'tab-of', rank: 1 },
  { id: 'tab-of', label: 'Tab Of', inverse: 'tab', rank: 1 },
  { id: 'template', label: 'Template', rank: 2 },
  { id: 'parent', label: 'Parent', inverse: 'child', rank: 2 },
  { id: 'child', label: 'Child', inverse: 'parent', rank: 2 },
  { id: 'contains', label: 'Contains', inverse: 'contained-by', rank: 3 },
  { id: 'contained-by', label: 'Contained By', inverse: 'contains', rank: 3 },
  { id: 'controls', label: 'Controls', inverse: 'controlled-by', rank: 4 },
  { id: 'controlled-by', label: 'Controlled By', inverse: 'controls', rank: 4 },
  { id: 'affects', label: 'Affects', inverse: 'affected-by', rank: 5 },
  { id: 'affected-by', label: 'Affected By', inverse: 'affects', rank: 5 },
  // Polarity bonds: an ally stands with you, a foe against you — both are
  // definitive, and a foe is the strongest bond of all.
  { id: 'ally', label: 'Ally', rank: 6 },
  { id: 'foe', label: 'Foe', rank: 7 },
];

/** The kind a connection asserts when nothing stronger was chosen. */
export const DEFAULT_RELATION = 'associate';

/**
 * What a node *is*. A note is the default: a heading whose prose is markdown,
 * diagrams included. The others classify the node — what it represents in the
 * world — and are drawn as such; the prose stays markdown either way, so
 * links, tags and relationships behave the same for every type.
 */
export const NODE_TYPES = [
  { id: 'note', label: 'Note', icon: '✎' },
  { id: 'stat', label: 'Stat', color: '#57d364', icon: 'Σ' },
  { id: 'skill', label: 'Skill', color: '#58a6ff', icon: '◆' },
  { id: 'ability', label: 'Ability', color: '#da70d6', icon: '✦' },
  { id: 'attribute', label: 'Attribute', color: '#d29922', icon: '≡' },
  { id: 'property', label: 'Property', color: '#8b949e', icon: '⚙' },
  { id: 'table', label: 'Table', color: '#8ecae6', icon: '▦' },
  { id: 'rating', label: 'Rating', color: '#9575cd', icon: '★' },
  // Places of the world: where things happen and what stands there.
  { id: 'place', label: 'Place', color: '#45c4b0', icon: '⌂' },
  { id: 'person', label: 'Person', color: '#f97066', icon: '♟' },
  { id: 'thing', label: 'Thing', color: '#ffa657', icon: '◉' },
  { id: 'prop', label: 'Prop', color: '#8d6e63', icon: '▣' },
  { id: 'location', label: 'Location', color: '#f778ba', icon: '⌖' },
  { id: 'scene', label: 'Scene', color: '#e3b341', icon: '▶' },
  { id: 'sound', label: 'Sound', color: '#00bcd4', icon: '♫' },
  { id: 'image', label: 'Image', color: '#ec407a', icon: '▧' },
  { id: 'animation', label: 'Animation', color: '#ab47bc', icon: '◌' },
  { id: 'mode', label: 'Mode', color: '#78909c', icon: '◈' },
  { id: 'actor', label: 'Actor', color: '#ef5350', icon: '🎭' },
  { id: 'voiceover', label: 'Voiceover', color: '#26a69a', icon: '🎙' },
  { id: 'dialog', label: 'Dialog', color: '#5c6bc0', icon: '❞' },
  { id: 'line', label: 'Line', color: '#ff7043', icon: '➖' },
  { id: 'action', label: 'Action', color: '#9ccc65', icon: '⚡' },
  { id: 'locale', label: 'Locale', color: '#a9d15e', icon: '⚐' },
  { id: 'biome', label: 'Biome', color: '#3fb68b', icon: '✿' },
  // Powers and their consequences: what a note does, and what it does to you.
  { id: 'perk', label: 'Perk', color: '#ffd700', icon: '✺' },
  { id: 'effect', label: 'Effect', color: '#56d4dd', icon: '⇒' },
  { id: 'condition', label: 'Condition', color: '#e8604c', icon: '◍' },
];

/** The type a node has when nothing was ever chosen for it. */
export const DEFAULT_NODE_TYPE = 'note';

/** Id-indexed records + a forgiving lookup, shared by types and relations. */
function indexById(records) {
  return new Map(records.map((record) => [record.id, record]));
}

function findById(map, value) {
  return map.get(String(value ?? '').trim().toLowerCase()) ?? null;
}

const NODE_TYPE_BY_ID = indexById(NODE_TYPES);

/** The type's record, or null for anything not on the list. */
export function nodeType(type) {
  return findById(NODE_TYPE_BY_ID, type);
}

/** The type asserted for one note's anchor, the default when none was. */
export function nodeTypeOf(types = {}, anchor) {
  return nodeType(types[anchor]) ?? NODE_TYPE_BY_ID.get(DEFAULT_NODE_TYPE);
}

/**
 * Set a note's type.
 * @returns {object} a new types object — the same object for an unknown type
 */
export function setNodeType(types = {}, anchor, type) {
  const known = nodeType(type);
  if (!known || !anchor) return types;
  return { ...types, [anchor]: known.id };
}

/**
 * The structured fields a node type carries besides its prose: a stat takes a
 * value, a skill or ability a level, an attribute or property a key/value
 * pair. A note takes none — its prose *is* its content. Every type keeps its
 * prose editable (links and tags are parsed from it); the fields live in the
 * vein's saved record, like positions and relationships, never in the
 * markdown.
 */
// Types with the same shape share one schema object. A numeric field may
// declare its range: values are clamped to it on the way in, and the editor
// offers it to the input (spinners, steppers, validation) for free.
const NUMERIC_RANGE = { kind: 'number', min: 0, max: 10, step: 1 };
const LEVEL = [{ id: 'level', label: 'Level', ...NUMERIC_RANGE }];
// A rating is one specific value on the same scale a level uses.
const RATING = [{ id: 'value', label: 'Value', ...NUMERIC_RANGE }];
// An ability spans a range, so it takes its two ends instead of one level.
// The ends are unbounded — an ability can outgrow any 0–10 scale.
const MIN_MAX = [
  { id: 'min', label: 'Min', kind: 'number', step: 1 },
  { id: 'max', label: 'Max', kind: 'number', step: 1 },
];
const KEY_VALUE = [
  { id: 'key', label: 'Key', kind: 'text' },
  { id: 'value', label: 'Value', kind: 'text' },
];

/**
 * The predetermined units an attribute's unit input autocompletes from.
 * A unit the user types by hand is remembered separately from the cards
 * (`rememberUnit`), so clearing the field or deleting the card does not take
 * the suggestion with it.
 */
export const UNIT_SUGGESTIONS = [
  '%', 'px', 'mm', 'cm', 'm', 'km', 'in', 'ft', 'mi', 'yd',
  'g', 'kg', 'lb', 'oz', 't', 's', 'ms', 'min', 'h', 'day', 'week', 'month', 'year',
  '°C', '°F', 'K', 'Hz', 'kHz', 'MHz', 'GHz', 'B', 'KB', 'MB', 'GB', 'TB',
  '/10', '/100', 'count', 'level',
];

/** Longest unit anyone would type; longer input is cut, not refused. */
export const UNIT_MAX_LENGTH = 32;

/** A unit as stored: trimmed, inner whitespace collapsed, capped in length. */
export function normalizeUnit(unit) {
  return String(unit ?? '').trim().replace(/\s+/g, ' ').slice(0, UNIT_MAX_LENGTH);
}

/** How many hand-typed units a vault remembers for its autocomplete. */
export const UNIT_VOCABULARY_LIMIT = 120;

/**
 * A learned-unit list with `raw` at the front, normalised and de-duplicated
 * case-insensitively. The newest hand-typed unit wins; an emptied field does
 * not remove anything from the vocabulary.
 */
export function rememberUnit(units = [], raw) {
  const wanted = normalizeUnit(raw);
  const out = [];
  const seen = new Set();
  if (wanted) {
    out.push(wanted);
    seen.add(wanted.toLowerCase());
  }
  for (const value of Array.isArray(units) ? units : []) {
    const unit = normalizeUnit(value);
    if (!unit) continue;
    const key = unit.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(unit);
  }
  return out.slice(0, UNIT_VOCABULARY_LIMIT);
}

/**
 * The autocomplete list for a unit input: the predetermined units first,
 * then the vault's learned units, then every unit currently stored in the
 * given fields records (one record, or an array of them, e.g. every vein's
 * record), in first-seen order. The learned list is what keeps a hand-typed
 * unit offerable after its field is cleared or its card deleted.
 * De-duplicated case-insensitively, so "Tokens" and "tokens" are one entry.
 */
export function unitSuggestions(fields = {}, learned = []) {
  const records = Array.isArray(fields) ? fields : [fields];
  const seen = new Set();
  const out = [];
  const offer = (raw) => {
    const unit = normalizeUnit(raw);
    if (!unit) return;
    const key = unit.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(unit);
  };
  for (const unit of UNIT_SUGGESTIONS) offer(unit);
  for (const unit of Array.isArray(learned) ? learned : []) offer(unit);
  for (const record of records) {
    for (const stored of Object.values(record ?? {})) {
      if (stored && typeof stored === 'object') offer(stored.unit);
    }
  }
  return out;
}

// An attribute is a key/value pair with a unit: "temper — 1200 °C".
const ATTRIBUTE = [...KEY_VALUE, { id: 'unit', label: 'Unit', kind: 'unit' }];

// A Table's grid lives in the markdown table itself. These limits are shared
// by the parser, the editor and the paste path so every route clamps alike.
export const TABLE_MAX_COLUMNS = 8;
export const TABLE_MAX_ROWS = 50;
export const TABLE_HEADER_MAX_LENGTH = 64;
export const TABLE_CELL_MAX_LENGTH = 200;
export const TABLE_ALIGNMENTS = ['default', 'left', 'center', 'right'];

/** A fresh table: three empty columns and three empty rows. */
export function blankTable({ columns = 3, rows = 3 } = {}) {
  const count = Number.isFinite(Number(columns)) ? Number(columns) : 3;
  const columnCount = Math.max(1, Math.min(TABLE_MAX_COLUMNS, Math.floor(count)));
  const rowInput = Number.isFinite(Number(rows)) ? Number(rows) : 3;
  const rowCount = Math.max(0, Math.min(TABLE_MAX_ROWS, Math.floor(rowInput)));
  const headers = Array.from({ length: columnCount }, () => '');
  return {
    columns: headers,
    rows: Array.from({ length: rowCount }, () => Array.from({ length: columnCount }, () => '')),
    align: Array.from({ length: columnCount }, () => 'default'),
  };
}

/**
 * Normalise a table from its stored JSON string or an in-memory object. Bad
 * data falls back to a fresh table; rows and columns are clipped to the same
 * limits the editor enforces, and cells are always strings.
 */
export function normalizeTable(value) {
  let raw = value;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return blankTable();
    try {
      raw = JSON.parse(trimmed);
    } catch {
      return blankTable();
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return blankTable();
  const rawColumns = Array.isArray(raw.columns) ? raw.columns.slice(0, TABLE_MAX_COLUMNS) : [];
  if (!rawColumns.length) return blankTable();
  const columns = rawColumns.map((column) => String(column ?? '').slice(0, TABLE_HEADER_MAX_LENGTH));
  const rawAlign = Array.isArray(raw.align) ? raw.align : [];
  const align = columns.map((_, index) => (TABLE_ALIGNMENTS.includes(rawAlign[index]) ? rawAlign[index] : 'default'));
  const rawRows = Array.isArray(raw.rows) ? raw.rows.slice(0, TABLE_MAX_ROWS) : [];
  const rows = rawRows.map((row) => {
    const cells = Array.isArray(row) ? row : [];
    return columns.map((_, index) => String(cells[index] ?? '').slice(0, TABLE_CELL_MAX_LENGTH));
  });
  return { columns, rows, align };
}

/** The legacy stored JSON form; live table content is canonical in markdown. */
export function serializeTable(value) {
  return JSON.stringify(normalizeTable(value));
}

/** Human-readable table text for search (never the stored JSON). */
export function tableText(value) {
  const table = normalizeTable(value);
  const parts = table.columns.filter((column) => String(column).trim());
  for (const row of table.rows) {
    for (const cell of row) if (String(cell).trim()) parts.push(cell);
  }
  return parts.join(' ');
}

/** A compact table description for the canvas SVG export. */
export function tableSummary(value) {
  const table = normalizeTable(value);
  const headers = table.columns.map((column, index) => String(column).trim() || `Column ${index + 1}`);
  const shown = headers.slice(0, 3).join(', ') + (headers.length > 3 ? ` +${headers.length - 3}` : '');
  return `${shown} · ${table.rows.length} row${table.rows.length === 1 ? '' : 's'}`;
}

/* ------------------------------------------------------ markdown tables -- */

/** A GFM delimiter cell: three-or-so dashes with optional alignment colons. */
function isTableDelimiterCell(cell) {
  return /^:?-{1,}:?$/.test(String(cell ?? '').trim());
}

/**
 * Split one GitHub-flavoured table row into cell text.
 *
 * Pipes inside an escaped pair (`\|`), an inline code span, or a wiki-link
 * alias (`[[Target|label]]`) belong to the cell, not to the table's shape.
 * The edge pipes that make a row look like `| A | B |` are optional; an empty
 * cell between two separators is preserved. Returns null when the line has no
 * unescaped table pipe at all.
 */
export function splitMarkdownTableRow(line) {
  const text = String(line ?? '').replace(/\r$/, '');
  const cells = [];
  let cell = '';
  let ticks = 0;
  let wikilinks = 0;
  let sawPipe = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\\' && text[i + 1] === '|') {
      cell += '|';
      i += 1;
      continue;
    }
    if (ch === '`') {
      let run = 1;
      while (text[i + run] === '`') run += 1;
      if (!ticks) ticks = run;
      else if (ticks === run) ticks = 0;
      cell += '`'.repeat(run);
      i += run - 1;
      continue;
    }
    if (!ticks && ch === '[' && text[i + 1] === '[') {
      wikilinks += 1;
      cell += '[[';
      i += 1;
      continue;
    }
    if (!ticks && ch === ']' && text[i + 1] === ']' && wikilinks) {
      wikilinks -= 1;
      cell += ']]';
      i += 1;
      continue;
    }
    if (ch === '|' && !ticks && !wikilinks) {
      cells.push(cell.trim());
      cell = '';
      sawPipe = true;
      continue;
    }
    cell += ch;
  }
  cells.push(cell.trim());
  if (!sawPipe) return null;

  const trimmed = text.trim();
  if (trimmed.startsWith('|') && cells.length && cells[0] === '') cells.shift();
  if (trimmed.endsWith('|') && cells.length && cells[cells.length - 1] === '') cells.pop();
  return cells;
}

/** The cells of a GFM header-separator row, or null when the line is not one. */
function tableDelimiter(line) {
  const cells = splitMarkdownTableRow(line);
  if (!cells?.length || !cells.every(isTableDelimiterCell)) return null;
  return cells;
}

/** The alignment a GFM delimiter cell declares. */
function alignmentOfDelimiter(cell) {
  const value = String(cell ?? '').trim();
  if (/^:-+:$/.test(value)) return 'center';
  if (/^:-+$/.test(value)) return 'left';
  if (/^-+:$/.test(value)) return 'right';
  return 'default';
}

/**
 * Find every GFM table in a note body. Fenced code is skipped, and each table
 * must have a header row plus a matching delimiter row. Body rows run until a
 * blank line. The returned range makes a table replaceable while leaving the
 * markdown around it — including any other tables — alone.
 *
 * Markdown is the table's canonical representation: the editor reads this
 * list on every build, so an external edit is never hidden behind a stale
 * saved grid.
 *
 * @returns {Array<{table: object, start: number, end: number, before: string,
 *            after: string}>}
 */
export function markdownTables(text) {
  const src = String(text ?? '');
  const rawLines = src.split('\n');
  const lines = [];
  let offset = 0;
  for (const raw of rawLines) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    lines.push({ text: line, start: offset, end: offset + line.length });
    offset += raw.length + 1;
  }

  let fence = null;
  const hits = [];
  for (let i = 0; i < lines.length - 1; i += 1) {
    const line = lines[i].text;
    const fenceHit = /^[ \t]*(`{3,}|~{3,})/.exec(line);
    if (fenceHit) {
      if (!fence) fence = fenceHit[1][0];
      else if (fenceHit[1][0] === fence) fence = null;
      continue;
    }
    if (fence || !line.includes('|')) continue;

    const delimiter = tableDelimiter(lines[i + 1]?.text);
    if (!delimiter) continue;
    const headers = splitMarkdownTableRow(line);
    if (!headers || headers.length !== delimiter.length) continue;

    const rows = [];
    let last = i + 1;
    for (let j = i + 2; j < lines.length; j += 1) {
      const candidate = lines[j].text;
      if (!candidate.trim() || !candidate.includes('|')) break;
      if (/^[ \t]*(`{3,}|~{3,})/.test(candidate)) break;
      const cells = splitMarkdownTableRow(candidate);
      if (!cells) break;
      rows.push(headers.map((_, column) => cells[column] ?? ''));
      last = j;
    }

    const start = lines[i].start;
    const end = lines[last].end;
    hits.push({
      table: normalizeTable({ columns: headers, rows, align: delimiter.map(alignmentOfDelimiter) }),
      start,
      end,
      before: src.slice(0, start),
      after: src.slice(end),
    });
    // Continue after this table rather than inside its body rows.
    i = last;
  }
  return hits;
}

/** One markdown table by position, or null when the note has no such table. */
export function markdownTableAt(text, index = 0) {
  return markdownTables(text)[Math.max(0, Math.floor(Number(index) || 0))] ?? null;
}

/** One markdown table as table data, or null when the note has no such table. */
export function tableFromMarkdown(text, index = 0) {
  return markdownTableAt(text, index)?.table ?? null;
}

/** True when the note's whole body is exactly one markdown table. */
export function markdownTableOnly(text) {
  const hits = markdownTables(text);
  const hit = hits[0];
  return Boolean(hits.length === 1 && hit && !String(hit.before).trim() && !String(hit.after).trim());
}

/** Write table data as a GFM table, headings and alignment row included. */
export function markdownFromTable(value) {
  const table = normalizeTable(value);
  const row = (cells) => `| ${cells
    .map((cell) => String(cell ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim())
    .join(' | ')} |`;
  const delimiter = (align) => {
    if (align === 'center') return ':---:';
    if (align === 'right') return '---:';
    if (align === 'left') return ':---';
    return '---';
  };
  return [
    row(table.columns),
    `| ${table.align.map(delimiter).join(' | ')} |`,
    ...table.rows.map(row),
  ].join('\n');
}

/**
 * The markdown outside a single table: Table mode's caption. A section with
 * several tables has no single caption to edit safely, so it returns an empty
 * string and the card sends the writer to the reader instead.
 */
export function tableCaptionOf(text) {
  const hits = markdownTables(text);
  const hit = hits[0];
  if (!hit) return String(text ?? '').trim();
  if (hits.length > 1) return '';
  return [hit.before, hit.after]
    .map((part) => String(part ?? '').trim())
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Replace the prose outside the table without touching the table itself. A
 * table-less body is all caption, so it becomes exactly the new caption.
 */
export function replaceTableCaption(text, caption) {
  const body = String(text ?? '');
  const next = String(caption ?? '').trim();
  const hits = markdownTables(body);
  const hit = hits[0];
  if (!hit) return next;
  if (hits.length > 1) return body;
  const table = body.slice(hit.start, hit.end).trim();
  return [next, table].filter(Boolean).join('\n\n');
}

/**
 * Write one table into the prose at its position, leaving the caption and
 * every other table untouched. This is the editor's only commit path.
 */
export function syncTableMarkdown(text, table, index = 0) {
  const body = String(text ?? '');
  const markdown = markdownFromTable(table);
  const hits = markdownTables(body);
  if (!hits.length) return [body.trim(), markdown].filter(Boolean).join('\n\n');
  const at = Math.min(Math.max(0, Math.floor(Number(index) || 0)), hits.length - 1);
  const hit = hits[at];
  return `${body.slice(0, hit.start)}${markdown}${body.slice(hit.end)}`;
}

/**
 * Parse TSV/CSV copied from a spreadsheet. Tabs win when present, otherwise
 * commas. RFC 4180 quoting, doubled quotes and newlines inside quoted fields
 * are understood, so a paste is not shredded by a comma in a cell.
 */
export function parseTablePaste(text) {
  let src = String(text ?? '').replace(/\r\n?/g, '\n');
  if (!src) return [];
  if (src.endsWith('\n')) src = src.slice(0, -1);
  const delimiter = src.includes('\t') ? '\t' : ',';
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(cell.trim());
      cell = '';
    } else if (ch === '\n') {
      row.push(cell.trim());
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  row.push(cell.trim());
  rows.push(row);
  return rows;
}

/**
 * Stamp a pasted block into a table at one cell. Rows and columns grow to fit
 * the block, within the same limits the editor enforces; existing content is
 * overwritten only where the block lands.
 */
export function pasteTableData(table, pasted, { row = 0, column = 0 } = {}) {
  const base = normalizeTable(table);
  const block = Array.isArray(pasted) ? pasted : [];
  if (!block.length) return base;
  const startRow = Math.max(0, Math.floor(Number(row) || 0));
  const startColumn = Math.max(0, Math.floor(Number(column) || 0));
  if (startRow >= TABLE_MAX_ROWS || startColumn >= TABLE_MAX_COLUMNS) return base;
  const width = Math.max(base.columns.length, startColumn + Math.max(...block.map((cells) => (Array.isArray(cells) ? cells.length : 1))));
  const height = Math.max(base.rows.length, startRow + block.length);
  const columnCount = Math.min(TABLE_MAX_COLUMNS, width);
  const rowCount = Math.min(TABLE_MAX_ROWS, height);
  const next = {
    columns: Array.from({ length: columnCount }, (_, index) => base.columns[index] ?? ''),
    align: Array.from({ length: columnCount }, (_, index) => base.align[index] ?? 'default'),
    rows: Array.from({ length: rowCount }, (_, index) => Array.from(
      { length: columnCount },
      (_, columnIndex) => base.rows[index]?.[columnIndex] ?? '',
    )),
  };
  block.forEach((cells, rowOffset) => {
    const targetRow = startRow + rowOffset;
    if (targetRow >= rowCount) return;
    (Array.isArray(cells) ? cells : [cells]).forEach((value, columnOffset) => {
      const targetColumn = startColumn + columnOffset;
      if (targetColumn >= columnCount) return;
      next.rows[targetRow][targetColumn] = String(value ?? '');
    });
  });
  return normalizeTable(next);
}

/** Reorder one table row, as a new table. */
export function moveTableRow(table, from, to) {
  const next = normalizeTable(table);
  const source = Math.floor(Number(from));
  const target = Math.floor(Number(to));
  if (!Number.isInteger(source) || !Number.isInteger(target)) return next;
  if (source < 0 || source >= next.rows.length || target < 0 || target >= next.rows.length || source === target) return next;
  const [row] = next.rows.splice(source, 1);
  next.rows.splice(target, 0, row);
  return next;
}

/** Set one column's alignment; the delimiter row is the stored form. */
export function setTableColumnAlign(table, column, align) {
  const next = normalizeTable(table);
  const index = Math.floor(Number(column));
  if (!Number.isInteger(index) || index < 0 || index >= next.columns.length) return next;
  next.align[index] = TABLE_ALIGNMENTS.includes(align) ? align : 'default';
  return next;
}

/**
 * The source row indexes a table view shows. Sorting and filtering are views,
 * never rewrites: the markdown row order stays exactly as written.
 */
export function tableRowOrder(table, { query = '', sortColumn = -1, sortDirection = 'asc' } = {}) {
  const rows = normalizeTable(table).rows.map((row, index) => ({ row, index }));
  const needle = String(query ?? '').trim().toLowerCase();
  const shown = needle
    ? rows.filter(({ row }) => row.some((cell) => String(cell).toLowerCase().includes(needle)))
    : rows;
  const column = Math.floor(Number(sortColumn));
  if (!Number.isInteger(column) || column < 0 || column >= (normalizeTable(table).columns.length)) return shown.map(({ index }) => index);
  const direction = sortDirection === 'desc' ? -1 : 1;
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  return [...shown]
    .sort((a, b) => direction * collator.compare(String(a.row[column] ?? ''), String(b.row[column] ?? '')) || a.index - b.index)
    .map(({ index }) => index);
}

export const NODE_FIELDS = {
  note: [],
  stat: [{ id: 'value', label: 'Value', kind: 'text' }],
  skill: LEVEL,
  ability: MIN_MAX,
  attribute: ATTRIBUTE,
  property: KEY_VALUE,
  table: [{ id: 'table', label: 'Table', kind: 'table' }],
  rating: RATING,
  // Place-like types are prose cards like notes: their content is markdown.
  place: [],
  person: [],
  thing: [],
  prop: [],
  location: [],
  scene: [],
  sound: [],
  image: [],
  animation: [],
  mode: [],
  actor: [],
  voiceover: [],
  dialog: [],
  line: [],
  action: [],
  locale: [],
  biome: [],
  perk: [],
  effect: [],
  condition: [],
};

/** The field schema for a type; empty for notes and unknown types. */
export function nodeFields(type) {
  return NODE_FIELDS[nodeType(type)?.id ?? DEFAULT_NODE_TYPE] ?? [];
}

/**
 * A numeric field's declared range as text for the editor (`0–10`,
 * `≥ 0`, `≤ 10`), or null when the field has no range to show.
 */
export function fieldRangeHint(field) {
  if (!field || field.kind !== 'number') return null;
  const { min, max } = field;
  if (typeof min === 'number' && typeof max === 'number') return `${min}–${max}`;
  if (typeof min === 'number') return `≥ ${min}`;
  if (typeof max === 'number') return `≤ ${max}`;
  return null;
}

/** One field's saved value for a note, empty when never set. */
export function nodeFieldOf(fields = {}, anchor, field) {
  const value = fields[anchor]?.[field];
  return typeof value === 'string' ? value : '';
}

/** Clamp a numeric value to a field's declared range, when it has one. */
function clampToRange(value, field) {
  const num = Number(value);
  if (!Number.isFinite(num)) return String(value);
  const min = typeof field.min === 'number' ? field.min : -Infinity;
  const max = typeof field.max === 'number' ? field.max : Infinity;
  return String(Math.min(max, Math.max(min, num)));
}

/**
 * Set one field's value on a note of the given type. Numeric fields are
 * clamped to the range their schema declares — an empty (cleared) field
 * stays empty rather than becoming 0. The min/max pair an ability takes is
 * kept ordered: the value just set wins, and its partner follows it.
 * @returns {object} a new fields object — the same object when the field is
 * not on the type's schema (so a note can never grow structured data)
 */
export function setNodeField(fields = {}, type, anchor, field, value) {
  const spec = nodeFields(type).find((f) => f.id === field);
  if (!anchor || !spec) return fields;
  const stored = spec.kind === 'table'
    ? serializeTable(value)
    : spec.kind === 'unit'
      ? normalizeUnit(value)
      : spec.kind === 'number' && String(value).trim() !== ''
        ? clampToRange(value, spec)
        : String(value);
  const pair = { ...(fields[anchor] ?? {}), [field]: stored };
  if (spec.kind === 'number' && (field === 'min' || field === 'max') && stored.trim() !== '') {
    const other = field === 'min' ? 'max' : 'min';
    const partner = pair[other];
    const crossed = field === 'min'
      ? Number(stored) > Number(partner)
      : Number(stored) < Number(partner);
    if (partner && String(partner).trim() !== '' && crossed) pair[other] = stored;
  }
  return { ...fields, [anchor]: pair };
}

/** Forget one stored field, removing the anchor when nothing else remains. */
export function dropNodeField(fields = {}, anchor, field) {
  if (!fields[anchor] || !(field in fields[anchor])) return fields;
  const pair = { ...fields[anchor] };
  delete pair[field];
  const next = { ...fields };
  if (Object.keys(pair).length) next[anchor] = pair;
  else delete next[anchor];
  return next;
}

const RELATION_BY_ID = indexById(RELATION_KINDS);

/* --------------------------------------------------------- canvas history -- */

/** Free-floating canvas annotations, cleaned for storage and snapshots. */
export const ANNOTATION_MAX_TEXT = 1000;

export function cleanAnnotations(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [id, value] of Object.entries(raw)) {
    if (!id || !value || typeof value !== 'object') continue;
    const text = String(value.text ?? '').trim().slice(0, ANNOTATION_MAX_TEXT);
    if (!text || !Number.isFinite(value.x) || !Number.isFinite(value.y)) continue;
    const annotation = { id, x: Math.round(value.x), y: Math.round(value.y), text };
    if (typeof value.color === 'string' && /^#[\da-f]{6}$/i.test(value.color)) annotation.color = value.color.toLowerCase();
    if (value.folded === true) annotation.folded = true;
    out[id] = annotation;
  }
  return out;
}

export function makeAnnotationId(annotations = {}) {
  let id = '';
  do {
    id = `ann-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  } while (annotations[id]);
  return id;
}

/**
 * Node images live as files under `.macusanite/node-images/`, referenced by
 * vault-relative path — never as data URLs in the record, so a canvas
 * snapshot carries a short path instead of duplicating the image bytes.
 * Older records may still hold a data URL; `isInlineImage` tells them apart.
 */
export const NODE_IMAGES_DIR = '.macusanite/node-images';

/** A legacy in-record data URL, as opposed to a file reference. */
export function isInlineImage(ref) {
  return typeof ref === 'string' && ref.startsWith('data:image/');
}

/**
 * Node-graph images are stored downscaled: they only ever show as a small
 * card icon, so the longest side is capped and the result is re-encoded
 * with a lossy codec. Images embedded in markdown prose are a different
 * thing entirely — those are the writer's own files and are never touched.
 */
export const NODE_IMAGE_MAX_SIDE = 320;
export const NODE_IMAGE_QUALITY = 0.8;

/**
 * The downscaled pixel size for a node image: the longest side shrinks to
 * at most `maxSide`, never upscaled. Returns `[width, height]`.
 */
export function nodeImageSize(naturalWidth, naturalHeight, maxSide = NODE_IMAGE_MAX_SIDE) {
  const w = Math.max(1, Math.floor(Number(naturalWidth) || 0));
  const h = Math.max(1, Math.floor(Number(naturalHeight) || 0));
  const side = Math.max(1, Math.floor(Number(maxSide) || NODE_IMAGE_MAX_SIDE));
  const scale = Math.min(1, side / Math.max(w, h));
  return [Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale))];
}

/** The vault-relative reference for an image file name. */
export function nodeImageRef(fileName) {
  return `${NODE_IMAGES_DIR}/${fileName}`;
}

/**
 * The `.macusanite`-relative meta name for an image reference, or null when
 * the reference is not a node-image file (a legacy inline data URL, say).
 */
export function nodeImageMetaName(ref) {
  if (!ref || isInlineImage(ref)) return null;
  const clean = String(ref).replace(/\\/g, '/');
  if (clean.startsWith(`${NODE_IMAGES_DIR}/`)) return clean.slice('.macusanite/'.length);
  if (clean.startsWith('.macusanite/')) return clean.slice('.macusanite/'.length);
  return null;
}

/**
 * The node-image files one images map points at: unique meta names, with
 * legacy inline data URLs and foreign references skipped.
 */
export function nodeImageMetaNames(images) {
  const names = new Set();
  for (const ref of Object.values(images ?? {})) {
    const metaName = nodeImageMetaName(ref);
    if (metaName) names.add(metaName);
  }
  return [...names];
}

/** The node-image files one canvas snapshot (string or object) points at. */
export function nodeImageMetaNamesFromSnapshot(snap) {
  let saved = snap;
  if (typeof saved?.snap === 'string') saved = saved.snap;
  if (typeof saved === 'string') {
    try {
      saved = JSON.parse(saved);
    } catch {
      return [];
    }
  }
  return nodeImageMetaNames(saved?.images);
}

/**
 * Every node-image file still referenced anywhere: the current images, the
 * undo/redo snapshots of this vein (`history: { past, future }`), and every
 * other vein's record in `worlds` (its images and its persisted history).
 * A file a snapshot still names is not an orphan — undo must find it there.
 */
export function referencedNodeImageMetaNames({ images = {}, history = null, worlds = {} } = {}) {
  const names = new Set(nodeImageMetaNames(images));
  const fromHistory = (stack) => {
    for (const entry of [...(stack?.past ?? []), ...(stack?.future ?? [])]) {
      for (const name of nodeImageMetaNamesFromSnapshot(entry)) names.add(name);
    }
  };
  fromHistory(history);
  for (const record of Object.values(worlds ?? {})) {
    for (const name of nodeImageMetaNames(record?.images)) names.add(name);
    fromHistory(record?.history);
  }
  return names;
}

/**
 * The candidate files (refs or meta names) that nothing references any more,
 * as meta names ready to delete. Inline data URLs have no file to delete.
 */
export function orphanedNodeImageMetaNames(candidates, referenced) {
  const keep = referenced instanceof Set ? referenced : new Set(referenced ?? []);
  const orphans = new Set();
  for (const candidate of candidates ?? []) {
    const metaName = nodeImageMetaName(candidate) ?? (String(candidate ?? '').startsWith('node-images/') ? String(candidate) : null);
    if (metaName && !keep.has(metaName)) orphans.add(metaName);
  }
  return [...orphans];
}

/**
 * Files attached to nodes live under `.macusanite/node-files/`, beside node
 * images and for the same reason: a canvas snapshot carries a short path,
 * never the bytes. URLs are validated web resources, not arbitrary schemes.
 */
export const NODE_FILES_DIR = '.macusanite/node-files';

/** One attached file's ceiling; the vault keeps files, not archives of them. */
export const NODE_FILE_MAX_BYTES = 8 * 1024 * 1024;

/** The most attachments and URLs one node records. */
export const NODE_RESOURCE_LIMIT = 24;

/** The vault-relative reference for an attached file name. */
export function nodeFileRef(fileName) {
  return `${NODE_FILES_DIR}/${fileName}`;
}

/**
 * The `.macusanite`-relative meta name for an attachment reference, or null
 * when the reference is not a node file.
 */
export function nodeFileMetaName(ref) {
  const clean = String(ref ?? '').replace(/\\/g, '/');
  if (clean.startsWith(`${NODE_FILES_DIR}/`) && !clean.includes('..')) return clean.slice('.macusanite/'.length);
  if (clean.startsWith('node-files/') && !clean.includes('..')) return clean;
  return null;
}

/** A web resource URL, or null for anything that is not http(s). */
export function normalizeWebUrl(value) {
  try {
    const url = new URL(String(value ?? '').trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname) return null;
    return url.href;
  } catch {
    return null;
  }
}

/**
 * One node's resources, cleaned: attachments must name a node file, URLs must
 * be http(s), duplicates collapse, and both lists are capped. Empty nodes are
 * dropped, so a record only carries resources that exist.
 */
export function cleanNodeResources(resources = {}) {
  const out = {};
  for (const [anchor, entry] of Object.entries(resources ?? {})) {
    if (!anchor || !entry || typeof entry !== 'object') continue;
    const files = [];
    const seenRefs = new Set();
    for (const file of Array.isArray(entry.files) ? entry.files : []) {
      if (!file || typeof file !== 'object') continue;
      const ref = String(file.ref ?? '').replace(/\\/g, '/');
      if (!ref.startsWith(`${NODE_FILES_DIR}/`) || ref.includes('..')) continue;
      if (ref.split('/').length !== 3 || seenRefs.has(ref)) continue;
      seenRefs.add(ref);
      const size = Number(file.size);
      const name = String(file.name ?? '').trim().slice(0, 160) || ref.split('/').pop();
      files.push({
        name,
        ref,
        ...(Number.isFinite(size) && size >= 0 ? { size: Math.round(size) } : {}),
        ...(typeof file.type === 'string' && file.type ? { type: file.type.slice(0, 100) } : {}),
      });
      if (files.length >= NODE_RESOURCE_LIMIT) break;
    }
    const urls = [];
    const seenUrls = new Set();
    for (const link of Array.isArray(entry.urls) ? entry.urls : []) {
      const url = normalizeWebUrl(link?.url);
      if (!url || url.length > 2048 || seenUrls.has(url)) continue;
      seenUrls.add(url);
      urls.push({ url, label: String(link?.label ?? '').trim().slice(0, 120) || url });
      if (urls.length >= NODE_RESOURCE_LIMIT) break;
    }
    if (files.length || urls.length) out[anchor] = { files, urls };
  }
  return out;
}

/** The attachment files one resources map points at, as meta names. */
export function nodeFileMetaNames(resources) {
  const names = new Set();
  for (const entry of Object.values(resources ?? {})) {
    for (const file of Array.isArray(entry?.files) ? entry.files : []) {
      const metaName = nodeFileMetaName(file?.ref);
      if (metaName) names.add(metaName);
    }
  }
  return [...names];
}

/** The attachment files one canvas snapshot (string or object) points at. */
export function nodeFileMetaNamesFromSnapshot(snap) {
  let saved = snap;
  if (typeof saved?.snap === 'string') saved = saved.snap;
  if (typeof saved === 'string') {
    try {
      saved = JSON.parse(saved);
    } catch {
      return [];
    }
  }
  return nodeFileMetaNames(saved?.resources);
}

/**
 * Every attachment file still referenced anywhere: the current resources, the
 * undo/redo snapshots of this vein, and every other vein's record and
 * persisted history. A file a snapshot still names is not an orphan.
 */
export function referencedNodeFileMetaNames({ resources = {}, history = null, worlds = {} } = {}) {
  const names = new Set(nodeFileMetaNames(resources));
  const fromHistory = (stack) => {
    for (const entry of [...(stack?.past ?? []), ...(stack?.future ?? [])]) {
      for (const name of nodeFileMetaNamesFromSnapshot(entry)) names.add(name);
    }
  };
  fromHistory(history);
  for (const record of Object.values(worlds ?? {})) {
    for (const name of nodeFileMetaNames(record?.resources)) names.add(name);
    fromHistory(record?.history);
  }
  return names;
}

/** Candidate attachment files (refs or meta names) that nothing references. */
export function orphanedNodeFileMetaNames(candidates, referenced) {
  const keep = referenced instanceof Set ? referenced : new Set(referenced ?? []);
  const orphans = new Set();
  for (const candidate of candidates ?? []) {
    const metaName = nodeFileMetaName(candidate);
    if (metaName && !keep.has(metaName)) orphans.add(metaName);
  }
  return [...orphans];
}

/**
 * Anchors whose markdown content is locked read-only, whether by a node
 * lock or by sitting in a locked group (through nesting, exactly as the
 * canvas treats it). Relationships are not content: links to and from a
 * locked card remain possible, and their bonds live in the record rather
 * than in the prose.
 */
export function lockedContentAnchors(groups = {}, nodeLocked = {}) {
  const out = new Set();
  for (const [anchor, locked] of Object.entries(nodeLocked ?? {})) {
    if (anchor && locked) out.add(anchor);
  }
  const all = groups ?? {};
  const parentOf = new Map();
  for (const [id, group] of Object.entries(all)) {
    for (const child of Array.isArray(group?.children) ? group.children : []) {
      if (child && !parentOf.has(child)) parentOf.set(child, id);
    }
  }
  const isLocked = (id) => {
    const seen = new Set();
    let current = id;
    while (current && !seen.has(current)) {
      if (all[current]?.locked) return true;
      seen.add(current);
      current = parentOf.get(current) ?? null;
    }
    return false;
  };
  const collect = (id, seen) => {
    if (seen.has(id)) return;
    seen.add(id);
    const group = all[id];
    if (!group) return;
    for (const anchor of Array.isArray(group.members) ? group.members : []) {
      if (anchor) out.add(anchor);
    }
    for (const child of Array.isArray(group.children) ? group.children : []) collect(child, seen);
  };
  for (const id of Object.keys(all)) {
    if (isLocked(id)) collect(id, new Set());
  }
  return out;
}

/**
 * Where each note's source sits in a vein, in full-text lines and offsets.
 * Scanning matches `parseNotes` — front matter and fences aside, the same
 * de-duplicated anchors — so a range always names the heading and the prose
 * that belongs to it, up to the next heading.
 */
export function sourceSectionRanges(text) {
  const src = String(text ?? '');
  const { body, raw, present } = parseFrontmatter(src);
  const lines = src.split('\n');
  const lineStarts = [];
  let cursor = 0;
  for (const line of lines) {
    lineStarts.push(cursor);
    cursor += line.length + 1;
  }
  const bodyLines = body.split('\n');
  const baseLine = present ? Math.max(0, raw.split('\n').length - 1) : 0;
  const seen = new Map();
  const ranges = [];
  let inFence = false;
  let fenceMarker = '';
  bodyLines.forEach((line, index) => {
    const fence = FENCE_RE.exec(line);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fence[1][0];
      } else if (fence[1][0] === fenceMarker) {
        inFence = false;
      }
      return;
    }
    if (inFence) return;
    const heading = HEADING_RE.exec(line);
    if (!heading) return;
    const title = heading[2].trim();
    const base = slugify(title) || `section-${ranges.length + 1}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    const startLine = baseLine + index;
    ranges.push({
      anchor: count === 0 ? base : `${base}-${count}`,
      level: heading[1].length,
      title,
      startLine,
      endLine: lines.length,
      start: lineStarts[startLine] ?? src.length,
      end: src.length,
    });
  });
  for (let i = 0; i < ranges.length - 1; i += 1) {
    ranges[i].endLine = ranges[i + 1].startLine;
    ranges[i].end = ranges[i + 1].start;
  }
  return ranges;
}

/**
 * The locked range an edit would touch, if any. A caret counts as inside
 * when it sits at or after the range start and before its end; a selection
 * counts when it overlaps the range at all.
 */
export function lockedRangeAt(ranges, start, end) {
  const s = Math.min(Number(start) || 0, Number(end) || 0);
  const e = Math.max(Number(start) || 0, Number(end) || 0);
  for (const range of ranges ?? []) {
    if (s === e) {
      if (s >= range.start && s < range.end) return range;
    } else if (s < range.end && range.start < e) {
      return range;
    }
  }
  return null;
}

/**
 * Keep locked sections read-only in the source editor. Ordinary edits come
 * back with the protected source restored from `baseText`, so outside text
 * still saves; structural escapes — a locked heading renamed or deleted, a
 * heading inserted or deleted inside locked prose, a locked section moved —
 * are refused whole rather than guessed at.
 *
 * @returns {{ok: boolean, text: string, enforced: boolean, blocked: string[]}}
 */
export function enforceLockedSource(baseText, draftText, protectedAnchors) {
  const anchors = protectedAnchors instanceof Set ? protectedAnchors : new Set(protectedAnchors ?? []);
  const base = String(baseText ?? '');
  const draft = String(draftText ?? '');
  if (!anchors.size) return { ok: true, text: draft, enforced: false, blocked: [] };
  const baseRanges = sourceSectionRanges(base);
  const draftRanges = sourceSectionRanges(draft);
  const baseByAnchor = new Map(baseRanges.map((range) => [range.anchor, range]));
  const draftByAnchor = new Map(draftRanges.map((range) => [range.anchor, range]));
  const protectedBase = baseRanges.filter((range) => anchors.has(range.anchor));
  if (!protectedBase.length) return { ok: true, text: draft, enforced: false, blocked: [] };
  const blocked = new Set();
  for (const range of protectedBase) {
    if (!draftByAnchor.has(range.anchor)) blocked.add(range.anchor);
  }
  const insideProtected = (startLine) => protectedBase.some(
    (range) => range.startLine < startLine && startLine < range.endLine,
  );
  for (const range of draftRanges) {
    if (!baseByAnchor.has(range.anchor) && insideProtected(range.startLine)) blocked.add(range.anchor);
  }
  for (const range of baseRanges) {
    if (!draftByAnchor.has(range.anchor) && insideProtected(range.startLine)) blocked.add(range.anchor);
  }
  const baseOrder = protectedBase.map((range) => range.anchor);
  const draftOrder = draftRanges.filter((range) => anchors.has(range.anchor)).map((range) => range.anchor);
  if (baseOrder.join('\0') !== draftOrder.join('\0')) {
    for (const anchor of draftOrder) blocked.add(anchor);
  }
  if (blocked.size) return { ok: false, text: draft, enforced: false, blocked: [...blocked] };
  let text = draft;
  const replacements = protectedBase
    .map((range) => ({ draft: draftByAnchor.get(range.anchor), base: range }))
    .filter((entry) => entry.draft)
    .sort((a, b) => b.draft.start - a.draft.start);
  for (const entry of replacements) {
    text = text.slice(0, entry.draft.start)
      + base.slice(entry.base.start, entry.base.end)
      + text.slice(entry.draft.end);
  }
  return { ok: true, text, enforced: text !== draft, blocked: [] };
}

/**
 * Card positions as a snapshot carries them: whole pixels, exactly as
 * `saveWorldLayout` persists them. A drag ending at 2349.199… snapshots as
 * 2349, so one undo restores the integer that was actually saved.
 */
export function cleanPositions(positions) {
  const out = {};
  for (const [anchor, pos] of Object.entries(positions ?? {})) {
    if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
      out[anchor] = { x: Math.round(pos.x), y: Math.round(pos.y) };
    }
  }
  return out;
}

/**
 * The canvas state an undo step puts back, as a comparable string: every
 * slice of the vein record the canvas itself owns — positions, groups,
 * relationships, folds, node types, structured fields, node colours, node
 * images, annotations, pins, node content locks and the camera. The markdown — titles, prose,
 * links — is edited by the vein's own undo, so it never appears here.
 */
/** Card display modes: `full` (the default, stored nowhere), `compact`, `thumbnail`. */
export const CARD_MODES = ['full', 'compact', 'thumbnail'];

export function cleanCardModes(modes = {}) {
  const out = {};
  for (const [anchor, mode] of Object.entries(modes ?? {})) {
    if (anchor && CARD_MODES.includes(mode) && mode !== 'full') out[anchor] = mode;
  }
  return out;
}

/**
 * Card heights: `fixed` (the vault default, stored only as an override) or
 * `content`, where a full card grows to its prose instead of scrolling it.
 * Unlike modes, `fixed` is kept: a node can opt back out of a vault that
 * fits cards to content by default.
 */
export const CARD_SIZES = ['fixed', 'content'];

export function cleanCardSizes(sizes = {}) {
  const out = {};
  for (const [anchor, size] of Object.entries(sizes ?? {})) {
    if (anchor && CARD_SIZES.includes(size)) out[anchor] = size;
  }
  return out;
}

/** How small and how large a card may be dragged, in canvas pixels. */
export const CARD_MIN_W = 180;
export const CARD_MIN_H = 120;
export const CARD_MAX_W = 1200;
export const CARD_MAX_H = 2000;

/**
 * Explicit card sizes, by note anchor: `{ width, height }` in canvas pixels.
 * A card without an entry keeps its designed box (or grows to its prose), so
 * only dragged cards ever appear here.
 */
export function cleanCardDims(dims = {}) {
  const out = {};
  for (const [anchor, value] of Object.entries(dims ?? {})) {
    if (!anchor || !value) continue;
    const width = Math.round(Number(value.width));
    const height = Math.round(Number(value.height));
    if (!Number.isFinite(width) || !Number.isFinite(height)) continue;
    out[anchor] = {
      width: Math.min(CARD_MAX_W, Math.max(CARD_MIN_W, width)),
      height: Math.min(CARD_MAX_H, Math.max(CARD_MIN_H, height)),
    };
  }
  return out;
}

export function cleanCollapsedGroups(collapsed = {}) {
  const out = {};
  for (const [id, value] of Object.entries(collapsed ?? {})) {
    if (id && value === true) out[id] = true;
  }
  return out;
}

/** Names on saved canvas views, capped so a menu row stays readable. */
const SAVED_VIEW_NAME_MAX = 80;
const SAVED_VIEW_QUERY_MAX = 500;

/**
 * Named canvas lenses kept beside a vein's layout. Each stores its search
 * filter, the anchors isolated at save time, its collapsed groups and the
 * camera anchor. Values are normalised here so old or hand-edited state
 * cannot put junk back on the canvas; duplicate names and unusable cameras
 * are dropped.
 */
export function cleanSavedViews(views = []) {
  if (!Array.isArray(views)) return [];
  const out = [];
  const names = new Set();
  const ids = new Set();
  for (const raw of views) {
    if (!raw || typeof raw !== 'object') continue;
    const name = String(raw.name ?? '').trim().slice(0, SAVED_VIEW_NAME_MAX);
    const key = name.toLowerCase();
    if (!name || names.has(key)) continue;
    const camera = cleanView(raw.view);
    if (!camera) continue;
    const query = String(raw.filters?.query ?? '').trim().slice(0, SAVED_VIEW_QUERY_MAX);
    const isolated = Array.isArray(raw.isolated)
      ? [...new Set(raw.isolated.filter((anchor) => typeof anchor === 'string' && anchor))]
      : null;
    let id = String(raw.id ?? '').trim();
    if (!id || ids.has(id)) {
      let n = out.length + 1;
      while (ids.has(`view-${n}`)) n += 1;
      id = `view-${n}`;
    }
    names.add(key);
    ids.add(id);
    out.push({
      id,
      name,
      filters: { query },
      isolated,
      collapsedGroups: cleanCollapsedGroups(raw.collapsedGroups),
      view: camera,
    });
  }
  return out;
}

export function canvasSnapshot(state = {}) {
  return JSON.stringify({
    positions: cleanPositions(state.positions),
    groups: state.groups ?? {},
    relations: state.relations ?? {},
    folded: state.folded ?? {},
    types: state.types ?? {},
    fields: state.fields ?? {},
    colors: state.colors ?? {},
    images: state.images ?? {},
    resources: cleanNodeResources(state.resources),
    pinned: state.pinned ?? {},
    locked: state.locked ?? {},
    cardModes: cleanCardModes(state.cardModes),
    cardSizes: cleanCardSizes(state.cardSizes),
    cardDims: cleanCardDims(state.cardDims),
    collapsedGroups: cleanCollapsedGroups(state.collapsedGroups),
    annotations: cleanAnnotations(state.annotations),
    // Markdown is a table's source of truth. Table edit steps carry the prose
    // they changed, so canvas undo restores the same grid the card showed.
    ...(state.tables ? { tables: state.tables } : {}),
    view: state.view ?? { x: 0, y: 0, s: 1 },
  });
}

/**
 * A snapshot cleaned of every reference to an anchor the vein has no card
 * for: its position, fold, type, fields and colour, bonds touching it, and
 * group memberships — a group then holding fewer than two cards (its
 * nested groups counted) dissolves with its bonds, the same cleanup a
 * delete gives the vein record. This keeps an undo from bringing back
 * bonds, folds, types, fields or colours for a card that is gone.
 *
 * Snapshots written before types, fields and colours existed carry no such
 * keys, and gain none here: whether one restores them is the caller's
 * business.
 */
/**
 * The groups that survive a membership filter: a group lives while it holds
 * at least two members, counting recovered children, so a parent emptied of
 * its own cards can still live on its nested groups. Returns the surviving
 * groups and the ids that dissolved.
 */
function pruneGroups(all, isLive) {
  const effectiveSize = (id, seen) => {
    const group = all[id];
    if (!group || seen.has(id)) return 0;
    seen.add(id);
    let size = (group.members ?? []).filter(isLive).length;
    for (const child of group.children ?? []) size += effectiveSize(child, seen);
    return size;
  };
  const surviving = new Set(Object.keys(all).filter((id) => effectiveSize(id, new Set()) >= 2));
  const groups = {};
  for (const [id, group] of Object.entries(all)) {
    if (!surviving.has(id)) continue;
    groups[id] = {
      ...group,
      members: (group.members ?? []).filter(isLive),
      children: (group.children ?? []).filter((child) => surviving.has(child)),
    };
  }
  return { groups, dissolved: Object.keys(all).filter((id) => !surviving.has(id)) };
}

/**
 * A deleted note leaves its group: everyone but it stays, and a group it
 * emptied below two cards dissolves — counting nested groups, so a parent
 * can live on its children's cards.
 */
export function dropAnchorFromGroups(groups = {}, anchor) {
  return pruneGroups(groups ?? {}, (member) => member !== anchor);
}

export function pruneSnapshotAnchors(snap, live) {
  const prunedGroups = pruneGroups(snap.groups ?? {}, (anchor) => live.has(anchor));
  const { groups } = prunedGroups;
  const surviving = new Set(Object.keys(groups));
  const relations = {};
  for (const [key, kind] of Object.entries(snap.relations ?? {})) {
    const ends = splitRelationKey(key);
    if (!ends) continue;
    const known = (end) => live.has(end) || (end.startsWith('group:') && surviving.has(end.slice(6)));
    if (known(ends.from) && known(ends.to)) relations[key] = kind;
  }
  const anchors = (obj) => Object.fromEntries(
    Object.entries(obj ?? {}).filter(([anchor]) => live.has(anchor)),
  );
  const collapsedGroups = Object.fromEntries(
    Object.entries(cleanCollapsedGroups(snap.collapsedGroups)).filter(([id]) => surviving.has(id)),
  );
  return {
    ...snap,
    positions: anchors(snap.positions),
    folded: anchors(snap.folded),
    groups,
    relations,
    ...(snap.types ? { types: anchors(snap.types) } : {}),
    ...(snap.fields ? { fields: anchors(snap.fields) } : {}),
    ...(snap.colors ? { colors: anchors(snap.colors) } : {}),
    ...(snap.images ? { images: anchors(snap.images) } : {}),
    ...(snap.resources ? { resources: anchors(snap.resources) } : {}),
    ...(snap.pinned ? { pinned: anchors(snap.pinned) } : {}),
    ...(snap.locked ? { locked: anchors(snap.locked) } : {}),
    ...(snap.cardModes ? { cardModes: anchors(snap.cardModes) } : {}),
    ...(snap.cardSizes ? { cardSizes: anchors(snap.cardSizes) } : {}),
    ...(snap.cardDims ? { cardDims: anchors(snap.cardDims) } : {}),
    ...(snap.collapsedGroups ? { collapsedGroups } : {}),
    ...(snap.annotations ? { annotations: cleanAnnotations(snap.annotations) } : {}),
    ...(snap.tables ? { tables: anchors(snap.tables) } : {}),
  };
}

/**
 * A view as it is kept and restored: a finite origin with its zoom clamped
 * to the canvas limits, a missing zoom meaning 1:1. Falls back when the
 * stored view is unusable, so a step can keep the camera it found.
 */
export function cleanView(view, fallback = null) {
  if (!view || !Number.isFinite(view.x) || !Number.isFinite(view.y)) return fallback;
  const s = Number.isFinite(view.s) ? Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, view.s)) : 1;
  return { x: view.x, y: view.y, s };
}

/**
 * A snapshot put back as slices: parsed when it arrives as a string, and
 * pruned of references to anchors with no card on screen. Types, fields
 * and colours come with the restore — snapshots written before they
 * existed keep the current ones instead. The view comes back when the
 * snapshot has a usable one, and stays the current one otherwise.
 *
 * @returns {object|null} the slices, or null for a snapshot that is not one
 */
export function restoreSnapshot(snap, live, current = {}) {
  let saved = snap;
  if (typeof saved === 'string') {
    try {
      saved = JSON.parse(saved);
    } catch {
      return null;
    }
  }
  if (!saved || typeof saved !== 'object') return null;
  const pruned = pruneSnapshotAnchors(saved, live);
  return {
    positions: cleanPositions(pruned.positions),
    groups: pruned.groups ?? {},
    relations: pruned.relations ?? {},
    folded: pruned.folded ?? {},
    types: pruned.types ?? current.types ?? {},
    fields: pruned.fields ?? current.fields ?? {},
    colors: pruned.colors ?? current.colors ?? {},
    images: pruned.images ?? current.images ?? {},
    resources: cleanNodeResources(pruned.resources ?? current.resources),
    pinned: pruned.pinned ?? current.pinned ?? {},
    locked: pruned.locked ?? current.locked ?? {},
    cardModes: cleanCardModes(pruned.cardModes ?? current.cardModes),
    cardSizes: cleanCardSizes(pruned.cardSizes ?? current.cardSizes),
    cardDims: cleanCardDims(pruned.cardDims ?? current.cardDims),
    collapsedGroups: cleanCollapsedGroups(pruned.collapsedGroups ?? current.collapsedGroups),
    annotations: pruned.annotations ?? cleanAnnotations(current.annotations),
    tables: pruned.tables ?? null,
    view: cleanView(pruned.view, current.view ?? null),
  };
}

/**
 * The patch an undo step writes into the vein record, as one piece so a
 * step is never half applied: positions, groups, relationships and folds
 * always; types, fields and colours only when the step carries them; the
 * camera only when the step has a usable view.
 */
export function canvasRecordPatch({ positions = {}, groups = {}, relations = {}, folded = {}, types = null, fields = null, colors = null, images = null, resources = null, pinned = null, locked = null, cardModes = null, cardSizes = null, cardDims = null, collapsedGroups = null, annotations = null, view = null } = {}) {
  const patch = { positions, groups, relations, folded };
  if (types) patch.types = types;
  if (fields) patch.fields = fields;
  if (colors) patch.colors = colors;
  if (images) patch.images = images;
  if (resources) patch.resources = cleanNodeResources(resources);
  if (pinned) patch.pinned = pinned;
  if (locked) patch.locked = locked;
  if (cardModes) patch.cardModes = cleanCardModes(cardModes);
  if (cardSizes) patch.cardSizes = cleanCardSizes(cardSizes);
  if (cardDims) patch.cardDims = cleanCardDims(cardDims);
  if (collapsedGroups) patch.collapsedGroups = cleanCollapsedGroups(collapsedGroups);
  if (annotations) patch.annotations = cleanAnnotations(annotations);
  const cleaned = cleanView(view);
  if (cleaned) patch.view = cleaned;
  return patch;
}

/** The name a history step wears when nothing nicer was chosen for it. */
export const DEFAULT_STEP_NAME = 'Canvas change';

/**
 * The in-memory key for a vein's canvas history. The vault path is part of
 * it, so the same vein path in two vaults cannot share an undo stack.
 */
export function historyKey(vaultPath, veinPath) {
  return `${vaultPath ?? ''}\0${veinPath ?? ''}`;
}

/**
 * One step of a canvas stack: the name of the change, and the snapshot it
 * put back. Stacks persisted before names existed hold bare snapshot
 * strings, which take the default name on the way in.
 */
export function normalizeHistoryEntry(entry) {
  if (typeof entry === 'string') return { name: DEFAULT_STEP_NAME, snap: entry };
  if (entry && typeof entry.snap === 'string') {
    const name = typeof entry.name === 'string' && entry.name.trim() ? entry.name : DEFAULT_STEP_NAME;
    return { name, snap: entry.snap };
  }
  return null;
}

/** A vein's stacks as the panel and the record keep them: entries only. */
export function cleanHistoryStack(saved = {}, limit = Infinity) {
  const clean = (snaps) => (Array.isArray(snaps)
    ? snaps.map(normalizeHistoryEntry).filter(Boolean).slice(-limit)
    : []);
  return { past: clean(saved?.past), future: clean(saved?.future) };
}

/**
 * Record one change on a stack, unless it left the canvas exactly as it
 * was: a new branch, so whatever could have been redone is gone, and the
 * oldest step gives way past the limit. Returns whether a step landed.
 */
export function pushHistoryStep(stack, currentSnap, before, name = DEFAULT_STEP_NAME, limit = Infinity) {
  if (before === currentSnap) return false;
  stack.past.push({ name, snap: before });
  if (stack.past.length > limit) stack.past.shift();
  stack.future.length = 0;
  return true;
}

/**
 * Rewrite every stored snapshot the way the vein record was just rewritten:
 * a rename moves entries onto the new name. Each step keeps its name, and a
 * malformed legacy snapshot is kept as it is — exactly as pruning keeps it —
 * so one bad entry cannot strand every other snapshot on the old anchor.
 */
export function rewriteHistoryStack(stack, edit) {
  const map = (entry) => {
    try {
      return { ...entry, name: entry.name, snap: JSON.stringify(edit(JSON.parse(entry.snap))) };
    } catch {
      return entry;
    }
  };
  stack.past = (stack.past ?? []).map(map);
  stack.future = (stack.future ?? []).map(map);
  return stack;
}

/** Rename one card through every undo and redo snapshot, keeping step names. */
export function renameHistoryAnchor(stack, before, after) {
  return rewriteHistoryStack(stack, (snap) => renameAnchorIn(snap, before, after));
}

/**
 * Prune deleted-card references from every stored snapshot, on both sides of
 * the history stack. Malformed legacy entries are retained unchanged; valid
 * snapshots are always anchor-safe before a future restore.
 */
export function pruneHistoryStack(stack, live) {
  const prune = (entries) => entries.map((entry) => {
    try {
      return { ...entry, snap: JSON.stringify(pruneSnapshotAnchors(JSON.parse(entry.snap), live)) };
    } catch {
      return entry;
    }
  });
  stack.past = prune(stack.past ?? []);
  stack.future = prune(stack.future ?? []);
  return stack;
}

/**
 * Jump through a stack: undo or redo `count` steps at once, landing on one
 * state. The steps leapfrogged land on the opposite stack, names intact, so
 * single-stepping works from either end afterwards.
 *
 * @returns {{past, future, restore}|null} the new stacks and the snapshot
 *   that puts the verdict state back — or null when there is nothing to jump
 */
export function historyJump(stack, kind, count, currentSnap) {
  const past = stack?.past ?? [];
  const future = stack?.future ?? [];
  if (!Number.isInteger(count) || count < 1) return null;
  // Walk the leapfrogged steps in the order single-stepping would, carrying
  // the live state with them: each step's entry keeps its own name, and the
  // state it must put back is the one the previous step left behind.
  if (kind === 'undo') {
    if (count > past.length) return null;
    const cut = past.length - count;
    const undone = past.slice(cut);
    const entersFuture = [];
    let snap = currentSnap;
    for (let i = undone.length - 1; i >= 0; i -= 1) {
      entersFuture.push({ name: undone[i].name, snap });
      snap = undone[i].snap;
    }
    return { past: past.slice(0, cut), future: [...future, ...entersFuture], restore: undone[0].snap };
  }
  if (kind === 'redo') {
    if (count > future.length) return null;
    const cut = future.length - count;
    const redone = future.slice(cut);
    const entersPast = [];
    let snap = currentSnap;
    for (let i = redone.length - 1; i >= 0; i -= 1) {
      entersPast.push({ name: redone[i].name, snap });
      snap = redone[i].snap;
    }
    return { past: [...past, ...entersPast], future: future.slice(0, cut), restore: redone[0].snap };
  }
  return null;
}

/**
 * A rename inside a stored snapshot: positions, folds, types, fields and
 * group members follow the new name, as they do in the vein record, while
 * bonds naming the old name drop, as the record's do.
 */
export function renameAnchorIn(snap, before, after) {
  const move = (obj) => {
    const next = { ...(obj ?? {}) };
    if (before in next) {
      next[after] = next[before];
      delete next[before];
    }
    return next;
  };
  const relations = {};
  for (const [key, kind] of Object.entries(snap.relations ?? {})) {
    const [from, to] = key.split('->');
    if (from === before || to === before) continue;
    relations[key] = kind;
  }
  const groups = {};
  for (const [id, group] of Object.entries(snap.groups ?? {})) {
    groups[id] = { ...group, members: (group.members ?? []).map((anchor) => (anchor === before ? after : anchor)) };
  }
  return {
    ...snap,
    positions: move(snap.positions),
    folded: move(snap.folded),
    cardModes: move(snap.cardModes),
    cardSizes: move(snap.cardSizes),
    cardDims: move(snap.cardDims),
    relations,
    groups,
    ...(snap.types ? { types: move(snap.types) } : {}),
    ...(snap.fields ? { fields: move(snap.fields) } : {}),
    ...(snap.colors ? { colors: move(snap.colors) } : {}),
    ...(snap.images ? { images: move(snap.images) } : {}),
    ...(snap.resources ? { resources: move(snap.resources) } : {}),
    ...(snap.pinned ? { pinned: move(snap.pinned) } : {}),
    ...(snap.locked ? { locked: move(snap.locked) } : {}),
    ...(snap.tables ? { tables: move(snap.tables) } : {}),
  };
}

/** The kind's record, or null for anything not on the list. */
export function relationKind(kind) {
  return findById(RELATION_BY_ID, kind);
}

/**
 * Key of the directed bond "this endpoint relates to that endpoint". An
 * endpoint is a note anchor or a group endpoint (`group:<id>`); node-to-node
 * records stay readable beside the older anchor→anchor keys.
 */
export function relationKey(from, to) {
  return `${from}->${to}`;
}

/** The relations endpoint that names a group rather than a note. */
export function groupEndpoint(groupId) {
  return `group:${groupId}`;
}

/**
 * Assert (or re-assert) the kind of one directed bond.
 *
 * @returns {object} a new relations object — the same object when the bond
 *   cannot be asserted (unknown kind, or an endpoint relating to itself)
 */
export function setRelation(relations = {}, from, to, kind) {
  const known = relationKind(kind);
  if (!known || !from || !to || from === to) return relations;
  return { ...relations, [relationKey(from, to)]: known.id };
}

/** The kind asserted for one directed bond, Associate when none was. */
export function relationOf(relations = {}, from, to) {
  return relationKind(relations[relationKey(from, to)])
    ?? RELATION_BY_ID.get(DEFAULT_RELATION);
}

/** The two endpoints a stored relation key names. */
function splitRelationKey(key) {
  const [from, to] = String(key).split('->');
  return from && to ? { from, to } : null;
}

/** Every bond touching an endpoint that left the vein, dropped. */
export function dropRelations(relations = {}, endpoint) {
  if (!endpoint) return relations;
  const next = { ...relations };
  for (const key of Object.keys(next)) {
    const ends = splitRelationKey(key);
    if (ends && (ends.from === endpoint || ends.to === endpoint)) delete next[key];
  }
  return next;
}

/**
 * Stored relationships where at least one end is a group. A node's bonds are
 * written in its prose (`noteEdges`), but a group holds no prose, so its
 * bonds live only in the record and the canvas draws them from here.
 *
 * `fromIndex`/`toIndex` locate an end on a card — a group's first member — so
 * arrangement can score the connector; they are -1 when nothing resolves.
 *
 * @returns {Array<{from, to, relation, fromIndex, toIndex}>}
 */
export function groupRelationEdges(model = {}, groups = {}, relations = {}) {
  const notes = model.notes ?? [];
  const cardIndex = (endpoint) => {
    if (!String(endpoint).startsWith('group:')) {
      return notes.findIndex((note) => note.anchor === endpoint);
    }
    const group = groups[String(endpoint).slice('group:'.length)];
    for (const anchor of group?.members ?? []) {
      const index = notes.findIndex((note) => note.anchor === anchor);
      if (index >= 0) return index;
    }
    return -1;
  };
  const edges = [];
  for (const [key, kind] of Object.entries(relations ?? {})) {
    const ends = splitRelationKey(key);
    if (!ends || !(ends.from.startsWith('group:') || ends.to.startsWith('group:'))) continue;
    const fromIndex = cardIndex(ends.from);
    const toIndex = cardIndex(ends.to);
    if (fromIndex < 0 || toIndex < 0) continue;
    edges.push({
      from: ends.from,
      to: ends.to,
      relation: (relationKind(kind) ?? RELATION_BY_ID.get(DEFAULT_RELATION)).id,
      fromIndex,
      toIndex,
    });
  }
  return edges;
}

/**
 * Associations written in the prose: a note linking `[[#Heading]]` points at
 * that note, and `[[Note title]]` points at the note with that title. Each
 * edge also carries the relationship asserted for it (`relations`, keyed by
 * anchor pair) and that kind's strength rank, so the canvas can draw and
 * label what the connection *means*, not just that it exists.
 *
 * @returns {Array<{id: string, from: number, to: number, kind: string,
 *                  relation: string, strength: number, label: string}>}
 */
export function noteEdges(model = {}, relations = {}) {
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
      const relation = relationKind(relations[relationKey(note.anchor, notes[to].anchor)])
        ?? RELATION_BY_ID.get(DEFAULT_RELATION);
      edges.push({
        id,
        from,
        to,
        kind,
        relation: relation.id,
        strength: relation.rank,
        label: link.section || link.alias || '',
      });
    }
  });

  return edges;
}

/**
 * The prose link that still joins two notes, when one does: a `[[#Heading]]`
 * section link or a `[[Note]]` mention, in either direction. A stated bond
 * removed from the canvas leaves this link — and the wire drawn from it — in
 * place, which is worth saying out loud. Returns `{ from, to, kind }` with
 * anchors, or null.
 */
export function proseLinkBetween(model = {}, from, to) {
  if (!from || !to || from === to) return null;
  const notes = model.notes ?? [];
  const anchorOf = (index) => notes[index]?.anchor ?? null;
  const edge = noteEdges(model, {}).find((candidate) => {
    if (candidate.kind !== 'section' && candidate.kind !== 'mention') return false;
    const source = anchorOf(candidate.from);
    const target = anchorOf(candidate.to);
    return (source === from && target === to) || (source === to && target === from);
  });
  return edge ? { from: anchorOf(edge.from), to: anchorOf(edge.to), kind: edge.kind } : null;
}

/**
 * Unlink two cards' prose from each other: every `[[#Heading]]` section link
 * and `[[Note]]` mention the two notes write between them — in either
 * direction — loses its brackets and keeps the words the reader saw, so the
 * wire the prose was drawing goes away and the sentence still reads. Links to
 * other notes, and the note bodies either side of them, are left alone.
 *
 * @returns {{model: object, removed: number}} a new model and how many links
 *   came out — the same model and 0 when there was nothing to unlink
 */
export function unlinkProseBetween(model = {}, from, to) {
  if (!from || !to || from === to) return { model, removed: 0 };
  const notes = model.notes ?? [];
  const byAnchor = new Map(notes.map((note, index) => [note.anchor, index]));
  const byTitle = new Map(notes.map((note, index) => [String(note.title).toLowerCase(), index]));
  let removed = 0;
  const next = notes.map((note) => {
    const other = note.anchor === from ? to : note.anchor === to ? from : null;
    const otherIndex = other ? byAnchor.get(other) : undefined;
    if (otherIndex === undefined) return note;
    const title = String(notes[otherIndex].title ?? '');
    const reaches = (link) => (link.samePage
      ? byAnchor.get(link.anchor) === otherIndex
      : Boolean(link.target) && byTitle.get(String(link.target).toLowerCase()) === otherIndex);
    // Right to left, so each edit leaves the offsets before it alone.
    const hits = parseWikiLinks(note.body).filter(reaches).sort((a, b) => b.start - a.start);
    if (!hits.length) return note;
    let body = note.body;
    for (const hit of hits) {
      const words = hit.alias || hit.section || title;
      body = `${body.slice(0, hit.start)}${words}${body.slice(hit.end)}`;
      removed += 1;
    }
    return { ...note, body, ...describeBody(body) };
  });
  return removed ? { model: { ...model, notes: next }, removed } : { model, removed: 0 };
}

/**
 * Progression columns for a set of anchors: where each card sits on a
 * Kanban-style board of its group, by the heading tree. The top items —
 * cards with no shallower ancestor inside the set — form the leftmost
 * column (tier 0); a card under one of them sits one tier to the right,
 * and so on down the outline. A card whose parent is not in the set is a
 * top item of the set, however deep it sits in the vein. Returns a Map of
 * anchor to column, in card order for the anchors present in the model.
 */
export function progressionColumns(model = {}, anchors = []) {
  const notes = model.notes ?? [];
  const target = new Set(anchors ?? []);
  const parentOf = new Map();
  for (const edge of hierarchyEdges(model)) {
    const from = notes[edge.from]?.anchor;
    const to = notes[edge.to]?.anchor;
    if (from && to && target.has(from) && target.has(to)) parentOf.set(to, from);
  }
  const columns = new Map();
  const depthOf = (anchor, seen = new Set()) => {
    if (columns.has(anchor)) return columns.get(anchor);
    if (seen.has(anchor)) return 0;
    seen.add(anchor);
    const parent = parentOf.get(anchor);
    const depth = parent ? depthOf(parent, seen) + 1 : 0;
    columns.set(anchor, depth);
    return depth;
  };
  for (const note of notes) {
    if (target.has(note.anchor)) depthOf(note.anchor);
  }
  return columns;
}

/**
 * Lay entries out as progression columns: each entry's column steps right
 * by `stepX`, and entries stack down their column in the order given, each
 * `stepY` below the last card's bottom. Entries need a `key`, a finite
 * `column`, and finite `height`. Returns a Map of key to `{x, y}`.
 */
export function layoutProgressionColumns(entries, { origin = { x: 0, y: 0 }, stepX = 0, stepY = 0 } = {}) {
  const next = new Map();
  const tops = new Map();
  const list = (entries ?? []).filter((entry) => (
    entry && entry.key !== undefined && Number.isFinite(entry.column) && entry.column >= 0 && Number.isFinite(entry.height)
  ));
  for (const entry of list) {
    const y = tops.get(entry.column) ?? origin.y;
    next.set(entry.key, { x: origin.x + entry.column * stepX, y });
    tops.set(entry.column, y + entry.height + stepY);
  }
  return next;
}

/**
 * How far a card must move, in canvas pixels, before a drop changes its
 * membership — a nudge is not a placement.
 */
export const DROP_MIN_PX = 12;

/**
 * What a solo card's drop does to its membership:
 *
 * - `'join'` — dragged across a group's border from outside it, by more
 *   than a nudge: it joins that group. (That also leaves its previous one.)
 * - `'leave'` — dragged out of the group it started the drag in, by more
 *   than a nudge: it leaves that group.
 * - `null` — anywhere else: it stayed in the group it started in, or it
 *   never really moved.
 *
 * `startGroupId` is the group (or null) the card started the drag inside;
 * `targetId` the group (or null) under its centre now.
 */
export function dropMembershipKind({ distance, startGroupId, targetId }) {
  if (!Number.isFinite(distance) || distance < DROP_MIN_PX) return null;
  if (targetId != null && targetId !== startGroupId) return 'join';
  if (startGroupId != null && targetId !== startGroupId) return 'leave';
  return null;
}

/**
 * Bonds asserted between two notes that neither one's prose links: the canvas
 * can state a relationship without a `[[link]]` being written into either
 * note. A pair the prose already links is `noteEdges`' business, and a bond
 * with a group at one end is `groupRelationEdges`'.
 *
 * @returns {Array<{from, to, relation, fromIndex, toIndex}>} anchors at each
 *   end, so a bond and a link name their ends the same way
 */
export function bondEdges(model = {}, relations = {}) {
  const notes = model.notes ?? [];
  const byAnchor = new Map(notes.map((note, i) => [note.anchor, i]));
  const linked = new Set(noteEdges(model, relations).map((edge) => relationKey(notes[edge.from].anchor, notes[edge.to].anchor)));
  const edges = [];
  for (const [key, kind] of Object.entries(relations ?? {})) {
    const ends = splitRelationKey(key);
    if (!ends || linked.has(key)) continue;
    if (ends.from.startsWith('group:') || ends.to.startsWith('group:')) continue;
    const fromIndex = byAnchor.get(ends.from);
    const toIndex = byAnchor.get(ends.to);
    if (fromIndex === undefined || toIndex === undefined) continue;
    edges.push({
      from: ends.from,
      to: ends.to,
      relation: (relationKind(kind) ?? RELATION_BY_ID.get(DEFAULT_RELATION)).id,
      fromIndex,
      toIndex,
    });
  }
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

/**
 * Anchors of the connected component the seeds sit in, through prose links
 * and asserted bonds (the outline spine is not a connection). The seeds
 * themselves are included.
 */
export function connectedAnchors(model = {}, relations = {}, seeds = []) {
  const notes = model.notes ?? [];
  const adjacency = new Map(notes.map((note) => [note.anchor, new Set()]));
  const link = (a, b) => {
    if (adjacency.has(a) && adjacency.has(b)) {
      adjacency.get(a).add(b);
      adjacency.get(b).add(a);
    }
  };
  // noteEdges name ends by index, bondEdges by anchor — either resolves.
  const anchorOf = (end) => (typeof end === 'number' ? notes[end]?.anchor : end);
  for (const edge of [...noteEdges(model, relations), ...bondEdges(model, relations)]) {
    const from = anchorOf(edge.from);
    const to = anchorOf(edge.to);
    if (from && to) link(from, to);
  }
  const out = new Set();
  const queue = [...new Set(seeds ?? [])].filter((anchor) => adjacency.has(anchor));
  while (queue.length) {
    const anchor = queue.pop();
    if (out.has(anchor)) continue;
    out.add(anchor);
    for (const next of adjacency.get(anchor) ?? []) {
      if (!out.has(next)) queue.push(next);
    }
  }
  return out;
}

/**
 * Anchors above (`'ancestors'`) or below (`'descendants'`) the seeds in the
 * heading outline. The seeds themselves are not included.
 */
export function lineageAnchors(model = {}, seeds = [], direction = 'descendants') {
  const notes = model.notes ?? [];
  const children = new Map(notes.map((note) => [note.anchor, new Set()]));
  const parents = new Map(notes.map((note) => [note.anchor, new Set()]));
  for (const edge of hierarchyEdges(model)) {
    const from = notes[edge.from]?.anchor;
    const to = notes[edge.to]?.anchor;
    if (from && to) {
      children.get(from).add(to);
      parents.get(to).add(from);
    }
  }
  const graph = direction === 'ancestors' ? parents : children;
  const seedSet = new Set(seeds ?? []);
  const out = new Set();
  const queue = [...seedSet].filter((anchor) => graph.has(anchor));
  while (queue.length) {
    const anchor = queue.pop();
    for (const next of graph.get(anchor) ?? []) {
      if (seedSet.has(next) || out.has(next)) continue;
      out.add(next);
      queue.push(next);
    }
  }
  return out;
}

/**
 * Anchors whose rect intersects `box` — the marquee hit test. Rects and the
 * box share canvas coordinates; touching an edge counts.
 */
export function anchorsInRect(rects = [], box = {}) {
  const out = new Set();
  if (!box || !Number.isFinite(box.x) || !Number.isFinite(box.y)
    || !Number.isFinite(box.width) || !Number.isFinite(box.height)) return out;
  const x2 = box.x + box.width;
  const y2 = box.y + box.height;
  for (const rect of rects ?? []) {
    if (!rect?.anchor || !Number.isFinite(rect.x) || !Number.isFinite(rect.y)
      || !Number.isFinite(rect.width) || !Number.isFinite(rect.height)) continue;
    if (rect.x <= x2 && rect.x + rect.width >= box.x && rect.y <= y2 && rect.y + rect.height >= box.y) {
      out.add(rect.anchor);
    }
  }
  return out;
}

/**
 * Whether the straight run between two points touches a box. A run that only
 * passes through counts: a wire crossing the marquee has neither end inside it.
 */
function segmentHitsRect(from, to, box) {
  const right = box.x + box.width;
  const bottom = box.y + box.height;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  let enter = 0;
  let exit = 1;
  const edges = [
    [-dx, from.x - box.x],
    [dx, right - from.x],
    [-dy, from.y - box.y],
    [dy, bottom - from.y],
  ];
  for (const [edge, distance] of edges) {
    if (edge === 0) {
      // Parallel to this edge: only a run already outside it can miss.
      if (distance < 0) return false;
      continue;
    }
    const at = distance / edge;
    if (edge < 0) enter = Math.max(enter, at);
    else exit = Math.min(exit, at);
    if (enter > exit) return false;
  }
  return true;
}

/**
 * The keys of the wires a marquee box touches. `curves` are `{key, points}`
 * sampled along each drawn wire; a wire counts when any of its points is in
 * the box or a run between two points crosses it, so a wire that passes
 * straight through the box is picked as readily as one that ends inside it.
 */
export function curvesInRect(curves = [], box = {}) {
  const hits = new Set();
  if (!box || !Number.isFinite(box.x) || !Number.isFinite(box.y)
    || !Number.isFinite(box.width) || !Number.isFinite(box.height)) return hits;
  const right = box.x + box.width;
  const bottom = box.y + box.height;
  for (const curve of curves ?? []) {
    const key = curve?.key;
    const points = (curve?.points ?? []).filter((point) => point
      && Number.isFinite(point.x) && Number.isFinite(point.y));
    if (!key || !points.length) continue;
    if (hits.has(key)) continue;
    for (let i = 0; i < points.length; i += 1) {
      const point = points[i];
      if (point.x >= box.x && point.x <= right && point.y >= box.y && point.y <= bottom) {
        hits.add(key);
        break;
      }
      if (i && segmentHitsRect(points[i - 1], point, box)) {
        hits.add(key);
        break;
      }
    }
  }
  return hits;
}

/**
 * Relationship depth for each anchor in `anchors`: the longest directed
 * path through prose links and bonds inside the set. Roots (no incoming
 * bond) sit at depth 0; cycles are bounded rather than infinite.
 */
export function relationshipDepths(model = {}, relations = {}, anchors = []) {
  const notes = model.notes ?? [];
  const target = new Set(anchors ?? []);
  const edges = [];
  const anchorOf = (end) => (typeof end === 'number' ? notes[end]?.anchor : end);
  for (const edge of [...noteEdges(model, relations), ...bondEdges(model, relations)]) {
    const from = anchorOf(edge.from);
    const to = anchorOf(edge.to);
    if (target.has(from) && target.has(to) && from !== to) edges.push([from, to]);
  }
  const indegree = new Map([...target].map((anchor) => [anchor, 0]));
  for (const [, to] of edges) indegree.set(to, indegree.get(to) + 1);
  const depth = new Map();
  for (const anchor of target) {
    if (indegree.get(anchor) === 0) depth.set(anchor, 0);
  }
  if (!depth.size && target.size) {
    const indexOf = new Map(notes.map((note, i) => [note.anchor, i]));
    depth.set([...target].sort((a, b) => (indexOf.get(a) ?? 0) - (indexOf.get(b) ?? 0))[0], 0);
  }
  for (let pass = 0; pass < target.size; pass += 1) {
    let changed = false;
    for (const [from, to] of edges) {
      if (!depth.has(from)) continue;
      const next = depth.get(from) + 1;
      if (!depth.has(to) || next > depth.get(to)) {
        depth.set(to, next);
        changed = true;
      }
    }
    if (!changed) break;
  }
  for (const anchor of target) {
    if (!depth.has(anchor)) depth.set(anchor, 0);
  }
  return depth;
}

/**
 * Search one vein's cards across titles, types, fields, colours and group
 * names. Every term must land somewhere on the card (terms are ANDed,
 * fields ORed). Returns matches in card order, title matches first, each
 * with the kinds of fields it matched (`title`, `type`, `field`,
 * `colour`, `group`).
 */
export function canvasSearch(model = {}, record = {}, query = '') {
  const terms = String(query ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const notes = model.notes ?? [];
  const types = record.types ?? {};
  const fields = record.fields ?? {};
  const colors = record.colors ?? {};
  const groups = record.groups ?? {};
  const groupNames = new Map();
  const collect = (group, seen) => {
    if (!group || seen.has(group.id)) return;
    seen.add(group.id);
    const name = group.name || 'Group';
    for (const anchor of Array.isArray(group.members) ? group.members : []) {
      const list = groupNames.get(anchor) ?? [];
      if (!list.includes(name)) list.push(name);
      groupNames.set(anchor, list);
    }
    for (const child of Array.isArray(group.children) ? group.children : []) collect(groups[child], seen);
  };
  for (const group of Object.values(groups)) collect(group, new Set());
  const matches = [];
  notes.forEach((note, index) => {
    const type = nodeTypeOf(types, note.anchor);
    const stored = fields[note.anchor] ?? {};
    const fieldTexts = [];
    // A saved table field is legacy in every type. Never let an old JSON grid
    // make a locked card searchable after its markdown moved on.
    const tableFields = new Set(['table']);
    for (const field of nodeFields(type.id)) {
      const value = stored[field.id];
      if (field.kind === 'table') {
        // The markdown table is canonical; a stale saved field is ignored.
        const text = markdownTables(note.body)
          .map((hit) => tableText(hit.table))
          .filter(Boolean)
          .join(' ');
        if (text) fieldTexts.push(`${field.label} ${text}`);
      } else if (value !== undefined && value !== null && String(value).trim() !== '') {
        fieldTexts.push(`${field.label} ${value}`);
      }
    }
    for (const [fieldId, value] of Object.entries(stored)) {
      if (tableFields.has(fieldId)) continue;
      if (String(value ?? '').trim() !== '') fieldTexts.push(String(value));
    }
    const searchable = [
      { kind: 'title', text: note.title ?? '' },
      { kind: 'type', text: `${type.label} ${type.id}` },
      ...fieldTexts.map((text) => ({ kind: 'field', text })),
      ...[colors[note.anchor], type.color].filter(Boolean).map((color) => ({ kind: 'colour', text: String(color) })),
      ...(groupNames.get(note.anchor) ?? []).map((name) => ({ kind: 'group', text: name })),
    ].map((entry) => ({ kind: entry.kind, text: entry.text.toLowerCase() }));
    if (!terms.every((term) => searchable.some((entry) => entry.text.includes(term)))) return;
    const reasons = [];
    for (const term of terms) {
      const hit = searchable.find((entry) => entry.text.includes(term));
      if (hit && !reasons.includes(hit.kind)) reasons.push(hit.kind);
    }
    matches.push({ anchor: note.anchor, index, title: note.title || note.anchor, reasons });
  });
  return matches.sort((a, b) => (a.reasons.includes('title') ? 0 : 1) - (b.reasons.includes('title') ? 0 : 1) || a.index - b.index);
}

/**
 * Every connector the canvas draws, named the same way: a kind, two
 * endpoints (note anchors or `group:` endpoints), and the asserted
 * relationship when there is one. The outline spine is a connector too,
 * so selection and tracing see exactly what is on screen.
 */
export function connectorList(model = {}, groups = {}, relations = {}) {
  const notes = model.notes ?? [];
  const anchorOf = (index) => notes[index]?.anchor ?? null;
  return [
    ...hierarchyEdges(model).map((edge) => ({ from: anchorOf(edge.from), to: anchorOf(edge.to), kind: 'contains' })),
    ...noteEdges(model, relations).map((edge) => ({ from: anchorOf(edge.from), to: anchorOf(edge.to), kind: edge.kind, relation: edge.relation })),
    ...bondEdges(model, relations).map((edge) => ({ from: edge.from, to: edge.to, kind: 'bond', relation: edge.relation })),
    ...groupRelationEdges(model, groups, relations).map((edge) => ({ from: edge.from, to: edge.to, kind: 'group', relation: edge.relation })),
  ].filter((edge) => edge.from && edge.to && edge.from !== edge.to);
}

/** A connector's stable identity, for selection and routing overrides. */
export function connectorKey(edge) {
  return `${edge?.kind ?? 'bond'}:${edge?.from}->${edge?.to}`;
}

/**
 * The next connector selection after a canvas click. A plain click picks one
 * connector, and a second plain click on that sole pick clears it. Ctrl/Cmd
 * toggles the clicked connector without dropping the others.
 */
export function nextConnectorSelection(selected, key, additive = false) {
  if (additive) {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  }
  if (selected.size === 1 && selected.has(key)) return new Set();
  return new Set([key]);
}

/**
 * Anchors reached by following directed relationships: `'downstream'`
 * along the arrows, `'upstream'` against them. Prose links and bonds
 * count; the outline spine does not. Seeds excluded.
 */
export function pathAnchors(model = {}, relations = {}, seeds = [], direction = 'downstream') {
  const notes = model.notes ?? [];
  const forward = new Map(notes.map((note) => [note.anchor, new Set()]));
  const backward = new Map(notes.map((note) => [note.anchor, new Set()]));
  const anchorOf = (end) => (typeof end === 'number' ? notes[end]?.anchor : end);
  for (const edge of [...noteEdges(model, relations), ...bondEdges(model, relations)]) {
    const from = anchorOf(edge.from);
    const to = anchorOf(edge.to);
    if (!forward.has(from) || !forward.has(to) || from === to) continue;
    forward.get(from).add(to);
    backward.get(to).add(from);
  }
  const graph = direction === 'upstream' ? backward : forward;
  const seedSet = new Set(seeds ?? []);
  const out = new Set();
  const queue = [...seedSet].filter((anchor) => graph.has(anchor));
  while (queue.length) {
    const anchor = queue.pop();
    for (const next of graph.get(anchor) ?? []) {
      if (seedSet.has(next) || out.has(next)) continue;
      out.add(next);
      queue.push(next);
    }
  }
  return out;
}

/** The tag token shape `parseTags` reads: `#name`, with slashes and dashes inside. */
const TAG_RE = /^[\p{L}\p{N}][\p{L}\p{N}/_-]*$/u;

/**
 * Normalise a tag typed on a card: drop the `#`, trim, lowercase, and reject
 * anything the prose reader would not read back as a tag.
 * @returns {string|null} the tag, or null when it cannot be a tag
 */
export function normalizeTag(value) {
  const tag = String(value ?? '').trim().replace(/^#+/, '').toLowerCase();
  return TAG_RE.test(tag) ? tag : null;
}

/**
 * The note a tag names, when one does. A tag and a heading's anchor are both
 * lowercase slugs, so `#field-checklist` reaches the “Field checklist” card —
 * the tag is a door to it. Returns null when no node wears that name.
 */
export function tagTarget(tag, notes) {
  const wanted = normalizeTag(tag);
  if (!wanted) return null;
  return (notes ?? []).find((note) => note.anchor === wanted) ?? null;
}

/** True for a line made of nothing but `#tag` tokens — where addNoteTags writes. */
function isTagLine(line) {
  const words = String(line ?? '').trim().split(/\s+/).filter(Boolean);
  return words.length > 0 && words.every((word) => word.startsWith('#') && normalizeTag(word));
}

/**
 * Tag a note: append the new `#tag` tokens to the note's prose (a trailing
 * tags line when one is already there, a fresh line otherwise), so the tag is
 * plain markdown the vault index can read back.
 *
 * @param {object} [options] `{ locked }` — a content-locked note's tags are
 *   its markdown, so a locked note takes no tags: the same model comes back.
 * @returns {object} a new model — the same model when nothing is new
 */
export function addNoteTags(model, index, tags = [], { locked = false } = {}) {
  if (locked) return model;
  const wanted = [...new Set((tags ?? []).map((tag) => normalizeTag(tag)).filter(Boolean))];
  const note = (model?.notes ?? [])[index];
  if (!wanted.length || !note) return model;
  const have = new Set((note.tags ?? []).map((tag) => String(tag).toLowerCase()));
  const fresh = wanted.filter((tag) => !have.has(tag));
  if (!fresh.length) return model;

  const tokens = fresh.map((tag) => `#${tag}`).join(' ');
  const lines = String(note.body ?? '').split('\n');
  let lastTagLine = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!String(lines[i]).trim()) continue;
    if (isTagLine(lines[i])) lastTagLine = i;
    break;
  }
  if (lastTagLine >= 0) {
    lines[lastTagLine] = `${lines[lastTagLine].trim()} ${tokens}`;
  } else {
    const body = String(note.body ?? '');
    lines.push(body.trim() ? '' : '', tokens);
  }
  return updateNote(model, index, { body: lines.join('\n') });
}

/**
 * Untag a note: strip that `#tag` token from the note's prose, leaving code
 * fences alone (the reader's tag reader ignores them too). Lines that were
 * only the token disappear with it.
 *
 * @param {object} [options] `{ locked }` — as `addNoteTags`: a content-locked
 *   note keeps its tags, so the same model comes back.
 * @returns {object} a new model — the same model when the note has no such tag
 */
export function removeNoteTag(model, index, tag, { locked = false } = {}) {
  if (locked) return model;
  const norm = normalizeTag(tag);
  const note = (model?.notes ?? [])[index];
  if (!norm || !note) return model;
  const have = new Set((note.tags ?? []).map((value) => String(value).toLowerCase()));
  if (!have.has(norm)) return model;

  // `norm` is TAG_RE-validated, so it holds no regex specials to escape.
  const token = new RegExp(`(^|\\s)#${norm}(?=$|\\s)`, 'gi');
  let inFence = false;
  let fenceMarker = '';
  const lines = [];
  for (const line of String(note.body ?? '').split('\n')) {
    const fence = FENCE_RE.exec(line);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fence[1][0];
      } else if (fence[1][0] === fenceMarker) {
        inFence = false;
      }
    }
    if (inFence) {
      lines.push(line);
      continue;
    }
    const replaced = line.replace(token, (match, gap) => gap);
    if (replaced === line) {
      lines.push(line);
      continue;
    }
    // Only lines the strip touched get tidied: the space the token stood in
    // must not leave a double space (or a dangling leading one) behind.
    const cleaned = replaced.replace(/[ \t]+/g, ' ').trim();
    // A line that held only the token(s) disappears with them; a tags line
    // that still holds other tags keeps just those.
    if (isTagLine(line) && (!cleaned || isTagLine(cleaned))) {
      if (cleaned) lines.push(cleaned);
      continue;
    }
    lines.push(cleaned);
  }
  return updateNote(model, index, { body: lines.join('\n') });
}

/**
 * The vault's tag record: every tag the index knows about, with how many veins
 * carry it. Reads the same index entries the search pane and graph read, so
 * the canvas stays in step with the vault.
 *
 * @param {Array} index index entries (`{path, tags, indexed}`)
 * @returns {Array<{tag: string, count: number, veins: string[]}>}
 */
export function tagRecord(index = []) {
  const counts = new Map();
  for (const doc of index ?? []) {
    if (!doc || doc.indexed === false) continue;
    const seen = new Set();
    for (const raw of doc.tags ?? []) {
      const tag = normalizeTag(raw) ?? String(raw).toLowerCase();
      if (!tag || seen.has(tag)) continue;
      seen.add(tag);
      const row = counts.get(tag) ?? { tag, count: 0, veins: [] };
      row.count += 1;
      row.veins.push(String(doc.path ?? ''));
      counts.set(tag, row);
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/**
 * Zoom limits for the worldbuilding canvas (1 is 100%). The lower bound is
 * deliberately far below the readable-card scale: Fit has to be able to frame
 * a canvas of any size, and the panel switches to icon-only cards at 12.5%
 * long before this floor is reached.
 */
export const ZOOM_MIN = 0.000001;
export const ZOOM_MAX = 3;

/**
 * Below this scale the cards read as compact objects rather than editable
 * surfaces. Forging a relationship stays available there: the link dot is
 * redrawn at a constant screen size on the card's corner as long as the view
 * is this small. At the boundary itself the port still sits in the card head.
 */
export const FORGE_ZOOM = 0.65;

/** True when a view scale calls for the screen-sized corner forge ring. */
export function isForgeZoom(scale) {
  return scale < FORGE_ZOOM;
}

/**
 * Toggle the compact-forge stage class for a scale. Takes a classList-like
 * object so the rule can be exercised without a DOM; returns whether the
 * class is on once the call is done.
 */
export function syncForgeZoomClass(classList, scale) {
  const forge = isForgeZoom(scale);
  classList.toggle('is-forge-zoom', forge);
  return forge;
}

/**
 * Connector display preferences for a vein: whether wires run as bezier
 * curves or right-angle elbows, whether they carry arrowheads, and whether
 * long wires are cut off at a marker. Stored as a view preference, so junk
 * values can neither break the canvas nor turn an unexpected saved shape
 * into a feature.
 */
export function normalizeRouting(routing) {
  const edges = {};
  for (const [key, value] of Object.entries(routing?.edges ?? {})) {
    if (!key || !value || typeof value !== 'object') continue;
    const entry = {};
    if (typeof value.elbow === 'boolean') entry.elbow = value.elbow;
    if (typeof value.arrows === 'boolean') entry.arrows = value.arrows;
    if (typeof value.cut === 'boolean') entry.cut = value.cut;
    if (Object.keys(entry).length) edges[key] = entry;
  }
  return {
    elbow: Boolean(routing?.elbow),
    arrows: Boolean(routing?.arrows),
    cut: Boolean(routing?.cut),
    edges,
  };
}

/** One connector's routing: its per-connector override, else the vein default. */
export function effectiveRouting(routing, key) {
  const normalized = normalizeRouting(routing);
  const override = normalized.edges[key] ?? {};
  return {
    elbow: override.elbow ?? normalized.elbow,
    arrows: override.arrows ?? normalized.arrows,
    cut: override.cut ?? normalized.cut,
  };
}

/**
 * The four points of an orthogonal connector between two boxes: it leaves
 * one side, turns once, runs the other axis, and enters the other side.
 * Vertical connectors leave bottom-to-top; horizontal ones leave side-to-
 * side. The middle of a wire can therefore sit on a bend, which the label
 * placer treats like any other point along it.
 */
export function elbowPoints(from, to, vertical = false) {
  if (vertical) {
    const [top, bottom] = to.y + to.height / 2 >= from.y + from.height / 2 ? [from, to] : [to, from];
    const x1 = top.x + top.width / 2;
    const y1 = top.y + top.height;
    const x2 = bottom.x + bottom.width / 2;
    const y2 = bottom.y;
    const midY = (y1 + y2) / 2;
    return [
      { x: x1, y: y1 },
      { x: x1, y: midY },
      { x: x2, y: midY },
      { x: x2, y: y2 },
    ];
  }
  const y1 = from.y + from.height / 2;
  const y2 = to.y + to.height / 2;
  const rightward = to.x + to.width / 2 >= from.x + from.width / 2;
  const x1 = rightward ? from.x + from.width : from.x;
  const x2 = rightward ? to.x : to.x + to.width;
  const midX = (x1 + x2) / 2;
  return [
    { x: x1, y: y1 },
    { x: midX, y: y1 },
    { x: midX, y: y2 },
    { x: x2, y: y2 },
  ];
}

/** A point along an orthogonal (elbow) wire, by distance rather than by segment. */
export function polylineAt(points) {
  const lengths = [];
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    const length = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    lengths.push(length);
    total += length;
  }
  return (t) => {
    let remaining = Math.min(1, Math.max(0, t)) * total;
    for (let i = 1; i < points.length; i += 1) {
      const length = lengths[i - 1];
      if (remaining <= length || i === points.length - 1) {
        const u = length === 0 ? 0 : remaining / length;
        return {
          x: points[i - 1].x + (points[i].x - points[i - 1].x) * u,
          y: points[i - 1].y + (points[i].y - points[i - 1].y) * u,
        };
      }
      remaining -= length;
    }
    return points[points.length - 1];
  };
}

/**
 * How far a wire runs before it is cut off, in canvas pixels: a card dragged
 * far from its neighbours still reads as connected, without a wire crossing
 * every card in between. The cut end carries a marker that flies the camera
 * to the far card when clicked.
 */
export const CONNECTOR_CUT_SPAN = 1100;

/** A point on the cubic through four control points, at t. */
function cubicPoint([p0, p1, p2, p3], t) {
  const m = 1 - t;
  const w = [m ** 3, 3 * m * m * t, 3 * m * t * t, t ** 3];
  return {
    x: w[0] * p0.x + w[1] * p1.x + w[2] * p2.x + w[3] * p3.x,
    y: w[0] * p0.y + w[1] * p1.y + w[2] * p2.y + w[3] * p3.y,
  };
}

/** Split a cubic at t into its two halves, de Casteljau: [before, after]. */
function splitCubic([p0, p1, p2, p3], t) {
  const lerp = (a, b) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  const [a1, b1, c1] = [lerp(p0, p1), lerp(p1, p2), lerp(p2, p3)];
  const [a2, b2] = [lerp(a1, b1), lerp(b1, c1)];
  const a3 = lerp(a2, b2);
  return [[p0, a1, a2, a3], [a3, b2, c1, p3]];
}

/** Cut a right-angle wire at `limit` px from its start; null when it is short. */
function cutPolyline(points, limit) {
  if (!Number.isFinite(limit) || limit <= 0) return null;
  const lengths = [];
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    lengths.push(Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
    total += lengths[lengths.length - 1];
  }
  if (total <= limit) return null;
  let remaining = limit;
  for (let i = 1; i < points.length; i += 1) {
    const length = lengths[i - 1];
    if (remaining <= length) {
      const previous = points[i - 1];
      const next = points[i];
      const u = length ? remaining / length : 0;
      const end = {
        x: previous.x + (next.x - previous.x) * u,
        y: previous.y + (next.y - previous.y) * u,
      };
      const dir = length
        ? { x: (next.x - previous.x) / length, y: (next.y - previous.y) / length }
        : { x: 1, y: 0 };
      return { points: [...points.slice(0, i), end], cut: { x: end.x, y: end.y, dir, length: limit, total } };
    }
    remaining -= length;
  }
  return null;
}

/** Cut a bezier at `limit` px along it; null when it is short enough. */
function cutCubic(points, limit, steps = 64) {
  if (!Number.isFinite(limit) || limit <= 0) return null;
  let total = 0;
  let previous = points[0];
  let before = null;
  for (let i = 1; i <= steps; i += 1) {
    const next = cubicPoint(points, i / steps);
    const length = Math.hypot(next.x - previous.x, next.y - previous.y);
    if (!before && total + length >= limit) {
      const u = length ? (limit - total) / length : 0;
      before = {
        t: (i - 1 + u) / steps,
        x: previous.x + (next.x - previous.x) * u,
        y: previous.y + (next.y - previous.y) * u,
      };
    }
    total += length;
    previous = next;
  }
  if (!before) return null;
  const [drawn, rest] = splitCubic(points, before.t);
  const dx = rest[3].x - rest[2].x;
  const dy = rest[3].y - rest[2].y;
  const length = Math.hypot(dx, dy);
  const dir = length ? { x: dx / length, y: dy / length } : { x: 1, y: 0 };
  // The split's own end is the exact point on the curve at that t — the
  // marker sits on the wire, not on the chord the length walk measured.
  const end = drawn[3];
  return { points: drawn, cut: { x: end.x, y: end.y, dir, length: limit, total } };
}

/**
 * Where a connector leaves one box's side and meets the other's: a cubic
 * that only ever curves sideways, so it reads as a wire between cards. Both
 * control points share their endpoint's height, which makes it symmetric
 * about t = 0.5 — its halfway point is also its visual centre. A stacked
 * pair (`vertical`) instead leaves the top card's bottom and enters the
 * next card's top, curving the same way vertically. In elbow mode the same
 * endpoints become a right-angle wire. `path` is the wire's SVG
 * description, `at(t)` a point along it, t from its start at 0 to its
 * end at 1. `head` is the destination end, for an arrowhead.
 *
 * With `limit`, a wire longer than that many pixels is drawn only that far:
 * `path` and `at` cover the drawn stretch, and `cut` names where it stops
 * ({ x, y, dir, length, total }) so the panel can end it in a marker pointing
 * at the far card. A wire that fits is unchanged.
 *
 * This is the one place the bend math lives: the panel draws `path`, and the
 * arrangement scorer samples the prepared entry's `at`, so the curve scored is
 * always the curve drawn.
 */
export function connectorCurve(from, to, { vertical = false, elbow = false, limit = Infinity } = {}) {
  const unit = (x, y) => {
    const length = Math.hypot(x, y);
    return length ? { x: x / length, y: y / length } : { x: 0, y: 0 };
  };
  const headAtStart = vertical && to.y + to.height / 2 <= from.y + from.height / 2;
  if (elbow) {
    const full = elbowPoints(from, to, vertical);
    const [a, b, c, d] = full;
    const head = headAtStart ? a : d;
    const headDir = headAtStart ? unit(a.x - b.x, a.y - b.y) : unit(d.x - c.x, d.y - c.y);
    const trimmed = cutPolyline(full, limit);
    const points = trimmed?.points ?? full;
    return {
      path: points.map((point, i) => `${i === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' '),
      at: polylineAt(points),
      head,
      headDir,
      headAtStart,
      ...(trimmed ? { cut: trimmed.cut } : {}),
    };
  }
  let full;
  if (vertical) {
    const [top, bottom] = to.y + to.height / 2 >= from.y + from.height / 2 ? [from, to] : [to, from];
    const x1 = top.x + top.width / 2;
    const y1 = top.y + top.height;
    const x2 = bottom.x + bottom.width / 2;
    const y2 = bottom.y;
    const bend = Math.max(36, Math.abs(y2 - y1) * 0.45);
    full = [
      { x: x1, y: y1 },
      { x: x1, y: y1 + bend },
      { x: x2, y: y2 - bend },
      { x: x2, y: y2 },
    ];
  } else {
    const y1 = from.y + from.height / 2;
    const y2 = to.y + to.height / 2;
    const rightward = to.x + to.width / 2 >= from.x + from.width / 2;
    const x1 = rightward ? from.x + from.width : from.x;
    const x2 = rightward ? to.x : to.x + to.width;
    const bend = Math.max(36, Math.abs(x2 - x1) * 0.45);
    full = [
      { x: x1, y: y1 },
      { x: rightward ? x1 + bend : x1 - bend, y: y1 },
      { x: rightward ? x2 - bend : x2 + bend, y: y2 },
      { x: x2, y: y2 },
    ];
  }
  const [a, b, c, d] = full;
  const head = headAtStart ? a : d;
  const headDir = headAtStart ? unit(a.x - b.x, a.y - b.y) : unit(d.x - c.x, d.y - c.y);
  const trimmed = cutCubic(full, limit);
  const [p0, p1, p2, p3] = trimmed?.points ?? full;
  return {
    path: `M ${p0.x} ${p0.y} C ${p1.x} ${p1.y} ${p2.x} ${p2.y} ${p3.x} ${p3.y}`,
    at(t) {
      return cubicPoint([p0, p1, p2, p3], t);
    },
    head,
    headDir,
    headAtStart,
    ...(trimmed ? { cut: trimmed.cut } : {}),
  };
}

/**
 * How far apart two connectors that would otherwise share a path are spread,
 * in canvas pixels: enough to read as two wires, small enough to stay on the
 * sides of a card.
 */
export const CONNECTOR_SPREAD = 12;

const CONNECTOR_LABEL_SLOTS = [0.5, 0.44, 0.56, 0.38, 0.62, 0.32, 0.68, 0.26, 0.74, 0.2, 0.8];
const CONNECTOR_LABEL_SLOTS_CLEAR = [0.5, 0.56, 0.44, 0.62, 0.38, 0.68, 0.32, 0.74, 0.26, 0.8, 0.2];
const CONNECTOR_LABEL_GAP = 14;
const CONNECTOR_LABEL_STROKE_PAD = 3;
const CONNECTOR_LABEL_WIRE_CLEARANCE = 6;
const CONNECTOR_LABEL_WIRE_STEPS = 48;
const CONNECTOR_LABEL_FALLBACK_OFFSETS = [12, 20, 28, 36];
const CONNECTOR_LABEL_BOX_CLEARANCE = 4;

function segmentIntersectsBox(a, b, box) {
  let low = 0;
  let high = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  for (const [origin, delta, min, max] of [
    [a.x, dx, box.left, box.right],
    [a.y, dy, box.top, box.bottom],
  ]) {
    if (Math.abs(delta) < 1e-9) {
      if (origin < min || origin > max) return false;
      continue;
    }
    const enter = (min - origin) / delta;
    const exit = (max - origin) / delta;
    low = Math.max(low, Math.min(enter, exit));
    high = Math.min(high, Math.max(enter, exit));
    if (low > high) return false;
  }
  return true;
}

/**
 * Place connector words at the nearest clear slot along their own wires.
 * SVG text can report a zero box while its stage or font is unavailable; in
 * that case estimate a conservative monospace box from the visible word.
 * Candidate boxes include the text halo and avoid other connector curves/lines.
 * Rectangular obstacles — card bodies and group or card borders — reject any
 * candidate that would cover or straddle them. If no along-wire slot is clear,
 * try readable off-wire positions with a short leader. Return null only if
 * neither placement is clear.
 *
 * @param {Array<{label: string, width: number, height: number, at: (t: number) => {x: number, y: number}, obstacles?: Array<(t: number) => {x: number, y: number}>, rects?: Array<{x: number, y: number, width: number, height: number}>}>} labels
 * @returns {Array<{x: number, y: number, leader?: {x: number, y: number}}|null>}
 */
export function placeConnectorLabels(labels = []) {
  const placed = [];
  return labels.map(({ label = '', width, height, at, obstacles = [], rects = [] }) => {
    const measuredWidth = Number(width);
    const measuredHeight = Number(height);
    const fallbackWidth = Math.max(6, [...String(label)].length * 6);
    const labelWidth = Number.isFinite(measuredWidth) && measuredWidth > 0 ? measuredWidth : fallbackWidth;
    const labelHeight = Number.isFinite(measuredHeight) && measuredHeight > 0 ? measuredHeight : 12;
    // The visible halo extends past getBBox() on each side. Include it in both
    // label-to-label tests and line clearance so halos cannot touch or overlap.
    const boxWidth = labelWidth + CONNECTOR_LABEL_STROKE_PAD * 2;
    const boxHeight = labelHeight + CONNECTOR_LABEL_STROKE_PAD * 2;
    const obstaclePoints = obstacles.map((obstacleAt) => {
      const points = [];
      for (let i = 0; i <= CONNECTOR_LABEL_WIRE_STEPS; i += 1) {
        points.push(obstacleAt(i / CONNECTOR_LABEL_WIRE_STEPS));
      }
      return points;
    });
    // The word's own box, halo included, and the wider box its wire needs.
    const wordBox = (candidate) => ({
      left: candidate.x - boxWidth / 2,
      right: candidate.x + boxWidth / 2,
      top: candidate.y - boxHeight / 2,
      bottom: candidate.y + boxHeight / 2,
    });
    // A card's body, a group's box edge or a card's border is a surface the
    // word must not cover or straddle: it would read as part of the node.
    const surfaceOverlap = (candidate) => {
      const word = wordBox(candidate);
      return rects.reduce((most, rect) => {
        if (!rect || !Number.isFinite(rect.x) || !Number.isFinite(rect.y)) return most;
        const width = Math.max(0, Number(rect.width) || 0);
        const height = Math.max(0, Number(rect.height) || 0);
        const overlapX = Math.min(word.right, rect.x + width + CONNECTOR_LABEL_BOX_CLEARANCE)
          - Math.max(word.left, rect.x - CONNECTOR_LABEL_BOX_CLEARANCE);
        const overlapY = Math.min(word.bottom, rect.y + height + CONNECTOR_LABEL_BOX_CLEARANCE)
          - Math.max(word.top, rect.y - CONNECTOR_LABEL_BOX_CLEARANCE);
        if (overlapX <= 0 || overlapY <= 0) return most;
        return Math.max(most, overlapX * overlapY);
      }, 0);
    };
    const clearAt = (candidate) => {
      if (surfaceOverlap(candidate)) return false;
      const box = {
        left: wordBox(candidate).left - CONNECTOR_LABEL_WIRE_CLEARANCE,
        right: wordBox(candidate).right + CONNECTOR_LABEL_WIRE_CLEARANCE,
        top: wordBox(candidate).top - CONNECTOR_LABEL_WIRE_CLEARANCE,
        bottom: wordBox(candidate).bottom + CONNECTOR_LABEL_WIRE_CLEARANCE,
      };
      const crossesWire = obstaclePoints.some((points) => points.some((point, i) => (
        i > 0 && segmentIntersectsBox(points[i - 1], point, box)
      )));
      if (crossesWire) return false;
      return placed.every((other) => {
        const apartX = Math.abs(candidate.x - other.x) - (boxWidth + other.width) / 2;
        const apartY = Math.abs(candidate.y - other.y) - (boxHeight + other.height) / 2;
        return apartX >= CONNECTOR_LABEL_GAP || apartY >= CONNECTOR_LABEL_GAP;
      });
    };
    // With surfaces in play the middle can be blocked, so the slots alternate
    // outwards from it rather than running one way first; a bare canvas keeps
    // the original order.
    const slots = rects.length ? CONNECTOR_LABEL_SLOTS_CLEAR : CONNECTOR_LABEL_SLOTS;
    let spot = null;
    for (const t of slots) {
      const candidate = at(t);
      if (clearAt(candidate)) {
        spot = candidate;
        break;
      }
    }
    if (!spot) {
      for (const t of slots) {
        const anchor = at(t);
        const before = at(Math.max(0, t - 0.01));
        const after = at(Math.min(1, t + 0.01));
        const dx = after.x - before.x;
        const dy = after.y - before.y;
        const length = Math.hypot(dx, dy);
        const normal = length > 1e-9 ? { x: -dy / length, y: dx / length } : { x: 0, y: 1 };
        for (const offset of CONNECTOR_LABEL_FALLBACK_OFFSETS) {
          for (const sign of [1, -1]) {
            const candidate = {
              x: anchor.x + normal.x * offset * sign,
              y: anchor.y + normal.y * offset * sign,
            };
            if (!clearAt(candidate)) continue;
            spot = { ...candidate, leader: anchor };
            break;
          }
          if (spot) break;
        }
        if (spot) break;
      }
    }
    if (!spot) {
      // Nothing is clear: keep the relationship readable on the slot that
      // covers the least of any node or group rather than hiding the word.
      let least = Infinity;
      for (const t of slots) {
        const candidate = at(t);
        const overlap = surfaceOverlap(candidate);
        if (overlap < least) {
          least = overlap;
          spot = candidate;
        }
      }
    }
    if (spot) placed.push({ x: spot.x, y: spot.y, width: boxWidth, height: boxHeight });
    return spot;
  });
}

/**
 * Give every connector in a drawing its own geometry.
 *
 * The lane fan-out at each endpoint keeps most wires apart, but two
 * connectors can still resolve to exactly the same boxes and routing — a
 * folded pair with both a prose link and a mention, two links between the
 * same cards in one direction, or two endpoints that measure to one box.
 * Drawing them would paint one wire on top of the other, hiding the second
 * relationship (and its click target).
 *
 * Entries are taken in drawing order and each one keeps its path unless that
 * path is already claimed; then it is shifted perpendicular to its own wire
 * (down/up for a horizontal wire, sideways for a vertical one) in growing
 * steps until the path is unique. The first wire of a duplicated set stays
 * where it was, so ordinary canvases are unchanged, and the result is stable
 * for the same drawing order. `from`/`to` come back adjusted for the callers
 * that need the endpoints themselves.
 *
 * @param {Array<{from: object, to: object, vertical?: boolean, elbow?: boolean, limit?: number}>} entries
 * @returns {Array<object>} the entries with `from`, `to`, `path`, `at`, `head`, `headDir` and `cut`
 */
export function spreadConnectorCurves(entries = []) {
  const used = new Set();
  const options = (entry) => ({ vertical: Boolean(entry.vertical), elbow: Boolean(entry.elbow), limit: entry.limit ?? Infinity });
  const shifted = (rect, offset, vertical) => (vertical
    ? { ...rect, x: rect.x + offset }
    : { ...rect, y: rect.y + offset });
  return entries.map((entry) => {
    const base = connectorCurve(entry.from, entry.to, options(entry));
    if (!used.has(base.path)) {
      used.add(base.path);
      return { ...entry, ...base };
    }
    for (let step = 1; step <= 30; step += 1) {
      for (const sign of [1, -1]) {
        const offset = sign * step * CONNECTOR_SPREAD;
        const from = shifted(entry.from, offset, Boolean(entry.vertical));
        const to = shifted(entry.to, offset, Boolean(entry.vertical));
        const candidate = connectorCurve(from, to, options(entry));
        if (used.has(candidate.path)) continue;
        used.add(candidate.path);
        return { ...entry, from, to, ...candidate };
      }
    }
    // Thirty lanes either way is far beyond any real canvas: keep the base
    // wire rather than fail a draw, but it is already the last resort.
    used.add(base.path);
    return { ...entry, ...base };
  });
}

/** The distance between neighbouring connector lanes at one endpoint. */
export const CONNECTOR_LANE_PITCH = 16;

/**
 * Prepare connectors exactly as the canvas draws them: actual endpoint rects,
 * a lane per bond at a shared endpoint, stacked-pair verticals, per-edge
 * routing and the cut limit where that routing asks for one.
 *
 * Drawing and the arrangement's occlusion scorer both call this, so a score
 * measures the wires the reader actually sees. The scorer supplies rects for
 * its candidate positions; the canvas supplies the rects on screen.
 *
 * @param {Array<{from: string, to: string, kind?: string}>} connectors
 * @param {object} options
 * @param {(endpoint: string) => object|null} options.rectFor
 * @param {object} [options.routing]
 * @param {(from: string, to: string) => boolean} [options.isStacked]
 * @param {(endpoint: string) => object|null} [options.proxyRectFor]
 *   A rect for a hidden far end, used only by a wire that is cut. The wire
 *   still points at the real card, so its diamond can reveal and fly there.
 * @param {number} [options.lanePitch]
 * @param {number} [options.cutSpan]
 * @returns {Array<object>} entries carrying `from`, `to`, `vertical`, `elbow`, `limit` and the source edge
 */
export function prepareConnectorGeometry(connectors = [], {
  rectFor,
  routing = null,
  isStacked = () => false,
  proxyRectFor = null,
  lanePitch = CONNECTOR_LANE_PITCH,
  cutSpan = CONNECTOR_CUT_SPAN,
} = {}) {
  if (typeof rectFor !== 'function') return [];
  // Normalise once: the scorer calls this many times per arrangement pass,
  // and every edge used to re-normalise the whole routing record.
  const normalizedRouting = normalizeRouting(routing);
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
    // Labels sit at wire midpoints, so neighbouring lanes can put their words
    // only half a pitch apart. The label placer checks measured text boxes and
    // tries other slots along each wire to keep a 14px gap; if none is free,
    // the word stays at the midpoint.
    const shift = (taken - (total - 1) / 2) * lanePitch;
    return shift ? { ...rect, y: rect.y + shift } : rect;
  };
  const prepared = [];
  for (const edge of connectors) {
    const key = connectorKey(edge);
    const override = normalizedRouting.edges[key] ?? {};
    const eff = {
      elbow: override.elbow ?? normalizedRouting.elbow,
      arrows: override.arrows ?? normalizedRouting.arrows,
      cut: override.cut ?? normalizedRouting.cut,
    };
    const stacked = edge.kind !== 'contains' && Boolean(isStacked(edge.from, edge.to));
    // A long wire may be cut off at a marker instead of crossing the whole
    // canvas; the outline spine and a stacked pair stay whole.
    const wantsCut = eff.cut && !stacked && edge.kind !== 'contains';
    const limit = wantsCut ? cutSpan : Infinity;
    let from = rectFor(edge.from);
    let to = rectFor(edge.to);
    // A card hidden inside a collapsed group still has a real place. Give a
    // cut wire that far end so it can end in a reachable diamond; a short
    // hidden wire stays hidden with its card.
    if (wantsCut && from && !to && typeof proxyRectFor === 'function') to = proxyRectFor(edge.to);
    if (!from || !to) continue;
    prepared.push({
      edge,
      key,
      eff,
      stacked,
      from: stacked ? from : laneRect(from, edge.from),
      to: stacked ? to : laneRect(to, edge.to),
      vertical: stacked,
      elbow: eff.elbow,
      limit,
    });
  }
  return prepared;
}

/**
 * Sampled points along `connectorCurve(from, to, …)`, for callers and tests
 * that want a point list rather than the `at` function. The arrangement scores
 * prepared geometry directly, with the same real rects and routing; `cardSize`
 * remains available for callers that deliberately want a substituted box.
 */
export function sampleConnectorCurve(from, to, { vertical = false, elbow = false, steps = 16, cardSize = null } = {}) {
  const a = cardSize ? { ...from, width: cardSize.width, height: cardSize.height } : from;
  const b = cardSize ? { ...to, width: cardSize.width, height: cardSize.height } : to;
  const { at } = connectorCurve(a, b, { vertical, elbow });
  return Array.from({ length: steps + 1 }, (_, i) => at(i / steps));
}

/**
 * How far a pan may go past the canvas's own edges, in screen pixels: wires
 * reach a little beyond the cards that bound the canvas rect, and past the
 * edge is the only way to see their ends at the extremes.
 */
export const PAN_OVERHANG = 120;

/**
 * Clamp a canvas view ({x, y} translate in px, s scale) so the canvas always
 * covers the viewport — except that it may overshoot each edge by
 * PAN_OVERHANG, so edges past the rect stay reachable. No runaway pan.
 */
export function clampView(view, canvasW, canvasH, vpW, vpH) {
  const s = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, view.s));
  const clamp = (t, scaled, vp) => {
    const lo = Math.min(0, vp - scaled) - PAN_OVERHANG;
    const hi = Math.max(0, vp - scaled) + PAN_OVERHANG;
    return Math.min(hi, Math.max(lo, t));
  };
  return {
    x: clamp(view.x, canvasW * s, vpW),
    y: clamp(view.y, canvasH * s, vpH),
    s,
  };
}

/**
 * Put a view at one exact scale around a viewport point (the pointer): the
 * canvas point under the pointer stays under the pointer. Internal because
 * callers normally have a factor in hand, not a scale.
 */
function viewAtScale(view, px, py, scale) {
  // The scale is clamped here rather than left to clampView: the anchor math
  // below must run against the scale that will actually be applied.
  const s = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale));
  return {
    x: px - (s * (px - view.x)) / view.s,
    y: py - (s * (py - view.y)) / view.s,
    s,
  };
}

/**
 * Zoom a view by a factor around a viewport point (the pointer): the canvas
 * point under the pointer stays under the pointer. Unclamped — the caller
 * runs the result through {@link clampView}.
 */
export function zoomViewAt(view, px, py, factor) {
  return viewAtScale(view, px, py, view.s * factor);
}

/** How near a crossing wheel step must land to be pulled onto 100%. */
const ZOOM_SNAP_RADIUS = 0.3;

/**
 * Zoom around a pointer, with 100% as a detent. A wheel step that crosses
 * 100% and lands close enough stops exactly there; the next step leaves
 * freely. A long fling that lands well past 100% passes through unchanged.
 */
export function snapZoomView(view, px, py, factor) {
  const next = zoomViewAt(view, px, py, factor);
  const crossed100 = (view.s < 1 && next.s >= 1) || (view.s > 1 && next.s <= 1);
  if (!crossed100 || Math.abs(next.s - 1) > ZOOM_SNAP_RADIUS) return next;
  return viewAtScale(view, px, py, 1);
}

/**
 * The view that fits a content rect ({minX, minY, maxX, maxY}, in canvas
 * coordinates) into a viewport, centred, with a margin around it on every
 * side. The scale is clamped to the canvas limits; the minimum is tiny enough
 * that a graph of any practical size lands with all of its edges on screen.
 *
 * @returns {object|null} the view, or null when there is nothing to fit
 */
export function fitView(content, vpW, vpH, margin = 40) {
  if (!content || !Number.isFinite(vpW) || !Number.isFinite(vpH) || vpW <= 0 || vpH <= 0) return null;
  const w = content.maxX - content.minX;
  const h = content.maxY - content.minY;
  if (!(w > 0) || !(h > 0)) return null;
  const s = Math.min(
    ZOOM_MAX,
    Math.max(ZOOM_MIN, Math.min((vpW - margin * 2) / w, (vpH - margin * 2) / h)),
  );
  return {
    x: (vpW - w * s) / 2 - content.minX * s,
    y: (vpH - h * s) / 2 - content.minY * s,
    s,
  };
}

/**
 * The view that puts a rect's centre at the viewport's centre, keeping the
 * current scale — centre-on-card, and the health panel's jump targets.
 */
export function centreView(rect, vpW, vpH, s = 1) {
  if (!rect || !Number.isFinite(vpW) || !Number.isFinite(vpH) || vpW <= 0 || vpH <= 0) return null;
  const scale = Number.isFinite(s) && s > 0 ? Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, s)) : 1;
  return {
    x: vpW / 2 - (rect.x + rect.width / 2) * scale,
    y: vpH / 2 - (rect.y + rect.height / 2) * scale,
    s: scale,
  };
}

/**
 * Smart guides for a drag: how far the dragged rect must move so one of
 * its edges or centrelines lines up with one of the others', within a
 * threshold (in canvas pixels). Returns the nudge per axis and the guide
 * positions to draw — each a canvas coordinate on its own axis.
 */
export function snapDelta(dragRect, others, threshold = 8) {
  const lines = (rect) => ({
    x: [rect.x, rect.x + rect.width / 2, rect.x + rect.width],
    y: [rect.y, rect.y + rect.height / 2, rect.y + rect.height],
  });
  const mine = lines(dragRect);
  let bestX = null;
  let bestY = null;
  for (const other of others ?? []) {
    const theirs = lines(other);
    for (let i = 0; i < 3; i += 1) {
      for (let j = 0; j < 3; j += 1) {
        const dx = theirs.x[j] - mine.x[i];
        if (Math.abs(dx) <= threshold && (!bestX || Math.abs(dx) < Math.abs(bestX.delta))) {
          bestX = { delta: dx, at: theirs.x[j] };
        }
        const dy = theirs.y[j] - mine.y[i];
        if (Math.abs(dy) <= threshold && (!bestY || Math.abs(dy) < Math.abs(bestY.delta))) {
          bestY = { delta: dy, at: theirs.y[j] };
        }
      }
    }
  }
  return {
    dx: bestX?.delta ?? 0,
    dy: bestY?.delta ?? 0,
    guides: [
      ...(bestX ? [{ axis: 'x', at: bestX.at }] : []),
      ...(bestY ? [{ axis: 'y', at: bestY.at }] : []),
    ],
  };
}

/**
 * Whether two card boxes overlap. Touching edges do not count: a card can
 * sit flush against another without hiding any of it.
 */
export function rectsOverlap(a, b) {
  if (!a || !b) return false;
  return a.x < b.x + b.width
    && a.x + a.width > b.x
    && a.y < b.y + b.height
    && a.y + a.height > b.y;
}

/**
 * Move each entry out of every blocker it overlaps, as little as possible.
 * Entries are movable; blockers are fixed. A blocker carrying the same `key`
 * as the entry is ignored, so a caller can pass the complete card set and let
 * each entry keep its own old box out of the way. New placements leave a gap
 * around every blocker and never go above `minX`/`minY`. The nearest direct
 * edge is tried first; a bounded ring search handles tighter clusters.
 *
 * Returns `{ positions, moved, unresolved }`: final positions for every entry,
 * the keys that actually moved, and the keys that could not be placed.
 */
export function resolveOverlaps(entries, blockers = [], {
  gap = 12, minX = 4, minY = 4, step = 32, maxRings = 64,
} = {}) {
  const boxes = (list) => (list ?? []).filter((box) => (
    box
    && Number.isFinite(box.x)
    && Number.isFinite(box.y)
    && Number.isFinite(box.width)
    && Number.isFinite(box.height)
    && box.width > 0
    && box.height > 0
  ));
  const cleanEntries = boxes(entries);
  let occupied = boxes(blockers).map((box) => ({ ...box }));
  const positions = new Map();
  const moved = new Set();
  const unresolved = new Set();
  const margin = Number.isFinite(gap) && gap >= 0 ? gap : 12;
  const left = Number.isFinite(minX) ? minX : 4;
  const top = Number.isFinite(minY) ? minY : 4;
  const stride = Number.isFinite(step) && step > 0 ? step : 32;
  const rings = Number.isInteger(maxRings) && maxRings >= 0 ? maxRings : 64;

  const sameKey = (a, key) => key !== undefined && a.key === key;
  const clear = (rect, blocker) => (
    rect.x + rect.width + margin <= blocker.x
    || blocker.x + blocker.width + margin <= rect.x
    || rect.y + rect.height + margin <= blocker.y
    || blocker.y + blocker.height + margin <= rect.y
  );
  const fits = (rect, key) => occupied.every((blocker) => sameKey(blocker, key) || clear(rect, blocker));
  const overlapsAny = (rect, key) => occupied.some(
    (blocker) => !sameKey(blocker, key) && rectsOverlap(rect, blocker),
  );
  const clamp = (point) => ({
    x: Math.max(left, point.x),
    y: Math.max(top, point.y),
  });

  const nearest = (entry) => {
    if (!overlapsAny(entry, entry.key)) return { x: entry.x, y: entry.y };
    const direct = [];
    const seen = new Set();
    const add = (x, y) => {
      const point = clamp({ x, y });
      const signature = `${point.x},${point.y}`;
      if (seen.has(signature)) return;
      seen.add(signature);
      direct.push(point);
    };
    // Only cards already touching the entry can produce a useful edge
    // candidate; `fits` still checks every blocker before accepting one.
    const near = occupied.filter((blocker) => !sameKey(blocker, entry.key) && !clear(entry, blocker));
    for (const blocker of near) {
      add(blocker.x + blocker.width + margin, entry.y);
      add(blocker.x - entry.width - margin, entry.y);
      add(entry.x, blocker.y + blocker.height + margin);
      add(entry.x, blocker.y - entry.height - margin);
      add(blocker.x + blocker.width + margin, blocker.y);
      add(blocker.x - entry.width - margin, blocker.y);
      add(blocker.x, blocker.y + blocker.height + margin);
      add(blocker.x, blocker.y - entry.height - margin);
    }
    const origin = clamp({ x: entry.x, y: entry.y });
    direct.sort((a, b) => ((a.x - origin.x) ** 2 + (a.y - origin.y) ** 2)
      - ((b.x - origin.x) ** 2 + (b.y - origin.y) ** 2));
    for (const point of direct) {
      const rect = { ...point, width: entry.width, height: entry.height };
      if (fits(rect, entry.key)) return point;
    }
    // Dense clusters can have every edge blocked. Walk outward in square
    // rings; the first free point is the nearest on that ring.
    for (let ring = 1; ring <= rings; ring += 1) {
      const radius = ring * stride;
      for (let offset = -radius; offset <= radius; offset += stride) {
        const candidates = [
          { x: origin.x + offset, y: origin.y - radius },
          { x: origin.x + offset, y: origin.y + radius },
          { x: origin.x - radius, y: origin.y + offset },
          { x: origin.x + radius, y: origin.y + offset },
        ];
        for (const raw of candidates) {
          const point = clamp(raw);
          const rect = { ...point, width: entry.width, height: entry.height };
          if (fits(rect, entry.key)) return point;
        }
      }
    }
    return null;
  };

  for (const entry of cleanEntries) {
    const at = nearest(entry);
    if (!at) {
      positions.set(entry.key, { x: entry.x, y: entry.y });
      unresolved.add(entry.key);
    } else {
      positions.set(entry.key, at);
      if (Math.abs(at.x - entry.x) > 0.01 || Math.abs(at.y - entry.y) > 0.01) moved.add(entry.key);
    }
    occupied = occupied.filter((blocker) => !sameKey(blocker, entry.key));
    occupied.push({ ...(at ?? { x: entry.x, y: entry.y }), width: entry.width, height: entry.height, key: entry.key });
  }
  return { positions, moved, unresolved };
}

/**
 * Where the cards around a card being resized from its bottom-right corner
 * belong.
 *
 * `start` is the resized box when the drag began and `next` is that box now;
 * they share a top-left corner, because only the corner handle moves. Cards
 * beside a moving right or bottom edge stick to it: one is pushed only once
 * the edge reaches it, and the same cards come back in when the box shrinks
 * past its original size. Dragging the corner back to where it started
 * therefore puts every card back where it was. A card the expanded box
 * reaches under the corner rather than beside an edge is cleared along the
 * axis that costs it the least movement.
 *
 * `cards` are the other cards at the boxes they had when the drag began, each
 * with a `key`; `movable: false` pins one in place as an obstacle. A push
 * travels through cards it meets instead of stopping at the first one, while
 * a card that cannot come back in without landing on another stays put. The
 * result is a Map of every card's `key` to the `{x, y}` it should now occupy.
 */
export function resizePush({ start, next, cards = [], gap = 0, minX = 4, minY = 4 } = {}) {
  const result = new Map();
  if (!start || !next) return result;
  const geometry = [start.x, start.y, start.width, start.height, next.x, next.y, next.width, next.height];
  if (!geometry.every((value) => Number.isFinite(value))) return result;

  const margin = Number.isFinite(gap) && gap >= 0 ? gap : 0;
  const floorX = Number.isFinite(minX) ? minX : 4;
  const floorY = Number.isFinite(minY) ? minY : 4;
  const startRight = start.x + start.width;
  const startBottom = start.y + start.height;
  const right = next.x + next.width;
  const bottom = next.y + next.height;
  const box = { x: next.x, y: next.y, width: next.width, height: next.height };

  const live = (cards ?? []).filter((card) => card
    && Number.isFinite(card.x) && Number.isFinite(card.y)
    && Number.isFinite(card.width) && Number.isFinite(card.height)
    && card.width > 0 && card.height > 0);

  /** The moving edge a card sits beside, if any: that edge carries it along. */
  const sideOf = (card) => {
    const rightSide = card.y < startBottom && card.y + card.height > start.y;
    if (rightSide && card.x >= startRight - 0.5) return 'right';
    const bottomSide = card.x < startRight && card.x + card.width > start.x;
    return bottomSide && card.y >= startBottom - 0.5 ? 'bottom' : null;
  };

  // Sticking depends only on the edge and the card's first box, so the same
  // corner always produces the same places: the move is reversible.
  const stickTo = (card, side) => {
    if (side === 'right') {
      return { x: Math.max(card.x, right) + Math.min(0, right - startRight), y: card.y };
    }
    if (side === 'bottom') {
      return { x: card.x, y: Math.max(card.y, bottom) + Math.min(0, bottom - startBottom) };
    }
    return { x: card.x, y: card.y };
  };

  const current = new Map(live.map((card) => [
    card.key,
    { x: card.x, y: card.y, width: card.width, height: card.height },
  ]));
  const others = (key) => [...current.entries()]
    .filter(([other]) => other !== key)
    .map(([, rect]) => rect);
  const collisions = (rect, key) => [box, ...others(key)].filter((blocker) => rectsOverlap(rect, blocker));

  // A moving card clears the resized box, the cards that cannot move and the
  // cards already carried along. A card still awaiting its turn is left to
  // take the push itself, so a row of cards shifts across instead of the first
  // one hopping over the rest.
  const shifted = new Set();
  const pinned = live
    .filter((card) => card.movable === false)
    .map((card) => ({ x: card.x, y: card.y, width: card.width, height: card.height }));
  const shiftedRects = (key) => [...shifted]
    .filter((other) => other !== key)
    .map((other) => current.get(other))
    .filter(Boolean);

  // Right-side cards are handled before bottom-side ones, and each group from
  // the edge outwards, so a push meets the next card after it has a new place.
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const ordered = live
    .filter((card) => card.movable !== false)
    .map((card) => ({ card, side: sideOf(card) }))
    .sort((a, b) => {
      const rank = (entry) => (entry.side === 'right' ? 0 : entry.side === 'bottom' ? 1 : 2);
      const byRank = rank(a) - rank(b);
      if (byRank) return byRank;
      if (a.side === 'right') return a.card.x - b.card.x;
      if (a.side === 'bottom') return a.card.y - b.card.y;
      const distance = (entry) => Math.hypot(entry.card.x - centre.x, entry.card.y - centre.y);
      return distance(a) - distance(b);
    });

  for (const { card, side } of ordered) {
    const base = current.get(card.key);
    const target = stickTo(card, side);
    let x = Math.round(Math.max(floorX, target.x));
    let y = Math.round(Math.max(floorY, target.y));
    let axis = side === 'right' ? 'x' : side === 'bottom' ? 'y' : null;
    let direction = 1;
    let pushed = x !== base.x || y !== base.y || rectsOverlap(base, box);

    if (!pushed) {
      // A card the edges never reached can still stand where one of them was
      // pushed, and then it moves on in turn.
      const here = { x: base.x, y: base.y, width: card.width, height: card.height };
      const hit = [...shifted]
        .map((key) => current.get(key))
        .find((other) => other && rectsOverlap(here, other));
      if (hit) {
        pushed = true;
        x = base.x;
        y = base.y;
        const acrossX = Math.min(here.x + here.width, hit.x + hit.width) - Math.max(here.x, hit.x);
        const acrossY = Math.min(here.y + here.height, hit.y + hit.height) - Math.max(here.y, hit.y);
        axis = axis ?? (acrossX <= acrossY ? 'x' : 'y');
        // Move away from whatever arrived: a card hit from its left goes right.
        direction = axis === 'x' ? (hit.x >= here.x ? -1 : 1) : (hit.y >= here.y ? -1 : 1);
      }
    }
    if (!pushed) {
      result.set(card.key, { x: base.x, y: base.y });
      continue;
    }

    if (x < base.x || y < base.y) {
      // Closing the gap must not open a collision: a card that cannot follow
      // the shrinking edge where it now is stays where it was.
      if (collisions({ x, y, width: card.width, height: card.height }, card.key).length) {
        x = base.x;
        y = base.y;
      }
    } else {
      if (!axis) axis = right + margin - base.x <= bottom + margin - base.y ? 'x' : 'y';
      const blockers = [box, ...pinned, ...shiftedRects(card.key)];
      for (let guard = 0; guard < 64; guard += 1) {
        const rect = { x, y, width: card.width, height: card.height };
        const hits = blockers.filter((blocker) => rectsOverlap(rect, blocker));
        if (!hits.length) break;
        if (axis === 'x') {
          x = Math.round(direction > 0
            ? Math.max(...hits.map((hit) => hit.x + hit.width + margin))
            : Math.min(...hits.map((hit) => hit.x - card.width - margin)));
        } else {
          y = Math.round(direction > 0
            ? Math.max(...hits.map((hit) => hit.y + hit.height + margin))
            : Math.min(...hits.map((hit) => hit.y - card.height - margin)));
        }
        if (x < floorX || y < floorY) break;
      }
      x = Math.max(floorX, x);
      y = Math.max(floorY, y);
    }

    current.set(card.key, { x, y, width: card.width, height: card.height });
    result.set(card.key, { x, y });
    if (x !== base.x || y !== base.y) shifted.add(card.key);
  }
  return result;
}

/**
 * Lay a selected set out from its current rects. Alignment moves one axis
 * onto the set's bounding edge or centreline; distribution keeps the first
 * and last card fixed and spaces the others evenly between their
 * centrelines. The untouched axis is preserved. Entries need a `key` plus
 * finite `x`, `y`, `width`, and `height`; the result is a Map of the same
 * keys to their new `{x, y}` positions.
 */
/** Practical search limit: well beyond any normal arrangement, but bounded. */
export const MAX_ARRANGE_CANDIDATES = 4096;

/**
 * The arrangement candidate origins for one layout. The sequence would
 * continue indefinitely for finite blockers, but callers should consume it
 * through `findArrangeOrigin`, whose cap keeps the search practical. A
 * shape that exhausts the search stays where it already stands rather
 * than dropping onto the arrangement origin.
 */
export function* arrangeCandidateOrigins(layout, origin, { columns = 1, stepX = 0, stepY = 0, layer = 0, column = 0 } = {}) {
  if (!origin || !Number.isFinite(origin.x) || !Number.isFinite(origin.y)) return;
  if (!Number.isFinite(stepX) || !Number.isFinite(stepY)) return;
  if (layout === 'grid') {
    if (!Number.isInteger(columns) || columns < 1 || stepX <= 0 || stepY <= 0) return;
    for (let row = 0; ; row += 1) {
      for (let col = 0; col < columns; col += 1) {
        yield { x: origin.x + col * stepX, y: origin.y + row * stepY };
      }
    }
  } else if (layout === 'progression') {
    // One column, top to bottom: the column's x is fixed, the search walks
    // down it until the shape fits.
    if (stepX <= 0 || stepY <= 0 || !Number.isInteger(column) || column < 0) return;
    for (let k = 0; ; k += 1) {
      yield { x: origin.x + column * stepX, y: origin.y + k * stepY };
    }
  } else if (layout === 'rows' || layout === 'layered') {
    if (stepX <= 0 || !Number.isFinite(layer)) return;
    for (let k = 0; ; k += 1) {
      yield { x: origin.x + k * stepX, y: origin.y + (layout === 'layered' ? layer * stepY : 0) };
    }
  } else if (layout === 'columns') {
    if (stepY <= 0) return;
    for (let k = 0; ; k += 1) {
      yield { x: origin.x, y: origin.y + k * stepY };
    }
  } else if (layout === 'cascade') {
    for (let k = 0; ; k += 1) {
      yield { x: origin.x + k * 72, y: origin.y + k * 56 };
    }
  }
}

/**
 * The first candidate that fits, bounded to `MAX_ARRANGE_CANDIDATES`
 * checks so an extreme blocker cannot keep arrangement busy indefinitely.
 */
export function findArrangeOrigin(candidates, fits, maxCandidates = MAX_ARRANGE_CANDIDATES) {
  if (typeof fits !== 'function' || !Number.isInteger(maxCandidates) || maxCandidates < 0) return null;
  let searched = 0;
  for (const candidate of candidates ?? []) {
    if (searched >= maxCandidates) return null;
    searched += 1;
    if (fits(candidate)) return candidate;
  }
  return null;
}

export function layoutSelection(entries, mode) {
  const list = (entries ?? []).filter((entry) => (
    entry
    && entry.key !== undefined
    && Number.isFinite(entry.x)
    && Number.isFinite(entry.y)
    && Number.isFinite(entry.width)
    && Number.isFinite(entry.height)
  ));
  const next = new Map(list.map((entry) => [entry.key, { x: entry.x, y: entry.y }]));
  if (list.length < 2) return next;

  const minX = Math.min(...list.map((entry) => entry.x));
  const minY = Math.min(...list.map((entry) => entry.y));
  const maxX = Math.max(...list.map((entry) => entry.x + entry.width));
  const maxY = Math.max(...list.map((entry) => entry.y + entry.height));

  if (mode === 'left') {
    for (const entry of list) next.set(entry.key, { x: minX, y: entry.y });
  } else if (mode === 'center-x') {
    const centre = (minX + maxX) / 2;
    for (const entry of list) next.set(entry.key, { x: centre - entry.width / 2, y: entry.y });
  } else if (mode === 'right') {
    for (const entry of list) next.set(entry.key, { x: maxX - entry.width, y: entry.y });
  } else if (mode === 'top') {
    for (const entry of list) next.set(entry.key, { x: entry.x, y: minY });
  } else if (mode === 'center-y') {
    const centre = (minY + maxY) / 2;
    for (const entry of list) next.set(entry.key, { x: entry.x, y: centre - entry.height / 2 });
  } else if (mode === 'bottom') {
    for (const entry of list) next.set(entry.key, { x: entry.x, y: maxY - entry.height });
  } else if (mode === 'distribute-x' || mode === 'distribute-y') {
    const axis = mode === 'distribute-x' ? 'x' : 'y';
    const size = mode === 'distribute-x' ? 'width' : 'height';
    const ordered = [...list].sort((a, b) => (a[axis] + a[size] / 2) - (b[axis] + b[size] / 2));
    const first = ordered[0][axis] + ordered[0][size] / 2;
    const last = ordered[ordered.length - 1][axis] + ordered[ordered.length - 1][size] / 2;
    const step = (last - first) / (ordered.length - 1);
    ordered.forEach((entry, position) => {
      const centre = first + step * position;
      const at = { x: entry.x, y: entry.y };
      at[axis] = centre - entry[size] / 2;
      next.set(entry.key, at);
    });
  }
  return next;
}

/**
 * The form a view is saved in: the canvas point sitting at the viewport's
 * top-left corner (zoom-independent), with the zoom it was left at.
 */
export function anchorOfView(view) {
  return { x: -view.x / view.s, y: -view.y / view.s, s: view.s };
}

/**
 * The view a saved anchor restores, or null when the record is unusable.
 * The translate is the anchor scaled back up to screen px at its zoom.
 */
export function viewOfAnchor(saved) {
  if (!saved || !Number.isFinite(saved.x) || !Number.isFinite(saved.y)) return null;
  const s = Number.isFinite(saved.s) ? Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, saved.s)) : 1;
  return { x: -saved.x * s, y: -saved.y * s, s };
}

/** Word count of a block of prose, for the card footers and the toolbar. */
export function countWords(text) {
  const trimmed = String(text ?? '').trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

/**
 * How healthy the canvas is: what is connected, what is not, and which
 * groups are too thin to mean anything. An orphan is a card with no
 * connection at all — no prose link, no bond, no outline parent or child,
 * and no group to sit in — so it is invisible to every wire on the canvas.
 */
export function canvasHealth(model = {}, { relations = {}, groups = {} } = {}) {
  const notes = model.notes ?? [];
  const connected = new Set();
  const bump = (index) => {
    const anchor = notes[index]?.anchor;
    if (anchor) connected.add(anchor);
  };
  const edges = [
    ...noteEdges(model, relations),
    ...hierarchyEdges(model),
    ...bondEdges(model, relations),
    ...groupRelationEdges(model, groups, relations),
  ];
  for (const edge of edges) {
    bump(edge.fromIndex ?? edge.from);
    bump(edge.toIndex ?? edge.to);
  }
  const grouped = new Set(Object.values(groups ?? {}).flatMap((group) => group.members ?? []));
  const orphans = notes
    .filter((note) => !connected.has(note.anchor) && !grouped.has(note.anchor))
    .map((note) => ({ anchor: note.anchor, title: note.title || note.anchor }));
  const effectiveSize = (id, seen) => {
    const group = groups[id];
    if (!group || seen.has(id)) return 0;
    seen.add(id);
    let size = (group.members ?? []).length;
    for (const child of group.children ?? []) size += effectiveSize(child, seen);
    return size;
  };
  const thinGroups = Object.entries(groups ?? {})
    .filter(([id]) => effectiveSize(id, new Set()) < 2)
    .map(([id, group]) => ({ id, name: group.name || 'Group' }));
  return {
    notes: notes.length,
    edges: edges.length,
    groups: Object.keys(groups ?? {}).length,
    orphans,
    thinGroups,
  };
}

/** Everything the canvas header reports, computed once per change. */
export function noteStats(model = {}, types = {}) {
  const notes = model.notes ?? [];
  const tags = new Set();
  const typeCounts = {};
  let links = 0;
  let words = countWords(model.intro);
  for (const note of notes) {
    links += (note.links ?? []).length;
    words += countWords(note.title) + countWords(note.body);
    for (const tag of note.tags ?? []) tags.add(tag);
    const type = nodeTypeOf(types, note.anchor).id;
    if (type !== DEFAULT_NODE_TYPE) typeCounts[type] = (typeCounts[type] ?? 0) + 1;
  }
  return {
    notes: notes.length,
    associations: noteEdges(model).length,
    links,
    tags: tags.size,
    types: typeCounts,
    words,
  };
}
