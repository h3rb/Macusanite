import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeVein, diffLines, hasMergeMarkers, countConflicts, describeMerge,
} from '../../src/lib/merge.js';

const lines = (...parts) => `${parts.join('\n')}\n`;

test('diffLines reports the hunks that turn one text into another', () => {
  assert.deepEqual(diffLines('a\nb\nc\n', 'a\nb\nc\n'), []);
  // An edit in the middle: one line replaced, the surrounding ones untouched.
  assert.deepEqual(diffLines('a\nb\nc\n', 'a\nB\nc\n'), [{ baseStart: 1, baseEnd: 2, lines: ['B'] }]);
  // Additions and deletions keep their place in the base.
  assert.deepEqual(diffLines('a\nb\n', 'a\nnew\nb\n'), [{ baseStart: 1, baseEnd: 1, lines: ['new'] }]);
  assert.deepEqual(diffLines('a\nb\n', 'a\n'), [{ baseStart: 1, baseEnd: 2, lines: [] }]);
  // Two separate edits stay two hunks.
  assert.deepEqual(diffLines('a\nb\nc\nd\n', 'A\nb\nc\nD\n'), [
    { baseStart: 0, baseEnd: 1, lines: ['A'] },
    { baseStart: 3, baseEnd: 4, lines: ['D'] },
  ]);
});

test('a change on one side only is taken without asking', () => {
  const base = lines('# Title', 'one', 'two');
  // The draft moved, the disk did not.
  const mineMoved = mergeVein({ base, mine: lines('# Title', 'one', 'TWO'), theirs: base });
  assert.equal(mineMoved.clean, true);
  assert.equal(mineMoved.text, lines('# Title', 'one', 'TWO'));
  assert.equal(mineMoved.mineOnly, 1);

  // The disk moved, the draft did not: the draft gains the disk's edit.
  const theirsMoved = mergeVein({
    base,
    mine: lines('# Title', 'one', 'two'),
    theirs: lines('# Title', 'one', 'two', 'three'),
  });
  assert.equal(theirsMoved.clean, true);
  assert.equal(theirsMoved.text, lines('# Title', 'one', 'two', 'three'));
  assert.equal(theirsMoved.theirsOnly, 1);
});

test('two edits in different places both survive', () => {
  const base = lines('# Notes', 'alpha', 'beta', 'gamma');
  const result = mergeVein({
    base,
    mine: lines('# Notes', 'ALPHA', 'beta', 'gamma'),          // the reader, at the top
    theirs: lines('# Notes', 'alpha', 'beta', 'gamma', 'delta'), // another program, at the foot
  });
  assert.equal(result.clean, true);
  assert.equal(result.conflicts, 0);
  assert.equal(result.text, lines('# Notes', 'ALPHA', 'beta', 'gamma', 'delta'));
  // The merged text is neither side on its own, and the log says how it got there.
  assert.equal(result.mineOnly, 1);
  assert.equal(result.theirsOnly, 1);
  assert.equal(describeMerge(result), '1 change from disk, 1 change of yours · no conflicts');
});

test('the same edit made on both sides is taken once', () => {
  const base = lines('a', 'b', 'c');
  const both = lines('a', 'B', 'c');
  const result = mergeVein({ base, mine: both, theirs: both });
  assert.equal(result.clean, true);
  assert.equal(result.text, both);
  assert.equal(result.conflicts, 0);
  assert.equal(describeMerge(result), 'no changes · no conflicts');
});

test('the same lines edited differently become a marked conflict', () => {
  const base = lines('# Title', 'body');
  const result = mergeVein({
    base,
    mine: lines('# Title', 'my body'),
    theirs: lines('# Title', 'their body'),
  });
  assert.equal(result.clean, false);
  assert.equal(result.conflicts, 1);
  assert.equal(result.text, [
    '# Title',
    '<<<<<<< your draft',
    'my body',
    '=======',
    'their body',
    '>>>>>>> changed on disk',
    '',
  ].join('\n'));
  // The marker lines are what the editor must not autosave over.
  assert.equal(hasMergeMarkers(result.text), true);
  assert.equal(countConflicts(result.text), 1);
  assert.equal(describeMerge(result), 'no changes · 1 conflict to resolve');
  // Nothing was lost: both versions are in there.
  assert.match(result.text, /my body/);
  assert.match(result.text, /their body/);
});

