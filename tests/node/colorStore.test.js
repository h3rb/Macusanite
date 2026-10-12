import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyColorSet, colorKey, assignedColor, resolveColor, setColor, clearColor,
  pruneColorSet, colorStats, describeTarget, serializeColorSet, parseColorSet,
} from '../../src/lib/colorStore.js';

const DEFAULTS = {
  defaultPageColor: '#ffffff',
  defaultLinkColor: '#ffffff',
  defaultSectionColor: '#ffffff',
};

test('colour keys are stable and namespaced per kind', () => {
  assert.equal(colorKey('page', { path: 'A.md' }), 'A.md');
  assert.equal(colorKey('section', { path: 'A.md', anchor: 'intro' }), 'A.md#intro');
  assert.equal(colorKey('link', { from: 'A.md', to: 'B.md' }), 'A.md->B.md');
  assert.equal(colorKey('link', { from: 'A.md', to: 'B.md', section: 'intro' }), 'A.md->B.md#intro');
  assert.equal(colorKey('concept', { name: 'Glossary' }), 'glossary');
});

test('everything starts white', () => {
  const colors = emptyColorSet();
  assert.equal(resolveColor(colors, 'page', { path: 'A.md' }, DEFAULTS), '#ffffff');
  assert.equal(resolveColor(colors, 'link', { from: 'A.md', to: 'B.md' }, DEFAULTS), '#ffffff');
  assert.equal(resolveColor(colors, 'section', { path: 'A.md', anchor: 'x' }, DEFAULTS), '#ffffff');
});

test('sections inherit their page, links inherit their source page', () => {
  let colors = emptyColorSet();
  colors = setColor(colors, 'page', { path: 'A.md' }, '#ff8c00').colors;

  assert.equal(resolveColor(colors, 'page', { path: 'A.md' }, DEFAULTS), '#ff8c00');
  assert.equal(resolveColor(colors, 'section', { path: 'A.md', anchor: 'intro' }, DEFAULTS), '#ff8c00');
  assert.equal(resolveColor(colors, 'link', { from: 'A.md', to: 'B.md' }, DEFAULTS), '#ff8c00');
  assert.equal(resolveColor(colors, 'link', { from: 'C.md', to: 'A.md' }, DEFAULTS), '#ffffff');
});

test('explicit assignments win over inheritance, across all kinds', () => {
  let colors = emptyColorSet();
  colors = setColor(colors, 'page', { path: 'A.md' }, '#ff8c00').colors;
  colors = setColor(colors, 'section', { path: 'A.md', anchor: 'intro' }, '#52c41a').colors;
  colors = setColor(colors, 'link', { from: 'A.md', to: 'B.md' }, '#da70d6').colors;
  colors = setColor(colors, 'concept', { name: 'Glossary' }, '#87ceeb').colors;

  assert.equal(resolveColor(colors, 'section', { path: 'A.md', anchor: 'intro' }, DEFAULTS), '#52c41a');
  assert.equal(resolveColor(colors, 'section', { path: 'A.md', anchor: 'other' }, DEFAULTS), '#ff8c00');
  assert.equal(resolveColor(colors, 'link', { from: 'A.md', to: 'B.md' }, DEFAULTS), '#da70d6');
  assert.equal(resolveColor(colors, 'concept', { name: 'glossary' }, DEFAULTS), '#87ceeb');
});

test('front matter seeds a page colour, and picking overrides it', () => {
  const overrides = { 'A.md': '#ffd700' };
  assert.equal(resolveColor(emptyColorSet(), 'page', { path: 'A.md' }, DEFAULTS, overrides), '#ffd700');
  assert.equal(resolveColor(emptyColorSet(), 'page', { path: 'B.md' }, DEFAULTS, overrides), '#ffffff');

  // A colour chosen in the picker must win, otherwise the picker would look
  // broken on any page that declares a front-matter colour.
  const picked = setColor(emptyColorSet(), 'page', { path: 'A.md' }, '#111111').colors;
  assert.equal(resolveColor(picked, 'page', { path: 'A.md' }, DEFAULTS, overrides), '#111111');

  // Sections and links still start from the page's front-matter colour.
  assert.equal(resolveColor(emptyColorSet(), 'section', { path: 'A.md', anchor: 'x' }, DEFAULTS, overrides), '#ffd700');
  assert.equal(resolveColor(emptyColorSet(), 'link', { from: 'A.md', to: 'B.md' }, DEFAULTS, overrides), '#ffd700');
});

