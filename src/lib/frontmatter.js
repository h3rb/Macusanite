/**
 * Dependency-free front-matter parser.
 *
 * Deliberately not a YAML implementation: Macusanite documents use a small,
 * predictable subset so the viewer stays a single portable binary.
 *
 * ```markdown
 * ---
 * title: Fluid inclusions
 * color: #ff8c00            # page colour
 * link-color: SlateBlue     # colour of links leaving this page
 * tags: [petrology, melt]   # concept nodes
 * aliases:
 *   - MI
 * ---
 * ```
 */
import { normalizeColor } from './colors.js';

const FENCE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

function unquote(value) {
  const v = value.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

function coerce(key, rawValue) {
  const value = unquote(rawValue);
  if (key === 'color' || key === 'link-color' || key === 'section-color') {
    return normalizeColor(value) ?? value;
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(value) && key !== 'title') return Number(value);
  return value;
}

/**
 * @returns {{data: Record<string, unknown>, body: string, raw: string, present: boolean}}
 */
export function parseFrontmatter(text) {
  const src = String(text ?? '').replace(/^\uFEFF/, '');
  const match = FENCE.exec(src);
  if (!match) return { data: {}, body: src, raw: '', present: false };

  const data = {};
  const lines = match[1].split(/\r?\n/);
  let currentListKey = null;

  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue;

    const listItem = /^[ \t]+-[ \t]*(.*)$/.exec(line);
    if (listItem && currentListKey) {
      data[currentListKey].push(unquote(listItem[1]));
      continue;
    }

    const pair = /^([A-Za-z0-9_.-]+)[ \t]*:[ \t]*(.*)$/.exec(line);
    if (!pair) continue;
    const key = pair[1].toLowerCase();
    const value = pair[2].trim();

    const inlineList = /^\[(.*)\]$/.exec(value);
    if (inlineList) {
      data[key] = inlineList[1]
        .split(',')
        .map((v) => unquote(v))
        .filter(Boolean);
      currentListKey = null;
      continue;
    }

    if (value === '') {
      data[key] = [];
      currentListKey = key;
      continue;
    }

    data[key] = coerce(key, value);
    currentListKey = key;
  }

  return {
    data,
    body: src.slice(match[0].length),
    raw: match[0],
    present: true,
  };
}

/** Normalise the front matter fields Macusanite cares about. */
export function documentMeta(frontmatterData = {}) {
  const asList = (value) => {
    if (value === undefined || value === null) return [];
    if (Array.isArray(value)) return value.map(String).filter(Boolean);
    return String(value).split(',').map((v) => v.trim()).filter(Boolean);
  };
  return {
    title: frontmatterData.title ? String(frontmatterData.title) : null,
    pageColor: frontmatterData.color ? normalizeColor(frontmatterData.color) : null,
    linkColor: frontmatterData['link-color'] ? normalizeColor(frontmatterData['link-color']) : null,
    sectionColor: frontmatterData['section-color'] ? normalizeColor(frontmatterData['section-color']) : null,
    tags: asList(frontmatterData.tags ?? frontmatterData.tag),
    aliases: asList(frontmatterData.aliases ?? frontmatterData.alias),
  };
}

/** Serialise front matter back to disk (used when the settings dialog edits it). */
export function stringifyFrontmatter(data) {
  const lines = Object.entries(data)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([key, value]) => {
      if (Array.isArray(value)) return `${key}: [${value.join(', ')}]`;
      return `${key}: ${value}`;
    });
  return `---\n${lines.join('\n')}\n---\n`;
}
