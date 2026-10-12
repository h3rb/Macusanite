/**
 * What to do when the vault changes underneath the viewer.
 *
 * `src-tauri/src/watch.rs` watches the vault and emits `vault:changed` batches;
 * `backend.onVaultChange` delivers them here. This module is the pure half of
 * the answer — which paths matter, what a batch means for the open vein, and
 * which cached bodies have gone stale — so the decisions can be tested without
 * a filesystem or a window.
 *
 * The Rust side filters as well (it never reports `.macusanite` — except the two
 * files below — editor scratch files or its own writes); `isWatched` and
 * `isLiveMeta` mirror that rule so the same verdict holds wherever a batch comes
 * from, including the browser fallback.
 */
import { isMarkdown } from './path.js';

/** Editor scratch files: vim swaps, `~$` locks, emacs backups, our own temps. */
const SCRATCH = /(\.tmp|\.swp|\.swo|\.bak|\.orig|\.macusanite-tmp)$/i;

/**
 * Metadata the viewer follows live, as vault-relative paths.
 *
 * These two files are meant to be edited by hand — a theme tweak, a colour, a
 * panel width — so a change to one is applied to the window that is already
 * open. Everything else in `.macusanite` (the index cache, the viewer state,
 * the undo stacks, the session log) belongs to the viewer and stays quiet: those
 * are written constantly, and reacting to them would be a feedback loop.
 *
 * The list is exactly the one in `src-tauri/src/watch.rs`; the Rust filter
 * decides what reaches the frontend, and this decides what the frontend does
 * with it.
 */
export const LIVE_META = ['.macusanite/settings.json', '.macusanite/colors.json'];

/** The followed file a path names, or null. Spelling is not significant. */
function liveMeta(path) {
  if (!path) return null;
  const normalized = String(path).replace(/\\/g, '/').toLowerCase();
  const hit = LIVE_META.find((live) => live.toLowerCase() === normalized);
  return hit ? { path: hit, name: hit.slice('.macusanite/'.length, -'.json'.length) } : null;
}

/** The metadata file a path names, or null: `'settings'`, `'colors'`, `null`. */
export function liveMetaName(path) {
  return liveMeta(path)?.name ?? null;
}

/** True when a vault-relative path is followed metadata rather than a vein. */
export function isLiveMeta(path) {
  return liveMeta(path) !== null;
}

/**
 * The shape every metadata decision travels in: which files, and which of the
 * two flags matter.
 * @param {string[]} paths vault-relative paths of followed metadata
 */
export function metaPlan(paths = []) {
  return {
    paths,
    settings: paths.includes('.macusanite/settings.json'),
    colors: paths.includes('.macusanite/colors.json'),
  };
}

/**
 * Which of the followed metadata files a batch mentions.
 *
 * A file is reported once however many events mention it, and a path that is not
 * followed (the index cache, the log, another program's scratch file) is not
 * reported at all — that is what keeps the viewer's own bookkeeping silent.
 *
 * @param {Array<{path: string, kind: string}|string>} changes
 * @returns {{paths: string[], settings: boolean, colors: boolean}}
 */
export function metaChanges(changes = []) {
  const paths = [];
  for (const change of changes) {
    const found = liveMeta(typeof change === 'string' ? change : change?.path);
    if (found && !paths.includes(found.path)) paths.push(found.path);
  }
  return metaPlan(paths);
}

/**
 * True when a vault-relative path is something the viewer renders or indexes.
 * A markdown name is a vein, an extension-less name is a chamber, everything
 * else (a photo, an archive) is not part of the model.
 */
export function isWatched(path) {
  if (!path) return false;
  const parts = String(path).replace(/\\/g, '/').split('/').filter(Boolean);
  if (!parts.length) return false;
  if (parts.some((part) => part.startsWith('.'))) return false;
  const name = parts[parts.length - 1];
  if (name.startsWith('~$') || name.endsWith('~')) return false;
  if (SCRATCH.test(name)) return false;
  return isMarkdown(name) || !name.includes('.');
}

