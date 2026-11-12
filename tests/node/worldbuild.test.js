import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseNotes, serializeNotes, updateNote, updateIntro, addNote, removeNote,
  noteEdges, hierarchyEdges, noteStats, countWords, DEFAULT_LEVEL,
} from '../../src/lib/worldbuild.js';

const VEIN = `---
title: Fieldwork
tags: [glass]
---
Prelude paragraph.
# Fieldwork

Intro line.

## Sieve series

Coarse to fine, see [[#Composition]].

### Composition

Mostly glass. #petrology

## Composition

Second one, links [[Sieve series]].
`;

test('parseNotes reads the intro, the headings and each note’s prose', () => {
  const model = parseNotes(VEIN);
  assert.equal(model.hasFrontmatter, true);
  assert.equal(model.frontmatterData.title, 'Fieldwork');
  assert.equal(model.intro, 'Prelude paragraph.');
  assert.deepEqual(model.notes.map((note) => note.title), [
    'Fieldwork', 'Sieve series', 'Composition', 'Composition',
  ]);
  assert.deepEqual(model.notes.map((note) => note.level), [1, 2, 3, 2]);
  assert.deepEqual(model.notes.map((note) => note.anchor), [
    'fieldwork', 'sieve-series', 'composition', 'composition-1',
  ]);
  assert.equal(model.notes[1].body, 'Coarse to fine, see [[#Composition]].');
  assert.deepEqual(model.notes[2].tags, ['petrology']);
  assert.equal(model.notes[1].links.length, 1);
  assert.equal(model.notes[1].links[0].samePage, true);
  assert.equal(model.notes[1].links[0].anchor, 'composition');
});

test('a heading inside a fence is prose, not a note', () => {
  const model = parseNotes([
    '## Real',
    '',
    '```bash',
    '# not a heading',
    '```',
  ].join('\n'));
  assert.equal(model.notes.length, 1);
  assert.ok(model.notes[0].body.includes('# not a heading'));
  assert.ok(model.notes[0].body.startsWith('```bash'));
});

test('serializeNotes writes the notes back out as markdown', () => {
  const model = parseNotes('# Title\n\nBody.\n## Next\n\nMore.\n');
  assert.equal(serializeNotes(model), '# Title\n\nBody.\n\n## Next\n\nMore.\n');
});

test('a vein survives a round trip through the canvas unchanged', () => {
  const once = serializeNotes(parseNotes(VEIN));
  assert.equal(serializeNotes(parseNotes(once)), once);
  assert.ok(once.startsWith('---\ntitle: Fieldwork\ntags: [glass]\n---\n\nPrelude paragraph.\n\n# Fieldwork'));
  assert.ok(once.endsWith('Second one, links [[Sieve series]].\n'));
});

test('updateNote rewrites a card and re-reads its links, tags and anchor', () => {
  const model = parseNotes(VEIN);
  const next = updateNote(model, 1, { body: 'Now a [[field note]] about #glass.', title: 'Coarse sieve' });
  assert.equal(next.notes[1].title, 'Coarse sieve');
  assert.equal(next.notes[1].anchor, 'coarse-sieve');
  assert.deepEqual(next.notes[1].links.map((link) => link.target), ['field note']);
  assert.deepEqual(next.notes[1].tags, ['glass']);
  // Untouched notes are the same objects: editing one card cannot disturb another.
  assert.equal(next.notes[0], model.notes[0]);
  assert.ok(serializeNotes(next).includes('## Coarse sieve\n\nNow a [[field note]] about #glass.'));
});

test('updateIntro replaces the prose before the first heading', () => {
  const model = updateIntro(parseNotes(VEIN), 'A new prelude.');
  assert.equal(model.intro, 'A new prelude.');
  assert.ok(serializeNotes(model).includes('---\n\nA new prelude.\n\n# Fieldwork'));
});

test('addNote appends a section and returns its index', () => {
  const model = parseNotes('# Title\n\nBody.\n');
  const { model: next, index } = addNote(model, { title: 'Sieve series' });
  assert.equal(index, 1);
  assert.equal(DEFAULT_LEVEL, 2);
  assert.equal(next.notes[1].anchor, 'sieve-series');
  assert.equal(serializeNotes(next), '# Title\n\nBody.\n\n## Sieve series\n');
});

test('removeNote drops that note’s heading and prose', () => {
  const model = parseNotes('# Title\n\nBody.\n## Next\n\nMore.\n');
  const next = removeNote(model, 0);
  assert.equal(next.notes.length, 1);
  assert.equal(serializeNotes(next), '## Next\n\nMore.\n');
});

test('noteEdges joins notes by same-page links and by title', () => {
  const model = parseNotes(VEIN);
  const edges = noteEdges(model);
  const byKind = (kind) => edges.filter((edge) => edge.kind === kind);
  // `[[#Composition]]` in "Sieve series" points at the first Composition note.
  assert.deepEqual(byKind('section').map((edge) => [edge.from, edge.to]), [[1, 2]]);
  // `[[Sieve series]]` in the second Composition note points at that title.
  assert.deepEqual(byKind('mention').map((edge) => [edge.from, edge.to]), [[3, 1]]);
  assert.equal(byKind('section')[0].label, 'Composition');
});

test('noteEdges ignores a note that links to itself', () => {
  const model = parseNotes('## A\n\nSee [[#A]].\n');
  assert.deepEqual(noteEdges(model), []);
});

test('hierarchyEdges nest each note under the nearest shallower one', () => {
  const model = parseNotes(VEIN);
  assert.deepEqual(hierarchyEdges(model).map((edge) => [edge.from, edge.to]), [
    [0, 1], [1, 2], [0, 3],
  ]);
});

test('countWords and noteStats summarise the canvas', () => {
  assert.equal(countWords('  '), 0);
  assert.equal(countWords('one two  three'), 3);
  const stats = noteStats(parseNotes(VEIN));
  assert.equal(stats.notes, 4);
  assert.equal(stats.associations, 2);
  assert.equal(stats.links, 2);
  assert.equal(stats.tags, 1);
});
