/**
 * The record of link rewrites the viewer still owes.
 *
 * Renaming a heading writes the vein first and then points the links other veins
 * write to it at the new title; renaming a vein or a chamber moves the file those
 * links name. Each is a promise made to a second write: if the window closes in
 * between, the links name something that is no longer there. So the intent is
 * written to `.macusanite/retitles.json` before the change, and taken back out
 * once every link has followed. A window that comes back finds whatever is left
 * and finishes it.
 *
 * Nothing here touches the viewer: an entry is plain data — the vein whose
 * heading moved, the anchor it left and the title it took, or the path that moved
 * and where it went.
 */
import { extractHeadings } from './graph.js';
import { parseFrontmatter } from './frontmatter.js';
import { dirname, stem } from './path.js';

/** Write a title inside `[[vein#title]]`, or say that it cannot be. */
const writable = (title) => Boolean(title) && !/[\[\]|]/.test(title);

/** The file this app reads and writes, parsed, or null when it is not that. */
function parseJournal(raw) {
  try {
    return JSON.parse(String(raw ?? ''));
  } catch {
    return null;
  }
}

/**
 * The heading renames a journal file holds.
 *
 * The file is this app's alone, so its shape is the one `retitleJournalText`
 * writes: `{ pending: [...], moves?: [...] }`. Anything else in it — a file cut
 * short by a crash mid-write, a hand-edited entry — is dropped rather than
 * guessed at.
 *
 * @param {string|null} raw the file's text
 * @returns {Array<{path: string, before: string, after: string, title: string}>}
 */
export function readRetitleJournal(raw) {
  const parsed = parseJournal(raw);
  if (!Array.isArray(parsed?.pending)) return [];
  return parsed.pending.filter((entry) => Boolean(entry) && typeof entry === 'object'
    && typeof entry.path === 'string' && Boolean(entry.path)
    && typeof entry.before === 'string' && Boolean(entry.before)
    && typeof entry.after === 'string' && Boolean(entry.after) && entry.after !== entry.before
    && typeof entry.title === 'string' && writable(entry.title));
}

/**
 * The file moves a journal file holds: `{ kind, from, to }`, where `kind` is
 * `'vein'` for one file and `'chamber'` for every vein under a folder.
 *
 * @param {string|null} raw the file's text
 * @returns {Array<{kind: 'vein'|'chamber', from: string, to: string}>}
 */
export function readMoveJournal(raw) {
  const parsed = parseJournal(raw);
  if (!Array.isArray(parsed?.moves)) return [];
  return parsed.moves.filter((entry) => Boolean(entry) && typeof entry === 'object'
    && (entry.kind === 'vein' || entry.kind === 'chamber')
    && typeof entry.from === 'string' && Boolean(entry.from)
    && typeof entry.to === 'string' && Boolean(entry.to) && entry.to !== entry.from);
}

/**
 * What the journal file holds. An empty journal is deleted, never written.
 *
 * A headings-only journal keeps its original shape (`{ pending: [...] }`), and a
 * journal that also has moves carries them beside the headings.
 */
export function retitleJournalText(journal = []) {
  const pending = (Array.isArray(journal) ? journal : journal?.pending) ?? [];
  const moves = Array.isArray(journal) ? [] : (journal?.moves ?? []);
  return `${JSON.stringify(moves.length ? { pending, moves } : { pending }, null, 2)}\n`;
}

/**
 * The moves a rename made, as old path → new path for every file it carried.
 *
 * A vein entry is its own pair. A chamber entry is expanded against the vault as
 * it stands after the move, because that is the only list that says which files
 * the folder held — on the next open, as on this one, the old paths are gone.
 *
 * @param {Array<{kind: string, from: string, to: string}>} entries
 * @param {string[]} paths the vault's veins, after the move
 * @returns {Array<{from: string, to: string}>}
 */
export function movedPairs(entries = [], paths = []) {
  const veins = (paths ?? []).filter(Boolean);
  const out = [];
  for (const entry of entries ?? []) {
    if (!entry) continue;
    if (entry.kind === 'chamber') {
      for (const path of veins) {
        if (path === entry.to || path.startsWith(`${entry.to}/`)) {
          out.push({ from: `${entry.from}${path.slice(entry.to.length)}`, to: path });
        }
      }
    } else if (entry.kind === 'vein' && veins.includes(entry.to)) {
      out.push({ from: entry.from, to: entry.to });
    }
  }
  return out;
}

/**
 * Whether a move really reached the vault.
 *
 * The journal is written before the filesystem is touched, so a rename that
 * failed leaves an entry whose old path is still there; moving links then would
 * point them at a name nothing has. The vault's list of veins is what tells the
 * two apart, prefix-wise, so one answer serves a vein and a whole chamber.
 *
 * @param {string[]} paths the vault's veins, as the current window sees them
 * @param {{from: string, to: string}} entry
 */
export function renameReachedPaths(paths = [], entry = {}) {
  const from = String(entry?.from ?? '');
  const to = String(entry?.to ?? '');
  if (!from || !to || from === to) return false;
  const veins = (paths ?? []).filter(Boolean);
  const holds = (path) => veins.some((vein) => vein === path || vein.startsWith(`${path}/`));
  return holds(to) && !holds(from);
}

/**
 * The document index as it was before a move.
 *
 * A link written against the old name only resolves to the file it named while
 * the index still describes the file there, so matching links after a rename
 * runs over the moved entries put back at their old paths.
 *
 * @param {Array} index the live index, describing the files where they are now
 * @param {Array<{from: string, to: string}>} pairs
 * @returns {Array} entries with the moved documents described at their old paths
 */
