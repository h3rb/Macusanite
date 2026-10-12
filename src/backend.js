/**
 * The vault filesystem bridge.
 *
 * On the desktop the work is done by Rust (Tauri commands); in a plain browser
 * an in-memory vault backed by `localStorage` implements the exact same command
 * surface, so the whole UI — and its tests — run without Tauri.
 */
import { normalize, join, dirname, basename, isMarkdown, stem, titleFromPath } from './lib/path.js';
import { buildTree } from './lib/tree.js';
import { mergeSettings, mergeVaultMeta, DEFAULT_SETTINGS, DEFAULT_VAULT_META } from './lib/settings.js';
import { sampleVaultFiles, SAMPLE_VAULT_NAME } from './lib/fixtures.js';

const META_DIR = '.macusanite';
const tauriCore = globalThis.__TAURI__?.core ?? globalThis.__TAURI__ ?? null;
const invokeRaw = typeof tauriCore?.invoke === 'function' ? tauriCore.invoke.bind(tauriCore) : null;

/** True when running inside the Tauri shell with a real filesystem. */
export const isDesktop = invokeRaw !== null;

/* ------------------------------------------------------------------ */
/* Browser fallback: an in-memory vault with the same command surface */
/* ------------------------------------------------------------------ */

const STORAGE_KEY = 'macusanite.virtual-vault.v1';

class VirtualVault {
  constructor() {
    this.files = new Map();
    this.history = { undo: [], redo: [] };
    this.logs = [];
    this.load();
  }

  load() {
    try {
      const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        this.files = new Map(Object.entries(parsed.files ?? {}));
        this.mtimes = parsed.mtimes ?? {};
        this.history = parsed.history ?? { undo: [], redo: [] };
        this.logs = parsed.logs ?? [];
        if (this.files.size) return;
      }
    } catch {
      /* corrupt storage: fall through to a fresh sample vault */
    }
    this.reset();
  }

  reset() {
    this.files = new Map(Object.entries(sampleVaultFiles()));
    // Every file is "written" now, which is enough to tell a reload apart from
    // a fresh vault without pretending to be a filesystem.
    const now = Date.now();
    this.mtimes = Object.fromEntries([...this.files.keys()].map((path, i) => [path, now + i]));
    this.history = { undo: [], redo: [] };
    this.logs = [];
    this.persist();
  }

  persist() {
    try {
      globalThis.localStorage?.setItem(
        STORAGE_KEY,
        JSON.stringify({
          files: Object.fromEntries(this.files),
          mtimes: this.mtimes ?? {},
          history: this.history,
          logs: this.logs.slice(-200),
        }),
      );
    } catch {
      /* storage full or disabled — the session still works in memory */
    }
  }

  read(rel, fallback = null) {
    const path = normalize(rel);
    return this.files.has(path) ? this.files.get(path) : fallback;
  }

  /**
   * Modification time and size of a virtual vein, shaped like the Rust
   * `FileStat` so the viewer's index cache works the same in both worlds. The
   * stamps live in storage beside the files, which is what makes a reload of
   * this page behave like reopening a real vault.
   */
  stat(rel) {
    const path = normalize(rel);
    const text = this.files.get(path) ?? '';
    // A file stored before the stamps existed is stamped now, once, and the
    // stamp survives in storage: that is what makes the next reload look like
    // reopening a vault whose files have not been touched.
    if (this.mtimes?.[path] === undefined) {
      this.mtimes = { ...(this.mtimes ?? {}), [path]: Date.now() };
      this.persist();
    }
    return { path, mtime: this.mtimes[path], size: text.length };
  }

  write(rel, text, label) {
    const path = normalize(rel);
    const before = this.read(path);
    this.files.set(path, text);
    this.mtimes = { ...(this.mtimes ?? {}), [path]: Date.now() };
    this.record({ path, before, after: text, label: label ?? `write ${path}` });
    this.persist();
    return { path };
  }

  record(entry) {
    // Any new change invalidates the redo branch (the Rust side does the same).
    this.history.redo = [];
    this.history.undo.push({ ...entry, ts: Date.now() });
    if (this.history.undo.length > 400) this.history.undo.shift();
    this.persist();
  }

  meta(name, fallback) {
    return this.read(join(META_DIR, name), fallback);
  }

  writeMeta(name, text, label) {
    return this.write(join(META_DIR, name), text, label ?? `update ${name}`);
  }
}

const virtual = new VirtualVault();

