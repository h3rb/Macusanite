/**
 * The journal a save or a rename leaves for a window that closes before other
 * veins' links have followed.
 *
 * The Node suite cannot open a window, so what it proves here is the record's
 * own rules: what counts as an entry, which headings read as one renamed, and —
 * the part a retry depends on — how to tell a change that reached the vein from
 * one that failed before touching it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  readRetitleJournal, retitleJournalText, renameReachedFile, retypedHeadings,
} from '../../src/lib/retitles.js';
import { buildDocumentIndex } from '../../src/lib/graph.js';

/** The headings a vein has, as the viewer describes them. */
const heads = (text) => buildDocumentIndex({ 'Notes.md': text })[0].headings;

test('readRetitleJournal keeps the entries that name a rename, and only those', () => {
  const entry = { path: 'Chambers/Vault Notes.md', before: 'canvas-tour', after: 'crash-tour', title: 'Crash tour' };
  const journal = readRetitleJournal(JSON.stringify({
    pending: [
      entry,
      // Nothing here names a heading, or a title that could be written in a link.
      { ...entry, before: '' },
      { ...entry, after: '' },
      { ...entry, before: 'canvas-tour', after: 'canvas-tour' },
      { ...entry, title: 'Crash | tour' },
      { ...entry, path: '' },
      null,
      'not an entry',
    ],
  }));
  assert.deepEqual(journal, [entry]);
  // Only the file this app writes is a journal: a bare list, a file that is not
  // JSON at all, and no file all read as nothing outstanding.
  assert.deepEqual(readRetitleJournal(JSON.stringify([entry])), []);
  assert.deepEqual(readRetitleJournal('{ not json'), []);
  assert.deepEqual(readRetitleJournal(null), []);
});

test('retitleJournalText writes what readRetitleJournal reads back', () => {
  const entries = [
    { path: 'Home.md', before: 'old-a', after: 'new', title: 'New' },
    { path: 'Home.md', before: 'old-b', after: 'newer', title: 'Newer' },
  ];
  const text = retitleJournalText(entries);
  assert.deepEqual(readRetitleJournal(text), entries);
  // An empty journal is never written in place of being deleted; if one is asked
  // for it still reads back as nothing.
  assert.deepEqual(JSON.parse(retitleJournalText([])), { pending: [] });
});

test('retypedHeadings finds a heading retyped in place, not the ones around it', () => {
  const before = heads('# Notes\n\n## Coarse sieve\n\nProse.\n\n## Fine sieve\n\nProse.\n');
  // Retyped: the same heading under a new title.
  assert.deepEqual(
    retypedHeadings(before, heads('# Notes\n\n## Coarse mesh\n\nProse.\n\n## Fine sieve\n\nProse.\n')),
    [{ before: 'coarse-sieve', after: 'coarse-mesh', title: 'Coarse mesh' }],
  );
  // Two neighbours retyped in one save are both renames.
  assert.deepEqual(
    retypedHeadings(before, heads('# Notes\n\n## Coarse mesh\n\nProse.\n\n## Fine mesh\n\nProse.\n')),
    [
      { before: 'coarse-sieve', after: 'coarse-mesh', title: 'Coarse mesh' },
      { before: 'fine-sieve', after: 'fine-mesh', title: 'Fine mesh' },
    ],
  );
  // A rename beside an insertion elsewhere is still found on its own.
  assert.deepEqual(
    retypedHeadings(before, heads('# Notes\n\n## Fieldwork\n\nProse.\n\n## Coarse mesh\n\nProse.\n\n## Fine sieve\n\nProse.\n')),
    [{ before: 'coarse-sieve', after: 'coarse-mesh', title: 'Coarse mesh' }],
  );
  // Untouched headings, whatever else moved around them.
  assert.deepEqual(retypedHeadings(before, before), []);
});

test('retypedHeadings leaves insertions, deletions, reorders and level changes alone', () => {
  const before = heads('# Notes\n\n## Coarse sieve\n\nProse.\n\n## Fine sieve\n\nProse.\n');
  // A heading inserted before the pair: nothing lost, nothing renamed.
  assert.deepEqual(retypedHeadings(before, heads('# Notes\n\n## Methods\n\nProse.\n\n## Coarse sieve\n\nProse.\n\n## Fine sieve\n\nProse.\n')), []);
  // A heading removed: its links keep pointing where they did.
  assert.deepEqual(retypedHeadings(before, heads('# Notes\n\n## Coarse sieve\n\nProse.\n')), []);
  // The two swapped: the text moved, the titles did not.
  assert.deepEqual(retypedHeadings(before, heads('# Notes\n\n## Fine sieve\n\nProse.\n\n## Coarse sieve\n\nProse.\n')), []);
  // A heading demoted, keeping its title: its anchor is the same, so nothing moved.
  assert.deepEqual(retypedHeadings(before, heads('# Notes\n\n### Coarse sieve\n\nProse.\n\n## Fine sieve\n\nProse.\n')), []);
  // Retyped and demoted at once is anyone's guess, so it is not taken for a rename.
  assert.deepEqual(retypedHeadings(before, heads('# Notes\n\n### Coarse mesh\n\nProse.\n\n## Fine sieve\n\nProse.\n')), []);
  // A case-only change reads as the same anchor, and no link needs moving.
  assert.deepEqual(retypedHeadings(before, heads('# Notes\n\n## COARSE SIEVE\n\nProse.\n\n## Fine sieve\n\nProse.\n')), []);
  // An empty document, or one with no headings at all.
  assert.deepEqual(retypedHeadings([], before), []);
  assert.deepEqual(retypedHeadings(before, []), []);
  assert.deepEqual(retypedHeadings(null, undefined), []);
});

test('renameReachedFile tells a rename whose save landed from one that did not', () => {
  const before = 'worldbuilding-canvas-tour';
  // The heading is still there: the save that would have moved it never landed,
  // so links pointing at it must stay where they are.
  assert.equal(renameReachedFile('# Vault Notes\n\n## Worldbuilding canvas tour\n\nProse.\n', before), false);
  // The heading moved: the rewrite is owed.
  assert.equal(renameReachedFile('# Vault Notes\n\n## Crash tour\n\nProse.\n', before), true);
  // A rename within a draft chain (`A→B`, then `B→C`) asks only that this
  // entry's own anchor is gone, so both entries are still owed, in order.
  assert.equal(renameReachedFile('# Notes\n\n## Field tour\n', before), true);
  // A heading quoted in a fence is not the heading; a front-matter title is not
  // one either, so a vein carrying only those has lost it.
  assert.equal(renameReachedFile('# Notes\n\n```md\n## Worldbuilding canvas tour\n```\n', before), true);
  assert.equal(renameReachedFile('---\ntitle: Worldbuilding canvas tour\n---\n# Notes\n', before), true);
  // A lateral anchor (`…-1`) is a different heading from its base.
  assert.equal(renameReachedFile('# Notes\n\n## Worldbuilding canvas tour\n\n## Worldbuilding canvas tour\n', before), false);
  assert.equal(renameReachedFile('# Notes\n\n## Worldbuilding canvas tour\n', ''), false);
});
