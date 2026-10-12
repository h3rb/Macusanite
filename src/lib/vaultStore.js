/**
 * The headless vault.
 *
 * Everything the window does to a vault reduces to file operations: read a
 * vein, write it, create a chamber, flip a colour, append a log line, walk the
 * tree. This module is that layer, over a *filesystem adapter* instead of Tauri
 * IPC, so the same vault can be driven by
 *
 *   * the desktop window     (src/backend.js — the Rust core over IPC)
 *   * the browser fallback   (src/backend.js — the same store, localStorage adapter)
 *   * the CLI and MCP server (cli/ — the same store, `node:fs` adapter)
 *
 * The on-disk formats are the Rust core's (`src-tauri/src/{vault,meta,history}.rs`)
 * in the same shape: `.macusanite/vault.json`, `settings.json`, `colors.json`,
 * `history.json`, `logs/session-YYYYMMDD.log`, and the `.macusanite/index.json`
 * document cache. A vault written here opens in the window and vice versa.
 *
 * ## The filesystem adapter
 *
 * `createVaultStore` takes an object of async methods, all speaking
 * vault-relative POSIX paths:
 *
 * ```js
 * {
 *   list(): Promise<Array<{ path, mtime, size }>>   // every file, recursively
 *   read(path): Promise<string|null>                // null when absent
 *   write(path, text): Promise<void>                // creates chambers as needed
 *   append(path, text): Promise<void>
 *   remove(path): Promise<void>                     // a missing file is not an error
 *   stat(path): Promise<{ path, mtime, size }|null>
 * }
 * ```
 *
 * See [cli/vaultFs.js](../../cli/vaultFs.js) for the `node:fs` one, and the
 * localStorage adapter in [src/backend.js](../backend.js).
 */
import { buildDocumentIndex, buildGraph, graphStats } from './graph.js';
import { parseFrontmatter, documentMeta } from './frontmatter.js';
import { parseWikiLinks, resolveTarget } from './wikilinks.js';
import { buildTree, countVeins } from './tree.js';
import { isMarkdown, join, stem, dirname, basename, titleFromPath } from './path.js';
import { mergeSettings, mergeVaultMeta, DEFAULT_SETTINGS, DEFAULT_VAULT_META } from './settings.js';
import * as colorStore from './colorStore.js';
import {
  CACHE_VERSION, parseCache, serializeCache, cacheRecord, planIndex, createIndex, isStub, stubEntry,
} from './indexCache.js';
import { buildSearchCorpus, searchVault, plainText } from './search.js';

export const META_DIR = '.macusanite';
export const LOGS_DIR = 'logs';
export const INDEX_FILE = 'index.json';
export const META_FILES = {
  vault: 'vault.json',
  settings: 'settings.json',
  colors: 'colors.json',
  history: 'history.json',
  state: 'state.json',
  index: INDEX_FILE,
};
/** The undo stack is capped exactly as the Rust core caps it. */
export const MAX_HISTORY = 400;
/** Files this layer will write inside `.macusanite`; anything else is left alone. */
export const KNOWN_META_FILES = [META_FILES.vault, META_FILES.settings, META_FILES.colors, META_FILES.history];

/** A path that is not a valid vault-relative path. */
export class VaultPathError extends Error {
  constructor(message) {
    super(message);
    this.name = 'VaultPathError';
  }
}

/** ISO-8601 UTC, matching `meta.rs::iso_timestamp`. */
export function isoTimestamp(millis = Date.now()) {
  return new Date(millis).toISOString();
}

/** `YYYYMMDD` in UTC, matching `meta.rs::day_stamp`. */
export function dayStamp(millis = Date.now()) {
  return new Date(millis).toISOString().slice(0, 10).replace(/-/g, '');
}

/**
 * A vault-relative path, refused if it could leave the vault.
 * Mirrors `vault.rs::resolve_in_vault`.
 */
