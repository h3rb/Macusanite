/**
 * The index cache: `<vault>/.macusanite/index.json`.
 *
 * Opening a vault should not read a vault. A walk of the folder yields each
 * vein's modification time and size; anything that has not moved since the cache
 * was written is already described in it — title, aliases, headings, links, tags
 * and front-matter colours — so only what actually changed is ever opened and
 * parsed.
 *
 * Two consequences worth knowing:
 *
 * * Freshness is `mtime` plus `size`. A file rewritten inside the same clock
 *   tick with exactly the same byte count would look unchanged. The live watcher
 *   covers edits made while the vault is open, and the window is the one thing
 *   this design trades away.
 * * A vein with no cache entry, or one whose cache entry is stale, gets a
 *   **stub**: everything the path alone can say. Stubs carry no links, headings
 *   or tags, so the index fills in progressively (`entry.indexed === false`
 *   marks them) rather than the viewer waiting for every file.
 */
import { dirname, stem, titleFromPath } from './path.js';

export const CACHE_VERSION = 1;

const byPath = (a, b) => a.path.localeCompare(b.path);

/**
 * What can be said about a vein without reading it: the file name is the only
 * evidence there is.
 */
export function stubEntry(path) {
  const name = stem(path);
  return {
    path,
    stem: name,
    title: titleFromPath(path),
    aliases: name ? [name] : [],
    tags: [],
    headings: [],
    links: [],
    color: null,
    linkColor: null,
    sectionColor: null,
    depth: String(path).split('/').length - 1,
    chamber: dirname(path),
    indexed: false,
  };
}

/** True for an entry that still needs its file read. */
export function isStub(entry) {
  return entry?.indexed === false;
}

/**
 * Read the cache file. Anything unexpected — a different version, truncated
 * JSON, a hand-edit — is treated as "no cache at all", which is slower but never
 * wrong.
 * @returns {{version: number, entries: Record<string, {mtime: number, size: number, entry: object}>}}
 */
export function parseCache(json, version = CACHE_VERSION) {
  const empty = { version, entries: {} };
  if (!json) return empty;
  try {
    const parsed = typeof json === 'string' ? JSON.parse(json) : json;
    if (!parsed || parsed.version !== version) return empty;
    if (!parsed.entries || typeof parsed.entries !== 'object') return empty;
    return { version, entries: parsed.entries };
  } catch {
    return empty;
  }
}

/** Compact on purpose: this file is machine data and can be large. */
export function serializeCache(entries, { generated = null } = {}) {
  return `${JSON.stringify({ version: CACHE_VERSION, generated, entries })}\n`;
}

/** The cache record for a vein that was just read at a known stat. */
export function cacheRecord(stat, entry) {
  return { mtime: stat?.mtime ?? 0, size: stat?.size ?? 0, entry };
}

/**
 * Decide what the index can be built from right now, and what still has to be
 * read.
 *
 * @param {object} input
 * @param {Array<{path: string, mtime: number, size: number}>} input.stats vault walk
 * @param {{entries: object}|null} input.cache
 * @param {string|null} [input.priority] vein to read first (the open one)
 * @returns {{
 *   index: Array, reusable: Record<string, object>, toRead: string[],
 *   removed: string[], stats: Map<string, object>, clean: boolean,
 * }}
 */
export function planIndex({ stats = [], cache = null, priority = null } = {}) {
  const entries = cache?.entries ?? {};
  const reusable = {};
  const toRead = [];
  const seen = new Set();

  for (const stat of stats) {
    if (!stat?.path) continue;
    seen.add(stat.path);
    const cached = entries[stat.path];
    if (cached && cached.entry && cached.mtime === stat.mtime && cached.size === stat.size) {
      reusable[stat.path] = { ...cached.entry, indexed: true };
    } else {
      toRead.push(stat.path);
    }
  }

  const removed = Object.keys(entries).filter((path) => !seen.has(path));

  // The open vein is read first: its own headings, tags, links and graph are
  // what the reader is looking at.
  if (priority && toRead.includes(priority)) {
    toRead.splice(toRead.indexOf(priority), 1);
    toRead.unshift(priority);
  }

  return {
    index: assembleIndex(stats, reusable),
    reusable,
    toRead,
    removed,
    stats: new Map(stats.map((stat) => [stat.path, stat])),
    clean: toRead.length === 0 && removed.length === 0,
  };
}

/** Cached entries where they exist, stubs everywhere else, path-sorted. */
export function assembleIndex(stats = [], reusable = {}) {
  return stats
    .map((stat) => reusable[stat.path] ?? stubEntry(stat.path))
    .sort(byPath);
}

/**
 * The live index: a path-sorted list plus the position of each path, so a
 * progressive pass can replace stubs in place (O(1)) as entries arrive.
 */
export function createIndex(entries = []) {
  let list = [...entries].sort(byPath);
  const positions = new Map(list.map((entry, i) => [entry.path, i]));
  let indexedCount = list.filter((entry) => !isStub(entry)).length;

  return {
    get list() {
      return list;
    },
    /** How many veins have real entries rather than stubs. */
    get indexed() {
      return indexedCount;
    },
    get total() {
      return list.length;
    },
    find(path) {
      const at = positions.get(path);
      return at === undefined ? null : list[at];
    },
    /** Replace an entry (or add it) without disturbing the order. */
    replace(entry) {
      const at = positions.get(entry.path);
      if (at === undefined) return insert(entry);
      if (isStub(list[at]) && !isStub(entry)) indexedCount += 1;
      else if (!isStub(list[at]) && isStub(entry)) indexedCount -= 1;
      list[at] = entry;
      return entry;
    },
    insert,
    /** Forget veins that are no longer in the vault. */
    drop(paths) {
      const gone = new Set(paths);
      if (!gone.size) return 0;
      const kept = [];
      for (const entry of list) {
        if (gone.has(entry.path)) {
          if (!isStub(entry)) indexedCount -= 1;
          continue;
        }
        kept.push(entry);
      }
      const dropped = list.length - kept.length;
      list = kept;
      positions.clear();
      list.forEach((entry, i) => positions.set(entry.path, i));
      return dropped;
    },
  };

  function insert(entry) {
    const at = list.findIndex((other) => other.path.localeCompare(entry.path) > 0);
    const index = at === -1 ? list.length : at;
    list.splice(index, 0, entry);
    for (const [path, position] of positions) {
      if (position >= index) positions.set(path, position + 1);
    }
    positions.set(entry.path, index);
    if (!isStub(entry)) indexedCount += 1;
    return entry;
  }
}
