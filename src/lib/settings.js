/**
 * Viewer settings and vault metadata.
 *
 * Two files in `<vault>/.macusanite/` back these:
 *   vault.json     -> name, description, created (the vault's identity)
 *   settings.json  -> everything below (viewer behaviour, colours, graph)
 */
import { normalizeColor, PALETTE } from './colors.js';

/** Every page, link and section starts white unless the vault says otherwise. */
export const DEFAULT_COLOR = '#ffffff';

export const SETTINGS_VERSION = 1;

export const DEFAULT_SETTINGS = {
  version: SETTINGS_VERSION,
  theme: 'dark',
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
    depth: 2,
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
    showGraph: true,
  },
  editor: {
    enabled: true,
    livePreview: true,
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
 * Merge `saved` over `base`, dropping unknown keys, then validate once.
 *
 * The recursion deliberately does *not* validate: `validateSettings` shapes the
 * top-level settings object, so running it on a nested object (say `graph`)
 * would graft the top-level keys onto it.
 */
export function mergeSettings(base, saved) {
  return validateSettings(deepMerge(base, saved));
}

function deepMerge(base, saved) {
  if (!isPlainObject(saved)) return structuredCloneSafe(base);
  const out = structuredCloneSafe(base);
  for (const [key, value] of Object.entries(saved)) {
    if (!(key in out)) continue;
    if (isPlainObject(out[key]) && isPlainObject(value)) {
      out[key] = deepMerge(out[key], value);
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
  s.autosave = s.autosave !== false;
  s.graph = {
    ...DEFAULT_SETTINGS.graph,
    ...(isPlainObject(s.graph) ? s.graph : {}),
  };
  s.graph.depth = clamp(Number(s.graph.depth), 1, 4, DEFAULT_SETTINGS.graph.depth);
  s.graph.iterations = clamp(Number(s.graph.iterations), 40, 1200, DEFAULT_SETTINGS.graph.iterations);
  s.graph.nodeRadius = clamp(Number(s.graph.nodeRadius), 3, 20, DEFAULT_SETTINGS.graph.nodeRadius);
  s.layout = {
    ...DEFAULT_SETTINGS.layout,
    ...(isPlainObject(s.layout) ? s.layout : {}),
  };
  s.layout.sidebarWidth = clamp(Number(s.layout.sidebarWidth), 160, 640, DEFAULT_SETTINGS.layout.sidebarWidth);
  s.layout.graphWidth = clamp(Number(s.layout.graphWidth), 200, 900, DEFAULT_SETTINGS.layout.graphWidth);
  s.editor = { ...DEFAULT_SETTINGS.editor, ...(isPlainObject(s.editor) ? s.editor : {}) };
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
