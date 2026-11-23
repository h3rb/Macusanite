/**
 * Wiki link syntax: `[[target]]`, `[[target|alias]]`, `[[target#section]]`,
 * `[[#section]]` and the reference-card form `![[target]]`.
 *
 * The scanner is fence/code aware so markdown examples never turn into links,
 * and every token carries the offsets needed to recolour a rendered document.
 */
import { normalize, dirname, stem, slugify, titleFromPath } from './path.js';

const LINK_RE = /(!?)\[\[([^\[\]]+?)\]\]/g;

/** Strip fenced blocks and inline code, replacing them with spaces (offsets kept). */
export function maskCode(text) {
  const src = String(text ?? '');
  const out = src.split('');
  const blank = (start, end) => {
    for (let i = start; i < end && i < out.length; i += 1) {
      if (out[i] !== '\n') out[i] = ' ';
    }
  };

  const fence = /^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[^\n]*$/gm;
  let m;
  while ((m = fence.exec(src)) !== null) blank(m.index, m.index + m[0].length);
  // Unterminated fence: mask to the end of the document.
  const open = /^[ \t]*(`{3,}|~{3,})[^\n]*$/m.exec(src);
  if (open && src.indexOf(open[1], open.index + open[0].length) === -1) {
    blank(open.index, src.length);
  }

  for (const inline of src.matchAll(/`[^`\n]*`/g)) {
    blank(inline.index, inline.index + inline[0].length);
  }
  return out.join('');
}

/** Split a raw link body into target / alias / section. */
export function parseLinkBody(body) {
  const [targetPart, ...aliasParts] = String(body).split('|');
  const alias = aliasParts.length ? aliasParts.join('|').trim() : '';
  const raw = targetPart.trim();
  const hash = raw.indexOf('#');
  const target = hash === -1 ? raw : raw.slice(0, hash).trim();
  const section = hash === -1 ? '' : raw.slice(hash + 1).trim();
  return {
    target,
    section: section.startsWith('^') ? section : section,
    alias: alias || null,
    raw: String(body).trim(),
    samePage: target === '',
    anchor: section ? slugify(section.replace(/^\^/, '')) : '',
  };
}

/** All wiki links in a document body, in source order. */
export function parseWikiLinks(text) {
  const masked = maskCode(text);
  const links = [];
  LINK_RE.lastIndex = 0;
  let m;
  while ((m = LINK_RE.exec(masked)) !== null) {
    const body = parseLinkBody(m[2]);
    links.push({
      ...body,
      embed: m[1] === '!',
      start: m.index,
      end: m.index + m[0].length,
      raw_text: m[0],
    });
  }
  return links;
}