export function indexBeforeMoves(index = [], pairs = []) {
  const previous = new Map((pairs ?? []).map((pair) => [pair.to, pair.from]));
  return (index ?? []).map((entry) => {
    const path = previous.get(entry.path);
    if (!path) return entry;
    return {
      ...entry,
      path,
      stem: stem(path),
      depth: path.split('/').length - 1,
      chamber: dirname(path),
    };
  });
}

/** One heading, as `buildDocumentIndex` / `extractHeadings` describe it. */
function cleanHeading(heading) {
  if (!heading || typeof heading !== 'object') return null;
  const anchor = String(heading.anchor ?? '').trim();
  if (!anchor) return null;
  return {
    anchor,
    level: Math.min(6, Math.max(1, Number(heading.level) || 1)),
    text: String(heading.text ?? '').trim(),
  };
}

/** The words a heading is made of, for telling a retitled heading from a new one. */
function headingWords(text) {
  return new Set(String(text ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 1));
}

/** How many words two headings have in common. */
function sharedWords(left, right) {
  const a = headingWords(left);
  const b = headingWords(right);
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared;
}

const renameOf = (old, next) => ({ before: old.anchor, after: next.anchor, title: next.text });

/**
 * Pair the headings in one gap between two anchors both versions share.
 *
 * The same number on each side reads as the same headings renamed in place,
 * whatever they now say. With an insertion or a deletion alongside, positions
 * mean nothing any more, so only a heading that kept a word of its title — at the
 * same level — is taken for one renamed; the rest of the gap is something else
 * that happened, and is left alone. Guessing wrong there would quietly retitle a
 * link that points at a heading the reader never touched.
 */
function pairGap(gapBefore, gapAfter) {
  if (!gapBefore.length && !gapAfter.length) return [];
  if (gapBefore.length === gapAfter.length) {
    const paired = [];
    for (let k = 0; k < gapBefore.length; k += 1) {
      if (gapBefore[k].level !== gapAfter[k].level) continue;
      paired.push(renameOf(gapBefore[k], gapAfter[k]));
    }
    return paired;
  }
  const candidates = [];
  gapBefore.forEach((old, i) => gapAfter.forEach((next, j) => {
    if (old.level !== next.level) return;
    const score = sharedWords(old.text, next.text);
    if (!score) return;
    candidates.push({ i, j, score, lengthGap: Math.abs(old.text.length - next.text.length) });
  }));
  candidates.sort((a, b) => b.score - a.score || a.lengthGap - b.lengthGap || a.i - b.i || a.j - b.j);
  const usedBefore = new Set();
  const usedAfter = new Set();
  const paired = [];
  for (const candidate of candidates) {
    if (usedBefore.has(candidate.i) || usedAfter.has(candidate.j)) continue;
    usedBefore.add(candidate.i);
    usedAfter.add(candidate.j);
    paired.push({ i: candidate.i, entry: renameOf(gapBefore[candidate.i], gapAfter[candidate.j]) });
  }
  // The entries were chosen by likeness; the caller wants them in document order.
  return paired.sort((a, b) => a.i - b.i).map((chosen) => chosen.entry);
}

/**
 * The headings a saved draft renamed by typing.
 *
 * A heading retyped in the source editor is a rename like a card's title, and
 * the links other veins write to it have to follow. There is no commit to listen
 * to, so this compares the headings the vein was last known by with the ones the
 * draft has now: the anchors that are still there, in order, are what did not
 * move, and the gaps between them are the candidates.
 *
 * A heading that only changed level keeps its anchor, so it is not a rename and
 * its links still resolve. A gap holding a different number of headings on each
 * side is read by {@link pairGap}: only a heading that kept a word of its title
 * is taken for a rename there.
 *
 * @param {Array<{level: number, text: string, anchor: string}>} before as last read
 * @param {Array<{level: number, text: string, anchor: string}>} after as the save will write it
 * @returns {Array<{before: string, after: string, title: string}>} the renames, in order
 */
export function retypedHeadings(before = [], after = []) {
  const old = (before ?? []).map(cleanHeading).filter(Boolean);
  const next = (after ?? []).map(cleanHeading).filter(Boolean);
  const rows = old.length;
  const cols = next.length;
  if (!rows || !cols) return [];

  // Longest common subsequence of anchors: the headings both versions share,
  // used only to line the two lists up against each other.
  const table = Array.from({ length: rows + 1 }, () => new Int32Array(cols + 1));
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      table[i][j] = old[i].anchor === next[j].anchor
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const renames = [];
  let gapBefore = [];
  let gapAfter = [];
  const closeGap = () => {
    renames.push(...pairGap(gapBefore, gapAfter));
    gapBefore = [];
    gapAfter = [];
  };

  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (old[i].anchor === next[j].anchor) {
      closeGap();
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      gapBefore.push(old[i]);
      i += 1;
    } else {
      gapAfter.push(next[j]);
      j += 1;
    }
  }
  while (i < rows) gapBefore.push(old[i++]);
  while (j < cols) gapAfter.push(next[j++]);
  closeGap();
  return renames;
}

/**
 * Whether the vein really lost the heading a journal entry names.
 *
 * The journal is written before the vein is, so a save that failed leaves an
 * entry whose heading is still in the file; rewriting links for that would point
 * them at a section the vein never gained. The renamed vein's own text is what
 * tells the two apart, and it also settles a chain (`A→B`, then `B→C`): each
 * entry asks only that its own anchor is gone, so they run in order and the
 * links come out at the title the heading ended with.
 *
 * @param {string} text the vein as it is on disk
 * @param {string} before the anchor the heading had
 */
export function renameReachedFile(text, before) {
  const wanted = String(before ?? '').trim();
  if (!wanted) return false;
  const { body } = parseFrontmatter(String(text ?? ''));
  return !extractHeadings(body).some((heading) => heading.anchor === wanted);
}
