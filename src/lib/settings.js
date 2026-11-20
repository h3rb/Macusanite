/**
 * Viewer settings and vault metadata.
 *
 * Two files in `<vault>/.macusanite/` back these:
 *   vault.json     -> name, description, created (the vault's identity)
 *   settings.json  -> everything below (viewer behaviour, colours, graph)
 */
import { normalizeColor, PALETTE } from './colors.js';
import { normalizeUnit, UNIT_VOCABULARY_LIMIT } from './worldbuild.js';
import { cleanThemeHues, DEFAULT_THEME_HUES } from './themeHue.js';
import { cleanTutorialSeen } from './tutorials.js';

/** Every page, link and section starts white unless the vault says otherwise. */
export const DEFAULT_COLOR = '#ffffff';

export const SETTINGS_VERSION = 1;

/**
 * Hops the concept graph is allowed to walk out from the open vein. The canvas
 * fades each hop further into the background, so a deep number is a choice about
 * how much of the wider vault stays visible, not a hard limit on the vault.
 */
export const MAX_GRAPH_DEPTH = 144;

export const DEFAULT_SETTINGS = {
  version: SETTINGS_VERSION,
  theme: 'dark',
  // Degrees to rotate the background, chrome and text palettes around the
  // colour wheel. 0 keeps the theme's own hues (see themeHue.js).
  themeHues: { ...DEFAULT_THEME_HUES },
  // Whether buttons carry a small symbol or emoji beside their label. Off is
  // text-only, which is easier to scan for some readers (and avoids emoji
  // fonts changing how the toolbar looks between platforms).
  icons: true,
  // Instructional notes the viewer teaches with: the one-time object-map note
  // on the canvas, the search tip and the editor's shortcut hint. On by
  // default; off leaves the window free of teaching text, and Help keeps the
  // same story for anyone who turns them back on. The switch hides the notes
  // without forgetting which ones a reader closed — `tutorialSeen` keeps that.
  tutorials: true,
  // Teaching notes the reader has closed, by id, with the stamp of the
  // decision. Settings → Reading → Reset tutorials empties it so every note
  // can teach again; see src/lib/tutorials.js for the ids.
  tutorialSeen: {},
  autosave: true,
  autosaveDelayMs: 800,
  fontSize: 16,
  lineWidth: 78,
  defaultPageColor: DEFAULT_COLOR,
  defaultLinkColor: DEFAULT_COLOR,
  defaultSectionColor: DEFAULT_COLOR,
  linkFadeSteps: 5,
  palette: PALETTE,
  recentColors: [],
  graph: {
    // Ten hops is a readable neighbourhood around the open vein: far enough to
    // see the chambers it belongs to, close enough that the fade still reads.
    depth: 10,
    showSections: true,
    showTags: true,
    showUnresolved: true,
    showContext: true,
    iterations: 260,
    nodeRadius: 7,
    animate: false,
  },
  layout: {
    sidebarWidth: 268,
    graphWidth: 340,
    // Both side panes fold to a vertical tab, so the reading pane or the canvas
    // can take their width. They are independent: the left one is the vault.
    showSidebar: true,
    showGraph: true,
  },
  editor: {
    enabled: true,
    livePreview: true,
  },
  worldbuild: {
    // How tall a full card stands unless the node says otherwise: `fixed`
    // keeps the 260px box with scrolling prose, `content` grows the card so
    // the whole note shows. Per-node overrides live in the vein record.
    cardSize: 'fixed',
    // Units typed by hand into attribute cards. Kept outside the cards so
    // clearing a unit or deleting its card does not erase the suggestion.
    units: [],
    // The navigator: a minimap of the whole canvas with the viewport on it,
    // plus Fit selection and Fit group. On unless the reader turns it off.
    navigator: true,
    // Where it sits: floating in a corner of the canvas, or docked as a drawer
    // on its right edge. Closing it leaves the drawer's rail, so the drawer is
    // the placement a closed navigator comes back from. Settings → Worldbuilding
    // → Navigator placement switches between the two.
    navigatorDock: 'float',
    // How wide the drawer's panel is, in pixels, remembered from the grip on
    // its inner edge. The rail that opens it is a fixed 30px either way.
    navigatorWidth: 202,
    // Whether the one-time note about the object map has been shown. It opens
    // the first time the canvas passes below 65%, where the link port becomes
    // a screen-sized corner ring and the rings are the whole way to bond.
    lowZoomTipSeen: false,
    // Tablet and touch gestures: long-press a card or group to forge from it,
    // larger hit targets on the canvas, and two-finger pinch and pan. Off
    // unless the reader says they use touch, so a mouse never pays for it.
    touch: false,
  },
  updates: {
    // Checked automatically shortly after the vault opens; the user can turn
    // this off in Settings and still check manually. Manual checks always run.
    autoCheck: true,
  },
};

