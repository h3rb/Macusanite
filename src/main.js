/**
 * Macusanite application controller.
 *
 * Owns the state object, talks to the Rust backend through `backend.js`, and
 * hands rendering off to the UI modules. Everything the UI needs is exposed on
 * the `app` object below.
 */
import mermaid from 'mermaid';
import wikiDoc from '../Wiki.md?raw';

import { backend, isDesktop, META, onVaultChange, helpWindowUrl, HELP_WINDOW_FEATURES } from './backend.js';
import { NavHistory } from './lib/history.js';
import { LIVE_META, isWatched, isLiveMeta, metaChanges, metaPlan, planRefresh, currentOutcome, describeRefresh, describeMeta, staleBodies } from './lib/watch.js';
import { mergeVein, hasMergeMarkers, countConflicts, describeMerge } from './lib/merge.js';
import { tokenize, plainText, buildSearchCorpus, searchVault } from './lib/search.js';
import { mergeSettings, mergeVaultMeta, rememberColor, DEFAULT_SETTINGS } from './lib/settings.js';
import * as colorStore from './lib/colorStore.js';
import { buildDocumentIndex } from './lib/graph.js';
import { parseCache, serializeCache, cacheRecord, planIndex, stubEntry, createIndex, isStub } from './lib/indexCache.js';
import { parseFrontmatter, documentMeta } from './lib/frontmatter.js';
import { resolveTarget } from './lib/wikilinks.js';
import { dirname, join, basename, titleFromPath, slugify, isMarkdown } from './lib/path.js';
import { ancestorPaths } from './lib/tree.js';
import { el, qs, createToaster, askText } from './ui/dom.js';
import { createChrome } from './ui/chrome.js';
import { createSidebar } from './ui/sidebar.js';
import { createViewer } from './ui/viewer.js';
import { createGraphPanel } from './ui/graphPanel.js';
import { createColorPicker } from './ui/colorpicker.js';
import { createSettingsDialog } from './ui/settingsDialog.js';
import { askMerge } from './ui/mergeDialog.js';
import { createSearchPanel } from './ui/searchPanel.js';
import { createResizers } from './ui/resizer.js';

const LAST_VAULT_KEY = 'macusanite.lastVault';
const SYNTAX_GUIDE_PATH = 'Macusanite Wiki.md';
// Veins read per turn of the lazy index pass, and per turn of the search read.
// Small enough that a keystroke or a click never waits behind one.
const INDEX_CHUNK = 24;
const SEARCH_CHUNK = 24;
// The cache is written this long after the last entry changed, and at least
// every this many chunks while a long pass is still running.
const INDEX_WRITE_DELAY_MS = 1200;
const INDEX_FLUSH_EVERY = 20;
const NEW_VEIN_TEMPLATE = (title) => `---\ntitle: ${title}\n---\n# ${title}\n\n`;

/* ── state ────────────────────────────────────────────────────────────── */

const state = {
  vault: null,
  tree: [],
  veins: [],
  bodies: {},
  index: [],
  // How much of the vault the document index describes so far. `indexed`
  // counts real entries; the rest are stubs waiting for a read.
  indexing: { total: 0, indexed: 0, status: 'idle', read: 0, pending: 0 },
  settings: structuredClone(DEFAULT_SETTINGS),
  colors: colorStore.emptyColorSet(),
  // An external edit the unsaved draft has not answered yet: `{ path, theirs }`.
  // While it is set, autosave holds back — see `scheduleAutosave`.
  clash: null,
  current: null,
  draft: '',
  dirty: false,
  nav: new NavHistory(),
  undoStack: [],
  redoStack: [],
  virtualDocs: { [SYNTAX_GUIDE_PATH]: wikiDoc },
  ui: {
    mode: 'read',
    filter: '',
    expanded: {},
    menuOpen: false,
    ready: false,
    // True while the vault is followed on disk (see app.watchVault).
    watching: false,
    // Which sidebar pane is showing: 'tree' (the vault) or 'search'.
    pane: 'tree',
  },
  search: {
    query: '',
    terms: [],
    results: [],
    total: 0,
    scanned: 0,
    activeIndex: 0,
    // Hits on the page currently open, and which of them is highlighted.
    hits: 0,
    hitIndex: 0,
    // Progress of the background read that gives search every vein's text, or
    // null when nothing is being read.
    reading: null,
  },
};

const root = qs('#app');
let toaster;
let chrome;
let sidebar;
let viewer;
let graphPanel;
let colorPicker;
let settingsDialog;
let resizers;
let pageOverrides = {};
// The live document index. `state.index` is this list, so replacing an entry
// mutates the array the UI already holds.
let indexStore = createIndex([]);
// path -> {mtime, size} from the last walk of the vault: the freshness check for
// every cached entry, and the stat a new entry is recorded against.
let indexStats = new Map();
// path -> {mtime, size, entry}, the file that goes into `.macusanite/index.json`.
let cacheRecords = {};
// Background indexing passes are cancellable: only the newest id may write.
let indexPassId = 0;
let cacheTimer = null;
let searchHydrationId = 0;
let searchHydrating = false;
let corpusByPath = null;
let autosaveTimer = null;
let graphTimer = null;
let stateTimer = null;
let unwatchVault = null;
let searchPanel;
// The corpus (every vein, reduced to plain text) is expensive to rebuild and
// only changes when the index does.
let searchCorpus = null;
// External batches are applied one at a time: a burst must not interleave two
// half-finished refreshes of the tree, the index and the open document.
const externalQueue = [];
let externalBusy = false;

// Metadata files whose external change arrived while a write of ours was still
// on its way. Applied the moment that write lands. See `applyExternalMeta`.
const deferredMeta = new Set();

// How long an unanswered merge offer holds autosave back. Matched to the offer's
// own time on screen: while the button is there the clash is live, and when the
// offer goes away the clock takes over again rather than leaving the draft unsaved
// for as long as the reader happens to be away from the keyboard.
const CLASH_WINDOW_MS = 15_000;
let clashTimer = null;

/* ── helpers ──────────────────────────────────────────────────────────── */

const debounce = (fn, delay) => {
  let timer = null;
  let running = false;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      timer = null;
      running = true;
      try {
        await fn(...args);
      } finally {
        running = false;
      }
    }, delay);
  };
  /**
   * True while a call is waiting out the delay or actually running.
   *
   * The metadata files are watched, so this is how the viewer knows that a
   * change it can see on disk is its own write still on its way — see
   * `applyExternalMeta`.
   */
  wrapped.pending = () => timer !== null || running;
  return wrapped;
};

const readMetaJson = async (name, fallback = null) => {
  const raw = await backend.readMeta(name);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
};

/* ── the app object ───────────────────────────────────────────────────── */