test('each disagreement is marked in place, around the lines nobody touched', () => {
  const base = lines('a', 'b', 'c', 'd', 'e');
  const result = mergeVein({
    base,
    mine: lines('a', 'B-mine', 'c', 'd', 'E-mine'),      // edits line 2 and line 5
    theirs: lines('a', 'B-theirs', 'c', 'd', 'E-theirs'), // …differently in both places
  });
  assert.equal(result.conflicts, 2);
  assert.deepEqual(result.lines, [
    'a',
    '<<<<<<< your draft',
    'B-mine',
    '=======',
    'B-theirs',
    '>>>>>>> changed on disk',
    'c',
    'd',
    '<<<<<<< your draft',
    'E-mine',
    '=======',
    'E-theirs',
    '>>>>>>> changed on disk',
    '',
  ]);
  assert.equal(result.conflicts, countConflicts(result.text));
  // The untouched lines in between are still there, exactly once.
  assert.deepEqual(result.lines.slice(6, 8), ['c', 'd']);
});

test('neighbouring edits stay two merges rather than one conflict', () => {
  const base = lines('one', 'two', 'three', 'four');
  const result = mergeVein({
    base,
    mine: lines('ONE', 'two', 'three', 'four'),        // line 1 rewritten
    theirs: lines('one', 'two', 'THREE', 'four'),      // line 3 rewritten, nothing between
  });
  assert.equal(result.clean, true);
  assert.equal(result.text, lines('ONE', 'two', 'THREE', 'four'));
});

test('both sides adding a line at the same place is a conflict, not a guess', () => {
  const base = lines('# Log', '');
  const result = mergeVein({
    base,
    mine: lines('# Log', 'mine here', ''),
    theirs: lines('# Log', 'theirs here', ''),
  });
  assert.equal(result.conflicts, 1);
  assert.deepEqual(result.lines.slice(1, 6), [
    '<<<<<<< your draft',
    'mine here',
    '=======',
    'theirs here',
    '>>>>>>> changed on disk',
  ]);
});

test('an insertion inside the lines the other side rewrote is a conflict', () => {
  const base = lines('start', 'body-1', 'body-2', 'end');
  const result = mergeVein({
    base,
    mine: lines('start', 'REWRITTEN', 'end'),                       // replaces two lines
    theirs: lines('start', 'body-1', 'inserted', 'body-2', 'end'),  // inserts between them
  });
  assert.equal(result.conflicts, 1);
  assert.match(result.text, /<<<<<<< your draft\nREWRITTEN\n=======\nbody-1\ninserted\nbody-2\n>>>>>>> changed on disk/);
});

test('an edit at the end of the file merges with one at the start', () => {
  const base = lines('# Doc', '', 'text', '');
  const result = mergeVein({
    base,
    mine: lines('# Doc — mine', '', 'text', ''),
    theirs: lines('# Doc', '', 'text', '', 'appended'),
  });
  assert.equal(result.clean, true);
  assert.equal(result.text, lines('# Doc — mine', '', 'text', '', 'appended'));
});

