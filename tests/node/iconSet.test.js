import test from 'node:test';
import assert from 'node:assert/strict';
import { ICON_SECTIONS, ICON_LIBRARY, searchIcons } from '../../src/lib/iconSet.js';

test('the icon library is well formed', () => {
  assert.ok(ICON_LIBRARY.length > 250, `expected a broad set, got ${ICON_LIBRARY.length}`);
  const seen = new Set();
  for (const icon of ICON_LIBRARY) {
    // One glyph per entry: no joined sequences or variation selectors, so a
    // cell is always a single character.
    assert.equal([...icon.char].length, 1, `${icon.char} is not a single character`);
    assert.ok(icon.name.trim().length > 2, `${icon.char} has no searchable name`);
    assert.ok(icon.section.length > 0);
    assert.ok(!seen.has(icon.char), `${icon.char} appears twice`);
    seen.add(icon.char);
  }
  // Every section the picker shows is populated.
  for (const section of ICON_SECTIONS) {
    assert.ok(section.icons.length > 0, `${section.label} is empty`);
  }
});

test('an empty search lists the whole set', () => {
  assert.equal(searchIcons('').length, ICON_LIBRARY.length);
  assert.equal(searchIcons('   ').length, ICON_LIBRARY.length);
});

test('searches match names, keywords, sections and the character itself', () => {
  assert.ok(searchIcons('sword').some((icon) => icon.char === '⚔'));
  assert.ok(searchIcons('castle').some((icon) => icon.char === '🏰'));
  assert.ok(searchIcons('star').some((icon) => icon.char === '★'));
  assert.ok(searchIcons('weather').some((icon) => icon.char === '⛈'));
  // A section name searches its whole set.
  assert.ok(searchIcons('dingbats').length > 20);
  // Case does not matter, and the character itself finds its entry.
  assert.deepEqual(searchIcons('CASTLE').map((icon) => icon.char), searchIcons('castle').map((icon) => icon.char));
  assert.deepEqual(searchIcons('⚔').map((icon) => icon.char), ['⚔']);
});

test('every term has to match, so two words narrow the list', () => {
  const broad = searchIcons('heart');
  const narrow = searchIcons('heart blue');
  assert.ok(broad.length > narrow.length);
  assert.deepEqual(narrow.map((icon) => icon.char), ['💙']);
  assert.deepEqual(searchIcons('ship harbour').map((icon) => icon.char), ['⚓']);
});

test('a search nothing matches comes back empty', () => {
  assert.deepEqual(searchIcons('zzzznotanicon'), []);
  assert.deepEqual(searchIcons('sword castle'), []);
});