const app = {
  state,
  backend,
  mermaid,
  isDesktop,

  /* ---------------------------------------------------------- booting -- */

  async init() {
    toaster = createToaster(qs('#toasts'));
    chrome = createChrome({ app, root });
    sidebar = createSidebar({ app, root: qs('#sidebar') });
    viewer = createViewer({ app, root: qs('#viewer') });
    graphPanel = createGraphPanel({ app, root: qs('#graph-panel') });
    searchPanel = createSearchPanel({ app, root: qs('#search-pane') });
    colorPicker = createColorPicker({ app, root });
    settingsDialog = createSettingsDialog({ app });
    resizers = createResizers({ app, root });

    app.configureMermaid();
    wireGlobalEvents();

    state.ui.ready = true;
    root.dataset.booting = 'false';
    viewer.renderEmpty();
    chrome.render();
    sidebar.render();

    // Precedence: a vault named on the command line, then the last vault opened
    // in this installation, then (in a plain browser) the sample vault.
    let initial = null;
    if (isDesktop) {
      try {
        const fromCli = await backend.startupVault();
        initial = fromCli?.path ?? readLastVault();
      } catch (error) {
        await backend.log('warn', `startup_vault failed: ${error.message}`);
        initial = readLastVault();
      }
    } else {
      initial = '/sample-vault';
    }

    // `?novault=1` skips auto-open: handy for looking at (and testing) the
    // empty state without clearing storage.
    if (new URLSearchParams(location.search).get('novault') === '1') initial = null;

    if (initial) {
      try {
        await app.openVault(initial, { silent: true });
      } catch (error) {
        app.toast(`Could not reopen ${initial}: ${error.message}`, 'warn');
        await backend.log('warn', `auto-open failed: ${error.message}`);
      }
    }
  },

  configureMermaid() {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'loose',
      theme: state.settings.theme === 'light' ? 'default' : 'dark',
      fontFamily: '"Segoe UI", system-ui, sans-serif',
      themeVariables: { fontSize: '12px' },
      flowchart: { useMaxWidth: true },
      sequence: { useMaxWidth: true },
    });
  },

  async quit() {
    await backend.log('info', 'viewer exit requested');
    await backend.quit();
  },

  /* ------------------------------------------------------------ vault -- */

  async openVault(path, options = {}) {
    const openedAt = now();
    const info = await backend.openVault(path);
    state.vault = {
      path: info.path ?? path,
      name: info.name ?? 'Untitled Vault',
      description: info.description ?? '',
      created: info.created ?? null,
    };
    state.settings = mergeSettings(DEFAULT_SETTINGS, info.settings);
    state.colors = colorStore.cloneColorSet(info.colors);
    state.ui.expanded = {};
    app.configureMermaid();
    applyTheme();
    applyLayout();

    // A different vault: nothing cached from the last one applies, and a search
    // read that is still running is told so by moving its id on.
    state.bodies = {};
    state.current = null;
    searchCorpus = null;
    corpusByPath = null;
    searchHydrating = false;
    searchHydrationId += 1;
    state.search.reading = null;

    // The viewer's own bookkeeping first — it names the vein to land in, which
    // is also the one the index pass should read first.
    const saved = await readMetaJson(META.state, null);
    state.nav = NavHistory.fromJSON(saved?.nav ?? null);
    if (saved?.ui?.expanded) state.ui.expanded = { ...saved.ui.expanded };
    if (saved?.ui?.mode === 'edit') state.ui.mode = 'edit';
    if (saved?.ui?.pane === 'search') app.setPane('search');

    // One walk of the vault and one cache file: no vein has been opened yet, so
    // the tree, the graph and every wiki link are already available.
    const scan = await refreshScan();
    const target = pickStartVein(scan.veins, saved);
    const cache = parseCache(await backend.readMeta(META.index));
    const plan = planIndex({ stats: scan.stats ?? [], cache, priority: target });
    adoptIndex(plan, cache);
    state.indexing = {
      total: plan.index.length,
      indexed: indexStore.indexed,
      status: plan.toRead.length ? 'indexing' : 'ready',
      read: 0,
      pending: plan.toRead.length,
    };

    if (target) await app.openPath(target, { fromState: true });
    else {
      state.current = null;
      viewer.renderEmpty();
      chrome.render();
      sidebar.render();
      graphPanel.render();
    }

    writeLastVault(state.vault.path);
    app.watchVault();
    const fromCache = plan.index.length - plan.toRead.length;
    await backend.log(
      'info',
      `vault opened: ${state.vault.path} in ${Math.round(now() - openedAt)} ms — ${state.veins.length} veins, ${fromCache} from the index cache, ${plan.toRead.length} to read`,
    );
    if (!options.silent) {
      app.toast(`Opened “${state.vault.name}” — ${state.veins.length} veins${fromCache ? `, ${fromCache} already indexed` : ''}`, 'ok');
    }

    // Whatever the cache could not describe is read in the background.
    app.startIndexPass(plan);
  },

  /**
   * Re-read the vault from disk. One walk: the tree, the vein list and every
   * vein's stat. Bodies are not touched — a vein is read when it is needed.
   * @param {{tree?: boolean, index?: boolean}|true} [options]
   */
  async reloadVault(options = {}) {
    if (!state.vault) return;
    const opts = options === true ? { tree: true, index: true } : options;
    if (opts.tree !== false) {
      const scan = await refreshScan();
      // Keep the index in step with the vein list: a vein that appeared is a
      // stub until something reads it, and one that vanished takes its cached
      // entry with it.
      const known = new Set(indexStore.list.map((entry) => entry.path));
      for (const path of scan.veins) if (!known.has(path)) indexStore.replace(stubEntry(path));
      const gone = indexStore.list.filter((entry) => !scan.veins.includes(entry.path)).map((entry) => entry.path);
      if (gone.length) forgetPaths(gone);
      state.indexing = { ...state.indexing, total: indexStore.total, indexed: indexStore.indexed };
      invalidateSearch();
      sidebar?.render();
      if (opts.index) app.startIndexPass();
    } else if (opts.index) {
      app.startIndexPass();
    }
  },

  /* ---------------------------------------------------------- the index --
   * A vault is opened by describing it, not by reading it. The walk above says
   * which veins exist and when each last changed; `.macusanite/index.json` says
   * what every unchanged vein contains (its headings, links, tags and colours),
   * so only what moved is ever opened — here in the background, a chunk at a
   * time, so the window is usable throughout.
   */

  /**
   * Index what the cache could not describe yet.
   * @param {object|null} [plan] from {@link planIndex}; one is worked out when
   *   omitted, which is what a reload wants
   */
  startIndexPass(plan = null) {
    const pass = plan ?? planIndexNow(state.current?.path ?? null);
    const id = ++indexPassId;
    if (pass.removed.length) forgetPaths(pass.removed);

    // The plan may predate the open document, which indexes itself as it
    // renders: a vein whose cache record is fresh again is already described.
    const pending = pass.toRead.filter((path) => !cacheIsFresh(path));
    state.indexing = {
      total: indexStore.total,
      indexed: indexStore.indexed,
      status: pending.length ? 'indexing' : 'ready',
      read: 0,
      pending: pending.length,
    };
    sidebar?.render();

    if (!pending.length) {
      // Every vein came straight from the cache: nothing to read, and the file
      // on disk already says so.
      invalidateSearch();
      graphPanel?.render();
      return;
    }

    (async () => {
      const started = now();
      let read = 0;
      try {
        for (let i = 0; i < pending.length; i += INDEX_CHUNK) {
          if (indexPassId !== id) return; // superseded by a newer pass
          const slice = pending.slice(i, i + INDEX_CHUNK);
          await Promise.all(slice.map((path) => indexPath(path)));
          read += slice.length;
          state.indexing = { total: indexStore.total, indexed: indexStore.indexed, status: 'indexing', read, pending: pending.length };
          // A vault big enough to take a while gets its cache written as it
          // goes, so quitting in the middle does not throw the work away.
          if (read % (INDEX_CHUNK * INDEX_FLUSH_EVERY) === 0) await app.persistIndexCache();
          else app.scheduleIndexPersist();
          scheduleLiveRefresh();
          sidebar?.render();
          await yieldToUi();
        }
      } catch (error) {
        await backend.log('warn', `indexing stopped early: ${error.message}`);
      }
      if (indexPassId !== id) return;
      state.indexing = { total: indexStore.total, indexed: indexStore.indexed, status: 'ready', read, pending: pending.length };
      sidebar?.render();
      await app.persistIndexCache();
      await backend.log(
        'info',
        `indexed ${read} vein${read === 1 ? '' : 's'} in ${Math.round(now() - started)} ms (${indexStore.indexed}/${indexStore.total} described)`,
      );
      invalidateSearch();
      graphPanel?.render();
    })();
  },

  /** Re-index veins the viewer itself just wrote, from text it already has. */
  async reindex(paths, options = {}) {
    for (const path of [].concat(paths)) {
      if (!path) continue;
      // Our own write moved the file, so the stat the walk produced is stale.
      const stat = await safeStat(path);
      if (stat) indexStats.set(path, stat);
      await indexPath(path, { ...options, stat: stat ?? undefined });
    }
    app.scheduleIndexPersist();
    scheduleLiveRefresh();
    invalidateSearch();
  },

  /** Write `.macusanite/index.json`, a little after the last change. */
  scheduleIndexPersist() {
    clearTimeout(cacheTimer);
    cacheTimer = setTimeout(() => app.persistIndexCache(), INDEX_WRITE_DELAY_MS);
  },

  async persistIndexCache() {
    clearTimeout(cacheTimer);
    cacheTimer = null;
    if (!state.vault) return;
    const known = new Set(state.veins);
    const entries = {};
    for (const [path, record] of Object.entries(cacheRecords)) {
      // A stub is not worth caching, and a vein that is gone is not worth
      // keeping: the file is a description of *this* vault. An mtime of 0 is
      // kept, because that is what a platform that will not report one gives —
      // the size still has to match for the entry to count as fresh.
      if (!known.has(path) || !record?.entry || isStub(record.entry)) continue;
      entries[path] = record;
    }
    cacheRecords = entries;
    try {
      // `record: false`: the cache is bookkeeping, not an edit to undo.
      await backend.writeMeta(META.index, serializeCache(entries, { generated: new Date().toISOString() }), 'index cache', false);
    } catch (error) {
      await backend.log('warn', `could not write the index cache: ${error.message}`);
    }
  },

  /* ------------------------------------------------------- live vault --
   * The Rust side re-arms its watcher whenever a vault is opened; this only
   * manages the frontend subscription. In a plain browser the same hook fires
   * when another tab edits the shared virtual vault.
   */

  watchVault() {
    app.stopWatching();
    if (!state.vault) return;
    try {
      const off = onVaultChange((payload) => {
        app.applyExternalChanges(payload);
      });
      // A plain browser has no filesystem watcher to subscribe to.
      unwatchVault = typeof off === 'function' ? off : null;
      state.ui.watching = unwatchVault !== null;
    } catch (error) {
      state.ui.watching = false;
      backend.log('warn', `could not watch the vault: ${error?.message ?? error}`);
    }
    chrome?.renderIdentity();
  },

  stopWatching() {
    try {
      unwatchVault?.();
    } catch {
      /* the window is going away anyway */
    }
    unwatchVault = null;
    state.ui.watching = false;
  },

  /**
   * React to changes made outside the viewer: the tree, the document index and
   * the graph all catch up without a reload. Batches queue, so a burst of
   * filesystem events cannot interleave two refreshes.
   */
  async applyExternalChanges(payload) {
    if (!state.vault) return;
    externalQueue.push(payload ?? {});
    if (externalBusy) return;
    externalBusy = true;
    try {
      while (externalQueue.length) {
        await applyExternalBatch(externalQueue.shift());
      }
    } catch (error) {
      await backend.log('warn', `external change refresh failed: ${error.message}`);
    } finally {
      externalBusy = false;
    }
  },

  /* ------------------------------------------------------- live metadata --
   * `settings.json` and `colors.json` are made to be edited by hand, so the
   * watcher follows them and this puts a hand-edit into the window that is
   * already open. Everything else in `.macusanite` stays the viewer's own.
   */

  /**
   * Apply metadata edited outside the viewer.
   *
   * Each file is re-read, spread over the defaults and re-rendered: the theme and
   * font size, the panel widths, every colour swatch and graph edge, the graph's
   * own options, and the settings dialog if it is on screen. Nothing is written
   * back and nothing enters the undo stack — reading a file is not an edit.
   *
   * The viewer's own writes are the awkward case: a save of ours would otherwise
   * come back as "changed outside the viewer" and be re-applied over the change
   * that was just made. So a write that is scheduled or in flight wins, and the
   * external change is applied when that write lands ({@link flushDeferredMeta}).
   *
   * @param {string[]} paths vault-relative paths, as `metaChanges` reports them
   * @returns {Promise<string[]>} the files that actually said something new
   */
  async applyExternalMeta(paths = []) {
    const applied = [];
    for (const path of paths) {
      const name = path.split('/').pop();
      if (!isLiveMeta(path)) continue;
      if (app.metaWritePending(name)) {
        deferredMeta.add(name);
        continue;
      }
      if (await applyMetaFromDisk(name)) applied.push(path);
    }
    if (applied.length) {
      await backend.log('info', `applied from disk (edited outside the viewer): ${applied.join(', ')}`);
    }
    return applied;
  },

  /** Is a write of ours to this metadata file scheduled or in flight? */
  metaWritePending(name) {
    if (name === META.settings) return app.persistSettings.pending();
    if (name === META.colors) return app.persistColors.pending();
    return false;
  },

  /**
   * A metadata write of ours has landed: if the file changed while it was on its
   * way, that change is someone else's and is applied now.
   */
  async flushDeferredMeta(name) {
    if (!deferredMeta.delete(name)) return;
    const applied = await app.applyExternalMeta([`.macusanite/${name}`]);
    if (applied.length) app.toast(describeMeta(applied), 'info', 4200);
  },

  /* -------------------------------------------------------------- search --
   * Vault-wide search shares the sidebar with the tree: results are a place you
   * read *from*, so the reader keeps them (and their hits) while following a
   * result into the document.
   */

  /** Show one of the two sidebar panes. */
  setPane(pane) {
    state.ui.pane = pane === 'search' ? 'search' : 'tree';
    qs('#tree-pane').classList.toggle('hidden', state.ui.pane !== 'tree');
    qs('#search-pane').classList.toggle('hidden', state.ui.pane !== 'search');
    if (state.ui.pane !== 'search') {
      // Leaving the pane drops the highlights, so the page reads normally again.
      state.search.hits = 0;
      state.search.hitIndex = 0;
      viewer.clearHits();
    }
    sidebar.render();
    if (state.ui.pane === 'search') searchPanel.render();
    app.scheduleStatePersist();
  },

  /** Open the search pane, optionally with a query already in it. */
  openSearch(query) {
    const existing = typeof query === 'string' ? query : state.search.query;
    app.setPane('search');
    searchPanel.setQuery(existing);
    app.runSearch(existing);
    searchPanel.focus(Boolean(existing));
  },

  /**
   * Search the whole vault.
   *
   * Cheap enough to run on every keystroke: the corpus is cached until the
   * index changes, and only the open vein (whose editor may hold unsaved text)
   * is patched per query.
   */
  runSearch(query) {
    const value = String(query ?? '');
    const docs = searchDocs();
    const found = tokenize(value).length
      ? searchVault({ docs, query: value, limit: 80 })
      : { query: value, terms: [], total: 0, scanned: docs.length, results: [] };

    state.search.query = value;
    state.search.terms = found.terms;
    state.search.results = found.results;
    state.search.total = found.total;
    state.search.scanned = found.scanned;
    state.search.activeIndex = 0;
    searchHighlights();
    searchPanel?.render();
    // Title, heading and tag matches are already final; body matches need the
    // text, so anything unread starts arriving from here.
    if (found.terms.length) hydrateForSearch();
  },

  moveSearchSelection(delta) {
    const search = state.search;
    if (!search.results.length) return;
    search.activeIndex = Math.max(0, Math.min(search.results.length - 1, search.activeIndex + delta));
    searchPanel.render();
  },

  /** Open a result and land on its first hit. */
  async openSearchResult(path) {
    const at = state.search.results.findIndex((result) => result.path === path);
    if (at !== -1) state.search.activeIndex = at;
    await app.openPath(path);
    app.searchHit(0);
    searchPanel.render();
  },

  /** Step through the hits marked on the open page. */
  searchHit(delta) {
    const { index, count } = viewer.goToHit(delta);
    state.search.hits = count;
    state.search.hitIndex = index;
    searchPanel?.render();
  },

  async chooseAndOpenVault() {
    const path = await backend.pickFolder();
    if (!path) return;
    try {
      await app.openVault(path);
    } catch (error) {
      app.toast(`Could not open that folder: ${error.message}`, 'error');
    }
  },

  async createVaultInteractive() {
    const path = await backend.pickFolder();
    if (!path) return;
    const name = await askText({
      title: 'Create a vault',
      label: 'Vault name',
      value: path.split(/[\\/]/).filter(Boolean).pop() ?? 'New Vault',
      hint: `Macusanite will add a .macusanite folder in ${path}`,
      confirmLabel: 'Create vault',
    });
    if (!name) return;
    try {
      await backend.createVault(path, name, '');
      await app.openVault(path);
    } catch (error) {
      app.toast(`Could not create the vault: ${error.message}`, 'error');
    }
  },

  async updateVaultMeta(patch) {
    if (!state.vault) return;
    const next = mergeVaultMeta({ ...state.vault, ...patch });
    state.vault = { ...state.vault, ...next };
    await backend.writeMeta(META.vault, `${JSON.stringify(next, null, 2)}\n`, 'vault details');
    await refreshHistory();
    chrome.renderIdentity();
    app.toast('Vault details saved', 'ok');
  },

  /** Web links open in the system browser, never inside the vault window. */
  async openExternal(url) {
    try {
      await backend.openExternal(url);
      await backend.log('info', `opened externally: ${url}`);
    } catch (error) {
      app.toast(`Could not open ${url}: ${error.message}`, 'warn');
    }
  },

  async revealMetaFolder() {
    if (!state.vault) return;
    try {
      const target = await backend.reveal();
      app.toast(`Opened ${target} — vault.json, settings.json, colors.json, history.json, logs/`, 'info', 5200);
    } catch (error) {
      app.toast(`Could not open the metadata folder: ${error.message}`, 'warn');
    }
  },

  /* ---------------------------------------------------------- documents */

  async openPath(path, options = {}) {
    if (!path) return;
    const normalized = path.replace(/\\/g, '/');
    try {
      const text = await readVein(normalized);
      const { data, body } = parseFrontmatter(text);
      const meta = documentMeta(data);
      state.current = {
        path: normalized,
        text,
        body,
        raw: text,
        frontmatter: data,
        meta,
        headings: [],
        readOnly: Boolean(state.virtualDocs[normalized]) || !isMarkdown(normalized),
      };
      // Whatever was open before is gone, and with it any question about it.
      clearClash('another vein was opened');
      state.draft = text;
      state.dirty = false;
      state.current.headings = buildDocumentIndex({ [normalized]: text })[0]?.headings ?? [];
      // The reader just paid for this read: describe the vein with it, so the
      // link resolution, the graph and the search corpus all see it.
      await indexPath(normalized, { text });
      app.scheduleIndexPersist();

      if (!options.fromState) {
        state.nav.push({
          path: normalized,
          section: options.section ?? '',
          title: meta.title ?? titleFromPath(normalized),
          via: options.via ?? null,
        });
      } else if (!state.nav.current) {
        state.nav.push({ path: normalized, title: meta.title ?? titleFromPath(normalized) });
      }

      await viewer.render(state.current);
      await app.refreshGraph();
      chrome.render();
      sidebar.render();
      app.scheduleStatePersist();

      // Anchors arrive either as a slug or as the raw heading text; slugify is
      // idempotent, so normalising here covers both, including `[[Note#Sieve series]]`.
      const requested = options.anchor ?? options.section ?? '';
      const anchor = requested ? slugify(String(requested).replace(/^\^/, '')) : '';
      viewer.scrollToAnchor(anchor);

      const heading = anchor ? state.current.headings.find((h) => h.anchor === anchor) : null;
      if (heading && state.nav.current?.path === normalized) state.nav.current.section = heading.text;
      chrome.render();

      document.title = `${meta.title ?? titleFromPath(normalized)} — ${state.vault?.name ?? 'Macusanite'}`;
    } catch (error) {
      app.toast(`Could not open ${path}: ${error.message}`, 'error');
      await backend.log('error', `open failed: ${path}: ${error.message}`);
    }
  },

  resolveLink(link, fromPath) {
    if (link.samePage) {
      return {
        ok: true,
        path: fromPath,
        anchor: link.section ? slugify(String(link.section).replace(/^\^/, '')) : '',
        label: link.section || 'this page',
        ghost: false,
      };
    }
    const resolved = resolveTarget(link, fromPath, state.index);
    return {
      ...resolved,
      label: resolved.ok && resolved.path ? (state.index.find((d) => d.path === resolved.path)?.title ?? titleFromPath(resolved.path)) : titleFromPath(link.target ?? ''),
      ghost: !resolved.ok,
    };
  },

  backlinksFor(path) {
    if (!path) return [];
    const needle = path.toLowerCase();
    const stem = path.split('/').pop().replace(/\.(md|markdown|mdx)$/i, '').toLowerCase();
    const out = [];
    for (const doc of state.index) {
      if (doc.path === path) continue;
      for (const link of doc.links) {
        const target = String(link.target ?? '').toLowerCase();
        if (!target) continue;
        const matches = target === needle
          || target === stem
          || target === needle.replace(/\.(md|markdown|mdx)$/i, '')
          || target.endsWith(`/${stem}`);
        if (matches) {
          out.push({ path: doc.path, title: doc.title, context: link.section ? `§ ${link.section}` : '' });
          break;
        }
      }
    }
    return out.sort((a, b) => a.title.localeCompare(b.title));
  },

  /* ------------------------------------------------------------ editing */

  setDraft(text) {
    state.draft = text;
    markDirty(state.current ? text !== state.current.raw : false);
    app.scheduleAutosave();
  },

  toggleEdit() {
    if (!state.current || state.current.readOnly) return;
    state.ui.mode = state.ui.mode === 'edit' ? 'read' : 'edit';
    viewer.render(state.current);
    app.scheduleStatePersist();
  },

  revertDraft() {
    if (!state.current) return;
    // Discarding the draft answers the clash too: there is no second version left
    // to merge, only the one on disk.
    clearClash('the draft was discarded');
    state.draft = state.current.raw;
    viewer.syncEditor(state.draft);
    markDirty(false);
  },

  async saveCurrent(options = {}) {
    if (!state.current || state.current.readOnly) return;
    if (!state.dirty && !options.force) {
      if (!options.silent) app.toast('Nothing to save', 'info', 1600);
      return;
    }
    const text = state.draft;
    try {
      await backend.writeVein(state.current.path, text, `edit ${state.current.path}`);
      state.bodies[state.current.path] = text;
      const { data, body } = parseFrontmatter(text);
      state.current.raw = text;
      state.current.text = text;
      state.current.body = body;
      state.current.frontmatter = data;
      state.current.meta = documentMeta(data);
      state.current.headings = buildDocumentIndex({ [state.current.path]: text })[0]?.headings ?? [];
      markDirty(false);
      await app.reindex([state.current.path], { text });
      await viewer.render(state.current);
      await app.refreshGraph();
      chrome.render();
      await refreshHistory();
      // An explicit save with a conflict still in it is allowed — the reader may
      // want the marked text on disk — but never silent about it.
      if (state.clash?.path === state.current.path) clearClash('saved');
      const conflicts = countConflicts(text);
      if (!options.silent && !conflicts) app.toast('Saved', 'ok', 1400);
      if (conflicts) {
        app.toast(`Saved with ${conflicts} unresolved conflict${conflicts === 1 ? '' : 's'} still marked`, 'warn', 5600);
      }
      await backend.log('info', `saved ${state.current.path}${conflicts ? ` (${conflicts} conflict${conflicts === 1 ? '' : 's'} left marked)` : ''}`);
    } catch (error) {
      app.toast(`Save failed: ${error.message}`, 'error');
    }
  },

  scheduleAutosave() {
    clearTimeout(autosaveTimer);
    if (!state.settings.autosave) return;
    // The offer is only worth making if the clock cannot answer it first: saving
    // the draft now would write it over the very version it is offering to merge.
    if (state.clash && state.clash.path === state.current?.path) return;
    // A draft still carrying merge markers is never written by the clock. Writing
    // `<<<<<<<` into a vein is the one mistake autosave could make that the reader
    // cannot see coming; resolve the markers and `Ctrl+S` writes the result. The
    // check is for *our* markers, not for any line that starts with `<<<<<<<`, so a
    // vein that merely quotes a git conflict is untouched by it.
    if (hasMergeMarkers(state.draft)) return;
    autosaveTimer = setTimeout(() => {
      // Checked again here, not only when the timer was set: an external edit can
      // arrive between the keystroke and the clock, and the whole point of the
      // offer is that the clock does not get to answer it by writing the draft.
      if (state.clash && state.clash.path === state.current?.path) return;
      app.saveCurrent({ silent: true });
    }, state.settings.autosaveDelayMs);
  },

  /**
   * Offer to merge a vein that changed on disk while the editor held unsaved text.
   *
   * Throws neither version away by itself: the dialog offers the line-by-line
   * merge, the disk version, or keeping the draft, and only the first two touch
   * anything. Whichever is chosen, the text now on disk becomes the version the
   * draft is measured against, which is what stops the same clash being offered
   * again every time the vault is refreshed.
   *
   * @param {string} path the vein to merge, as the batch named it
   */
  async offerMerge(path) {
    if (!state.current || state.current.path !== path) return;
    const base = state.current.raw ?? null;
    const mine = state.draft ?? '';
    let theirs = state.bodies[path] ?? null;
    if (typeof theirs !== 'string') {
      try {
        theirs = await backend.readVein(path);
      } catch {
        theirs = null;
      }
    }
    if (typeof theirs !== 'string') {
      app.toast(`Could not read “${basename(path)}” to merge it`, 'error');
      return;
    }

    const merge = mergeVein({ base, mine, theirs });
    const choice = await askMerge({ name: basename(path), merge });

    if (choice === 'keep') {
      // The dialog closed, or the reader said no: the draft stays exactly as it
      // was, nothing is written down as reconciled, and the clock is let go again
      // — keeping the draft means the draft is what should end up on disk.
      clearClash('declined');
      await backend.log('info', `merge declined for ${path} — the unsaved draft is kept`);
      return;
    }
    if (choice === 'disk') {
      await reloadCurrentFromDisk();
      await backend.log('info', `took the version of ${path} from disk, discarding the draft`);
      app.toast(`Took the disk version of “${basename(path)}”`, 'info', 3600);
      return;
    }

    const conflicts = countConflicts(merge.text);
    clearClash('answered');
    state.current.raw = theirs;
    state.draft = merge.text;
    if (state.ui.mode !== 'edit') {
      // Show it: the merged text is the draft now, and the editor is where the
      // marked regions get resolved. Render first, then put the draft back in —
      // rendering an edit-mode document fills the textarea from the saved text.
      state.ui.mode = 'edit';
      await viewer.render(state.current);
    }
    viewer.syncEditor(state.draft);
    markDirty(state.draft !== state.current.raw);
    // The clock is held back while markers remain (see `scheduleAutosave`), so a
    // conflicting merge waits for the reader instead of being written out.
    app.scheduleAutosave();
    await backend.log('info', `merged ${path}: ${describeMerge(merge)}`);
    app.toast(conflicts
      ? `Merged — ${conflicts} conflict${conflicts === 1 ? '' : 's'} marked in the editor; resolve and save`
      : `Merged: ${describeMerge(merge)}`, conflicts ? 'warn' : 'ok', 5600);
  },

  /* ------------------------------------------------------------- colour */

  colorFor(kind, parts) {
    return colorStore.resolveColor(state.colors, kind, parts, state.settings, pageOverrides);
  },

  assignedColorFor(target) {
    if (!target || target.kind === 'default') return null;
    return colorStore.assignedColor(state.colors, target.kind, target);
  },

  async applyColor(target, hex) {
    const { colors } = colorStore.setColor(state.colors, target.kind, target, hex);
    state.colors = colors;
    await app.persistColors(`colour ${target.kind} ${colorStore.colorKey(target.kind, target)}`);
    app.rememberRecentColor(hex);
    await rerenderCurrent();
    app.toast(`${target.kind} colour set to ${hex}`, 'ok', 1500);
  },

  async clearColor(target) {
    state.colors = colorStore.clearColor(state.colors, target.kind, target);
    await app.persistColors(`reset ${target.kind} colour`);
    await rerenderCurrent();
    app.toast(`${target.kind} colour back to its default`, 'info', 1600);
  },

  async resetAllColors() {
    state.colors = colorStore.emptyColorSet();
    await app.persistColors('reset all colours');
    await rerenderCurrent();
    app.toast('All colour assignments cleared', 'ok');
  },

  setDefaultColor(slot, hex, options = {}) {
    state.settings[slot] = hex;
    if (!options.quiet) applyTheme();
    app.rememberRecentColor(hex, { record: true });
    app.persistSettings();
    rerenderCurrent();
  },

  /**
   * @param {string} hex
   * @param {{record?: boolean}} [options] `record: true` makes the containing
   *   settings write undoable too — used when a colour pick is itself undoable.
   */
  rememberRecentColor(hex, options = {}) {
    state.settings.recentColors = rememberColor(state.settings.recentColors, hex);
    app.persistSettings({ record: options.record !== false });
  },

  openColorPicker(target, anchorEl) {
    if (!anchorEl) return;
    anchorEl.classList.add('is-picking');
    colorPicker.open(target, anchorEl, {
      onPreview: (hex) => {
        if (state.current && target.kind === 'section') {
          // keep the swatch preview local; the document re-renders on commit
        }
        return hex;
      },
    });
  },

  /* ------------------------------------------------------------ history */

  async undo() {
    const result = await backend.undo();
    if (!result.applied) {
      app.toast('Nothing to undo', 'info', 1400);
      return;
    }
    await afterHistoryMove(result, 'Undone');
  },

  async redo() {
    const result = await backend.redo();
    if (!result.applied) {
      app.toast('Nothing to redo', 'info', 1400);
      return;
    }
    await afterHistoryMove(result, 'Redone');
  },

  /* ----------------------------------------------------------- settings */

  async updateSettings(patch) {
    state.settings = mergeSettings(state.settings, patch);
    applyTheme();
    applyLayout();
    app.configureMermaid();
    await app.persistSettings();
    await rerenderCurrent();
  },

  async setGraphOption(key, value) {
    state.settings.graph[key] = value;
    state.settings = mergeSettings(state.settings, { graph: state.settings.graph });
    await app.persistSettings({ record: false });
    graphPanel.render();
  },

  /**
   * Write settings.json. `record: false` keeps viewer-state-ish writes (recent
   * colours, panel widths) out of the undo stack; everything else is undoable.
   */
  persistSettings: debounce(async (options = {}) => {
    if (!state.vault) return;
    const record = options.record !== false;
    try {
      await backend.writeMeta(META.settings, `${JSON.stringify(state.settings, null, 2)}\n`, 'settings', record);
      if (record) await refreshHistory();
    } finally {
      // The file is watched, so a hand-edit that arrived while this write was on
      // its way is applied only now — after ours, never over it.
      await app.flushDeferredMeta(META.settings);
    }
  }, 250),

  openSettings() {
    settingsDialog.open();
  },

  openSyntaxGuide() {
    app.openPath(SYNTAX_GUIDE_PATH, { via: state.current?.path ?? null });
  },

  /**
   * The manual, in its own window.
   *
   * On the desktop that is a second OS window (Rust builds it, see
   * `open_help_window`); in the browser it is a new tab of the same page. It
   * carries the current theme, because the help window has no vault and so no
   * settings to read.
   */
  async openHelpWindow() {
    const theme = state.settings?.theme ?? null;
    if (!isDesktop) {
      // A browser only opens a window from a real user gesture, and awaiting
      // anything first loses that gesture — so the fallback happens right here.
      const opened = globalThis.open?.(helpWindowUrl(theme), 'macusanite-help', HELP_WINDOW_FEATURES);
      if (!opened) app.toast('The browser blocked the manual window — open help.html directly.', 'warn');
      return;
    }
    try {
      await backend.openHelpWindow(theme);
      app.log('info', 'opened the help window');
    } catch (error) {
      app.toast(`Could not open the manual: ${error.message}`, 'error');
    }
  },

  /* ------------------------------------------------------------ creating */

  async newVein(dir) {
    if (!state.vault) {
      app.toast('Open a vault first', 'warn');
      return;
    }
    const chamber = dir ?? dirname(state.current?.path ?? '');
    const name = await askText({
      title: 'New vein',
      label: 'File name',
      value: '',
      hint: chamber ? `Created in ${chamber}/` : 'Created at the vault root',
      confirmLabel: 'Create vein',
    });
    if (!name) return;
    const target = join(chamber, name.endsWith('.md') ? name : `${name}.md`);
    try {
      const result = await backend.createVein(target, NEW_VEIN_TEMPLATE(titleFromPath(target)));
      await app.reloadVault({ tree: true });
      await app.reindex([result.path ?? target]);
      await refreshHistory();
      for (const ancestor of ancestorPaths(target)) state.ui.expanded[ancestor] = true;
      await app.openPath(result.path ?? target);
      app.toast(`Created ${result.path ?? target}`, 'ok');
    } catch (error) {
      app.toast(`Could not create that vein: ${error.message}`, 'error');
    }
  },

  async newChamber(dir) {
    if (!state.vault) {
      app.toast('Open a vault first', 'warn');
      return;
    }
    const parent = dir ?? dirname(state.current?.path ?? '');
    const name = await askText({
      title: 'New chamber',
      label: 'Chamber name',
      value: '',
      hint: parent ? `Created inside ${parent}/` : 'Created at the vault root',
      confirmLabel: 'Create chamber',
    });
    if (!name) return;
    const target = join(parent, name);
    try {
      await backend.createChamber(target);
      await app.reloadVault({ tree: true });
      await refreshHistory();
      state.ui.expanded[target] = true;
      for (const ancestor of ancestorPaths(target)) state.ui.expanded[ancestor] = true;
      sidebar.render();
      app.toast(`Chamber ${target} ready`, 'ok');
    } catch (error) {
      app.toast(`Could not create that chamber: ${error.message}`, 'error');
    }
  },

  async createFromGhost(target, suggestedPath) {
    const resolved = app.resolveLink({ target, section: '', alias: null }, state.current?.path ?? '');
    const path = suggestedPath ?? resolved.suggestedPath ?? `${target}.md`;
    try {
      const result = await backend.createVein(path, NEW_VEIN_TEMPLATE(titleFromPath(path)));
      await app.reloadVault({ tree: true });
      await app.reindex([result.path ?? path]);
      await refreshHistory();
      for (const ancestor of ancestorPaths(result.path ?? path)) state.ui.expanded[ancestor] = true;
      await app.openPath(result.path ?? path, { via: state.current?.path ?? null });
      app.toast(`Wrote ${result.path ?? path}`, 'ok');
      await backend.log('info', `created from wiki link: ${result.path ?? path}`);
    } catch (error) {
      app.toast(`Could not create that page: ${error.message}`, 'error');
    }
  },

  showVeinMenu(path, anchorEvent) {
    const existing = qs('.context-menu');
    existing?.remove();
    const menu = el('div', { class: 'menu-popover context-menu', role: 'menu' });
    const item = (label, action) => el('button', {
      class: 'menu-item',
      type: 'button',
      text: label,
      onclick: () => {
        menu.remove();
        action();
      },
    });
    menu.append(
      item('Open', () => app.openPath(path)),
      item('Edit', async () => {
        await app.openPath(path);
        if (state.ui.mode !== 'edit') app.toggleEdit();
      }),
      item('Set page colour…', async () => {
        await app.openPath(path);
        setTimeout(() => {
          const swatch = qs('.viewer-title-row .color-swatch');
          if (swatch) app.openColorPicker({ kind: 'page', path }, swatch);
        }, 60);
      }),
      item('Copy wiki link', async () => {
        const link = `[[${path.replace(/\.md$/i, '')}]]`;
        try {
          await navigator.clipboard.writeText(link);
          app.toast(`Copied ${link}`, 'ok');
        } catch {
          app.toast(link, 'info');
        }
      }),
      item('Show in graph', async () => {
        await app.openPath(path);
        app.toggleGraph(true);
      }),
    );
    const x = anchorEvent?.clientX ?? 40;
    const y = anchorEvent?.clientY ?? 40;
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    menu.style.position = 'fixed';
    document.body.append(menu);
    const dismiss = (event) => {
      if (menu.contains(event.target)) return;
      menu.remove();
      document.removeEventListener('click', dismiss, true);
      document.removeEventListener('contextmenu', dismiss, true);
    };
    setTimeout(() => {
      document.addEventListener('click', dismiss, true);
      document.addEventListener('contextmenu', dismiss, true);
    }, 0);
  },

  /* ---------------------------------------------------------- navigation */

  async navigateBack() {
    const entry = state.nav.back();
    if (!entry) return;
    viewer.rememberScroll(state.current?.path);
    await app.openPath(entry.path, { section: entry.section, fromState: true });
  },

  async navigateForward() {
    const entry = state.nav.forward();
    if (!entry) return;
    viewer.rememberScroll(state.current?.path);
    await app.openPath(entry.path, { section: entry.section, fromState: true });
  },

  toggleExpanded(path) {
    if (!path) return;
    state.ui.expanded[path] = !(state.ui.expanded[path] ?? true);
    sidebar.render();
    app.scheduleStatePersist();
  },

  toggleGraph(force) {
    state.settings.layout.showGraph = typeof force === 'boolean' ? force : !state.settings.layout.showGraph;
    applyLayout();
    graphPanel.render();
    app.persistSettings({ record: false });
  },

  scheduleGraphRefresh() {
    clearTimeout(graphTimer);
    graphTimer = setTimeout(() => graphPanel.render(), 140);
  },

  async refreshGraph() {
    graphPanel.render();
  },

  scheduleStatePersist: debounce(async () => {
    if (!state.vault) return;
    const payload = {
      lastPath: state.current?.path ?? null,
      nav: state.nav.toJSON(),
      ui: { expanded: state.ui.expanded, mode: state.ui.mode, pane: state.ui.pane },
      savedAt: new Date().toISOString(),
    };
    await backend.writeMeta(META.state, `${JSON.stringify(payload, null, 2)}\n`, 'viewer state', false);
  }, 600),

  /* -------------------------------------------------------------- misc */

  toast(message, kind = 'info', timeout, action = null) {
    toaster?.show(message, kind, timeout, action);
  },

  persistColors: debounce(async (label) => {
    if (!state.vault) return;
    try {
      await backend.writeMeta(META.colors, colorStore.serializeColorSet(state.colors), label ?? 'colour change');
      await refreshHistory();
    } finally {
      await app.flushDeferredMeta(META.colors);
    }
  }, 120),

  refreshHistory,
};

