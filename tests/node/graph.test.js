import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDocumentIndex, extractHeadings, buildGraph, layoutGraph, graphStats,
  neighbours, docId, sectionId, conceptId, tagId, NODE, EDGE,
} from '../../src/lib/graph.js';
import { DEFAULT_SETTINGS } from '../../src/lib/settings.js';
import { resolveColor, setColor, emptyColorSet } from '../../src/lib/colorStore.js';

const BODIES = {
  'Home.md': `---\ntitle: Home\ncolor: '#ffd700'\ntags: [guide]\n---\n# Home\n\n## The three panes\n\nSee [[Chambers/Lab/Analytical Methods]] and [[Glossary]].\n`,
  'Chambers/Lab/Analytical Methods.md': `---\ntitle: Analytical Methods\n---\n# Analytical Methods\n\n## Sieve series\n\nBack to [[Home]].\n`,
  'Chambers/Lab/Cesium.md': '# Cesium\n\n## The problem\n\nSee [[Analytical Methods#Sieve series]].\n',
};

const makeColorOf = (colors = emptyColorSet(), settings = DEFAULT_SETTINGS) =>
  (kind, parts) => resolveColor(colors, kind, parts, settings);

test('extractHeadings skips fences and de-duplicates anchors', () => {
  const headings = extractHeadings([
    '# Title',
    '```md',
    '# not a heading',
    '```',
    '## Repeat',
    '## Repeat',
    '### Third level',
  ].join('\n'));
  assert.deepEqual(headings, [
    { level: 1, text: 'Title', anchor: 'title' },
    { level: 2, text: 'Repeat', anchor: 'repeat' },
    { level: 2, text: 'Repeat', anchor: 'repeat-1' },
    { level: 3, text: 'Third level', anchor: 'third-level' },
  ]);
});

test('the document index carries titles, aliases, tags, headings and links', () => {
  const index = buildDocumentIndex(BODIES);
  const home = index.find((d) => d.path === 'Home.md');
  assert.equal(home.title, 'Home');
  assert.equal(home.color, '#ffd700');
  assert.deepEqual(home.tags, ['guide']);
  assert.ok(home.aliases.includes('Home'));
  assert.deepEqual(home.headings.map((h) => h.anchor), ['home', 'the-three-panes']);
  assert.deepEqual(home.links.map((l) => l.target), ['Chambers/Lab/Analytical Methods', 'Glossary']);
});

test('the graph shows focus, sections, links, ghosts and tags', () => {
  const index = buildDocumentIndex(BODIES);
  const graph = buildGraph({ index, settings: DEFAULT_SETTINGS, focusPath: 'Home.md', colorOf: makeColorOf() });

  const ids = new Set(graph.nodes.map((n) => n.id));
  assert.ok(ids.has(docId('Home.md')), 'focus document node');
  assert.ok(ids.has(sectionId('Home.md', 'the-three-panes')), 'section node');
  assert.ok(ids.has(docId('Chambers/Lab/Analytical Methods.md')), 'linked document');
  assert.ok(ids.has(conceptId('Glossary')), 'ghost node for the unwritten page');
  assert.ok(ids.has(tagId('guide')), 'tag node');

  const ghost = graph.nodes.find((n) => n.id === conceptId('Glossary'));
  assert.equal(ghost.ghost, true);
  assert.equal(ghost.path, 'Glossary.md');
  assert.equal(ghost.kind, NODE.CONCEPT);

  const contains = graph.edges.find((e) => e.kind === EDGE.CONTAINS);
  assert.equal(contains.from, docId('Home.md'));
  assert.equal(contains.to, sectionId('Home.md', 'the-three-panes'));

  const link = graph.edges.find((e) => e.kind === EDGE.LINK && e.targetPath === 'Chambers/Lab/Analytical Methods.md');
  assert.equal(link.from, docId('Home.md'));
});

