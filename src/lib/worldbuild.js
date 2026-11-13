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
  // Polarity bonds: an ally stands with you, a foe against you — both are
  // definitive, and a foe is the strongest bond of all.
  { id: 'ally', label: 'Ally', rank: 5 },
  { id: 'foe', label: 'Foe', rank: 6 },
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

export const NODE_FIELDS = {
  note: [],
  stat: [{ id: 'value', label: 'Value', kind: 'text' }],
  skill: LEVEL,
  ability: MIN_MAX,
  attribute: KEY_VALUE,
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
  const stored = spec.kind === 'number' && String(value).trim() !== ''
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
 * @returns {object} a new model — the same model when nothing is new
 */
export function addNoteTags(model, index, tags = []) {
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
 * @returns {object} a new model — the same model when the note has no such tag
 */
export function removeNoteTag(model, index, tag) {
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
 * Clamp a canvas view ({x, y} translate in px, s scale) so the canvas
 * always covers the viewport: no void on any side, no runaway pan.
 */
export function clampView(view, canvasW, canvasH, vpW, vpH) {
  const s = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, view.s));
  const clamp = (t, scaled, vp) => {
    const lo = Math.min(0, vp - scaled);
    const hi = Math.max(0, vp - scaled);
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