/* ── implementation details ───────────────────────────────────────────── */

function markDirty(dirty) {
  if (state.dirty === dirty) return;
  state.dirty = dirty;
  chrome?.renderNavbar();
}

async function readVein(path) {
  if (state.virtualDocs[path]) return state.virtualDocs[path];
  if (typeof state.bodies[path] === 'string') return state.bodies[path];
  const text = await backend.readVein(path);
  state.bodies[path] = text;
  return text;
}

/** One walk of the vault: the tree, the vein list and each vein's stat. */
async function refreshScan() {
  const scan = await backend.scan();
  state.tree = scan.tree ?? state.tree;
  state.veins = scan.veins ?? [];
  indexStats = new Map((scan.stats ?? []).map((stat) => [stat.path, stat]));
  return { tree: state.tree, veins: state.veins, stats: scan.stats ?? [] };
}

/** Where to land when a vault opens: the last vein read, else Home, else the first. */
function pickStartVein(veins, saved) {
  if (saved?.lastPath && veins.includes(saved.lastPath)) return saved.lastPath;
  return veins.find((path) => path.toLowerCase() === 'home.md') ?? veins[0] ?? null;
}

/**
 * Take a planned index as the live one: the entries the cache vouched for stay,
 * everything else is a stub, and the cache records that survived are what will
 * be written back.
 */
