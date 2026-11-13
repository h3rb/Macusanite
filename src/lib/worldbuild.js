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
  { id: 'member-of', label: 'Member Of', rank: 1 },
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
  { id: 'rating', label: 'Rating', color: '#9575cd', icon: '★' },
  // Places of the world: where things happen and what stands there.
  { id: 'place', label: 'Place', color: '#45c4b0', icon: '⌂' },
  { id: 'person', label: 'Person', color: '#f97066', icon: '♟' },
  { id: 'thing', label: 'Thing', color: '#ffa657', icon: '◉' },
  { id: 'location', label: 'Location', color: '#f778ba', icon: '⌖' },
  { id: 'scene', label: 'Scene', color: '#e3b341', icon: '▶' },
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
 * A unit the user types by hand joins this list for the rest of the vault:
 * `unitSuggestions` reads the units already stored in the fields records,
 * so a hand-entered unit is offered on every later attribute.
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

/**
 * The autocomplete list for a unit input: the predetermined units first,
 * then every unit already stored in the given fields records (one record,
 * or an array of them, e.g. every vein's record), in first-seen order.
 * De-duplicated case-insensitively, so "Tokens" and "tokens" are one entry.
 */
export function unitSuggestions(fields = {}) {
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
  for (const record of records) {
    for (const stored of Object.values(record ?? {})) {
      if (stored && typeof stored === 'object') offer(stored.unit);
    }
  }
  return out;
}

// An attribute is a key/value pair with a unit: "temper — 1200 °C".
const ATTRIBUTE = [...KEY_VALUE, { id: 'unit', label: 'Unit', kind: 'unit' }];

export const NODE_FIELDS = {
  note: [],
  stat: [{ id: 'value', label: 'Value', kind: 'text' }],
  skill: LEVEL,
  ability: MIN_MAX,
  attribute: ATTRIBUTE,
  property: KEY_VALUE,
  rating: RATING,
  // Place-like types are prose cards like notes: their content is markdown.
  place: [],
  person: [],
  thing: [],
  location: [],
  scene: [],
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
  const stored = spec.kind === 'unit'
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
    out[id] = { id, x: Math.round(value.x), y: Math.round(value.y), text };
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

export function cleanCollapsedGroups(collapsed = {}) {
  const out = {};
  for (const [id, value] of Object.entries(collapsed ?? {})) {
    if (id && value === true) out[id] = true;
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
    pinned: state.pinned ?? {},
    locked: state.locked ?? {},
    cardModes: cleanCardModes(state.cardModes),
    collapsedGroups: cleanCollapsedGroups(state.collapsedGroups),
    annotations: cleanAnnotations(state.annotations),
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
  const { groups } = pruneGroups(snap.groups ?? {}, (anchor) => live.has(anchor));
  const relations = {};
  for (const [key, kind] of Object.entries(snap.relations ?? {})) {
    const [from, to] = key.split('->');
    const known = (end) => live.has(end) || (end.startsWith('group:') && surviving.has(end.slice(6)));
    if (from && to && known(from) && known(to)) relations[key] = kind;
  }
  const anchors = (obj) => Object.fromEntries(
    Object.entries(obj ?? {}).filter(([anchor]) => live.has(anchor)),
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
    ...(snap.pinned ? { pinned: anchors(snap.pinned) } : {}),
    ...(snap.locked ? { locked: anchors(snap.locked) } : {}),
    ...(snap.cardModes ? { cardModes: anchors(snap.cardModes) } : {}),
    ...(snap.annotations ? { annotations: cleanAnnotations(snap.annotations) } : {}),
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
    pinned: pruned.pinned ?? current.pinned ?? {},
    locked: pruned.locked ?? current.locked ?? {},
    cardModes: cleanCardModes(pruned.cardModes ?? current.cardModes),
    collapsedGroups: cleanCollapsedGroups(pruned.collapsedGroups ?? current.collapsedGroups),
    annotations: pruned.annotations ?? cleanAnnotations(current.annotations),
    view: cleanView(pruned.view, current.view ?? null),
  };
}

/**
 * The patch an undo step writes into the vein record, as one piece so a
 * step is never half applied: positions, groups, relationships and folds
 * always; types, fields and colours only when the step carries them; the
 * camera only when the step has a usable view.
 */
export function canvasRecordPatch({ positions = {}, groups = {}, relations = {}, folded = {}, types = null, fields = null, colors = null, images = null, pinned = null, locked = null, cardModes = null, collapsedGroups = null, annotations = null, view = null } = {}) {
  const patch = { positions, groups, relations, folded };
  if (types) patch.types = types;
  if (fields) patch.fields = fields;
  if (colors) patch.colors = colors;
  if (images) patch.images = images;
  if (pinned) patch.pinned = pinned;
  if (locked) patch.locked = locked;
  if (cardModes) patch.cardModes = cleanCardModes(cardModes);
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
 * a rename moves entries onto the new name. Each step keeps its name.
 */
export function rewriteHistoryStack(stack, edit) {
  const map = (entry) => ({ name: entry.name, snap: JSON.stringify(edit(JSON.parse(entry.snap))) });
  stack.past = stack.past.map(map);
  stack.future = stack.future.map(map);
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
    relations,
    groups,
    ...(snap.types ? { types: move(snap.types) } : {}),
    ...(snap.fields ? { fields: move(snap.fields) } : {}),
    ...(snap.colors ? { colors: move(snap.colors) } : {}),
    ...(snap.images ? { images: move(snap.images) } : {}),
    ...(snap.pinned ? { pinned: move(snap.pinned) } : {}),
    ...(snap.locked ? { locked: move(snap.locked) } : {}),
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
    for (const field of nodeFields(type.id)) {
      const value = stored[field.id];
      if (value !== undefined && value !== null && String(value).trim() !== '') {
        fieldTexts.push(`${field.label} ${value}`);
      }
    }
    for (const value of Object.values(stored)) {
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

/** Zoom limits for the worldbuilding canvas (1 is 100%). */
export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 3;

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
 * This is the one place the bend math lives: the panel draws `path` and the
 * occlusion scorer samples `at` (via `sampleConnectorCurve`), so the curve
 * scored is always the curve drawn.
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
 * Sampled points along `connectorCurve(from, to, …)` — the sampler the
 * arrangement's occlusion scorer uses, so it scores the curve the reader
 * sees. With `cardSize`, plain card boxes are substituted (the grid the
 * arrangement packs on), exactly as the scorer wants them.
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
 * Zoom a view by a factor around a viewport point (the pointer): the canvas
 * point under the pointer stays under the pointer. Unclamped — the caller
 * runs the result through {@link clampView}.
 */
export function zoomViewAt(view, px, py, factor) {
  // The scale is clamped here rather than left to clampView: the anchor math
  // below must run against the scale that will actually be applied.
  const s = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, view.s * factor));
  return {
    x: px - (s * (px - view.x)) / view.s,
    y: py - (s * (py - view.y)) / view.s,
    s,
  };
}

/**
 * The view that fits a content rect ({minX, minY, maxX, maxY}, in canvas
 * coordinates) into a viewport, centred, with a margin around it on every
 * side. The scale is clamped to the canvas limits, so a graph far wider
 * than the viewport lands at minimum zoom, centred, instead of losing
 * its edges off-screen.
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