export const DEFAULT_VAULT_META = {
  version: 1,
  name: 'Untitled Vault',
  description: '',
  created: null,
  kind: 'macusanite-vault',
};

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Settings slices whose keys are data — ids the reader's decisions created —
 * rather than a fixed shape the defaults declare. Everything else drops keys
 * the defaults do not know, so an older build's leftovers never ride along;
 * these maps keep every entry and are bounded by their own cleaners instead.
 */
const OPEN_MAP_KEYS = new Set(['tutorialSeen']);

/**
 * Merge `saved` over `base`, dropping unknown keys, then validate once.
 *
 * The recursion deliberately does *not* validate: `validateSettings` shapes the
 * top-level settings object, so running it on a nested object (say `graph`)
 * would graft the top-level keys onto it.
 */
export function mergeSettings(base, saved) {
  return validateSettings(deepMerge(base, saved));
}

function deepMerge(base, saved, open = false) {
  if (!isPlainObject(saved)) return structuredCloneSafe(base);
  const out = structuredCloneSafe(base);
  for (const [key, value] of Object.entries(saved)) {
    if (!open && !(key in out)) continue;
    if (isPlainObject(out[key]) && isPlainObject(value)) {
      out[key] = deepMerge(out[key], value, open || OPEN_MAP_KEYS.has(key));
    } else if (Array.isArray(out[key])) {
      if (Array.isArray(value)) out[key] = value.slice();
    } else if (value !== undefined && value !== null) {
      out[key] = value;
    }
  }
  return out;
}

