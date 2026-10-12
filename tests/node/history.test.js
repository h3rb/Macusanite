import test from 'node:test';
import assert from 'node:assert/strict';
import { NavHistory, colorKeys, colorFallbacks, resolveColorKey } from '../../src/lib/history.js';

const visit = (nav, path, section = '', via = null) => nav.push({ path, section, via });

test('back and forward walk the navigation stack', () => {
  const nav = new NavHistory();
  visit(nav, 'A.md');
  visit(nav, 'B.md');
  visit(nav, 'C.md');

  assert.equal(nav.canBack, true);
  assert.equal(nav.canForward, false);
  assert.equal(nav.back().path, 'B.md');
  assert.equal(nav.back().path, 'A.md');
  assert.equal(nav.canBack, false);
  assert.equal(nav.canForward, true);
  assert.equal(nav.forward().path, 'B.md');
});

test('revisiting the same page and section does not stack up', () => {
  const nav = new NavHistory();
  visit(nav, 'A.md', 'intro');
  visit(nav, 'A.md', 'intro');
  assert.equal(nav.entries.length, 1);
  visit(nav, 'A.md', 'other');
  assert.equal(nav.entries.length, 2);
});

test('navigating after going back discards the forward branch', () => {
  const nav = new NavHistory();
  visit(nav, 'A.md');
  visit(nav, 'B.md');
  visit(nav, 'C.md');
  nav.back();
  visit(nav, 'D.md');
  assert.equal(nav.canForward, false);
  assert.deepEqual(nav.entries.map((e) => e.path), ['A.md', 'B.md', 'D.md']);
});

test('the recent trail lists distinct previous pages, never the current one', () => {
  const nav = new NavHistory();
  visit(nav, 'A.md');
  visit(nav, 'B.md');
  visit(nav, 'C.md');
  assert.deepEqual(nav.recent(5).map((e) => e.path), ['B.md', 'A.md'], 'newest first');
  assert.deepEqual(nav.trail(5).map((e) => e.path), ['A.md', 'B.md'], 'oldest first, for the trail');

  // Revisiting a page moves it to the front instead of duplicating it.
  visit(nav, 'A.md');
  visit(nav, 'C.md');
  assert.deepEqual(nav.recent(5).map((e) => e.path), ['A.md', 'B.md']);
  assert.deepEqual(nav.trail(5).map((e) => e.path), ['B.md', 'A.md']);
});

test('wiki breadcrumbs follow the link the reader clicked', () => {
  const nav = new NavHistory();
  visit(nav, 'Home.md');
  visit(nav, 'Methods.md', '', 'Home.md');
  visit(nav, 'Cesium.md', '', 'Methods.md');
  assert.deepEqual(nav.wikiTrail().map((e) => e.path), ['Home.md', 'Methods.md', 'Cesium.md']);
});

test('history survives a JSON round trip', () => {
  const nav = new NavHistory({ limit: 5 });
  visit(nav, 'A.md');
  visit(nav, 'B.md');
  const revived = NavHistory.fromJSON(JSON.parse(JSON.stringify(nav.toJSON())));
  assert.deepEqual(revived.entries.map((e) => e.path), ['A.md', 'B.md']);
  assert.equal(revived.canBack, true);
});

test('colour keys and fallbacks line up with the store', () => {
  assert.equal(colorKeys.page('A.md'), 'page:A.md');
  assert.equal(colorKeys.link('A.md', 'B.md'), 'link:A.md->B.md');
  assert.equal(colorKeys.section('A.md', 'intro'), 'section:A.md#intro');
  assert.deepEqual(colorFallbacks('section', { path: 'A.md' }), ['page:A.md']);
  assert.deepEqual(colorFallbacks('link', { from: 'A.md' }), ['page:A.md']);
  assert.equal(
    resolveColorKey({ 'page:A.md': '#ff8c00' }, 'section:A.md#x', colorFallbacks('section', { path: 'A.md' }), '#ffffff'),
    '#ff8c00',
  );
  assert.equal(resolveColorKey({}, 'section:A.md#x', [], '#ffffff'), '#ffffff');
});