/** Commands the fallback understands, mirroring the Rust command names. */
const fallbackCommands = {
  async open_vault({ vault }) {
    if (!virtual.files.size) virtual.reset();
    return { path: normalize(vault || '/sample-vault'), ...readVaultMeta() };
  },
  async startup_vault() {
    // The browser fallback has no command line: it always starts with the
    // bundled sample vault.
    return null;
  },
  async create_vault({ vault, name, description }) {
    virtual.reset();
    const meta = {
      ...DEFAULT_VAULT_META,
      name: name || SAMPLE_VAULT_NAME,
      description: description ?? '',
      created: new Date().toISOString(),
    };
    virtual.write(join(META_DIR, 'vault.json'), JSON.stringify(meta, null, 2), 'create vault');
    return { path: normalize(vault || '/sample-vault'), ...meta, settings: DEFAULT_SETTINGS };
  },
  async vault_scan() {
    // `.keep` markers let the browser fallback represent an empty chamber.
    const keepMarkers = [...virtual.files.keys()].filter((p) => p === '.keep' || p.endsWith('/.keep'));
    const veins = veinPaths();
    return {
      tree: pruneKeepMarkers(buildTree([...veins, ...keepMarkers])),
      veins,
      stats: veins.map((path) => virtual.stat(path)),
    };
  },
  async vault_stat({ rel }) {
    return virtual.stat(normalize(rel));
  },
  async vault_tree() {
    const scan = await fallbackCommands.vault_scan({});
    return scan.tree;
  },
  async list_veins() {
    return veinPaths();
  },
  async read_vein({ rel }) {
    const text = virtual.read(rel);
    if (text === null) throw new Error(`vein not found: ${rel}`);
    return text;
  },
  async write_vein({ rel, contents, label }) {
    return virtual.write(rel, contents, label ?? `edit ${rel}`);
  },
  async create_vein({ rel, contents }) {
    const path = normalize(rel.endsWith('.md') ? rel : `${rel}.md`);
    if (virtual.files.has(path)) return { path, created: false };
    virtual.write(path, contents || `# ${titleFromPath(path)}\n\n`, 'create vein');
    return { path, created: true };
  },
  async create_chamber({ rel }) {
    const path = normalize(rel);
    const marker = join(path, '.keep');
    if (!virtual.files.has(marker)) virtual.write(marker, '', 'create chamber');
    return { path, created: true };
  },
  async read_meta({ name }) {
    return virtual.meta(name, null);
  },
  async write_meta({ name, contents, label, record }) {
    const path = join(META_DIR, name);
    const before = virtual.read(path);
    virtual.files.set(path, contents);
    virtual.persist();
    if (record !== false) virtual.record({ path, before, after: contents, label: label ?? `update ${name}` });
    return { path };
  },
  async append_log({ level, message }) {
    virtual.logs.push({ ts: new Date().toISOString(), level, message });
    virtual.persist();
    return null;
  },
  async history_state() {
    return historyState();
  },
  async history_undo() {
    const entry = virtual.history.undo.pop();
    if (!entry) return { applied: false, stacks: historyState() };
    if (entry.before === null) virtual.files.delete(entry.path);
    else virtual.files.set(entry.path, entry.before);
    virtual.history.redo.push(entry);
    virtual.persist();
    return { applied: true, path: entry.path, label: entry.label, stacks: historyState() };
  },
  async history_redo() {
    const entry = virtual.history.redo.pop();
    if (!entry) return { applied: false, stacks: historyState() };
    virtual.files.set(entry.path, entry.after);
    virtual.history.undo.push(entry);
    virtual.persist();
    return { applied: true, path: entry.path, label: entry.label, stacks: historyState() };
  },
  async pick_folder() {
    // Browsers cannot hand back a real directory path; the UI substitutes the
    // bundled sample vault so the fallback stays useful for design work.
    return '/sample-vault';
  },
  async reveal_meta() {
    return `${META_DIR}/`;
  },
  async open_external({ url }) {
    globalThis.open?.(url, '_blank', 'noopener');
    return null;
  },
  async quit_app() {
    globalThis.close?.();
    return null;
  },
  async open_help_window({ theme }) {
    // The browser has no second OS window to build, so it opens a tab instead.
    // `help.html` is the same page the desktop window loads. A browser only
    // allows this from a real user gesture, so the UI calls window.open itself
    // (see `openHelpWindow` in src/main.js) and this path is for programmatic use.
    const opened = globalThis.open?.(helpWindowUrl(theme), 'macusanite-help', HELP_WINDOW_FEATURES);
    if (!opened) throw new Error('the browser blocked the new window — open help.html directly');
    return helpWindowUrl(theme);
  },
};

function veinPaths() {
  return [...virtual.files.keys()].filter((p) => isMarkdown(p) && !p.startsWith(`${META_DIR}/`)).sort();
}

/** Drop `.keep` placeholders from a tree while keeping their chambers. */
function pruneKeepMarkers(nodes) {
  return nodes
    .filter((node) => node.name !== '.keep')
    .map((node) => (node.children?.length ? { ...node, children: pruneKeepMarkers(node.children) } : node));
}

function historyState() {
  const brief = (e) => ({ path: e.path, label: e.label, ts: e.ts });
  // Newest first, matching the Rust side, so `undo[0]` is what Ctrl+Z would do.
  return {
    undo: [...virtual.history.undo].reverse().map(brief),
    redo: [...virtual.history.redo].reverse().map(brief),
  };
}