/**
 * Decide what a batch of external changes means.
 *
 * @param {object} input
 * @param {Array<{path: string, kind: string}|string>} input.changes
 * @param {string[]} input.veins    the vein list *after* re-reading the vault
 * @param {Record<string, string>} input.bodies the cache from before the change,
 *   which is how a vein that was never read before is told apart from an edit
 * @param {string[]|null} [input.indexed] paths the document index already
 *   describes. The viewer is lazy: a vein can be indexed without its text ever
 *   being held, so the index — not the body cache — is the honest answer to
 *   "have we seen this file?"
 */
export function planRefresh({ changes = [], veins = [], bodies = {}, indexed = null } = {}) {
  const known = new Set(veins);
  const seen = Array.isArray(indexed) ? new Set(indexed) : null;
  const isKnown = (path) => (seen ? seen.has(path) : typeof bodies?.[path] === 'string');
  const added = [];
  const relevant = [];
  const removed = [];
  const chambers = [];

  for (const change of changes) {
    const path = typeof change === 'string' ? change : change?.path;
    if (!isWatched(path)) continue;
    if (known.has(path)) {
      // It exists now, whatever the event claimed: re-reading is always right.
      const bucket = isKnown(path) ? relevant : added;
      if (!bucket.includes(path)) bucket.push(path);
    } else if (isMarkdown(path)) {
      if (!removed.includes(path)) removed.push(path);
    } else if (!chambers.includes(path)) {
      chambers.push(path);
    }
  }

  const touched = added.length + relevant.length + removed.length + chambers.length > 0;

  return { full: false, touched, treeChanged: touched, rereadAll: false, added, relevant, removed, chambers };
}

/*
 * A batch that says "re-read everything" — the watcher overflowed, or another
 * window is sharing this vault — is not planned from its own contents. Nothing
 * in it can be trusted, so the viewer walks the vault instead and lets the index
 * cache's freshness rule (mtime plus size) say what moved. That is also how an
 * idle ping from another window's bookkeeping is recognised as nothing at all:
 * the walk reports the same stats, so nothing is read and nothing is reported.
 */

/**
 * What to do with the open vein, once the changed bodies have been re-read.
 *
 * `none` — its text on disk is what is already on screen (or unreadable), so a
 * re-render would only cost the reader their scroll position. `keep-draft` — the
 * editor holds unsaved text, and unsaved text always wins over the disk.
 *
 * @param {object} input
 * @param {string|null} input.currentPath
 * @param {boolean} input.exists     the vein is still in the vault's vein list
 * @param {string|null} input.raw    the text the document was rendered from
 * @param {string|null} input.diskText the freshly read file, if it could be read
 * @param {boolean} input.dirty
 * @returns {'none'|'reload'|'keep-draft'|'removed'}
 */
export function currentOutcome({ currentPath = null, exists = true, raw = null, diskText = null, dirty = false } = {}) {
  if (!currentPath) return 'none';
  if (!exists) return 'removed';
  if (typeof diskText !== 'string' || diskText === raw) return 'none';
  return dirty ? 'keep-draft' : 'reload';
}

/** Which metadata files a batch carried, in words: `settings.json`, `colors.json`. */
export function describeMeta(paths = []) {
  const names = paths.map((path) => String(path).replace('.macusanite/', ''));
  if (!names.length) return 'Metadata edited outside the viewer';
  if (names.length === 1) {
    return `${names[0] === 'colors.json' ? 'Colours' : 'Settings'} edited outside the viewer — applied`;
  }
  return 'Settings and colours edited outside the viewer — applied';
}

/** One line for the toast and the session log that says what moved. */
export function describeRefresh(plan) {
  const parts = [];
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (plan.added?.length) parts.push(`${plural(plan.added.length, 'vein')} added`);
  if (plan.relevant?.length) parts.push(`${plural(plan.relevant.length, 'vein')} changed`);
  if (plan.removed?.length) parts.push(`${plan.removed.length} removed`);
  if (plan.chambers?.length) parts.push(plural(plan.chambers.length, 'chamber'));
  if (parts.length) return `Vault changed outside the viewer: ${parts.join(', ')}`;
  if (plan.rereadAll) return 'Vault changed outside the viewer — reloading';
  return 'Vault changed outside the viewer';
}

/** Cached body paths that no longer exist on disk. */
export function staleBodies(bodies, veins) {
  const known = new Set(veins);
  return Object.keys(bodies ?? {}).filter((path) => !known.has(path));
}
