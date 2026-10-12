/**
 * Vault-wide search.
 *
 * Everything here is pure: the query is tokenised, each document is scored
 * field by field, and the winner is turned into a snippet with the matched
 * characters already located. The UI ([src/ui/searchPanel.js]) only has to put
 * those ranges on screen — and so does the document pass in
 * [src/ui/viewer.js], which highlights the same terms in the rendered page.
 *
 * Ranking, in one sentence: a title hit beats a heading hit, a heading hit beats
 * a tag, all of those beat body text, an exact title is nearly always right, and
 * a phrase that appears whole beats the same words scattered.
 */
import { titleFromPath } from './path.js';

/** What each field is worth before match quality and repetition are applied. */
const FIELD = { title: 120, heading: 70, tag: 50, body: 12 };
/** A match near the top of a vein is about what the vein is about. */
const EARLY_BONUS = 24;
const EARLY_WINDOW = 480;
const MAX_BODY_HITS = 8;
const MAX_HEADING_HITS = 4;
/** `HEADING_LEVEL_BONUS[level]` — an h2 match matters more than an h5. */
const HEADING_LEVEL_BONUS = [0, 60, 40, 25, 15, 10, 5];
const PHRASE_BONUS = { title: 200, heading: 120, body: 60 };

const WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * Split a query into terms. `"a quoted run"` stays one term; anything else is a
 * word. Every term has to appear somewhere in a document for it to be a result.
 * @returns {Array<{text: string, lower: string, phrase: boolean}>}
 */
export function tokenize(query = '') {
  const terms = [];
  const re = /"([^"]*)"|(\S+)/g;
  let match;
  while ((match = re.exec(String(query ?? ''))) !== null) {
    const text = (match[1] ?? match[2] ?? '').trim();
    if (!text) continue;
    terms.push({ text, lower: text.toLowerCase(), phrase: Boolean(match[1]) });
  }
  return terms;
}

/** Non-overlapping occurrences of `needle` in `haystack` (both already lowered). */
function occurrences(haystack, needle) {
  const found = [];
  let from = 0;
  while (needle && from <= haystack.length - needle.length) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) break;
    found.push(at);
    from = at + needle.length;
  }
  return found;
}

/** True when the match at `index` is not glued to other letters or digits. */
function wholeWord(haystack, index, length) {
  const before = index > 0 ? haystack[index - 1] : '';
  const after = index + length < haystack.length ? haystack[index + length] : '';
  return !WORD_CHAR.test(before) && !WORD_CHAR.test(after);
}

/**
 * Where and how well one term matches one piece of text.
 * @returns {{count: number, first: number, quality: number}|null} null when absent
 */
export function matchText(text, term) {
  const haystack = String(text ?? '').toLowerCase();
  const needle = typeof term === 'string' ? term.toLowerCase() : term?.lower ?? '';
  if (!haystack || !needle) return null;
  const positions = occurrences(haystack, needle);
  if (!positions.length) return null;

  const first = positions[0];
  let quality = 1;
  if (haystack.trim() === needle) quality = 1.7;
  else if (first === 0 || !WORD_CHAR.test(haystack[0])) {
    // counts as a prefix of the field
    quality = wholeWord(haystack, first, needle.length) ? 1.35 : 1.15;
  } else if (wholeWord(haystack, first, needle.length)) {
    quality = 1.15;
  }
  return { count: positions.length, first, quality };
}

/**
 * Mark the matched ranges of `text` (used for snippets and for the document).
 *
 * Ranges are sorted, so a phrase that contains a single word — searching
 * `sieve series` — does not produce overlapping marks.
 * @returns {Array<[number, number]>} `[start, end)` pairs
 */
export function findMatches(text, terms = []) {
  const haystack = String(text ?? '').toLowerCase();
  if (!haystack) return [];
  const ranges = [];
  for (const term of terms) {
    const needle = typeof term === 'string' ? term.toLowerCase() : term?.lower ?? '';
    for (const at of occurrences(haystack, needle)) ranges.push([at, at + needle.length]);
  }
  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] < last[1]) continue;
    merged.push(range);
  }
  return merged;
}