function readVaultMeta() {
  const metaRaw = virtual.meta('vault.json', null);
  const settingsRaw = virtual.meta('settings.json', null);
  const colorsRaw = virtual.meta('colors.json', null);
  let meta = DEFAULT_VAULT_META;
  let settings = DEFAULT_SETTINGS;
  let colors = { pages: {}, links: {}, sections: {}, concepts: {} };
  try {
    if (metaRaw) meta = mergeVaultMeta(JSON.parse(metaRaw));
  } catch { /* keep defaults */ }
  try {
    if (settingsRaw) settings = mergeSettings(DEFAULT_SETTINGS, JSON.parse(settingsRaw));
  } catch { /* keep defaults */ }
  try {
    if (colorsRaw) colors = { pages: {}, links: {}, sections: {}, concepts: {}, ...JSON.parse(colorsRaw) };
  } catch { /* keep defaults */ }
  return { ...meta, settings, colors };
}

/* ------------------------------------------------------------------ */
/* Public bridge                                                       */
/* ------------------------------------------------------------------ */

async function invoke(command, args = {}) {
  if (invokeRaw) {
    try {
      return await invokeRaw(command, args);
    } catch (error) {
      const message = typeof error === 'string' ? error : (error?.message ?? String(error));
      log('error', `${command} failed: ${message}`);
      throw new Error(message);
    }
  }
  const impl = fallbackCommands[command];
  if (!impl) throw new Error(`no fallback for command ${command}`);
  return impl(args);
}

/**
 * Follow changes made to the vault outside the viewer.
 *
 * The Rust watcher (src-tauri/src/watch.rs) emits one `vault:changed` batch per
 * burst of filesystem events: `{ changes: [{ path, kind }], full }`, where
 * `full` means the watcher missed events and everything should be re-read.
 *
 * A plain browser has no watcher and gets no substitute. Watching the shared
 * localStorage key would look tempting, but two tabs both hold a whole snapshot
 * of the virtual vault and each write replaces all of it, so "the other tab
 * changed something" is indistinguishable from "the other tab is stale" — and
 * reacting to it would clobber whichever tab is behind.
 *
 * @param {(payload: {changes?: Array<{path: string, kind: string}>, full?: boolean}) => void} handler
 * @returns {(() => void)|null} stop listening, or null where nothing is watching
 */
export function onVaultChange(handler) {
  const events = globalThis.__TAURI__?.event;
  if (typeof events?.listen !== 'function') return null;

  let unlisten = null;
  let stopped = false;
  events
    .listen('vault:changed', (event) => handler(event?.payload ?? {}))
    .then((off) => {
      // The subscription may resolve after the caller gave up on it.
      if (stopped) off();
      else unlisten = off;
    })
    .catch((error) => console.warn('[macusanite] vault watching unavailable:', error));

  return () => {
    stopped = true;
    unlisten?.();
    unlisten = null;
  };
}

/** Best-effort logging: never let a log failure break a user action. */
export async function log(level, message) {
  try {
    await invoke('append_log', { level, message });
  } catch {
    if (level === 'error') console.error('[macusanite]', message);
  }
}

export const backend = {
  isDesktop,

  openVault: (path) => invoke('open_vault', { vault: path }),
  startupVault: () => invoke('startup_vault', {}),
  createVault: (path, name, description) => invoke('create_vault', { vault: path, name, description }),
  /** One walk of the vault: the tree, the vein list and each vein's stat. */
  scan: () => invoke('vault_scan', {}),
  tree: () => invoke('vault_tree', {}),
  veins: () => invoke('list_veins', {}),
  stat: (rel) => invoke('vault_stat', { rel }),
  readVein: (rel) => invoke('read_vein', { rel }),
  writeVein: (rel, contents, label) => invoke('write_vein', { rel, contents, label: label ?? null }),
  createVein: (rel, contents) => invoke('create_vein', { rel, contents: contents ?? null }),
  createChamber: (rel) => invoke('create_chamber', { rel }),
  readMeta: (name) => invoke('read_meta', { name }),
  writeMeta: (name, contents, label, record = true) => invoke('write_meta', {
    name,
    contents,
    label: label ?? null,
    record,
  }),
  reveal: () => invoke('reveal_meta', {}),
  openExternal: (url) => invoke('open_external', { url }),
  /** The manual, in its own window (the theme is passed because it has no vault). */
  openHelpWindow: (theme) => invoke('open_help_window', { theme: theme ?? null }),
  history: () => invoke('history_state', {}),
  undo: () => invoke('history_undo', {}),
  redo: () => invoke('history_redo', {}),
  pickFolder: () => invoke('pick_folder', {}),
  quit: () => invoke('quit_app', {}),
  onVaultChange,
  log,
};

/** The manual's page. Shared by the desktop command and the browser fallback. */
export function helpWindowUrl(theme = null) {
  return theme === 'light' || theme === 'dark' ? `help.html?theme=${theme}` : 'help.html';
}

export const HELP_WINDOW_FEATURES = 'width=1080,height=820,noopener';

/** Meta file names in `<vault>/.macusanite/`. */
export const META = {
  dir: META_DIR,
  vault: 'vault.json',
  settings: 'settings.json',
  colors: 'colors.json',
  history: 'history.json',
  state: 'state.json',
  // The document index cache: per-file headings, links and tags, keyed by stat.
  index: 'index.json',
};

export { virtual as virtualVault, basename, dirname, stem };