function adoptIndex(plan, cache = null) {
  indexStats = plan.stats instanceof Map ? plan.stats : new Map();
  indexStore = createIndex(plan.index);
  state.index = indexStore.list;

  const cached = cache?.entries ?? {};
  cacheRecords = {};
  for (const entry of plan.index) {
    if (!isStub(entry) && cached[entry.path]) cacheRecords[entry.path] = cached[entry.path];
  }

  pageOverrides = {};
  for (const entry of plan.index) setPageOverride(entry.path, entry.color);
  invalidateSearch();
}

/** Page colours come from the front matter the index has already read. */
function setPageOverride(path, color) {
  if (color) pageOverrides[path] = color;
  else delete pageOverrides[path];
}

/** Drop veins the vault no longer has: index, cache, bodies and colours. */
function forgetPaths(paths) {
  const list = [].concat(paths ?? []).filter(Boolean);
  if (!list.length) return;
  indexStore.drop(list);
  for (const path of list) {
    delete cacheRecords[path];
    delete state.bodies[path];
    setPageOverride(path, null);
  }
  state.indexing = { ...state.indexing, total: indexStore.total, indexed: indexStore.indexed };
}

/**
 * Describe one vein and remember what it was described from.
 *
 * The text is deliberately not kept: the search corpus holds the plain text of
 * what the reader has searched, the open vein keeps its body, and everything else
 * is relearned from the cache. That is what keeps a large vault's memory flat.
 *
 * @param {string} path
 * @param {{text?: string, stat?: object}} [options] text the caller already has
 */
