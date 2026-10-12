import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontmatter, documentMeta, stringifyFrontmatter } from '../../src/lib/frontmatter.js';
import {
  DEFAULT_SETTINGS, DEFAULT_VAULT_META, mergeSettings, mergeVaultMeta, rememberColor, validateSettings,
} from '../../src/lib/settings.js';

test('front matter parses scalars, inline lists and block lists', () => {
  const { data, body, present } = parseFrontmatter([
    '---',
    'title: Fluid inclusions',
    "color: '#ff8c00'",
    'tags: [petrology, melt]',
    'aliases:',
    '  - MI',
    '  - bubble notes',
    'weight: 12',
    'draft: false',
    '---',
    '# Body',
  ].join('\n'));

  assert.equal(present, true);
  assert.equal(data.title, 'Fluid inclusions');
  assert.equal(data.color, '#ff8c00');
  assert.deepEqual(data.tags, ['petrology', 'melt']);
  assert.deepEqual(data.aliases, ['MI', 'bubble notes']);
  assert.equal(data.weight, 12);
  assert.equal(data.draft, false);
  assert.equal(body.startsWith('# Body'), true);
});

test('documents without front matter pass through untouched', () => {
  const { data, body, present } = parseFrontmatter('# Just markdown\n\nhello');
  assert.equal(present, false);
  assert.deepEqual(data, {});
  assert.equal(body, '# Just markdown\n\nhello');
});

test('documentMeta normalises the fields the viewer uses', () => {
  const meta = documentMeta({
    title: 'Cesium Enrichment',
    color: 'Violet',
    'link-color': 'coral',
    tags: 'petrology, geochemistry',
    aliases: 'Cs, caesium',
  });
  assert.equal(meta.title, 'Cesium Enrichment');
  assert.equal(meta.pageColor, '#ee82ee');
  assert.equal(meta.linkColor, '#ff7f50');
  assert.deepEqual(meta.tags, ['petrology', 'geochemistry']);
  assert.deepEqual(meta.aliases, ['Cs', 'caesium']);
  assert.equal(documentMeta({}).pageColor, null);
});

test('front matter can be written back out', () => {
  const text = stringifyFrontmatter({ title: 'T', tags: ['a', 'b'], skip: null });
  assert.equal(text, '---\ntitle: T\ntags: [a, b]\n---\n');
});

test('nested settings keep their own shape (no top-level keys leak in)', () => {
  const merged = mergeSettings(DEFAULT_SETTINGS, { graph: { depth: 3 }, layout: { graphWidth: 500 } });
  assert.deepEqual(Object.keys(merged.graph).sort(), Object.keys(DEFAULT_SETTINGS.graph).sort());
  assert.deepEqual(Object.keys(merged.layout).sort(), Object.keys(DEFAULT_SETTINGS.layout).sort());
  assert.equal(merged.graph.graph, undefined);
  assert.equal(merged.graph.defaultPageColor, undefined);
  assert.equal(merged.graph.depth, 3);
  assert.equal(merged.layout.graphWidth, 500);
});

test('settings merge over defaults and reject junk', () => {
  const merged = mergeSettings(DEFAULT_SETTINGS, {
    theme: 'light',
    fontSize: 999,
    defaultPageColor: 'not-a-colour',
    unknownKey: true,
    graph: { depth: 3 },
  });
  assert.equal(merged.theme, 'light');
  assert.equal(merged.fontSize, 28, 'out-of-range numbers are clamped to the setting limits');
  assert.equal(merged.defaultPageColor, '#ffffff', 'invalid colours fall back to the default');
  assert.equal(merged.unknownKey, undefined, 'unknown keys are dropped');
  assert.equal(merged.graph.depth, 3);
  assert.equal(merged.graph.showSections, DEFAULT_SETTINGS.graph.showSections, 'nested defaults survive');
});

test('every colour default starts white', () => {
  assert.equal(DEFAULT_SETTINGS.defaultPageColor, '#ffffff');
  assert.equal(DEFAULT_SETTINGS.defaultLinkColor, '#ffffff');
  assert.equal(DEFAULT_SETTINGS.defaultSectionColor, '#ffffff');
});

test('validation clamps numbers and normalises colours in place', () => {
  const validated = validateSettings({
    ...DEFAULT_SETTINGS,
    fontSize: 40,
    lineWidth: 1,
    defaultLinkColor: 'SlateBlue',
    palette: ['#fff', 'nonsense'],
    recentColors: ['Coral', 'junk'],
  });
  assert.equal(validated.fontSize, 28);
  assert.equal(validated.lineWidth, 40);
  assert.equal(validated.defaultLinkColor, '#6a5acd');
  assert.deepEqual(validated.palette, ['#ffffff']);
  assert.deepEqual(validated.recentColors, ['#ff7f50']);
});

test('vault metadata merges and defaults', () => {
  const meta = mergeVaultMeta({ name: '  My Vault  ', description: 'hi' });
  assert.equal(meta.name, 'My Vault');
  assert.equal(meta.description, 'hi');
  assert.equal(meta.version, DEFAULT_VAULT_META.version);
  assert.equal(mergeVaultMeta(null).name, 'Untitled Vault');
  assert.equal(mergeVaultMeta({ name: '   ' }).name, 'Untitled Vault');
});

test('recent colours are de-duplicated and capped', () => {
  assert.deepEqual(rememberColor(['#ff0000', '#00ff00'], '#ff0000'), ['#ff0000', '#00ff00']);
  assert.deepEqual(rememberColor(['#00ff00'], 'coral'), ['#ff7f50', '#00ff00']);
  assert.deepEqual(rememberColor(['#00ff00'], 'nonsense'), ['#00ff00']);
  const many = rememberColor(Array.from({ length: 40 }, (_, i) => `#0000${(i % 10)}${i % 10}`), '#ffffff', 4);
  assert.equal(many.length, 4);
});