test('every line is labelled, so the dialog can show where it came from', () => {
  const result = mergeVein({
    base: lines('keep', 'change', ''),
    mine: lines('keep', 'mine', ''),
    theirs: lines('keep', 'theirs', ''),
  });
  const kinds = result.parts.map((part) => part.kind);
  assert.deepEqual(kinds, ['same', 'conflict', 'same']);
  assert.deepEqual(result.parts[0].lines, ['keep']);
  assert.equal(result.parts.flatMap((part) => part.lines).join('\n'), result.text);
  // The parts of a clean merge name the side each change came from, in the order
  // the lines appear — the disk's first line, then the draft's second.
  const clean = mergeVein({
    base: lines('a', 'b', ''),
    mine: lines('a', 'B', ''),
    theirs: lines('A', 'b', ''),
  });
  assert.deepEqual(clean.parts.map((part) => part.kind), ['theirs', 'mine', 'same']);
  assert.deepEqual(clean.parts[0].lines, ['A']);
  assert.deepEqual(clean.parts[1].lines, ['B']);
  assert.equal(clean.text, lines('A', 'B', ''));
  // …and a clean merge that adds nothing to the draft is labelled as such.
  const nothing = mergeVein({ base: lines('a', ''), mine: lines('B', ''), theirs: lines('B', '') });
  assert.equal(nothing.unchanged, true);
  assert.equal(describeMerge(nothing), 'no changes · no conflicts');
});

test('without an ancestor there is no line merge to offer', () => {
  const result = mergeVein({ base: null, mine: 'draft\n', theirs: 'disk\n' });
  assert.equal(result.supported, false);
  assert.equal(result.reason, 'no-base');
  assert.equal(result.text, 'draft\n');   // the draft is left exactly as it was
  assert.equal(result.clean, false);
  assert.equal(describeMerge(result), 'the two versions cannot be merged line by line');
});

test('a draft that already matches the disk merges to itself', () => {
  const text = lines('# Same', 'both sides ended up here');
  const result = mergeVein({ base: lines('# Old', 'text'), mine: text, theirs: text });
  assert.equal(result.clean, true);
  assert.equal(result.text, text);
  assert.equal(result.text === text, true);
});

test('a whole-file rewrite on both sides is one conflict, not a guess', () => {
  const base = lines(...Array.from({ length: 40 }, (_, i) => `line ${i}`));
  const mine = lines(...Array.from({ length: 40 }, (_, i) => `mine ${i}`));
  const theirs = lines(...Array.from({ length: 40 }, (_, i) => `theirs ${i}`));
  const result = mergeVein({ base, mine, theirs });
  assert.equal(result.conflicts, 1);
  assert.equal(countConflicts(result.text), 1);
  assert.match(result.text, /\nmine 0\n/);
  assert.match(result.text, /\ntheirs 39\n/);
});

test('a file with no trailing newline keeps its shape', () => {
  const result = mergeVein({ base: 'a\nb', mine: 'a\nB', theirs: 'x\nb' });
  assert.equal(result.clean, true);
  assert.equal(result.text, 'x\nB');
  assert.equal(hasMergeMarkers(result.text), false);
});

test('only this application\u2019s own markers count as a conflict to hold back', () => {
  // A vein about git contains marker lines that are not a Macusanite conflict.
  const git = ['# Conflicts', '', '<<<<<<< HEAD', 'ours', '=======', 'theirs', '>>>>>>> branch', ''].join('\n');
  assert.equal(hasMergeMarkers(git), false);
  assert.equal(countConflicts(git), 0);

  // …and a setext heading is a line of `=======` too.
  const heading = ['Title here', '=======', '', 'body', ''].join('\n');
  assert.equal(hasMergeMarkers(heading), false);
  assert.equal(countConflicts(heading), 0);

  // Ours are recognised, in the form the merge writes them — including halfway
  // through resolving one.
  const ours = ['<<<<<<< your draft', 'mine', '=======', 'theirs', '>>>>>>> changed on disk', ''].join('\n');
  assert.equal(hasMergeMarkers(ours), true);
  assert.equal(countConflicts(ours), 1);
  assert.equal(hasMergeMarkers('<<<<<<< your draft'), true);
  assert.equal(hasMergeMarkers('>>>>>>> changed on disk\n'), true);
  assert.equal(hasMergeMarkers(''), false);
  assert.equal(countConflicts(''), 0);
});
