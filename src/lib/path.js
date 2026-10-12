/**
 * Path helpers for vault-relative, posix-style paths.
 *
 * Every path that crosses the JS <-> Rust bridge uses forward slashes and is
 * relative to the vault root. OS-specific separators are only ever produced by
 * the Rust side when it touches the filesystem.
 */

/** Collapse `.`, `..`, duplicate and trailing separators. `..` never escapes. */
export function normalize(input) {
  const raw = String(input ?? '').replace(/\\/g, '/');
  const absolute = raw.startsWith('/');
  const parts = [];
  for (const segment of raw.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (parts.length && parts[parts.length - 1] !== '..') parts.pop();
      else if (!absolute) parts.push('..');
      continue;
    }
    parts.push(segment);
  }
  return (absolute ? '/' : '') + parts.join('/');
}

export function join(...parts) {
  return normalize(parts.filter((p) => p !== undefined && p !== null && p !== '').join('/'));
}

export function dirname(p) {
  const n = normalize(p);
  const i = n.lastIndexOf('/');
  return i <= 0 ? '' : n.slice(0, i);
}

export function basename(p) {
  const n = normalize(p);
  return n.slice(n.lastIndexOf('/') + 1);
}

export function extname(p) {
  const base = basename(p);
  const i = base.lastIndexOf('.');
  return i <= 0 ? '' : base.slice(i).toLowerCase();
}

/** File name without its extension. Used as the wiki-link target name. */
export function stem(p) {
  const base = basename(p);
  const i = base.lastIndexOf('.');
  return i <= 0 ? base : base.slice(0, i);
}

export function isMarkdown(p) {
  return ['.md', '.markdown', '.mdx'].includes(extname(p));
}

/** Path of every ancestor chamber, outermost first (`a/b/c.md` -> `['a', 'a/b']`). */
export function ancestorChambers(p) {
  const parts = normalize(p).split('/').slice(0, -1);
  const out = [];
  let acc = '';
  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : part;
    out.push(acc);
  }
  return out;
}

/** Human-readable document title derived from the file name. */
export function titleFromPath(p) {
  return stem(p)
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * GitHub-style heading slug. Kept byte-for-byte compatible with the Rust side's
 * `slugify` so anchors written in markdown resolve in both worlds.
 */
export function slugify(text) {
  return String(text ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-');
}

/** Render a leaf wiki breadcrumb: `a/b/note.md` -> `note`. */
export function chamberLabel(p) {
  return basename(p) || 'Vault';
}

export function isWithin(root, candidate) {
  const r = normalize(root);
  const c = normalize(candidate);
  return c === r || c.startsWith(`${r}/`);
}