async function indexPath(path, options = {}) {
  if (state.virtualDocs[path] || !isMarkdown(path)) return null;
  const text = typeof options.text === 'string' ? options.text : await readForIndex(path);
  if (typeof text !== 'string') return null;
  const entry = buildDocumentIndex({ [path]: text })[0] ?? stubEntry(path);
  indexStore.replace(entry);

  const stat = options.stat ?? indexStats.get(path) ?? await safeStat(path);
  if (stat) indexStats.set(path, stat);
  cacheRecords[path] = cacheRecord(stat ?? { mtime: 0, size: text.length }, entry);
  setPageOverride(path, entry.color);
  return entry;
}

/** Read a vein for its entry alone — the text is used and dropped. */
async function readForIndex(path) {
  if (state.virtualDocs[path]) return state.virtualDocs[path];
  if (typeof state.bodies[path] === 'string') return state.bodies[path];
  try {
    return await backend.readVein(path);
  } catch {
    return null;
  }
}

/** A stat we can do without: no answer simply means "read it next time". */
async function safeStat(path) {
  try {
    return await backend.stat(path);
  } catch {
    return null;
  }
}

/** Paths the index already describes, whatever became of their text. */
function indexedPaths() {
  return indexStore.list.filter((entry) => !isStub(entry)).map((entry) => entry.path);
}

