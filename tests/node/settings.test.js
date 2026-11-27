import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSettings, mergeSettings, resetDockSlides } from '../../src/lib/settings.js';

// The canvas dock keeps its two tabs whatever a vault's settings say: an id it
// does not know, a repeat or a missing tab must never cost the reader a panel.
test('the dock order keeps both tabs, once each', () => {
  const order = (worldbuild) => validateSettings({ worldbuild }).worldbuild.dockOrder;
  assert.deepEqual(order({ dockOrder: ['inspector', 'navigator'] }), ['inspector', 'navigator']);
  assert.deepEqual(order({ dockOrder: ['inspector', 'inspector', 'bogus'] }), ['inspector', 'navigator']);
  assert.deepEqual(order({ dockOrder: 'navigator' }), ['navigator', 'inspector']);
  assert.deepEqual(order({}), ['navigator', 'inspector']);
});

// A panel's place on the edge is a share of its height, saved once a grip moves
// it. Anything else reads as "never moved", which keeps the centred pair.
test('dock slides keep a share of the edge, or no place at all', () => {
  const slides = (worldbuild) => validateSettings({ worldbuild }).worldbuild.dockSlides;
  assert.deepEqual(slides({ dockSlides: { navigator: 0.12, inspector: 0.8 } }), { navigator: 0.12, inspector: 0.8 });
  assert.deepEqual(slides({ dockSlides: { navigator: -0.5, inspector: 1.4 } }), { navigator: 0, inspector: 1 });
  assert.deepEqual(slides({ dockSlides: { navigator: 0.5 } }), { navigator: 0.5, inspector: null });
  assert.deepEqual(slides({ dockSlides: { navigator: '0.3', inspector: Number.NaN } }), { navigator: null, inspector: null });
  assert.deepEqual(slides({}), { navigator: null, inspector: null });
});

// A dragged place is a number, and a patch cannot put null back: `deepMerge`
// drops null, which is exactly the value that means "never moved". The reset
// replaces the slides, so both cards return to their centred pair.
test('resetting the panel places restores the centred pair', () => {
  const moved = validateSettings({ worldbuild: { dockSlides: { navigator: 0.1, inspector: 0.7 } } });
  const patched = mergeSettings(moved, { worldbuild: { dockSlides: { navigator: null, inspector: null } } });
  assert.deepEqual(patched.worldbuild.dockSlides, { navigator: 0.1, inspector: 0.7 });
  const reset = resetDockSlides(moved);
  assert.deepEqual(reset.worldbuild.dockSlides, { navigator: null, inspector: null });
  // The reset touches nothing else, and its result merges like any settings.
  assert.equal(reset.worldbuild.navigatorDock, moved.worldbuild.navigatorDock);
  assert.equal(reset.worldbuild.inspectorDock, moved.worldbuild.inspectorDock);
  assert.deepEqual(mergeSettings(reset, {}).worldbuild.dockSlides, { navigator: null, inspector: null });
});

// A folded inspector opens for the seconds the reader chose when a card
// arrives; 0 keeps it open, and anything unusable falls back to seven.
test('the inspector peek is a number of seconds, seven by default', () => {
  const peek = (worldbuild) => validateSettings({ worldbuild }).worldbuild.inspectorPeek;
  assert.equal(peek({}), 7);
  assert.equal(peek({ inspectorPeek: 12 }), 12);
  assert.equal(peek({ inspectorPeek: 0 }), 0);
  assert.equal(peek({ inspectorPeek: -3 }), 0);
  assert.equal(peek({ inspectorPeek: 500 }), 120);
  assert.equal(peek({ inspectorPeek: 'bogus' }), 7);
  assert.equal(peek({ inspectorPeek: '9' }), 9);
});

// Each panel chooses the edge or a floating card on its own, and an old vault
// that only knew the navigator's choice keeps the inspector on the edge.
test('each panel keeps its own placement', () => {
  const world = (worldbuild) => validateSettings({ worldbuild }).worldbuild;
  assert.equal(world({ navigatorDock: 'drawer', inspectorDock: 'float' }).navigatorDock, 'drawer');
  assert.equal(world({ navigatorDock: 'drawer', inspectorDock: 'float' }).inspectorDock, 'float');
  assert.equal(world({ navigatorDock: 'float' }).inspectorDock, 'drawer');
  assert.equal(world({ inspectorDock: 'bogus' }).inspectorDock, 'drawer');
});

// A floating card's place is a share of the room it can move in; anything else
// reads as "never moved", which keeps its own corner.
test('floating places are fractions, or nothing', () => {
  const places = (worldbuild) => validateSettings({ worldbuild }).worldbuild.floatPlaces;
  assert.deepEqual(places({ floatPlaces: { navigator: { x: 0.25, y: 0.75 }, inspector: { x: 1, y: 0 } } }), {
    navigator: { x: 0.25, y: 0.75 },
    inspector: { x: 1, y: 0 },
  });
  assert.deepEqual(places({ floatPlaces: { navigator: { x: -0.5, y: 1.4 } } }), {
    navigator: { x: 0, y: 1 },
    inspector: null,
  });
  assert.deepEqual(places({ floatPlaces: { navigator: 'top left', inspector: { x: '1', y: 0 } } }), {
    navigator: null,
    inspector: null,
  });
  assert.deepEqual(places({}), { navigator: null, inspector: null });
});

