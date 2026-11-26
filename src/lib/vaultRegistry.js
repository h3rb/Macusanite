/**
 * The vaults this installation knows about.
 *
 * The list lives outside every vault, because it is about the computer rather
 * than about one set of notes: `<CurrentUser>/Documents/macusanite/localstorage/
 * vaults.json` on the desktop (written by `src-tauri/src/appstore.rs`) and a
 * `localStorage` key in a plain browser. It is plain, pretty-printed JSON so a
 * reader can inspect or edit it by hand:
 *
 * ```json
 * {
 *   "version": 1,
 *   "vaults": [
 *     { "name": "Field Notes", "path": "C:\\Users\\you\\Documents\\Field Notes", "lastOpened": 1764150000000 }
 *   ]
 * }
 * ```
 *
 * Only the minimum is kept — folder path, display name, and when it was last
 * opened. Note content, settings and colours stay inside each vault's own
 * `.macusanite` folder. This module is pure: it parses, cleans, sorts and
 * serialises, and never touches a filesystem.
 */

/** File name inside the installation's local-storage folder. */
export const REGISTRY_FILE = 'vaults.json';

/** The record shape's version, so a future build can migrate old files. */
export const REGISTRY_VERSION = 1;

/** How many vaults the menu and the file remember. */
export const MAX_KNOWN_VAULTS = 12;

/** The folder's name segments, relative to the user's Documents folder. */
export const STORAGE_DIR = ['macusanite', 'localstorage'];

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The last segment of a path, used when a vault was recorded without a name. */
function lastSegment(path) {
  return String(path ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .pop() ?? '';
}

/**
 * Compare paths the way a vault identity should: separators unified, trailing
 * separators dropped, case folded. Windows paths are case-insensitive, and a
 * doubled entry for the same folder is never what anyone wants.
 */
export function pathKey(path) {
  return String(path ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** A brand-new, empty registry. */
export function emptyRegistry() {
  return { version: REGISTRY_VERSION, vaults: [] };
}

/** One cleaned entry, or null when the record is not usable. */
function cleanEntry(raw) {
  if (!isPlainObject(raw)) return null;
  const path = typeof raw.path === 'string' ? raw.path.trim() : '';
  if (!path) return null;
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : lastSegment(path);
  const lastOpened = Number.isFinite(raw.lastOpened) ? raw.lastOpened : 0;
  return { name, path, lastOpened };
}

/**
 * Read a registry from text, an object, or an array of entries. Anything
 * unreadable is an empty registry rather than an error: the file is a
 * convenience, and a damaged one must never stop a vault from opening.
 */
export function parseRegistry(raw) {
  let parsed = raw;
  if (typeof raw === 'string') {
    if (!raw.trim()) return emptyRegistry();
    try {
      parsed = JSON.parse(raw);
    } catch {
      return emptyRegistry();
    }
  }
  const list = Array.isArray(parsed) ? parsed : parsed?.vaults;
  if (!Array.isArray(list)) return emptyRegistry();

  const seen = new Set();
  const vaults = [];
  for (const item of list) {
    const entry = cleanEntry(item);
    if (!entry) continue;
    const key = pathKey(entry.path);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    vaults.push(entry);
  }
  vaults.sort((a, b) => b.lastOpened - a.lastOpened || a.name.localeCompare(b.name));
  return { version: REGISTRY_VERSION, vaults: vaults.slice(0, MAX_KNOWN_VAULTS) };
}

/** Pretty JSON with a trailing newline — a file meant to be read by people. */
export function serializeRegistry(registry) {
  return `${JSON.stringify(parseRegistry(registry), null, 2)}\n`;
}

/**
 * Put a vault at the front of the list, replacing any earlier entry for the
 * same folder, and keep the list bounded.
 */
export function rememberVault(registry, entry, { max = MAX_KNOWN_VAULTS } = {}) {
  const current = parseRegistry(registry);
  const next = cleanEntry(entry);
  if (!next) return current;
  const key = pathKey(next.path);
  const vaults = [next, ...current.vaults.filter((vault) => pathKey(vault.path) !== key)]
    .slice(0, Math.max(1, Math.floor(Number(max) || MAX_KNOWN_VAULTS)));
  return { version: REGISTRY_VERSION, vaults };
}

/**
 * Vaults a switch menu should offer: newest first, minus the one already open.
 */
export function knownVaults(registry, { current = null, limit = MAX_KNOWN_VAULTS } = {}) {
  const skip = current ? pathKey(current) : '';
  return parseRegistry(registry).vaults
    .filter((vault) => pathKey(vault.path) !== skip)
    .slice(0, Math.max(0, Math.floor(Number(limit) || MAX_KNOWN_VAULTS)));
}