/** True when the cached entry for `path` still matches the last walk of the vault. */
function cacheIsFresh(path) {
  const record = cacheRecords[path];
  const stat = indexStats.get(path);
  if (!record || !stat) return false;
  return record.mtime === stat.mtime && record.size === stat.size;
}

/** Plan against the vault as it stands right now. */
function planIndexNow(priority = null) {
  return planIndex({ stats: [...indexStats.values()], cache: { entries: cacheRecords }, priority });
}

/**
 * Let the browser paint and take input between two chunks of work.
 *
 * A hidden window has no frames to lose — and its timers are throttled to about
 * one a second, which would turn a large vault's first index into an hour of
 * work for a reader who minimised the window. So the yield is skipped while the
 * document is hidden, and the pass runs at the speed of the disk instead.
 */
function yieldToUi() {
  if (typeof document !== 'undefined' && document.hidden) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/**
 * Mark the search terms in the open page — but only while the search pane is
 * showing. Re-running a query in the background (the vault changed, a vein was
 * saved) must not paint highlights on a page the reader has left search from.
 */
function searchHighlights() {
  if (state.ui.pane !== 'search') {
    state.search.hits = 0;
    state.search.hitIndex = 0;
    viewer.clearHits();
    return;
  }
  state.search.hits = viewer.setTerms(state.search.terms);
  state.search.hitIndex = 0;
}

/**
 * The vault moved (or we moved it): the graph and an open query should follow,
 * but not once per chunk — a reader cannot read four hundred updates a second.
 */
const refreshLiveSoon = debounce(() => {
  graphPanel?.render();
  rerunSearchSoon();
}, 250);

/** Re-run the open query, without rebuilding the corpus. */
const rerunSearchSoon = debounce(() => {
  if (state.search.terms.length && searchPanel) app.runSearch(state.search.query);
}, 250);

function scheduleLiveRefresh() {
  refreshLiveSoon();
}

/**
 * The index changed, so what search sees changed too. An open query is re-run in
 * place: results stay live while the vault is edited — by the reader or by
 * another program through the watcher.
 */function invalidateSearch() {
  searchCorpus = null;
  corpusByPath = null;
  if (state.search.terms.length && searchPanel) app.runSearch(state.search.query);
}

/**
 * The documents search looks at: the cached corpus, with the open vein patched
 * to whatever its editor currently shows. Unsaved text is searchable, and
 * reverting a draft restores the disk text.
 *
 * A vein is in the corpus whether or not its text has been read — its title,
 * headings and tags come from the index cache — so a lazily opened vault can be
 * searched the moment it appears.
 */
function searchDocs() {
  if (!searchCorpus) {
    searchCorpus = buildSearchCorpus({ index: state.index, bodies: state.bodies });
    corpusByPath = new Map(searchCorpus.map((doc) => [doc.path, doc]));
  }
  const path = state.current?.path;
  if (path) {
    const doc = corpusByPath.get(path);
    if (doc) {
      const text = state.dirty ? state.draft : state.bodies[path];
      if (typeof text === 'string') {
        doc.text = text;
        doc.clean = plainText(text);
      }
    }
  }
  return searchCorpus;
}

/** Veins whose text the viewer has not read (and has not tried to). */
function unreadVeins() {
  return state.veins.filter((path) => typeof state.bodies[path] !== 'string' && !state.virtualDocs[path]);
}

/**
 * Read the vault for search, a chunk at a time.
 *
 * A query is answered immediately from cached metadata; body matches need the
 * text, so the search reads on and the results grow into the full answer while
 * the reader keeps typing. The read is deliberately not kept in `state.bodies`
 * beyond this session's corpus, and a newer search (or a reloaded vault) cancels
 * it by moving `searchHydrationId` on.
 */
async function hydrateForSearch() {
  if (searchHydrating) return;
  const missing = unreadVeins();
  if (!missing.length) return;

  const id = ++searchHydrationId;
  searchHydrating = true;
  state.search.reading = { done: 0, total: missing.length };
  searchPanel?.render();
  try {
    for (let i = 0; i < missing.length; i += SEARCH_CHUNK) {
      if (searchHydrationId !== id) return;
      const slice = missing.slice(i, i + SEARCH_CHUNK);
      const texts = await Promise.all(slice.map((path) => readForIndex(path)));
      slice.forEach((path, j) => {
        // An unreadable vein is remembered as empty, so it is not retried for
        // every keystroke.
        state.bodies[path] = typeof texts[j] === 'string' ? texts[j] : '';
        const doc = corpusByPath?.get(path);
        if (doc && typeof texts[j] === 'string') {
          doc.text = texts[j];
          doc.clean = plainText(texts[j]);
        }
      });
      state.search.reading = { done: Math.min(i + slice.length, missing.length), total: missing.length };
      rerunSearchSoon();
      searchPanel?.render();
      await yieldToUi();
    }
  } finally {
    if (searchHydrationId === id) {
      searchHydrating = false;
      state.search.reading = null;
      if (state.search.terms.length) app.runSearch(state.search.query);
      searchPanel?.render();
    }
  }
}

async function refreshHistory() {
  try {
    const stacks = await backend.history();
    state.undoStack = stacks.undo ?? [];
    state.redoStack = stacks.redo ?? [];
  } catch {
    state.undoStack = [];
    state.redoStack = [];
  }
  chrome?.renderNavbar();
}

async function afterHistoryMove(result, verb) {
  await refreshHistory();
  const affected = result.path ?? '';
  if (affected.endsWith(META.colors) || affected.endsWith(META.settings)) {
    // An undo of a metadata change moves the same file a hand-edit does, so it
    // goes through the same reader. `render: false`: this function's own tail
    // re-renders the document, the graph and the chrome.
    await applyMetaFromDisk(affected.endsWith(META.colors) ? META.colors : META.settings, { render: false });
  } else if (affected.endsWith(META.vault)) {
    const raw = await backend.readMeta(META.vault);
    state.vault = { ...state.vault, ...mergeVaultMeta(raw ? JSON.parse(raw) : null) };
  } else if (isMarkdown(affected)) {
    try {
      const text = await backend.readVein(affected);
      state.bodies[affected] = text;
      if (state.current?.path === affected) {
        const { data, body } = parseFrontmatter(text);
        state.current = {
          ...state.current,
          text,
          body,
          raw: text,
          frontmatter: data,
          meta: documentMeta(data),
          headings: buildDocumentIndex({ [affected]: text })[0]?.headings ?? [],
        };
        state.draft = text;
        viewer.syncEditor(text);
        markDirty(false);
      }
    } catch {
      /* the file may have been removed by the undo */
    }
  }
  await app.reloadVault({ tree: true });
  if (isMarkdown(affected)) await app.reindex([affected]);
  if (state.current) await viewer.render(state.current);
  graphPanel.render();
  chrome.render();
  sidebar.render();
  app.toast(`${verb} ${result.label ?? ''}`.trim(), 'info', 1600);
}

/**
 * Re-read one `.macusanite` file and put it into the running viewer.
 *
 * This is the single place that turns a file on disk into live settings or live
 * colours, shared by the watcher (a hand-edit) and by undo/redo (the stacks hold
 * metadata files too).
 *
 * Returns true when the file said something *different*: a rewrite that changes
 * nothing — a formatter, another program's no-op save, our own write coming back
 * in a window the watcher did not suppress — costs no re-render and shows no
 * toast.
 *
 * A file that cannot be parsed is refused rather than trusted: half a broken
 * settings file would otherwise blank the theme, and a broken colours file would
 * drop every colour in the vault.
 *
 * @param {string} name `settings.json` or `colors.json`
 * @param {{render?: boolean}} [options] `render: false` when the caller renders
 */
async function applyMetaFromDisk(name, { render = true } = {}) {
  const raw = await backend.readMeta(name);

  if (name === META.settings) {
    let parsed = null;
    if (raw) {
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        await backend.log('warn', `settings.json could not be parsed, keeping the current settings: ${error.message}`);
        return false;
      }
    }
    const next = mergeSettings(DEFAULT_SETTINGS, parsed);
    if (JSON.stringify(next) === JSON.stringify(state.settings)) return false;
    state.settings = next;
    applyTheme();
    applyLayout();
    app.configureMermaid();
    settingsDialog?.refresh();
    if (render) await rerenderCurrent();
    return true;
  }

  if (name === META.colors) {
    let parsed = null;
    if (raw) {
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        await backend.log('warn', `colors.json could not be parsed, keeping the current colours: ${error.message}`);
        return false;
      }
    }
    const next = parsed === null ? colorStore.emptyColorSet() : colorStore.cloneColorSet(parsed);
    if (colorStore.serializeColorSet(next) === colorStore.serializeColorSet(state.colors)) return false;
    state.colors = next;
    settingsDialog?.refresh();
    if (render) await rerenderCurrent();
    return true;
  }

  return false;
}