/** Clamp numbers and normalise colours; call after any external write. */
export function validateSettings(settings) {
  const s = settings;
  for (const key of ['defaultPageColor', 'defaultLinkColor', 'defaultSectionColor']) {
    s[key] = normalizeColor(s[key]) ?? DEFAULT_COLOR;
  }
  s.palette = (Array.isArray(s.palette) ? s.palette : PALETTE)
    .map((c) => normalizeColor(c))
    .filter(Boolean);
  if (!s.palette.length) s.palette = [...PALETTE];
  s.recentColors = (Array.isArray(s.recentColors) ? s.recentColors : [])
    .map((c) => normalizeColor(c))
    .filter(Boolean)
    .slice(0, 24);
  s.fontSize = clamp(Number(s.fontSize), 11, 28, DEFAULT_SETTINGS.fontSize);
  s.lineWidth = clamp(Number(s.lineWidth), 40, 160, DEFAULT_SETTINGS.lineWidth);
  s.autosaveDelayMs = clamp(Number(s.autosaveDelayMs), 150, 10_000, DEFAULT_SETTINGS.autosaveDelayMs);
  s.linkFadeSteps = clamp(Number(s.linkFadeSteps), 2, 12, DEFAULT_SETTINGS.linkFadeSteps);
  s.theme = s.theme === 'light' ? 'light' : 'dark';
  s.themeHues = cleanThemeHues(s.themeHues);
  s.icons = s.icons !== false;
  s.tutorials = s.tutorials !== false;
  s.tutorialSeen = cleanTutorialSeen(s.tutorialSeen);
  s.autosave = s.autosave !== false;
  s.graph = {
    ...DEFAULT_SETTINGS.graph,
    ...(isPlainObject(s.graph) ? s.graph : {}),
  };
  s.graph.depth = clamp(Number(s.graph.depth), 1, MAX_GRAPH_DEPTH, DEFAULT_SETTINGS.graph.depth);
  s.graph.iterations = clamp(Number(s.graph.iterations), 40, 1200, DEFAULT_SETTINGS.graph.iterations);
  s.graph.nodeRadius = clamp(Number(s.graph.nodeRadius), 3, 20, DEFAULT_SETTINGS.graph.nodeRadius);
  s.layout = {
    ...DEFAULT_SETTINGS.layout,
    ...(isPlainObject(s.layout) ? s.layout : {}),
  };
  s.layout.sidebarWidth = clamp(Number(s.layout.sidebarWidth), 160, 640, DEFAULT_SETTINGS.layout.sidebarWidth);
  s.layout.graphWidth = clamp(Number(s.layout.graphWidth), 200, 900, DEFAULT_SETTINGS.layout.graphWidth);
  s.editor = { ...DEFAULT_SETTINGS.editor, ...(isPlainObject(s.editor) ? s.editor : {}) };
  s.worldbuild = { ...DEFAULT_SETTINGS.worldbuild, ...(isPlainObject(s.worldbuild) ? s.worldbuild : {}) };
  s.worldbuild.cardSize = s.worldbuild.cardSize === 'content' ? 'content' : DEFAULT_SETTINGS.worldbuild.cardSize;
  s.worldbuild.navigator = s.worldbuild.navigator !== false;
  s.worldbuild.navigatorDock = s.worldbuild.navigatorDock === 'drawer' ? 'drawer' : 'float';
  s.worldbuild.navigatorWidth = clamp(Number(s.worldbuild.navigatorWidth), 160, 420, DEFAULT_SETTINGS.worldbuild.navigatorWidth);
  s.worldbuild.lowZoomTipSeen = s.worldbuild.lowZoomTipSeen === true;
  // Before `tutorialSeen` existed, the object-map note's “Got it” was
  // remembered here. Fold that decision in once, so an upgrade does not reopen
  // a note the reader closed; the new record is the only place it lives after.
  if (s.worldbuild.lowZoomTipSeen && !s.tutorialSeen['object-map']) {
    s.tutorialSeen = { ...s.tutorialSeen, 'object-map': 'legacy' };
  }
  s.worldbuild.lowZoomTipSeen = false;
  s.worldbuild.touch = s.worldbuild.touch === true;
  s.worldbuild.units = (Array.isArray(s.worldbuild.units) ? s.worldbuild.units : [])
    .filter((unit) => typeof unit === 'string')
    .map((unit) => normalizeUnit(unit))
    .filter(Boolean)
    .slice(0, UNIT_VOCABULARY_LIMIT);
  s.updates = { ...DEFAULT_SETTINGS.updates, ...(isPlainObject(s.updates) ? s.updates : {}) };
  s.updates.autoCheck = s.updates.autoCheck !== false;
  return s;
}

export function mergeVaultMeta(saved) {
  const base = structuredCloneSafe(DEFAULT_VAULT_META);
  if (!isPlainObject(saved)) return base;
  base.name = typeof saved.name === 'string' && saved.name.trim() ? saved.name.trim() : base.name;
  base.description = typeof saved.description === 'string' ? saved.description : base.description;
  base.created = typeof saved.created === 'string' ? saved.created : base.created;
  base.version = Number(saved.version) || base.version;
  if (isPlainObject(saved.counters)) base.counters = saved.counters;
  return base;
}

/** Push a colour to the front of the recent list, de-duplicated. */
export function rememberColor(recent, color, limit = 24) {
  const c = normalizeColor(color);
  if (!c) return recent.slice();
  return [c, ...recent.filter((x) => x !== c)].slice(0, limit);
}

function clamp(value, min, max, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function structuredCloneSafe(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}