/** Outgoing link targets of one document, de-duplicated. */
export function outgoingLinks(text) {
  const seen = new Set();
  const out = [];
  for (const link of parseWikiLinks(text)) {
    const key = `${link.target}#${link.section}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(link);
  }
  return out;
}

/**
 * Resolve a wiki link against the vault index.
 *
 * Resolution order (Obsidian/Logseq-ish, but deterministic):
 *   1. an explicit vault-relative path (with or without `.md`)
 *   2. a document in the same chamber
 *   3. the shallowest document anywhere in the vault with that name
 *   4. a front-matter title / alias match
 *   5. a case-insensitive file-name match
 *
 * @returns {{ok: boolean, path: string|null, anchor: string, reason?: string,
 *            candidates: string[], ghost?: boolean}}
 */
export function resolveTarget(link, fromPath, index) {
  const docs = normalizeIndex(index);
  const anchor = link.anchor ?? (link.section ? slugify(link.section.replace(/^\^/, '')) : '');
  if (link.samePage) {
    return { ok: true, path: fromPath ?? null, anchor, candidates: [], samePage: true };
  }

  const target = normalize(String(link.target ?? '').split('|')[0].trim());
  if (!target) return { ok: false, path: null, anchor, reason: 'empty', candidates: [] };

  const byPath = new Map(docs.map((d) => [d.path.toLowerCase(), d.path]));
  const withExt = /\.(md|markdown|mdx)$/i.test(target) ? target : `${target}.md`;

  // 1. explicit path
  for (const candidate of [target, withExt]) {
    const hit = byPath.get(candidate.toLowerCase());
    if (hit) return { ok: true, path: hit, anchor, candidates: [] };
  }

  // 2. same chamber first
  const chamber = dirname(fromPath ?? '');
  const scored = [];
  for (const doc of docs) {
    if (doc.path === fromPath) continue;
    let score = 0;
    const sameDir = dirname(doc.path) === chamber;
    const stemMatch = doc.stem.toLowerCase() === stem(target).toLowerCase();
    const fullMatch = doc.path.toLowerCase() === withExt.toLowerCase();
    if (!stemMatch && !fullMatch) continue;
    score += sameDir ? 100 : 0;
    score += fullMatch ? 50 : 0;
    score += Math.max(0, 40 - doc.depth * 4);
    if (doc.title && doc.title.toLowerCase() === target.toLowerCase()) score += 20;
    scored.push({ path: doc.path, score });
  }
  if (scored.length) {
    scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    return { ok: true, path: scored[0].path, anchor, candidates: scored.map((s) => s.path) };
  }

  // 4/5. aliases, then loose case-insensitive match
  const loose = docs
    .filter((d) => d.aliases.some((a) => a.toLowerCase() === target.toLowerCase()))
    .map((d) => d.path);
  if (loose.length) {
    loose.sort();
    return { ok: true, path: loose[0], anchor, candidates: loose };
  }

  return {
    ok: false,
    path: null,
    anchor,
    ghost: true,
    reason: 'missing',
    candidates: [],
    suggestedPath: `${chamber ? `${chamber}/` : ''}${target.replace(/[\\/]+/g, '/')}${/\.(md|markdown|mdx)$/i.test(target) ? '' : '.md'}`,
  };
}

/**
 * Normalise whatever the vault index looks like into the shape the resolver
 * needs: `{ path, stem, title, aliases, depth, headings }`.
 */
export function normalizeIndex(index) {
  const list = Array.isArray(index) ? index : Object.values(index ?? {});
  return list.map((entry) => {
    const path = typeof entry === 'string' ? entry : String(entry.path ?? '');
    return {
      path,
      stem: typeof entry === 'string' ? stem(path) : (entry.stem ?? stem(path)),
      title: typeof entry === 'string' ? titleFromPath(path) : (entry.title ?? titleFromPath(path)),
      aliases: (typeof entry === 'string' ? [] : (entry.aliases ?? [])).map(String),
      headings: typeof entry === 'string' ? [] : (entry.headings ?? []),
      depth: typeof entry === 'string'
        ? path.split('/').length - 1
        : (entry.depth ?? path.split('/').length - 1),
    };
  });
}

/**
 * The links in one document that name one heading of one vein, as a click on
 * them would open it: `[[Methods#Sieve series]]` counts when it resolves to
 * `path`, however the target was spelled — path, file name or alias.
 *
 * Same-page links are left out: those never name a vein, and the whole-document
 * rename rewrites them where the document is already open. Block references
 * (`[[#^quote]]`) and section-less links are left out too.
 *
 * @param {Array} links `parseWikiLinks` output, or the `links` of an index entry
 * @param {{fromPath?: string, index?: Array, path?: string, anchor?: string}} where
 * @returns {Array} the links to rewrite, in source order
 */
export function linksToHeading(links = [], { fromPath = null, index = [], path = '', anchor = '' } = {}) {
  const wanted = String(anchor ?? '');
  if (!path || !wanted) return [];
  const docs = normalizeIndex(index);
  const out = [];
  for (const link of links ?? []) {
    if (link.samePage) continue;
    const section = String(link.section ?? '');
    if (!section || section.startsWith('^')) continue;
    if ((link.anchor ?? slugify(section)) !== wanted) continue;
    const resolved = resolveTarget({ target: String(link.target ?? ''), section }, fromPath, docs);
    if (resolved.ok && resolved.path === path) out.push(link);
  }
  return out;
}

/**
 * Point links that named one heading at another title: `[[Other#Old]]` becomes
 * `[[Other#New]]`. The target is kept exactly as it was written, and so are an
 * alias (`[[Other#Old|the old one]]` → `[[Other#New|the old one]]`) and an embed
 * marker. Edits run right to left, so each one leaves the offsets before it
 * alone.
 *
 * A title that cannot be written inside brackets — one holding a pipe or square
 * brackets — leaves the text as it is rather than writing markdown that would
 * not read back.
 *
 * @param {string} text the document body
 * @param {Array} hits links from {@link linksToHeading} or `parseWikiLinks`
 * @param {string} title the heading's new title, written verbatim
 * @returns {{text: string, rewritten: number}} the body and how many links
 *   changed — the same text and 0 when there was nothing to rewrite
 */
export function retitleSectionLinks(text, hits = [], title = '') {
  const src = String(text ?? '');
  const wanted = String(title ?? '').trim();
  const usable = (hits ?? []).filter((link) => Number.isFinite(link?.start)
    && Number.isFinite(link?.end) && link.end > link.start);
  if (!wanted || /[[\]|]/.test(wanted) || !usable.length) return { text: src, rewritten: 0 };
  let out = src;
  let rewritten = 0;
  for (const hit of [...usable].sort((a, b) => b.start - a.start)) {
    const target = String(hit.target ?? '').trim();
    const alias = hit.alias ? `|${hit.alias}` : '';
    const body = target ? `${target}#${wanted}${alias}` : `#${wanted}${alias}`;
    out = `${out.slice(0, hit.start)}${hit.embed ? '!' : ''}[[${body}]]${out.slice(hit.end)}`;
    rewritten += 1;
  }
  return { text: out, rewritten };
}

/** Display text for a rendered link. */
export function linkLabel(link, resolved) {
  if (link.alias) return link.alias;
  if (link.samePage) return link.section || 'this page';
  const path = resolved?.path ?? link.target;
  const name = titleFromPath(path);
  return link.section ? `${name} › ${link.section}` : name;
}

/** Extract `#tags` written outside code, ignoring markdown headings. */
export function parseTags(text) {
  const masked = maskCode(String(text ?? '').replace(/^#{1,6} .*$/gm, ''));
  const tags = new Set();
  for (const m of masked.matchAll(/(^|[\s(,])#([\p{L}\p{N}][\p{L}\p{N}/_-]*)/gu)) {
    tags.add(m[2]);
  }
  return [...tags];
}