test('defaults come from settings and accept X11 names', () => {
  const colors = emptyColorSet();
  const settings = { defaultPageColor: 'Coral', defaultLinkColor: '#abcdef', defaultSectionColor: 'SlateBlue' };
  assert.equal(resolveColor(colors, 'page', { path: 'A.md' }, settings), '#ff7f50');
  assert.equal(resolveColor(colors, 'link', { from: 'A.md', to: 'B.md' }, settings), '#abcdef');
  assert.equal(resolveColor(colors, 'section', { path: 'A.md', anchor: 'x' }, settings), '#6a5acd');
});

test('setColor and clearColor are immutable and reject junk', () => {
  const before = emptyColorSet();
  const { colors: after, key } = setColor(before, 'page', { path: 'A.md' }, 'Coral');
  assert.equal(key, 'A.md');
  assert.deepEqual(before.pages, {}, 'the input set is untouched');
  assert.equal(after.pages['A.md'], '#ff7f50');
  assert.equal(assignedColor(after, 'page', { path: 'A.md' }), '#ff7f50');

  const junk = setColor(after, 'page', { path: 'B.md' }, 'not-a-colour');
  assert.equal(assignedColor(junk.colors, 'page', { path: 'B.md' }), null);

  const cleared = clearColor(after, 'page', { path: 'A.md' });
  assert.equal(assignedColor(cleared, 'page', { path: 'A.md' }), null);
});

test('pruning drops assignments for veins that no longer exist', () => {
  let colors = emptyColorSet();
  colors = setColor(colors, 'page', { path: 'A.md' }, '#ff0000').colors;
  colors = setColor(colors, 'section', { path: 'A.md', anchor: 'x' }, '#00ff00').colors;
  colors = setColor(colors, 'link', { from: 'A.md', to: 'Gone.md' }, '#0000ff').colors;
  colors = setColor(colors, 'concept', { name: 'kept' }, '#ffff00').colors;

  const pruned = pruneColorSet(colors, ['A.md', 'B.md']);
  assert.equal(pruned.pages['A.md'], '#ff0000');
  assert.equal(pruned.sections['A.md#x'], '#00ff00');
  assert.equal(pruned.concepts.kept, '#ffff00');
  assert.equal(
    pruned.links['A.md->Gone.md'],
    '#0000ff',
    'a link colour survives while either end still exists, so recreating the target restores it',
  );

  const orphaned = pruneColorSet(colors, ['B.md']);
  assert.equal(orphaned.links['A.md->Gone.md'], undefined, 'both ends gone: drop it');
  assert.equal(orphaned.pages['A.md'], undefined);
  assert.equal(orphaned.concepts.kept, '#ffff00', 'concept colours are never pruned');
});

test('serialisation round trips and survives corruption', () => {
  let colors = emptyColorSet();
  colors = setColor(colors, 'page', { path: 'A.md' }, '#ff8c00').colors;
  const raw = serializeColorSet(colors);
  assert.equal(raw.endsWith('\n'), true);
  assert.deepEqual(parseColorSet(raw), colors);
  assert.deepEqual(parseColorSet('{oops'), emptyColorSet());
  assert.deepEqual(parseColorSet(null), emptyColorSet());
});

test('describeTarget labels every kind of colour target', () => {
  assert.equal(describeTarget('page', { path: 'A.md' }).title, 'Page colour');
  assert.equal(describeTarget('section', { path: 'A.md', anchor: 'x', name: 'Intro' }).title, 'Section: Intro');
  assert.equal(describeTarget('link', { from: 'A.md', to: 'B.md' }).subtitle, 'A.md → B.md');
  assert.equal(colorStats(emptyColorSet()).total, 0);
});