test('every edge carries both endpoint colours so the line can fade', () => {
  let colors = emptyColorSet();
  colors = setColor(colors, 'page', { path: 'Home.md' }, '#ffd700').colors;
  colors = setColor(colors, 'page', { path: 'Chambers/Lab/Analytical Methods.md' }, '#a0d911').colors;
  colors = setColor(colors, 'link', { from: 'Home.md', to: 'Chambers/Lab/Analytical Methods.md' }, '#ff8c00').colors;

  const index = buildDocumentIndex(BODIES);
  const graph = buildGraph({ index, settings: DEFAULT_SETTINGS, focusPath: 'Home.md', colorOf: makeColorOf(colors) });
  const link = graph.edges.find((e) => e.targetPath === 'Chambers/Lab/Analytical Methods.md');

  assert.equal(link.fromColor, '#ff8c00', 'the link uses its own colour at the source end');
  assert.equal(link.toColor, '#a0d911', 'and the target page colour at the other end');

  const ghost = graph.nodes.find((n) => n.id === conceptId('Glossary'));
  assert.equal(ghost.color, '#ffffff', 'unwritten pages start at the vault default');
});

test('section links in the graph point at the exact heading node', () => {
  const index = buildDocumentIndex(BODIES);
  const graph = buildGraph({ index, settings: DEFAULT_SETTINGS, focusPath: 'Chambers/Lab/Cesium.md', colorOf: makeColorOf() });
  const anchorId = sectionId('Chambers/Lab/Analytical Methods.md', 'sieve-series');
  assert.ok(graph.nodes.some((n) => n.id === anchorId), 'the referenced heading becomes a node');
  assert.ok(graph.edges.some((e) => e.to === anchorId), 'and the link points at it');
});

test('graph toggles actually remove node kinds', () => {
  const index = buildDocumentIndex(BODIES);
  const settings = {
    ...DEFAULT_SETTINGS,
    graph: { ...DEFAULT_SETTINGS.graph, showSections: false, showTags: false, showUnresolved: false, showContext: false },
  };
  const graph = buildGraph({ index, settings, focusPath: 'Home.md', colorOf: makeColorOf() });
  assert.equal(graph.nodes.some((n) => n.kind === NODE.SECTION), false);
  assert.equal(graph.nodes.some((n) => n.kind === NODE.TAG), false);
  assert.equal(graph.nodes.some((n) => n.kind === NODE.CONCEPT), false);
});

test('layout is deterministic and keeps every node inside the canvas', () => {
  const index = buildDocumentIndex(BODIES);
  const graph = buildGraph({ index, settings: DEFAULT_SETTINGS, focusPath: 'Home.md', colorOf: makeColorOf() });
  const a = layoutGraph(graph, { width: 400, height: 500, iterations: 120, seed: 7 });
  const b = layoutGraph(graph, { width: 400, height: 500, iterations: 120, seed: 7 });
  assert.deepEqual(a.nodes.map((n) => [n.id, n.x, n.y]), b.nodes.map((n) => [n.id, n.x, n.y]));
  for (const node of a.nodes) {
    assert.ok(node.x >= 18 && node.x <= 382, `${node.id} x in bounds`);
    assert.ok(node.y >= 18 && node.y <= 482, `${node.id} y in bounds`);
    assert.equal(typeof node.x, 'number');
  }
});

test('stats and neighbours describe the graph', () => {
  const index = buildDocumentIndex(BODIES);
  const graph = buildGraph({ index, settings: DEFAULT_SETTINGS, focusPath: 'Home.md', colorOf: makeColorOf() });
  const stats = graphStats(graph);
  assert.equal(stats.nodes, graph.nodes.length);
  assert.equal(stats.links, graph.edges.filter((e) => e.kind === EDGE.LINK).length);
  assert.ok(stats.ghosts >= 1);
  assert.ok(neighbours(graph, docId('Home.md')).includes(sectionId('Home.md', 'the-three-panes')));
});
