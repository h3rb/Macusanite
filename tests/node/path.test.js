import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalize, join, dirname, basename, stem, extname, isMarkdown,
  slugify, titleFromPath, ancestorChambers,
} from '../../src/lib/path.js';

test('normalize collapses separators and never escapes the vault', () => {
  assert.equal(normalize('Chambers//Lab/./Methods.md'), 'Chambers/Lab/Methods.md');
  assert.equal(normalize('Chambers\\Lab\\Methods.md'), 'Chambers/Lab/Methods.md');
  assert.equal(normalize('a/b/../c.md'), 'a/c.md');
  assert.equal(normalize('a/../../c.md'), '../c.md');
});

test('join, dirname, basename and stem agree with each other', () => {
  assert.equal(join('Chambers', 'Lab', 'Methods.md'), 'Chambers/Lab/Methods.md');
  assert.equal(join('Chambers/', '/Lab/', 'Methods.md'), 'Chambers/Lab/Methods.md');
  assert.equal(join('', 'Home.md'), 'Home.md');
  assert.equal(dirname('Chambers/Lab/Methods.md'), 'Chambers/Lab');
  assert.equal(dirname('Home.md'), '');
  assert.equal(basename('Chambers/Lab/Methods.md'), 'Methods.md');
  assert.equal(stem('Chambers/Lab/Methods.markdown'), 'Methods');
  assert.equal(stem('NoExtension'), 'NoExtension');
  assert.equal(extname('Notes.MD'), '.md');
  assert.equal(isMarkdown('a/b.md'), true);
  assert.equal(isMarkdown('a/b.markdown'), true);
  assert.equal(isMarkdown('a/b.txt'), false);
});

test('slugify matches the Rust implementation, anchor for anchor', () => {
  // The same expectations live in src-tauri/src/vault.rs (slugify test).
  assert.equal(slugify('Sieve series'), 'sieve-series');
  assert.equal(slugify('What they record'), 'what-they-record');
  assert.equal(slugify('Th 780C — hot, dry!'), 'th-780c-hot-dry');
  assert.equal(slugify('Undo/redo'), 'undoredo');
  assert.equal(slugify('  padded  '), 'padded');
  assert.equal(slugify('already-slugged'), 'already-slugged');
  assert.equal(slugify('snake_case_name'), 'snakecasename');
});

test('titleFromPath humanises file names', () => {
  assert.equal(titleFromPath('Chambers/fluid-inclusions.md'), 'fluid inclusions');
  assert.equal(titleFromPath('Chambers/Cesium_Enrichment.md'), 'Cesium Enrichment');
});

test('ancestorChambers lists every parent folder, outermost first', () => {
  assert.deepEqual(ancestorChambers('a/b/c/Note.md'), ['a', 'a/b', 'a/b/c']);
  assert.deepEqual(ancestorChambers('Home.md'), []);
});
