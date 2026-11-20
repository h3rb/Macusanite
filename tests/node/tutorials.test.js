import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TUTORIALS,
  TUTORIAL_IDS,
  cleanTutorialSeen,
  markTutorialSeen,
  tutorialIsKnown,
  tutorialWasSeen,
  clearTutorialSeen,
} from '../../src/lib/tutorials.js';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/lib/settings.js';

test('the tutorial registry names every teaching note once, with stable ids', () => {
  assert.deepEqual(TUTORIAL_IDS, ['object-map', 'search-quote', 'editor-shortcuts']);
  for (const tutorial of TUTORIALS) {
    // The ids are saved in settings, so they are slugs that cannot drift.
    assert.match(tutorial.id, /^[a-z][a-z0-9-]*$/);
    assert.ok(tutorial.label.length > 0);
    assert.ok(tutorial.where.length > 0);
  }
  assert.equal(new Set(TUTORIAL_IDS).size, TUTORIAL_IDS.length);
  assert.equal(tutorialIsKnown('object-map'), true);
  assert.equal(tutorialIsKnown('a-note-from-another-build'), false);
});

test('a recorded decision keeps known notes and real stamps only', () => {
  assert.deepEqual(cleanTutorialSeen(null), {});
  assert.deepEqual(cleanTutorialSeen([]), {});
  assert.deepEqual(
    cleanTutorialSeen({
      'object-map': '2026-11-20T09:14:22.118Z',
      'search-quote': true,
      'editor-shortcuts': '   ',
      'retired-note': '2026-01-01T00:00:00.000Z',
    }),
    { 'object-map': '2026-11-20T09:14:22.118Z' },
    'a boolean, a blank stamp and an id this build no longer has are not decisions',
  );
  // A hand-written value cannot grow the settings file without limit.
  assert.equal(cleanTutorialSeen({ 'object-map': 'x'.repeat(200) })['object-map'].length, 40);
});

test('closing a note is remembered, and closing it again only refreshes the stamp', () => {
  const first = markTutorialSeen({}, 'search-quote', '2026-11-20T09:14:22.118Z');
  assert.deepEqual(first, { 'search-quote': '2026-11-20T09:14:22.118Z' });
  assert.equal(tutorialWasSeen(first, 'search-quote'), true);
  assert.equal(tutorialWasSeen(first, 'object-map'), false);

  const again = markTutorialSeen(first, 'search-quote', '2026-11-21T08:00:00.000Z');
  assert.deepEqual(again, { 'search-quote': '2026-11-21T08:00:00.000Z' });
  assert.deepEqual(first, { 'search-quote': '2026-11-20T09:14:22.118Z' }, 'the old record is not mutated');
  assert.equal(Object.keys(again).length, 1, 'one decision, not a count');
});

test('an id this build does not know never becomes a decision', () => {
  const unchanged = { 'object-map': '2026-11-20T09:14:22.118Z' };
  assert.deepEqual(markTutorialSeen(unchanged, 'not-a-note', '2026-11-21T08:00:00.000Z'), unchanged);
  assert.equal(tutorialWasSeen({ 'not-a-note': '2026-11-21T08:00:00.000Z' }, 'not-a-note'), false);
  assert.deepEqual(clearTutorialSeen(), {}, 'reset forgets every note at once');
});

test('settings fold the old object-map flag into the shared record', () => {
  const upgraded = mergeSettings(DEFAULT_SETTINGS, { worldbuild: { lowZoomTipSeen: true } });
  assert.equal(upgraded.tutorialSeen['object-map'], 'legacy', 'a closed note stays closed across the upgrade');
  assert.equal(upgraded.worldbuild.lowZoomTipSeen, false, 'the old flag is spent, so reset cannot revive it');
  assert.equal(upgraded.tutorials, true);

  // A fresh vault starts with nothing closed.
  assert.deepEqual(mergeSettings(DEFAULT_SETTINGS, {}).tutorialSeen, {});
});

test('the decision record survives a reload, and the master switch does not erase it', () => {
  const saved = mergeSettings(DEFAULT_SETTINGS, {
    tutorials: false,
    tutorialSeen: { 'search-quote': '2026-11-20T09:14:22.118Z' },
  });
  assert.equal(saved.tutorials, false);
  assert.equal(saved.tutorialSeen['search-quote'], '2026-11-20T09:14:22.118Z');

  // What the next open of the vault reads back from settings.json.
  const reopened = mergeSettings(DEFAULT_SETTINGS, JSON.parse(JSON.stringify(saved)));
  assert.deepEqual(reopened.tutorialSeen, { 'search-quote': '2026-11-20T09:14:22.118Z' });
  assert.equal(reopened.tutorials, false, 'turning notes off hides them, it does not forget them');
});