/**
 * Markdown reduced to something worth showing in a result row, and worth
 * searching: no front matter, no code fences, `[[Target|alias]]` becomes the
 * alias, links keep their text, and whitespace is collapsed.
 */
export function plainText(markdown = '') {
  return String(markdown ?? '')
    .replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[\[([^\]|]*)\|([^\]]+)\]\]/g, '$2')
    .replace(/!?\[\[([^\]]*)\]\]/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}[ \t]*/gm, '')
    .replace(/^\s{0,3}>[ \t]?/gm, '')
    .replace(/^\s*([-*+]|\d+\.)[ \t]+/gm, '')
    .replace(/[*_~]{1,3}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Turn the vault into the shape search wants: one entry per vein, with the
 * bookkeeping ([buildDocumentIndex]) already extracted.
 *
 * The index — not the bodies — decides which veins exist, because a lazily
 * opened vault describes every vein (title, headings, tags) while holding the
 * text of only the ones it has had reason to read. A vein whose source is not
 * in hand still competes on its headings and tags, and gains its body matches
 * the moment the text arrives.
 *
 * @param {object} input
 * @param {Array} input.index    result of buildDocumentIndex
 * @param {Record<string, string>} input.bodies vault path -> markdown source
 */
export function buildSearchCorpus({ index = [], bodies = {} } = {}) {
  const paths = index.length
    ? index.map((doc) => doc.path)
    : Object.keys(bodies);
  const byPath = new Map(index.map((doc) => [doc.path, doc]));
  return paths
    .slice()
    .sort()
    .map((path) => {
      const doc = byPath.get(path);
      const text = bodies[path] ?? '';
      return {
        path,
        title: doc?.title ?? titleFromPath(path),
        headings: doc?.headings ?? [],
        tags: doc?.tags ?? [],
        text,
        clean: plainText(text),
      };
    });
}

/**
 * Score one document against the terms already tokenised.
 * @returns {object|null} null when any term is missing, so it is not a result
 */
export function scoreDocument(doc, terms, query = '') {
  if (!terms.length) return null;
  const title = String(doc.title ?? '');
  const clean = doc.clean ?? plainText(doc.text ?? '');
  const headings = doc.headings ?? [];
  const tags = Array.isArray(doc.tags) ? doc.tags : [];

  let score = 0;
  const fields = { title: 0, heading: 0, tag: 0, body: 0 };
  const headingMatches = [];
  let bodyHits = 0;
  let firstBodyIndex = -1;

  for (const term of terms) {
    let found = false;

    const inTitle = matchText(title, term);
    if (inTitle) {
      score += FIELD.title * inTitle.quality;
      fields.title += 1;
      found = true;
    }

    const inHeadings = [];
    for (const heading of headings) {
      const hit = matchText(heading.text, term);
      if (!hit) continue;
      inHeadings.push({
        anchor: heading.anchor,
        text: heading.text,
        level: heading.level,
        rank: FIELD.heading * hit.quality + (HEADING_LEVEL_BONUS[heading.level] ?? 5) + heading.text.length * 0.05,
      });
    }
    if (inHeadings.length) {
      inHeadings.sort((a, b) => b.rank - a.rank);
      score += inHeadings[0].rank;
      fields.heading += 1;
      found = true;
      headingMatches.push(...inHeadings.slice(0, MAX_HEADING_HITS));
    }

    // A tag is written `#fieldwork` on the page, so accept it either way.
    const inTags = tags.filter((tag) => matchText(tag, term) || matchText(`#${tag}`, term));
    if (inTags.length) {
      score += FIELD.tag * (1 + 0.25 * (inTags.length - 1));
      fields.tag += 1;
      found = true;
    }

    const inBody = matchText(clean, term);
    if (inBody) {
      score += FIELD.body * inBody.quality * Math.min(inBody.count, MAX_BODY_HITS);
      score += Math.max(0, EARLY_BONUS - inBody.first / (EARLY_WINDOW / EARLY_BONUS));
      bodyHits += inBody.count;
      fields.body += 1;
      if (firstBodyIndex === -1 || inBody.first < firstBodyIndex) firstBodyIndex = inBody.first;
      found = true;
    }

    // Every term has to land somewhere, otherwise this vein is not a match.
    if (!found) return null;
  }

  // A whole phrase is worth more than the same words apart: `sieve series`
  // should beat a vein that mentions sieves and series in different sections.
  if (terms.length > 1) {
    const phrase = terms.map((term) => term.text).join(' ').toLowerCase();
    const inTitle = occurrences(title.toLowerCase(), phrase).length > 0;
    const inHeading = headings.some((heading) => matchText(heading.text, { lower: phrase }));
    const inBody = occurrences(clean.toLowerCase(), phrase).length > 0;
    if (inTitle) score += PHRASE_BONUS.title;
    else if (inHeading) score += PHRASE_BONUS.heading;
    else if (inBody) score += PHRASE_BONUS.body;
  }

  // Typing a vein's title and getting it first is the whole point.
  if (query && title.trim().toLowerCase() === String(query).trim().toLowerCase()) score += 600;
  // Shallow veins are more likely to be what a name refers to.
  score += Math.max(0, 12 - (doc.path ? doc.path.split('/').length - 1 : 0) * 4);

  return {
    score: Math.round(score),
    fields,
    headingMatches: dedupeHeadings(headingMatches),
    bodyHits,
    firstBodyIndex,
  };
}

function dedupeHeadings(matches) {
  const seen = new Set();
  return matches.filter((match) => {
    if (seen.has(match.anchor)) return false;
    seen.add(match.anchor);
    return true;
  }).sort((a, b) => (a.level ?? 9) - (b.level ?? 9));
}

/**
 * A window of body text around the first match, with the ranges to mark up.
 * @returns {{text: string, ranges: Array<[number, number]>, truncated: boolean}|null}
 */
export function buildSnippet(text, terms, { radius = 70 } = {}) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  const ranges = findMatches(clean, terms);
  if (!ranges.length) return null;

  const [start] = ranges[0];
  const from = Math.max(0, start - radius);
  const to = Math.min(clean.length, start + radius);

  // Take the window, then drop partial words only at the edges we actually cut.
  let window = clean.slice(from, to);
  if (from > 0) {
    const space = window.indexOf(' ');
    if (space !== -1) window = window.slice(space + 1);
  }
  if (to < clean.length) {
    const space = window.lastIndexOf(' ');
    if (space !== -1) window = window.slice(0, space);
  }

  const prefix = from > 0 ? '…' : '';
  const suffix = to < clean.length ? '…' : '';
  return {
    text: `${prefix}${window}${suffix}`,
    ranges: findMatches(window, terms).map(([s, e]) => [s + prefix.length, e + prefix.length]),
    truncated: from > 0 || to < clean.length,
  };
}

/**
 * Search every vein in the corpus.
 *
 * @param {object} input
 * @param {Array} input.docs  from {@link buildSearchCorpus}
 * @param {string} input.query
 * @param {number} [input.limit] how many results to return (all are counted)
 */
export function searchVault({ docs = [], query = '', limit = 80 } = {}) {
  const terms = tokenize(query);
  if (!terms.length) {
    return { query, terms, total: 0, scanned: docs.length, results: [] };
  }

  const hits = [];
  for (const doc of docs) {
    const scored = scoreDocument(doc, terms, query);
    if (!scored) continue;
    hits.push({
      path: doc.path,
      title: doc.title,
      score: scored.score,
      fields: scored.fields,
      headingMatches: scored.headingMatches,
      bodyHits: scored.bodyHits,
      snippet: buildSnippet(doc.clean, terms),
    });
  }

  hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return {
    query,
    terms,
    total: hits.length,
    scanned: docs.length,
    results: hits.slice(0, limit),
  };
}
