/**
 * Colour assignments, persisted in `<vault>/.macusanite/colors.json`.
 *
 * Shape:
 * ```json
 * {
 *   "pages":    { "Chambers/Lab/Methods.md": "#a0d911" },
 *   "sections": { "Chambers/Lab/Methods.md#sieve-series": "#52c41a" },
 *   "links":    { "Home.md->Chambers/Lab/Methods.md": "#ff8c00" },
 *   "concepts": { "glossary": "#da70d6" }
 * }
 * ```
 *
 * Resolution runs along a fixed chain, most specific first:
 *
 *   1. an explicit assignment made in the picker (this wins so that picking a
 *      colour always does something, even on a page with front matter)
 *   2. the document's front-matter colour, which is the page's starting point
 *   3. inheritance: a section from its page, a link from its source page
 *   4. the vault default from settings (white out of the box)
 */
import { normalizeColor } from './colors.js';

export const KINDS = ['page', 'section', 'link', 'concept'];

export function emptyColorSet() {
  return { pages: {}, sections: {}, links: {}, concepts: {} };
}

/** The bucket a kind is stored in. */
const bucketFor = (kind) => `${kind}s`;

/** Human-readable key for a colour target. */
export function colorKey(kind, parts = {}) {
  switch (kind) {
    case 'page':
      return String(parts.path ?? '');
    case 'section':
      return `${parts.path ?? ''}#${parts.anchor ?? ''}`;
    case 'link': {
      const base = `${parts.from ?? ''}->${parts.to ?? ''}`;
      return parts.section ? `${base}#${parts.section}` : base;
    }
    case 'concept':
      return String(parts.name ?? '').toLowerCase();
    default:
      return '';
  }
}

/** Every key that could satisfy a request, most specific first. */
export function keyCandidates(kind, parts = {}) {
  const primary = colorKey(kind, parts);
  const out = [primary];
  if (kind === 'section') out.push(`${parts.path ?? ''}#`);
  if (kind === 'link' && parts.section) out.push(colorKey('link', { ...parts, section: '' }));
  return out.filter(Boolean);
}

/** Read an explicitly assigned colour (no defaults applied). */
export function assignedColor(colors, kind, parts) {
  const bucket = colors?.[bucketFor(kind)];
  if (!bucket) return null;
  for (const key of keyCandidates(kind, parts)) {
    if (bucket[key]) return bucket[key];
  }
  return null;
}

const fallbackDefaults = (defaults = {}) => ({
  page: normalizeColor(defaults.defaultPageColor) ?? '#ffffff',
  section: normalizeColor(defaults.defaultSectionColor) ?? '#ffffff',
  link: normalizeColor(defaults.defaultLinkColor) ?? '#ffffff',
  concept: normalizeColor(defaults.defaultSectionColor) ?? '#ffffff',
});

/**
 * Resolve the colour to paint for a target, including inherited values.
 * `pageOverrides` carries the front-matter colours of the vault's documents.
 */
export function resolveColor(colors, kind, parts = {}, defaults = {}, pageOverrides = {}) {
  const fb = fallbackDefaults(defaults);
  const explicit = assignedColor(colors, kind, parts);

  if (kind === 'page') {
    return explicit ?? pageOverrides[parts.path] ?? fb.page;
  }
  if (kind === 'section') {
    const sectionColor = explicit ?? pageOverrides[parts.path] ?? assignedColor(colors, 'page', parts);
    return sectionColor ?? fb.section;
  }
  if (kind === 'link') {
    const linkColor = explicit ??
      pageOverrides[parts.from] ??
      assignedColor(colors, 'page', { path: parts.from });
    return linkColor ?? fb.link;
  }
  if (kind === 'concept') {
    return explicit ?? fb.concept;
  }
  return fb.page;
}

/** Immutably set an assignment. */
export function setColor(colors, kind, parts, color) {
  const hex = normalizeColor(color);
  const next = cloneColorSet(colors);
  const bucket = bucketFor(kind);
  if (!next[bucket]) next[bucket] = {};
  const key = colorKey(kind, parts);
  if (hex === null) delete next[bucket][key];
  else next[bucket][key] = hex;
  return { colors: next, key, previous: colors?.[bucket]?.[key] ?? null };
}

/** Immutably remove an assignment (back to inherited/default). */
export function clearColor(colors, kind, parts) {
  const next = cloneColorSet(colors);
  const bucket = bucketFor(kind);
  if (next[bucket]) delete next[bucket][bucket === 'sections' ? colorKey('section', parts) : colorKey(kind, parts)];
  return next;
}

export function cloneColorSet(colors) {
  const base = emptyColorSet();
  if (!colors) return base;
  for (const kind of KINDS) {
    const bucket = bucketFor(kind);
    const source = colors[bucket];
    if (source && typeof source === 'object') {
      base[bucket] = {};
      for (const [key, value] of Object.entries(source)) {
        const hex = normalizeColor(value);
        if (hex) base[bucket][key] = hex;
      }
    }
  }
  if (colors.version) base.version = colors.version;
  return base;
}

/** Drop assignments that point at documents that no longer exist. */
export function pruneColorSet(colors, existingPaths) {
  const next = cloneColorSet(colors);
  const exists = new Set(existingPaths);
  const pathOf = (key) => {
    if (key.includes('->')) return key.split('->')[0].split('#')[0];
    return key.split('#')[0];
  };
  for (const bucket of ['pages', 'sections', 'links']) {
    for (const key of Object.keys(next[bucket])) {
      const path = pathOf(key);
      const targets = key.includes('->') ? [path, key.split('->')[1].split('#')[0]] : [path];
      if (!targets.some((t) => exists.has(t))) delete next[bucket][key];
    }
  }
  return next;
}

/** Counts per bucket, for the settings dialog. */
export function colorStats(colors) {
  const set = cloneColorSet(colors);
  return {
    pages: Object.keys(set.pages).length,
    sections: Object.keys(set.sections).length,
    links: Object.keys(set.links).length,
    concepts: Object.keys(set.concepts).length,
    total: KINDS.reduce((sum, kind) => sum + Object.keys(set[bucketFor(kind)]).length, 0),
  };
}

/** Human-readable description of a colour target, for the picker header. */
export function describeTarget(kind, parts = {}) {
  switch (kind) {
    case 'page':
      return { title: 'Page colour', subtitle: String(parts.path ?? '') };
    case 'section':
      return { title: parts.name ? `Section: ${parts.name}` : 'Section colour', subtitle: `${parts.path ?? ''}#${parts.anchor ?? ''}` };
    case 'link':
      return { title: 'Link colour', subtitle: `${parts.from ?? ''} → ${parts.to ?? 'unwritten'}` };
    case 'concept':
      return { title: `Concept: ${parts.name ?? ''}`, subtitle: 'unwritten page' };
    default:
      return { title: 'Colour', subtitle: '' };
  }
}

/** Serialise a set for `.macusanite/colors.json`. */
export function serializeColorSet(colors) {
  return `${JSON.stringify(cloneColorSet(colors), null, 2)}\n`;
}

export function parseColorSet(raw) {
  if (!raw) return emptyColorSet();
  try {
    return cloneColorSet(JSON.parse(raw));
  } catch {
    return emptyColorSet();
  }
}
