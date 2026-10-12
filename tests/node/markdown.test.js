import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, extractHeadings } from '../../src/ui/markdown.js';

const ctx = {
  currentPath: 'Home.md',
  resolveLink: (link) => (link.target === 'Glossary'
    ? { ok: false, path: null, anchor: link.anchor ?? '', label: 'Glossary', ghost: true, suggestedPath: 'Glossary.md' }
    : { ok: true, path: `${link.target}.md`, anchor: link.anchor ?? '', label: link.target, ghost: false }),
  colorFor: (kind, parts) => {
    if (kind === 'page') return parts.path === 'Home.md' ? '#ffd700' : '#87ceeb';
    if (kind === 'link') return '#ff8c00';
    return '#a0d911';
  },
};

const render = (source) => renderMarkdown(source, ctx);

test('headings get an anchor, a swatch and a stable id', () => {
  const { html } = render('# Home\n\n## The three panes\n');
  assert.match(html, /<h1 id="home"[^>]*data-anchor="home"/);
  assert.match(html, /<h2 id="the-three-panes"[^>]*data-anchor="the-three-panes"/);
  assert.match(html, /class="color-swatch" data-color-target="[^"]*section[^"]*"/);
  assert.deepEqual(extractHeadings(html), [
    { level: 1, text: 'Home', anchor: 'home' },
    { level: 2, text: 'The three panes', anchor: 'the-three-panes' },
  ]);
});

test('wiki links render as links with a colour fade to the target', () => {
  const { html } = render('See [[Analytical Methods]].\n');
  assert.match(html, /class="wikilink"/);
  assert.match(html, /data-resolved="Analytical Methods.md"/);
  assert.match(html, /--fade-from:#ff8c00;--fade-to:#87ceeb/);
  assert.match(html, /class="wikilink-label">Analytical Methods</);
});

test('aliased links show the alias, section links show the heading', () => {
  const aliased = render('[[Analytical Methods|the methods]]').html;
  assert.match(aliased, /class="wikilink-label">the methods</);
  const section = render('[[Fluid Inclusions#What they record]]').html;
  assert.match(section, /data-section="What they record"/);
  assert.match(section, /class="wikilink-section">#What they record</);
});

test('an unwritten target renders as a ghost that can be created', () => {
  const { html } = render('[[Glossary]]');
  assert.match(html, /wikilink-ghost/);
  assert.match(html, /data-ghost="true"/);
  assert.match(html, /title="Create Glossary"/);
});

test('same-page links stay on the page', () => {
  const { html } = render('[[#Field checklist]]');
  assert.match(html, /wikilink-anchor/);
  assert.match(html, /data-section="Field checklist"/);
  assert.match(html, /Field checklist</);
});

test('embeds are marked as reference cards', () => {
  const { html } = render('![[Sampling Plan]]');
  assert.match(html, /wikilink-embed-wrap/);
  assert.match(html, /wikilink-embed-mark/);
});

test('mermaid fences become placeholders and keep their source', () => {
  const { html, mermaid } = render('```mermaid\nflowchart LR\n  A --> B\n```');
  assert.equal(mermaid.size, 1);
  const [id, source] = [...mermaid.entries()][0];
  assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /mermaid-figure/);
  assert.equal(source.trim(), 'flowchart LR\n  A --> B');
  assert.match(html, /A --&gt; B/, 'the source is escaped until mermaid renders it');
});

test('code fences and inline code are never treated as markdown features', () => {
  const fenced = render('```js\nconst x = [[NotALink]];\n```').html;
  assert.equal(fenced.includes('wikilink'), false);
  const inline = render('Use `[[Brackets]]` literally.').html;
  assert.equal(inline.includes('wikilink'), false);
  assert.match(inline, /<code>\[\[Brackets\]\]<\/code>/);
});

test('tables, task lists and callouts survive the round trip', () => {
  const { html } = render([
    '| a | b |',
    '| - | - |',
    '| 1 | 2 |',
    '',
    '- [x] done',
    '- [ ] todo',
    '',
    '> [!WARNING] careful',
  ].join('\n'));
  assert.match(html, /<table>/);
  assert.match(html, /<td>1<\/td>/);
  assert.match(html, /type="checkbox"/);
  assert.match(html, /md-alert-label md-alert-warning/);
});

test('external links are flagged for the system browser, vault links stay internal', () => {
  const { html } = render('[docs](https://example.com) and [methods](Chambers/Lab/Analytical%20Methods.md)');
  assert.match(html, /class="md-link md-link-external"/);
  assert.match(html, /data-external="true"/);
  assert.match(html, /href="https:\/\/example.com"/);
  assert.match(html, /data-vault-file="Chambers\/Lab\/Analytical Methods.md"/);
  assert.equal(/data-external/.test(html.match(/md-link-vault[^>]*/)[0]), false);
});

test('links to file names with spaces are encoded instead of broken', () => {
  const { html } = render('see [the methods](Chambers/Lab/Analytical Methods.md#Sieve series)');
  assert.match(html, /href="Chambers\/Lab\/Analytical%20Methods\.md#Sieve%20series"/);
  assert.match(html, /data-vault-file="Chambers\/Lab\/Analytical Methods\.md#Sieve series"/);
});
