/**
 * Markdown rendering.
 *
 * `marked` does the heavy lifting; this module adds the four things a wiki needs:
 *   1. `[[wiki links]]` as recolourable, clickable anchors
 *   2. a colour swatch beside every heading and every link
 *   3. stable heading anchors, so `[[Note#Heading]]` resolves
 *   4. mermaid fences, rendered once the HTML is in the document
 */
import { Marked } from 'marked';
import { slugify } from '../lib/path.js';

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const escapeAttr = (value) => escapeHtml(value).replace(/'/g, '&#39;');

/** Flatten a marked token into its plain text. */
function tokenText(token) {
  if (token === null || token === undefined) return '';
  if (typeof token === 'string') return token;
  if (Array.isArray(token)) return token.map(tokenText).join('');
  if (token.tokens) return tokenText(token.tokens);
  return token.text ?? token.raw ?? '';
}

/** GitHub-flavoured `> [!NOTE]` alerts, styled by CSS. */
function preprocessAlerts(source) {
  return String(source ?? '').replace(
    /^([ \t]*)>[ \t]*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(.*)$/gim,
    (_m, indent, kind, rest) => `${indent}> <span class="md-alert-label md-alert-${kind.toLowerCase()}">${kind}</span>${rest ? ` ${rest}` : ''}`,
  );
}

/**
 * Vault file names contain spaces, but CommonMark link destinations may not.
 * Encode the destinations of `[text](Some Note.md)` so hand-written links to
 * real files keep working.
 */
function preprocessLinks(source) {
  return String(source ?? '').replace(/\]\((?!<)([^)\n]*?)\)/g, (match, destination) => {
    const url = destination.trim();
    if (!url || /["']/.test(url) || !/\s/.test(url)) return match;
    if (!/\.(md|markdown|mdx)(#.*)?$/i.test(url)) return match;
    return `](${encodeURI(url)})`;
  });
}

/** Inline swatch markup, reused by breadcrumbs, the sidebar and the graph. */
export function colorSwatch(kind, parts, color, title) {
  const target = encodeURIComponent(JSON.stringify({ kind, ...parts }));
  return `<button type="button" class="color-swatch" data-color-target="${escapeAttr(target)}" title="${escapeAttr(title ?? 'Set colour')}" style="--swatch:${escapeAttr(color)}" aria-label="${escapeAttr(title ?? 'Set colour')}"></button>`;
}

function parseLinkBody(body) {
  const [targetPart, ...aliasParts] = String(body).split('|');
  const alias = aliasParts.length ? aliasParts.join('|').trim() : '';
  const raw = targetPart.trim();
  const hash = raw.indexOf('#');
  const target = hash === -1 ? raw : raw.slice(0, hash).trim();
  const section = hash === -1 ? '' : raw.slice(hash + 1).trim();
  return { target, section, alias, samePage: target === '' };
}

function createMarked(ctx) {
  const marked = new Marked({
    gfm: true,
    breaks: false,
    pedantic: false,
    mangle: false,
  });

  marked.use({
    extensions: [
      {
        name: 'wikilink',
        level: 'inline',
        start(src) {
          const i = src.indexOf('[[');
          return i === -1 ? undefined : i;
        },
        tokenizer(src) {
          const match = /^(!?)\[\[([^\[\]]+?)\]\]/.exec(src);
          if (!match) return undefined;
          return { type: 'wikilink', raw: match[0], embed: match[1] === '!', body: match[2] };
        },
        renderer(token) {
          return renderWikiLink(token, ctx);
        },
      },
    ],
    renderer: {
      heading({ tokens, depth }) {
        const plain = tokenText(tokens).trim();
        const anchor = slugify(plain) || `section-${depth}`;
        const color = ctx.colorFor('section', { path: ctx.currentPath, anchor, name: plain });
        const swatch = colorSwatch(
          'section',
          { path: ctx.currentPath, anchor, name: plain },
          color,
          `Section colour: ${plain}`,
        );
        const inline = typeof this?.parser?.parseInline === 'function'
          ? this.parser.parseInline(tokens)
          : escapeHtml(plain);
        return `<h${depth} id="${escapeAttr(anchor)}" class="md-heading md-h${depth}" data-anchor="${escapeAttr(anchor)}">` +
          `${swatch}<span class="md-heading-text">${inline}</span></h${depth}>\n`;
      },

      link({ href, title, tokens }) {
        const url = String(href ?? '');
        const external = /^(https?|mailto):/i.test(url);
        const inline = typeof this?.parser?.parseInline === 'function'
          ? this.parser.parseInline(tokens)
          : escapeHtml(tokenText(tokens));
        const titleAttr = title ? ` title="${escapeAttr(title)}"` : '';

        if (external) {
          // Handled by the viewer: the system browser opens it, so the app
          // window is never navigated away from the vault.
          return `<a class="md-link md-link-external" href="${escapeAttr(url)}" data-external="true"${titleAttr} rel="noreferrer noopener">${inline}<span class="ext-mark">↗</span></a>`;
        }

        const isVaultFile = /\.(md|markdown|mdx)(#.*)?$/i.test(url);
        const attrs = isVaultFile
          ? ` data-vault-file="${escapeAttr(decodeURIComponent(url))}"`
          : '';
        return `<a class="md-link${isVaultFile ? ' md-link-vault' : ''}" href="${escapeAttr(url)}"${attrs}${titleAttr}>${inline}</a>`;
      },

      code({ text, lang }) {
        const language = String(lang ?? '').trim().split(/\s+/)[0].toLowerCase();
        if (language === 'mermaid') {
          const id = `mermaid-${Math.random().toString(36).slice(2, 9)}`;
          mermaidBlocks.set(id, String(text ?? ''));
          return `<figure class="mermaid-figure" data-mermaid-id="${id}">` +
            `<div class="mermaid-host" id="${id}"><pre class="mermaid-source"><code>${escapeHtml(text)}</code></pre></div>` +
            `<figcaption class="mermaid-caption">mermaid</figcaption></figure>`;
        }
        return `<pre class="md-code" data-lang="${escapeAttr(language)}"><code class="language-${escapeAttr(language)}">${escapeHtml(text)}</code></pre>`;
      },
    },
  });

  return marked;
}

function renderWikiLink(token, ctx) {
  const parsed = parseLinkBody(token.body);
  const resolved = ctx.resolveLink({ ...parsed, raw: token.body });
  const label = parsed.alias || resolved.label || parsed.section || parsed.target || 'link';
  const linkColor = ctx.colorFor('link', { from: ctx.currentPath, to: resolved.path, section: parsed.section });
  const targetColor = resolved.path
    ? ctx.colorFor('page', { path: resolved.path })
    : ctx.colorFor('concept', { name: resolved.label });

  const parts = { from: ctx.currentPath, to: resolved.path ?? parsed.target, section: parsed.section };
  const swatch = colorSwatch('link', parts, linkColor, `Link colour → ${parsed.target || parsed.section}`);

  const classes = ['wikilink'];
  if (!resolved.ok) classes.push('wikilink-ghost');
  if (token.embed) classes.push('wikilink-embed');
  if (parsed.samePage) classes.push('wikilink-anchor');

  const body = [
    `<span class="wikilink-fade" style="--fade-from:${escapeAttr(linkColor)};--fade-to:${escapeAttr(targetColor)}"></span>`,
    `<span class="wikilink-label">${escapeHtml(label)}</span>`,
    parsed.section && !parsed.samePage ? `<span class="wikilink-section">#${escapeHtml(parsed.section)}</span>` : '',
  ].join('');

  const attrs = [
    `class="${classes.join(' ')}"`,
    `data-target="${escapeAttr(parsed.target)}"`,
    `data-section="${escapeAttr(parsed.section)}"`,
    `data-resolved="${escapeAttr(resolved.path ?? '')}"`,
    resolved.ok ? '' : 'data-ghost="true"',
    `title="${escapeAttr(resolved.ok
      ? `Open ${resolved.path}${parsed.section ? ` § ${parsed.section}` : ''}`
      : `Create ${parsed.target || parsed.section}`)}"`,
  ].filter(Boolean).join(' ');

  if (token.embed) {
    return `<span class="wikilink-embed-wrap" data-embed-from="${escapeAttr(ctx.currentPath)}">${swatch}` +
      `<span ${attrs}>${body}</span><span class="wikilink-embed-mark" title="Reference card — the note itself stays where it is">⧉ reference</span></span>`;
  }
  return `<span class="wikilink-wrap">${swatch}<a ${attrs}>${body}</a></span>`;
}

/**
 * Rendered mermaid source, keyed by the placeholder id in the output HTML.
 * Cleared at the start of every {@link renderMarkdown} call.
 */
export const mermaidBlocks = new Map();

/**
 * @param {string} source markdown
 * @param {object} ctx
 * @param {(link: object) => object} ctx.resolveLink
 * @param {(kind: string, parts: object) => string} ctx.colorFor
 * @param {string} ctx.currentPath
 */
export function renderMarkdown(source, ctx) {
  mermaidBlocks.clear();
  const marked = createMarked(ctx);
  const html = marked.parse(preprocessLinks(preprocessAlerts(source)));
  return { html, mermaid: new Map(mermaidBlocks) };
}

/** Table of contents extracted from rendered HTML (headings carry anchors). */
export function extractHeadings(html) {
  const out = [];
  const re = /<h([1-6])[^>]*id="([^"]*)"[^>]*>[\s\S]*?<span class="md-heading-text">([\s\S]*?)<\/span>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    out.push({ level: Number(m[1]), anchor: m[2], text: m[3].replace(/<[^>]*>/g, '').trim() });
  }
  return out;
}

/** Replace mermaid placeholders with rendered diagrams, inline on failure. */
export async function renderMermaidIn(root, blocks, mermaidApi) {
  if (!blocks?.size) return;
  for (const [id, source] of blocks) {
    const host = root.querySelector(`[id="${id}"]`);
    if (!host) continue;
    try {
      const { svg } = await mermaidApi.render(`mmd-${id}`, source);
      host.innerHTML = svg;
      host.classList.add('mermaid-ready');
    } catch (error) {
      host.innerHTML = `<div class="mermaid-error"><strong>Mermaid could not render this diagram</strong>` +
        `<pre class="mermaid-error-message">${escapeHtml(error?.message ?? error)}</pre>` +
        `<pre class="mermaid-error-source">${escapeHtml(source)}</pre></div>`;
      host.classList.add('mermaid-failed');
    }
  }
}