function applyTheme() {
  document.documentElement.dataset.theme = state.settings.theme;
  document.documentElement.style.setProperty('--font-size', `${state.settings.fontSize}px`);
  document.documentElement.style.setProperty('--line-width', `${state.settings.lineWidth}ch`);
}

function applyLayout() {
  resizers?.apply();
  const show = state.settings.layout.showGraph;
  qs('#graph-panel').classList.toggle('hidden', !show);
  qs('#graph-resizer').classList.toggle('hidden', !show);
  document.documentElement.style.setProperty('--sidebar-width', `${state.settings.layout.sidebarWidth}px`);
  document.documentElement.style.setProperty('--graph-width', `${state.settings.layout.graphWidth}px`);
}

/**
 * Apply one batch of changes made outside the viewer.
 *
 * The vein list from disk is the source of truth: a path that still exists is
 * re-read whatever the event claimed (a delete-and-recreate reports both), and a
 * cached body whose file is gone is dropped. The tree, the index, the graph and
 * the open document then catch up — no reload, no lost scroll position, and no
 * clobbering of unsaved text.
 *
 * Only what the walk says has moved is opened. A batch that names a path whose
 * stat still matches the index cache is a duplicate of a change the viewer has
 * already accounted for, and costs nothing at all.
 */
async function applyExternalBatch(payload) {
  const full = payload?.full === true;
  const changes = Array.isArray(payload?.changes) ? payload.changes : [];
  const rendered = changes.some((change) => isWatched(typeof change === 'string' ? change : change?.path));

  // Hand-edited metadata is followed even when no vein moved — it is what makes a
  // theme or a colour changed in an editor land in the window that is already
  // open. After an overflow (`full`) both files are read again, because the batch
  // that would have named them is the one that was dropped; a file that says
  // nothing new is compared before anything is re-rendered, so a redundant read
  // costs a round trip and no more.
  const meta = full ? metaPlan(LIVE_META) : metaChanges(changes);
  const applied = meta.paths.length ? await app.applyExternalMeta(meta.paths) : [];

  // The other way out of this function: nothing the viewer renders moved.
  const stopHere = () => {
    if (applied.length) app.toast(describeMeta(applied), 'info', 4200);
  };

  if (!rendered && !full) {
    // A metadata-only batch: no scan, no index, no document re-render. A file
    // that changed nothing (our own write arriving a beat late, another window
    // saving the same settings) says nothing at all.
    stopHere();
    return;
  }

  const previous = { tree: state.tree, veins: state.veins };
  const scan = await refreshScan();

  let plan;
  if (full) {
    // Events were missed (or another window is sharing this vault): trust the
    // walk instead, and let the same cache decision say what moved. A batch that
    // really changes nothing — the viewer's own bookkeeping, say — stops here.
    const refreshed = planIndexNow(state.current?.path ?? null);
    const treeChanged = JSON.stringify(previous.veins) !== JSON.stringify(scan.veins)
      || JSON.stringify(previous.tree) !== JSON.stringify(scan.tree);
    plan = {
      added: refreshed.toRead.filter((path) => !cacheRecords[path]),
      relevant: refreshed.toRead.filter((path) => Boolean(cacheRecords[path])),
      removed: refreshed.removed,
      chambers: [],
      touched: treeChanged || refreshed.toRead.length > 0 || refreshed.removed.length > 0,
      treeChanged,
      rereadAll: true,
    };
    if (!plan.touched) {
      // The walk found no vein to re-read: the metadata was the whole batch.
      stopHere();
      return;
    }
  } else {
    plan = planRefresh({ changes, veins: state.veins, indexed: indexedPaths() });
    if (!plan.touched) return;
    // Re-read only what the walk agrees has changed since the cache was written.
    const stale = [...plan.added, ...plan.relevant].filter((path) => !cacheIsFresh(path));
    plan = { ...plan, added: plan.added.filter((path) => stale.includes(path)), relevant: plan.relevant.filter((path) => stale.includes(path)) };
    if (plan.added.length + plan.relevant.length + plan.removed.length + plan.chambers.length === 0) {
      // Every event was one the viewer had already accounted for.
      stopHere();
      return;
    }
  }

  if (plan.removed.length) forgetPaths(plan.removed);

  // The open vein needs its text (that is how a draft is compared with disk);
  // every other changed vein is described and its text dropped again.
  const open = state.current?.path ?? null;
  for (const path of [...plan.added, ...plan.relevant]) {
    if (path === open) {
      try {
        const text = await backend.readVein(path);
        state.bodies[path] = text;
        await indexPath(path, { text });
      } catch {
        delete state.bodies[path];
      }
    } else {
      await indexPath(path);
    }
  }
  for (const path of staleBodies(state.bodies, state.veins)) delete state.bodies[path];
  app.scheduleIndexPersist();
  scheduleLiveRefresh();
  invalidateSearch();

  const path = state.current?.path ?? null;
  const outcome = currentOutcome({
    currentPath: path,
    exists: Boolean(path) && state.veins.includes(path),
    raw: state.current?.raw ?? null,
    diskText: path ? state.bodies[path] ?? null : null,
    dirty: state.dirty,
  });
  const name = path ? basename(path) : 'this vein';

  if (outcome === 'reload') await reloadCurrentFromDisk();
  else if (outcome === 'keep-draft') {
    const merge = planExternalMerge(path);
    if (merge?.unchanged) {
      // Whoever else wrote the file wrote what the editor already holds: the draft
      // is on disk, so there is nothing unsaved after all.
      clearClash('the disk caught up');
      state.current.raw = state.bodies[path];
      markDirty(false);
      await backend.log('info', `${path}: the version on disk is the unsaved draft`);
      app.toast(`“${name}” was saved elsewhere with this draft's text`, 'ok', 4600);
    } else if (merge?.supported) {
      // The offer, and the reason it can be acted on: for as long as it is on
      // screen, autosave is held back, so the clock cannot quietly save the draft
      // over the version this button is offering to merge with it.
      noteClash(path);
      app.toast(`“${name}” changed on disk — your draft is kept, autosave paused`, 'warn', CLASH_WINDOW_MS, {
        label: 'Merge…',
        onClick: () => app.offerMerge(path),
      });
      await backend.log('info', `${path} changed on disk while the draft was unsaved — ${describeMerge(merge)}`);
    } else {
      app.toast(`“${name}” changed on disk — your unsaved text is kept`, 'warn', 5600);
    }
  } else if (outcome === 'removed') {
    app.toast(`“${name}” is gone from disk — Save writes it back`, 'warn', 6200);
  }

  sidebar.render();
  chrome.render();
  // reloadCurrentFromDisk has already re-rendered the graph.
  if (outcome !== 'reload') graphPanel.render();
  app.scheduleStatePersist();

  // Metadata that came in with the same batch gets its own sentence: it was
  // applied by the time we get here, and the plan does not describe it.
  const summary = [applied.length ? describeMeta(applied) : '', describeRefresh(plan)]
    .filter(Boolean)
    .join(' · ');
  const touched = [...plan.added, ...plan.relevant, ...plan.removed, ...plan.chambers];
  const detail = [
    touched.length ? touched.slice(0, 8).join(', ') : '',
    path ? `open vein: ${outcome}` : '',
  ].filter(Boolean).join('; ');
  await backend.log('info', `external change: ${summary}${detail ? ` (${detail})` : ''}`);
  app.toast(summary, 'info', 4200);
}