export function safePath(rel) {
  const cleaned = String(rel ?? '').replace(/\\/g, '/');
  const parts = [];
  for (const part of cleaned.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') throw new VaultPathError(`path escapes the vault: ${rel}`);
    if (part.includes(':')) throw new VaultPathError(`invalid path segment: ${part}`);
    parts.push(part);
  }
  if (!parts.length) throw new VaultPathError(`empty path: ${rel}`);
  return parts.join('/');
}

/** Meta file names are flat: no separators, no traversal. Mirrors `safe_meta_name`. */
export function safeMetaName(name) {
  const trimmed = String(name ?? '').trim();
  if (!trimmed || trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('..')) {
    throw new VaultPathError(`invalid meta file name: ${name}`);
  }
  return trimmed;
}

const prettyJson = (value) => `${JSON.stringify(value, null, 2)}\n`;
const parseJson = (raw, fallback = null) => {
  if (typeof raw !== 'string' || !raw.trim()) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
};

/**
 * @param {object} input
 * @param {object} input.fs the filesystem adapter (see the module doc)
 * @param {string} [input.root] where the vault lives — for display, and for the
 *   default vault name; the adapter already knows the real path
 */
export function createVaultStore({ fs, root = '' }) {
  // The document index is expensive and every read command wants it. One
  // command builds it at most once; any write throws it away.
  let indexPromise = null;
  let historyCache = null;

  const invalidate = () => {
    indexPromise = null;
    historyCache = null;
  };

  const metaPath = (name) => join(META_DIR, safeMetaName(name));
  const logPath = (day) => join(META_DIR, LOGS_DIR, `session-${day}.log`);
  const listFiles = async () => (await fs.list()) ?? [];

  /** Drop the `.keep` markers a tree was built with, keeping their chambers. */
  const pruneMarkers = (nodes) => nodes
    .filter((node) => node.name !== '.keep')
    .map((node) => (node.children?.length ? { ...node, children: pruneMarkers(node.children) } : node));

  /* ── walking the vault ───────────────────────────────────────────────── */

  /**
   * Every vein, chamber and file stat in the vault, in one walk.
   *
   * A dot-*folder* is invisible (`.macusanite`, `.git`), exactly as the Rust
   * scan has it, but a dot-*file* still registers its chamber: that is what makes
   * an empty chamber visible, because the only thing in it is the `.keep` marker.
   */
  async function scan() {
    const files = await listFiles();
    const veins = [];
    const chambers = [];
    const stats = [];
    const markers = [];
    const seen = new Set();
    for (const file of files) {
      const path = file.path;
      if (!path) continue;
      // Every ancestor directory is a chamber, outermost first — the Rust walk
      // reports a folder as soon as it visits it, and an empty chamber is still
      // a chamber.
      let prefix = '';
      let hidden = false;
      for (const part of dirname(path).split('/')) {
        if (!part) continue;
        if (part.startsWith('.')) {
          hidden = true;
          break;
        }
        prefix = prefix ? `${prefix}/${part}` : part;
        if (!seen.has(prefix)) {
          seen.add(prefix);
          chambers.push(prefix);
        }
      }
      if (hidden) continue; // inside a dot-folder: `.macusanite`, `.git`, …
      if (path.split('/').some((part) => part.startsWith('.'))) {
        // A `.keep` marker: it registered its chamber above and nothing else.
        if (prefix) markers.push(path);
        continue;
      }
      if (!isMarkdown(path)) continue;
      veins.push(path);
      stats.push({ path, mtime: file.mtime ?? 0, size: file.size ?? 0 });
    }
    veins.sort();
    chambers.sort();
    stats.sort((a, b) => a.path.localeCompare(b.path));
    return { veins, chambers, stats, tree: buildTree([...veins, ...markers]) };
  }

  /* ── identity and metadata ───────────────────────────────────────────── */

  /** Create `.macusanite` (and any missing file in it) and report the vault. */
  async function ensureMeta({ name = null, description = null } = {}) {
    const existing = await fs.read(metaPath(META_FILES.vault));
    if (existing === null) {
      await fs.write(metaPath(META_FILES.vault), prettyJson({
        version: 1,
        kind: 'macusanite-vault',
        name: name ?? (root ? basename(root) : DEFAULT_VAULT_META.name),
        description: description ?? '',
        created: isoTimestamp(),
      }));
    } else if (name !== null || description !== null) {
      // Creating a vault over an existing one updates the identity instead of
      // silently keeping the old one, exactly like the Rust core.
      const current = parseJson(existing, {}) ?? {};
      if (name !== null) current.name = name;
      if (description !== null) current.description = description;
      await fs.write(metaPath(META_FILES.vault), prettyJson(current));
    }

    if (await fs.read(metaPath(META_FILES.settings)) === null) {
      await fs.write(metaPath(META_FILES.settings), '{\n  "version": 1\n}\n');
    }
    if (await fs.read(metaPath(META_FILES.colors)) === null) {
      await fs.write(metaPath(META_FILES.colors), prettyJson(colorStore.emptyColorSet()));
    }
    if (await fs.read(metaPath(META_FILES.history)) === null) {
      await fs.write(metaPath(META_FILES.history), prettyJson({ version: 1, undo: [], redo: [] }));
    }
    invalidate();
    return info();
  }

  /** Vault identity plus the viewer's settings and colour assignments. */
  async function info() {
    const meta = mergeVaultMeta(parseJson(await fs.read(metaPath(META_FILES.vault)), {}) ?? {});
    return {
      path: root,
      name: meta.name,
      description: meta.description,
      created: meta.created,
      settings: parseJson(await fs.read(metaPath(META_FILES.settings)), {}) ?? { version: 1 },
      colors: parseJson(await fs.read(metaPath(META_FILES.colors)), {}) ?? {},
    };
  }

  async function updateVaultMeta(patch = {}, { record = true } = {}) {
    const current = mergeVaultMeta(parseJson(await fs.read(metaPath(META_FILES.vault)), {}) ?? {});
    const next = mergeVaultMeta({ ...current, ...patch });
    await writeMeta(META_FILES.vault, prettyJson(next), { label: 'vault details', record });
    return next;
  }

  /** Read a `.macusanite` file verbatim, or null when it does not exist. */
  async function readMeta(name) {
    return fs.read(metaPath(name));
  }

  /**
   * Write a `.macusanite` file.
   *
   * `record: false` keeps viewer bookkeeping (state, the index cache) out of the
   * undo stack, exactly like the window's own writes.
   */
  async function writeMeta(name, contents, { label = null, record = true } = {}) {
    const rel = metaPath(name);
    const before = await fs.read(rel);
    await fs.write(rel, contents);
    if (record) await recordHistory(rel, label ?? safeMetaName(name), before, contents);
    invalidate();
    return { path: rel };
  }

  async function appendLog(level, message) {
    await fs.append(logPath(dayStamp()), `${JSON.stringify({ ts: isoTimestamp(), level, message })}\n`);
  }

  /** Session log lines, oldest first, with the file each came from. */
  async function logs({ limit = 200, day = null } = {}) {
    const files = (await listFiles())
      .map((file) => /^\.macusanite\/logs\/session-(\d+)\.log$/.exec(file.path))
      .filter(Boolean)
      .filter((match) => day === null || match[1] === String(day))
      .sort((a, b) => a[1].localeCompare(b[1]));
    const out = [];
    for (const match of files) {
      const text = await fs.read(match[0]);
      if (!text) continue;
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        const entry = parseJson(line, null);
        if (entry) out.push({ ...entry, file: match[0] });
      }
    }
    return out.slice(-limit);
  }

  /* ── documents ───────────────────────────────────────────────────────── */

  async function readVein(rel) {
    const path = safePath(rel);
    const text = await fs.read(path);
    if (text === null) throw new Error(`vein not found: ${path}`);
    return text;
  }

  async function statVein(rel) {
    const path = safePath(rel);
    const stat = await fs.stat(path);
    if (!stat) throw new Error(`vein not found: ${path}`);
    return { path, mtime: stat.mtime ?? 0, size: stat.size ?? 0 };
  }

  /**
   * Write a vein and record it. `before === after` is a no-op, so a save that
   * changes nothing never lands in the undo stack.
   */
  async function writeVein(rel, contents, { label = null, record = true } = {}) {
    const path = safePath(rel);
    const text = String(contents ?? '');
    const before = await fs.read(path);
    await fs.write(path, text);
    if (record) await recordHistory(path, label ?? `edit ${path}`, before, text);
    invalidate();
    return { path, bytes: text.length };
  }

  /** Create a vein, with the project's standard template when no text is given. */
  async function createVein(rel, contents = null, { record = true } = {}) {
    const wanted = String(rel ?? '');
    const path = safePath(isMarkdown(wanted) ? wanted : `${wanted}.md`);
    if (await fs.read(path) !== null) return { path, created: false };
    const title = titleFromPath(path);
    const text = typeof contents === 'string' ? contents : `---\ntitle: ${title}\n---\n# ${title}\n\n`;
    await fs.write(path, text);
    if (record) await recordHistory(path, `create ${path}`, null, text);
    invalidate();
    return { path, created: true };
  }

  async function createChamber(rel, { record = false } = {}) {
    const path = safePath(rel);
    const marker = join(path, '.keep');
    const created = await fs.read(marker) === null;
    // A marker file is what makes an empty chamber visible in the tree; the Rust
    // core and the browser fallback use the same trick.
    await fs.write(marker, '');
    if (record) await recordHistory(marker, `create chamber ${path}`, null, '');
    invalidate();
    return { path, created };
  }

  /**
   * Delete a vein.
   *
   * Undo restores the text. Redo re-creates the file *empty*: a history entry
   * stores `after: ''`, because the Rust core reads the stack with a
   * non-optional `after` field, and a null there would make the whole file
   * unreadable to the window. Pass `record: false` to delete without an undo step.
   */
  async function deleteVein(rel, { label = null, record = true } = {}) {
    const path = safePath(rel);
    const before = await fs.read(path);
    if (before === null) return { path, deleted: false };
    await fs.remove(path);
    if (record) await recordHistory(path, label ?? `delete ${path}`, before, '');
    invalidate();
    return { path, deleted: true };
  }

  /**
   * Rename (or move) a vein. Two history entries are recorded — the new file,
   * then the old one — so undo restores the original in two steps, which keeps
   * every entry a single-file snapshot like the rest of the stack.
   */
  async function renameVein(from, to, { label = null, record = true } = {}) {
    const source = safePath(from);
    const wanted = String(to ?? '');
    const target = safePath(isMarkdown(wanted) ? wanted : `${wanted}.md`);
    if (source === target) return { path: target, moved: false };
    const text = await readVein(source);
    if (await fs.read(target) !== null) throw new Error(`vein already exists: ${target}`);
    await fs.write(target, text);
    await fs.remove(source);
    if (record) {
      const name = label ?? `rename ${source} -> ${target}`;
      await recordHistory(target, name, null, text);
      await recordHistory(source, name, text, '');
    }
    invalidate();
    return { path: target, from: source, moved: true };
  }

  /** Append to a vein — the common "add a note without rewriting it" move. */
  async function appendVein(rel, text, { label = null } = {}) {
    const path = safePath(rel);
    const before = await readVein(path);
    const addition = String(text ?? '');
    const joined = !before || before.endsWith('\n') ? `${before}${addition}` : `${before}\n${addition}`;
    return writeVein(path, joined, { label: label ?? `append to ${path}` });
  }

  /** Replace one heading's section content, or append the section when absent. */
  async function upsertSection(rel, heading, body, { level = 2 } = {}) {
    const path = safePath(rel);
    const text = await readVein(path);
    const title = String(heading).trim();
    const marks = '#'.repeat(Math.max(1, Math.min(6, Number(level) || 2)));
    const lines = text.split('\n');
    let start = -1;
    let end = lines.length;
    for (let i = 0; i < lines.length; i += 1) {
      const match = /^(#{1,6})\s+(.*)$/.exec(lines[i]);
      if (!match) continue;
      if (start === -1) {
        if (match[1] === marks && match[2].trim().toLowerCase() === title.toLowerCase()) start = i;
        continue;
      }
      if (match[1].length <= marks.length) {
        end = i;
        break;
      }
    }
    const block = [`${marks} ${title}`, '', String(body ?? '').trim(), ''];
    const next = start === -1
      ? [...lines, '', ...block].join('\n')
      : [...lines.slice(0, start), ...block, ...lines.slice(end)].join('\n');
    await writeVein(path, next.endsWith('\n') ? next : `${next}\n`, { label: `section ${title} in ${path}` });
    return { path, heading: title, replaced: start !== -1 };
  }

  /* ── undo and redo ───────────────────────────────────────────────────── */

  async function refreshHistory() {
    if (historyCache) return historyCache;
    const parsed = parseJson(await fs.read(metaPath(META_FILES.history)), null);
    historyCache = parsed && Array.isArray(parsed.undo) && Array.isArray(parsed.redo)
      ? { version: parsed.version ?? 1, undo: parsed.undo, redo: parsed.redo }
      : { version: 1, undo: [], redo: [] };
    return historyCache;
  }

  async function saveHistory() {
    const stacks = historyCache ?? { version: 1, undo: [], redo: [] };
    await fs.write(metaPath(META_FILES.history), prettyJson(stacks));
    return stacks;
  }

  async function recordHistory(rel, label, before, after) {
    if ((before ?? null) === after) return; // no-op writes stay out of the stack
    const stacks = await refreshHistory();
    stacks.undo.push({
      path: rel,
      label: String(label),
      before: before ?? null,
      after: String(after ?? ''),
      ts: Date.now(),
    });
    if (stacks.undo.length > MAX_HISTORY) stacks.undo.splice(0, stacks.undo.length - MAX_HISTORY);
    stacks.redo = [];
    await saveHistory();
  }

  /** Newest first, like the window's second bar expects. */
  async function historyState() {
    const stacks = await refreshHistory();
    const brief = (entry) => ({ path: entry.path, label: entry.label, ts: entry.ts });
    return { undo: [...stacks.undo].reverse().map(brief), redo: [...stacks.redo].reverse().map(brief) };
  }

  async function undo() {
    const stacks = await refreshHistory();
    const entry = stacks.undo.pop();
    if (!entry) return { applied: false, stacks: await historyState() };
    if (entry.before === null) await fs.remove(entry.path);
    else await fs.write(entry.path, entry.before);
    stacks.redo.push(entry);
    await saveHistory();
    invalidate();
    return { applied: true, path: entry.path, label: entry.label, stacks: await historyState() };
  }

  async function redo() {
    const stacks = await refreshHistory();
    const entry = stacks.redo.pop();
    if (!entry) return { applied: false, stacks: await historyState() };
    await fs.write(entry.path, entry.after ?? '');
    stacks.undo.push(entry);
    await saveHistory();
    invalidate();
    return { applied: true, path: entry.path, label: entry.label, stacks: await historyState() };
  }

  /* ── the document index and its cache ────────────────────────────────── */

  /**
   * Describe every vein — title, aliases, headings, links, tags, colours —
   * reusing `.macusanite/index.json` for anything whose stat has not moved, and
   * writing the cache back when it was stale. That is the same cache the window
   * reads, so a CLI call keeps the next open warm.
   *
   * @param {{refresh?: boolean, bodies?: Record<string,string>}} [options]
   */
  async function buildIndex({ refresh = false, bodies: supplied = null } = {}) {
    const { veins, stats } = await scan();
    const raw = refresh ? null : await fs.read(metaPath(INDEX_FILE));
    const cache = refresh ? { version: CACHE_VERSION, entries: {} } : parseCache(raw);
    const plan = planIndex({ stats, cache });
    const bodies = { ...(supplied ?? {}) };
    const store = createIndex(plan.index);
    const records = {};
    for (const entry of plan.index) {
      if (!isStub(entry) && cache.entries[entry.path]) records[entry.path] = cache.entries[entry.path];
    }

    const need = refresh ? veins : plan.toRead;
    if (need.length) {
      const texts = await Promise.all(need.map(async (path) => {
        try {
          return [path, await readVein(path)];
        } catch {
          return [path, null];
        }
      }));
      for (const [path, text] of texts) {
        if (typeof text !== 'string') continue;
        bodies[path] = text;
        const entry = buildDocumentIndex({ [path]: text })[0] ?? stubEntry(path);
        store.replace(entry);
        const stat = stats.find((s) => s.path === path) ?? { mtime: 0, size: text.length };
        records[path] = cacheRecord(stat, entry);
      }
    }

    // Prune veins that no longer exist, then persist only when there was
    // something to learn: reading a warm vault should not rewrite the file.
    const live = new Set(veins);
    for (const path of Object.keys(records)) if (!live.has(path)) delete records[path];
    if (need.length || raw === null) {
      await fs.write(metaPath(INDEX_FILE), serializeCache(records, { generated: isoTimestamp() }));
    }

    return { index: store.list, bodies, stats, veins, cached: plan.index.length - plan.toRead.length };
  }

  function index() {
    if (!indexPromise) indexPromise = buildIndex();
    return indexPromise;
  }

  /** Full-text search across the vault, ranked exactly like the search pane. */
  async function search(query, { limit = 80, refresh = false } = {}) {
    const { index: docs, bodies } = refresh ? await buildIndex({ refresh }) : await index();
    const found = searchVault({ docs: buildSearchCorpus({ index: docs, bodies }), query, limit });
    return {
      query: found.query,
      terms: found.terms,
      total: found.total,
      results: found.results.map((result) => ({
        path: result.path,
        title: result.title,
        score: result.score,
        snippet: result.snippet?.text ?? '',
        headings: result.headingMatches?.map((h) => h.text) ?? [],
        bodyHits: result.bodyHits ?? 0,
      })),
    };
  }

  /** Headings, links, tags and colours of one vein, as the viewer sees them. */
  async function document(rel) {
    const path = safePath(rel);
    const text = await readVein(path);
    const { data, body } = parseFrontmatter(text);
    const entry = buildDocumentIndex({ [path]: text })[0] ?? stubEntry(path);
    const clean = plainText(text);
    return {
      path,
      title: entry.title,
      aliases: entry.aliases,
      tags: entry.tags,
      color: entry.color,
      linkColor: entry.linkColor,
      sectionColor: entry.sectionColor,
      headings: entry.headings,
      links: entry.links,
      frontmatter: data,
      meta: documentMeta(data),
      body,
      text,
      words: clean ? clean.split(/\s+/).filter(Boolean).length : 0,
    };
  }

  /** Veins that link to `path`, in the shape the viewer's backlinks list uses. */
  async function backlinks(rel) {
    const path = safePath(rel);
    const { index: docs } = await index();
    const needle = path.toLowerCase();
    const name = stem(path).toLowerCase();
    const out = [];
    for (const doc of docs) {
      if (doc.path === path) continue;
      for (const link of doc.links ?? []) {
        const target = String(link.target ?? '').toLowerCase();
        if (!target) continue;
        const hit = target === needle
          || target === name
          || target === needle.replace(/\.(md|markdown|mdx)$/i, '')
          || target.endsWith(`/${name}`);
        if (!hit) continue;
        out.push({ path: doc.path, title: doc.title, context: link.section ? `§ ${link.section}` : '' });
        break;
      }
    }
    return out.sort((a, b) => a.title.localeCompare(b.title));
  }

  /** Where a wiki link points, including the ghost suggestion when it does not. */
  async function resolveLink(target, from = null) {
    const { index: docs } = await index();
    const link = typeof target === 'string' ? { target, section: '' } : target;
    return resolveTarget(link, from, docs);
  }

  const ghostsOf = (docs) => {
    const out = [];
    for (const doc of docs) {
      for (const link of doc.links ?? []) {
        if (!link.target) continue;
        const resolved = resolveTarget(link, doc.path, docs);
        if (!resolved.ok) {
          out.push({
            from: doc.path,
            target: link.target,
            section: link.section || '',
            suggestedPath: resolved.suggestedPath ?? `${link.target}.md`,
          });
        }
      }
    }
    return out;
  };

  /** Every wiki link in the vault that points at nothing yet. */
  async function ghosts() {
    const { index: docs } = await index();
    return ghostsOf(docs);
  }

  /** Tags across the vault, with how many veins carry each. */
  async function tags() {
    const { index: docs } = await index();
    const counts = new Map();
    for (const doc of docs) {
      for (const tag of doc.tags ?? []) {
        const key = String(tag).toLowerCase();
        const current = counts.get(key) ?? { tag: key, count: 0, veins: [] };
        current.count += 1;
        current.veins.push(doc.path);
        counts.set(key, current);
      }
    }
    return [...counts.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }

  /** The concept graph as data (the window's pane adds the layout). */
  async function graph({ focus = null, depth = null } = {}) {
    const settings = await readSettings();
    const { index: docs } = await index();
    const colors = await readColors();
    const pageOverrides = {};
    for (const doc of docs) if (doc.color) pageOverrides[doc.path] = doc.color;
    const effective = depth === null ? settings : { ...settings, graph: { ...settings.graph, depth } };
    const built = buildGraph({
      index: docs,
      settings: effective,
      focusPath: focus,
      colorOf: (kind, parts) => colorStore.resolveColor(colors, kind, parts, settings, pageOverrides),
    });
    return {
      focus,
      stats: graphStats(built),
      nodes: built.nodes.map((node) => ({
        id: node.id,
        kind: node.kind,
        label: node.label,
        path: node.path ?? null,
        anchor: node.anchor ?? null,
        color: node.color ?? null,
      })),
      edges: built.edges.map((edge) => ({ from: edge.from, to: edge.to, kind: edge.kind })),
    };
  }

  /** Numbers an agent can orient with before it starts editing. */
  async function stats() {
    const { veins, chambers, stats: fileStats, tree } = await scan();
    const { index: docs } = await index();
    const links = docs.reduce((sum, doc) => sum + (doc.links?.length ?? 0), 0);
    const headings = docs.reduce((sum, doc) => sum + (doc.headings?.length ?? 0), 0);
    const tagSet = new Set();
    for (const doc of docs) for (const tag of doc.tags ?? []) tagSet.add(String(tag).toLowerCase());
    const linked = new Set();
    const hasOutbound = new Set();
    for (const doc of docs) {
      if ((doc.links?.length ?? 0) > 0) hasOutbound.add(doc.path);
      for (const link of doc.links ?? []) {
        const resolved = resolveTarget(link, doc.path, docs);
        if (resolved.ok && resolved.path) linked.add(resolved.path);
      }
    }
    const newest = fileStats.reduce((latest, file) => (file.mtime > (latest?.mtime ?? 0) ? file : latest), null);
    return {
      path: root,
      veins: veins.length,
      chambers: chambers.length,
      headings,
      links,
      tags: tagSet.size,
      ghosts: ghostsOf(docs).length,
      orphans: veins.filter((path) => !linked.has(path) && !hasOutbound.has(path)).length,
      bytes: fileStats.reduce((sum, file) => sum + (file.size ?? 0), 0),
      newest: newest ? { path: newest.path, mtime: newest.mtime } : null,
      treeVeins: countVeins(pruneMarkers(tree)),
    };
  }

  /* ── settings, colours, viewer state ─────────────────────────────────── */

  async function readSettings() {
    return mergeSettings(DEFAULT_SETTINGS, parseJson(await fs.read(metaPath(META_FILES.settings)), null));
  }

  async function updateSettings(patch, { record = true } = {}) {
    const next = mergeSettings(await readSettings(), patch);
    await writeMeta(META_FILES.settings, prettyJson(next), { label: 'settings', record });
    return next;
  }

  async function readColors() {
    return colorStore.parseColorSet(await fs.read(metaPath(META_FILES.colors)));
  }

  async function setColor(kind, parts, hex, { record = true } = {}) {
    if (!colorStore.KINDS.includes(kind)) throw new VaultPathError(`unknown colour kind: ${kind}`);
    const { colors, key } = colorStore.setColor(await readColors(), kind, parts, hex);
    await writeMeta(META_FILES.colors, colorStore.serializeColorSet(colors), {
      label: `colour ${kind} ${key}`,
      record,
    });
    return { kind, key, color: colorStore.assignedColor(colors, kind, parts) };
  }

  async function clearColor(kind, parts, { record = true } = {}) {
    const colors = colorStore.clearColor(await readColors(), kind, parts);
    await writeMeta(META_FILES.colors, colorStore.serializeColorSet(colors), {
      label: `reset ${kind} colour`,
      record,
    });
    return { kind, key: colorStore.colorKey(kind, parts), colors };
  }

  async function resetColors({ record = true } = {}) {
    const colors = colorStore.emptyColorSet();
    await writeMeta(META_FILES.colors, colorStore.serializeColorSet(colors), {
      label: 'reset all colours',
      record,
    });
    return colors;
  }

  /** The colour to paint for one target, defaults and inheritance included. */
  async function resolveColor(kind, parts) {
    const settings = await readSettings();
    const colors = await readColors();
    const { index: docs } = await index();
    const pageOverrides = {};
    for (const doc of docs) if (doc.color) pageOverrides[doc.path] = doc.color;
    return colorStore.resolveColor(colors, kind, parts, settings, pageOverrides);
  }

  /** Viewer state: last vein read, expanded chambers, panel widths. */
  async function readState() {
    return parseJson(await fs.read(metaPath(META_FILES.state)), {}) ?? {};
  }

  async function writeState(state) {
    // Viewer bookkeeping is never undoable, exactly like the window.
    return writeMeta(META_FILES.state, prettyJson(state), { label: 'viewer state', record: false });
  }

  /* ── cache housekeeping ──────────────────────────────────────────────── */

  async function indexCacheStatus() {
    const raw = await fs.read(metaPath(INDEX_FILE));
    const parsed = parseCache(raw);
    const { stats: fileStats } = await scan();
    let fresh = 0;
    for (const stat of fileStats) {
      const record = parsed.entries[stat.path];
      if (record && record.mtime === stat.mtime && record.size === stat.size) fresh += 1;
    }
    return {
      path: `${META_DIR}/${INDEX_FILE}`,
      bytes: raw ? raw.length : 0,
      version: parsed.version,
      entries: Object.keys(parsed.entries).length,
      veins: fileStats.length,
      fresh,
      stale: fileStats.length - fresh,
      present: raw !== null,
    };
  }

  async function dropIndexCache() {
    await fs.remove(metaPath(INDEX_FILE));
    invalidate();
    return { path: `${META_DIR}/${INDEX_FILE}`, dropped: true };
  }

  return {
    root,
    // identity and metadata
    ensureMeta,
    info,
    updateVaultMeta,
    readMeta,
    writeMeta,
    appendLog,
    logs,
    // documents
    readVein,
    statVein,
    writeVein,
    createVein,
    createChamber,
    deleteVein,
    renameVein,
    appendVein,
    upsertSection,
    // vault shape
    scan,
    veins: async () => (await scan()).veins,
    chambers: async () => (await scan()).chambers,
    /** The chamber/vein tree, with the `.keep` markers that registered empty
     *  chambers pruned out of it. */
    tree: async () => pruneMarkers((await scan()).tree),
    // index, search, graph
    buildIndex,
    index,
    invalidate,
    search,
    document,
    backlinks,
    resolveLink,
    ghosts,
    tags,
    graph,
    stats,
    indexCacheStatus,
    dropIndexCache,
    // settings, colours, state
    readSettings,
    updateSettings,
    readColors,
    setColor,
    clearColor,
    resetColors,
    resolveColor,
    readState,
    writeState,
    // history
    historyState,
    undo,
    redo,
    // helpers worth sharing
    listFiles,
    safePath,
    safeMetaName,
    /** Wiki links of one vein, as data. */
    async links(rel) {
      const path = safePath(rel);
      return parseWikiLinks(await readVein(path)).map((link) => ({
        target: link.target,
        section: link.section,
        alias: link.alias,
        embed: link.embed,
        samePage: link.samePage,
      }));
    },
  };
}