/**
 * Remember that the open vein has an external edit the draft has not answered.
 * Autosave holds back until the reader chooses ({@link app.offerMerge}), saves
 * anyway, or the offer goes unanswered for `CLASH_WINDOW_MS`.
 */
function noteClash(path) {
  state.clash = { path };
  clearTimeout(clashTimer);
  clashTimer = setTimeout(() => {
    const open = state.clash;
    if (!open) return;
    state.clash = null;
    backend.log('info', `the merge offer for ${open.path} went unanswered — autosave resumes`);
    app.scheduleAutosave();
  }, CLASH_WINDOW_MS);
}

/** A clash has been resolved (or answered with no). */
function clearClash(reason) {
  const open = state.clash;
  if (!open) return;
  state.clash = null;
  clearTimeout(clashTimer);
  clashTimer = null;
  backend.log('info', `unresolved disk clash for ${open.path} cleared: ${reason}`);
  // The clock was held back while this stood; whatever is unsaved now is the
  // reader's again.
  app.scheduleAutosave();
}

/**
 * What a line-by-line merge of the open vein would do right now, or null when
 * there is nothing to compare: no open document, a different vein, or a body the
 * batch never read. Pure, so the decision to *offer* a merge costs no dialogue.
 */
function planExternalMerge(path) {
  if (!state.current || state.current.path !== path) return null;
  const theirs = state.bodies[path];
  if (typeof theirs !== 'string') return null;
  return mergeVein({ base: state.current.raw ?? null, mine: state.draft ?? '', theirs });
}

/** Re-read the open vein from disk and re-render it where the reader was. */
async function reloadCurrentFromDisk() {
  const path = state.current.path;
  clearClash('the disk version was taken');
  const text = state.virtualDocs[path] ?? await backend.readVein(path);
  state.bodies[path] = text;

  const { data, body } = parseFrontmatter(text);
  state.current = {
    ...state.current,
    text,
    raw: text,
    body,
    frontmatter: data,
    meta: documentMeta(data),
    headings: buildDocumentIndex({ [path]: text })[0]?.headings ?? [],
  };
  state.draft = text;
  markDirty(false);

  const scrollTop = qs('#viewer').scrollTop;
  await viewer.render(state.current);
  qs('#viewer').scrollTop = scrollTop;
  graphPanel.render();
  chrome.render();
  document.title = `${state.current.meta.title ?? titleFromPath(path)} — ${state.vault?.name ?? 'Macusanite'}`;
}

async function rerenderCurrent() {
  if (!state.current) {
    graphPanel.render();
    return;
  }
  const scrollTop = qs('#viewer').scrollTop;
  await viewer.render(state.current);
  qs('#viewer').scrollTop = scrollTop;
  graphPanel.render();
  chrome.render();
}

function wireGlobalEvents() {
  // Colour swatches: one delegated listener for the whole window.
  document.addEventListener('click', (event) => {
    const swatch = event.target.closest?.('.color-swatch');
    if (!swatch) return;
    event.preventDefault();
    event.stopPropagation();
    const target = JSON.parse(decodeURIComponent(swatch.dataset.colorTarget));
    app.openColorPicker(target, swatch);
  });

  // Wiki links and markdown file links inside the document.
  qs('#viewer').addEventListener('click', (event) => {
    const link = event.target.closest?.('.wikilink');
    if (link) {
      event.preventDefault();
      const section = link.dataset.section ?? '';
      const ghost = link.dataset.ghost === 'true';
      const resolved = link.dataset.resolved;
      if (ghost || !resolved) {
        app.createFromGhost(link.dataset.target, undefined);
      } else {
        app.openPath(resolved, { section, via: state.current?.path ?? null });
      }
      return;
    }
    const anchor = event.target.closest?.('a');
    if (!anchor) return;
    const href = anchor.getAttribute('href') ?? '';

    // Anything pointing off-machine belongs in the user's browser.
    if (anchor.dataset.external === 'true' || /^(https?|mailto):/i.test(href)) {
      event.preventDefault();
      app.openExternal(href);
      return;
    }

    const vaultFile = anchor.dataset.vaultFile ?? (!/^[a-z]+:/i.test(href) && isMarkdown(href.split('#')[0]) ? href : '');
    if (vaultFile) {
      event.preventDefault();
      const [file, anchorId] = vaultFile.split('#');
      app.openPath(decodeURIComponent(file), {
        anchor: anchorId ? decodeURIComponent(anchorId) : '',
        via: state.current?.path ?? null,
      });
    }
  });

  document.addEventListener('keydown', (event) => {
    const inEditor = event.target instanceof HTMLElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName);
    const mod = event.ctrlKey || event.metaKey;

    if (mod && event.key.toLowerCase() === 's') {
      event.preventDefault();
      app.saveCurrent();
      return;
    }
    if (mod && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      app.openSearch(state.search.query);
      return;
    }
    if (mod && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      chrome.openJump();
      return;
    }
    if (event.key === 'F3') {
      event.preventDefault();
      app.searchHit(event.shiftKey ? -1 : 1);
      return;
    }
    if (event.key === 'F1') {
      event.preventDefault();
      app.openHelpWindow();
      return;
    }
    if (mod && event.key.toLowerCase() === 'z' && !inEditor) {
      event.preventDefault();
      if (event.shiftKey) app.redo();
      else app.undo();
      return;
    }
    if (mod && event.key.toLowerCase() === 'y' && !inEditor) {
      event.preventDefault();
      app.redo();
      return;
    }
    if (event.altKey && event.key === 'ArrowLeft') {
      event.preventDefault();
      app.navigateBack();
      return;
    }
    if (event.altKey && event.key === 'ArrowRight') {
      event.preventDefault();
      app.navigateForward();
      return;
    }
    if (event.key === 'Escape') {
      // Escape unwinds the search the way the reader expects: the query first,
      // then the pane, and only then edit mode.
      if (state.ui.pane === 'search') {
        if (state.search.query) {
          searchPanel.setQuery('');
          app.runSearch('');
        } else {
          app.setPane('tree');
        }
        return;
      }
      if (state.ui.mode === 'edit') app.toggleEdit();
    }
  });

  window.addEventListener('beforeunload', () => {
    if (state.dirty && state.settings.autosave) app.saveCurrent({ silent: true });
  });
}

function readLastVault() {
  try {
    return globalThis.localStorage?.getItem(LAST_VAULT_KEY) ?? null;
  } catch {
    return null;
  }
}

function writeLastVault(path) {
  try {
    globalThis.localStorage?.setItem(LAST_VAULT_KEY, path);
  } catch {
    /* storage disabled — auto-open simply won't happen next launch */
  }
}

/* ── go ───────────────────────────────────────────────────────────────── */

// Handy for debugging and for scripted smoke checks in the browser.
globalThis.macusanite = app;

app.init().catch(async (error) => {
  console.error(error);
  const host = qs('#toasts');
  if (host) host.append(el('div', { class: 'toast toast-error', text: `Startup failed: ${error.message}` }));
  try {
    await backend.log('error', `startup failed: ${error.message}`);
  } catch {
    /* nothing else to do */
  }
});

export default app;
