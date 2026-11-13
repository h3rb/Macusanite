import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseNotes, serializeNotes, updateNote, updateIntro, addNote, removeNote,
  noteEdges, hierarchyEdges, noteStats, countWords, DEFAULT_LEVEL,
  normalizeTag, addNoteTags, removeNoteTag, tagRecord,
  RELATION_KINDS, DEFAULT_RELATION, relationKind, relationKey,
  setRelation, dropRelations, relationOf, groupEndpoint, groupRelationEdges, bondEdges,
  NODE_TYPES, DEFAULT_NODE_TYPE, nodeType, nodeTypeOf, setNodeType,
  NODE_FIELDS, nodeFields, nodeFieldOf, setNodeField, fieldRangeHint,
  ZOOM_MIN, ZOOM_MAX, clampView, zoomViewAt, anchorOfView, viewOfAnchor,
  DROP_MIN_PX, dropMembershipKind,
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

test('relationship kinds run weakest-first, in inverse pairs', () => {
  const ranks = RELATION_KINDS.map((kind) => kind.rank);
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
  assert.equal(DEFAULT_RELATION, 'associate');
  assert.equal(RELATION_KINDS[0].rank, 0);
  for (const kind of RELATION_KINDS) {
    if (!kind.inverse) continue;
    assert.equal(relationKind(kind.inverse).inverse, kind.id);
    assert.equal(relationKind(kind.inverse).rank, kind.rank);
  }
  assert.equal(relationKind('CONTAINS').id, 'contains');
  assert.equal(relationKind('nope'), null);
  // Template sits between Member Of and Parent on the scale.
  assert.equal(relationKind('template').rank, 2);
  const ids = RELATION_KINDS.map((k) => k.id);
  assert.ok(ids.indexOf('template') > ids.indexOf('member-of'));
  assert.ok(ids.indexOf('template') < ids.indexOf('parent'));
  // Affects pairs causation: above Controls, below Ally and Foe.
  assert.equal(relationKind('affects').inverse, 'affected-by');
  assert.ok(relationKind('affects').rank > relationKind('controls').rank);
  assert.ok(relationKind('affects').rank < relationKind('ally').rank);
  // Polarity bonds sit at the top of the scale: allies green, foes red.
  const last = RELATION_KINDS[RELATION_KINDS.length - 1];
  const secondLast = RELATION_KINDS[RELATION_KINDS.length - 2];
  assert.equal(secondLast.id, 'ally');
  assert.equal(last.id, 'foe');
  assert.ok(last.rank > secondLast.rank);
  assert.ok(secondLast.rank >= relationKind('controls').rank);
});

test('setRelation asserts a kind, overwrites it, and refuses nonsense', () => {
  let relations = setRelation({}, 'sieve-series', 'composition', 'contains');
  assert.equal(relations['sieve-series->composition'], 'contains');
  relations = setRelation(relations, 'sieve-series', 'composition', 'parent');
  assert.equal(relations['sieve-series->composition'], 'parent');
  assert.equal(setRelation(relations, 'a', 'b', 'nope'), relations);
  assert.equal(setRelation(relations, 'a', 'a', 'contains'), relations);
  assert.equal(relationKey('a', 'b'), 'a->b');
});

test('dropRelations forgets every bond touching a deleted note', () => {
  const relations = {
    'a->b': 'contains',
    'b->a': 'child',
    'a->c': 'controls',
  };
  assert.deepEqual(dropRelations(relations, 'b'), { 'a->c': 'controls' });
  assert.equal(dropRelations(relations, ''), relations);
});

test('groupRelationEdges draws group bonds that the prose cannot write', () => {
  const model = parseNotes(VEIN);
  const groups = {
    g1: { id: 'g1', members: ['sieve-series', 'composition'] },
    g2: { id: 'g2', members: ['composition-1'] },
    // A group whose cards have all left the vein draws nothing.
    gone: { id: 'gone', members: ['nowhere'] },
  };
  const relations = setRelation(
    setRelation({}, groupEndpoint('g1'), 'composition-1', 'ally'),
    groupEndpoint('g1'),
    groupEndpoint('g2'),
    'controls',
  );
  const nowhere = setRelation(relations, groupEndpoint('gone'), 'sieve-series', 'foe');
  const edges = groupRelationEdges(model, groups, withNodeBond(nowhere));
  assert.deepEqual(edges.map((edge) => [edge.from, edge.to, edge.relation]), [
    [groupEndpoint('g1'), 'composition-1', 'ally'],
    [groupEndpoint('g1'), groupEndpoint('g2'), 'controls'],
  ]);
  // Ends resolve to a card so arrangement can score the connector.
  assert.deepEqual(edges.map((edge) => [edge.fromIndex, edge.toIndex]), [[1, 3], [1, 3]]);
});

/** The same record with a plain node-to-node bond mixed in: not a group edge. */
function withNodeBond(relations) {
  return setRelation(relations, 'sieve-series', 'composition', 'contains');
}

test('noteEdges carries the asserted relationship and its strength', () => {
  const model = parseNotes(VEIN);
  const plain = noteEdges(model);
  assert.ok(plain.every((edge) => edge.relation === 'associate' && edge.strength === 0));
  const relations = setRelation({}, 'sieve-series', 'composition', 'controls');
  const defined = noteEdges(model, relations);
  const section = defined.find((edge) => edge.kind === 'section');
  assert.equal(section.relation, 'controls');
  assert.equal(section.strength, 4);
});

test('bondEdges draws a bond the prose does not link', () => {
  const model = parseNotes(VEIN);
  // sieve-series links composition in its prose, so that pair stays noteEdges'.
  let relations = setRelation({}, 'sieve-series', 'composition', 'ally');
  relations = setRelation(relations, 'composition', 'composition-1', 'parent');
  relations = setRelation(relations, groupEndpoint('g1'), 'composition-1', 'foe');
  relations = setRelation(relations, 'composition', 'gone', 'controls');
  const edges = bondEdges(model, relations);
  assert.deepEqual(edges.map((edge) => [edge.from, edge.to, edge.relation]), [
    ['composition', 'composition-1', 'parent'],
  ]);
  // Both ends name cards, so the bond draws and labels like any other edge.
  assert.deepEqual([edges[0].fromIndex, edges[0].toIndex], [2, 3]);
});

test('hierarchyEdges nest each note under the nearest shallower one', () => {
  const model = parseNotes(VEIN);
  assert.deepEqual(hierarchyEdges(model).map((edge) => [edge.from, edge.to]), [
    [0, 1], [1, 2], [0, 3],
  ]);
});

test('normalizeTag cleans up and rejects what the reader cannot read back', () => {
  assert.equal(normalizeTag('#Glass '), 'glass');
  assert.equal(normalizeTag('a/b_c-d'), 'a/b_c-d');
  assert.equal(normalizeTag('##'), null);
  assert.equal(normalizeTag('my tag'), null);
  assert.equal(normalizeTag(''), null);
  assert.equal(normalizeTag(null), null);
});

test('addNoteTags writes the tokens into the prose and reads them back', () => {
  const model = parseNotes('## Sieve\n\nCoarse to fine.\n');
  const next = addNoteTags(model, 0, ['#Glass', 'petrology']);
  assert.deepEqual(next.notes[0].tags, ['glass', 'petrology']);
  assert.equal(serializeNotes(next), '## Sieve\n\nCoarse to fine.\n\n#glass #petrology\n');
  // The tag survives a round trip: the vault index will see the same tags.
  assert.deepEqual(parseNotes(serializeNotes(next)).notes[0].tags, ['glass', 'petrology']);
  // Re-adding existing tags is a no-op — the same model comes back.
  assert.equal(addNoteTags(next, 0, ['glass']), next);
  // A trailing tags line takes the new tokens instead of growing a second one.
  const more = addNoteTags(next, 0, ['methods']);
  assert.ok(serializeNotes(more).endsWith('#glass #petrology #methods\n'));
});

test('removeNoteTag strips the token, keeps the prose, and respects fences', () => {
  const vein = '## Sieve\n\nCoarse #glass to fine.\n\n```bash\n#glass in a fence\n```\n\n#glass #petrology\n';
  const model = parseNotes(vein);
  const next = removeNoteTag(model, 0, 'glass');
  assert.deepEqual(next.notes[0].tags, ['petrology']);
  const body = next.notes[0].body;
  assert.ok(body.includes('Coarse to fine.'));
  assert.ok(body.includes('#glass in a fence'));
  assert.ok(body.trimEnd().endsWith('#petrology'));
  assert.equal(serializeNotes(parseNotes(serializeNotes(next))), serializeNotes(next));
  // Untagging a tag the note does not have returns the same model.
  assert.equal(removeNoteTag(next, 0, 'absent'), next);
});

test('tagRecord counts every tag across the vault index, most-used first', () => {
  const record = tagRecord([
    { path: 'a.md', tags: ['glass', 'Petrology'] },
    { path: 'b.md', tags: ['glass', 'glass'] },
    { path: 'c.md', tags: ['methods'] },
    { path: 'd.md', tags: [], indexed: false },
  ]);
  assert.deepEqual(record, [
    { tag: 'glass', count: 2, veins: ['a.md', 'b.md'] },
    { tag: 'methods', count: 1, veins: ['c.md'] },
    { tag: 'petrology', count: 1, veins: ['a.md'] },
  ]);
});

test('node types default to note and validate on the way in', () => {
  assert.equal(NODE_TYPES[0].id, 'note');
  assert.equal(DEFAULT_NODE_TYPE, 'note');
  assert.deepEqual(
    NODE_TYPES.map((t) => t.id),
    ['note', 'stat', 'skill', 'ability', 'attribute', 'property', 'rating', 'place', 'person', 'thing', 'location', 'scene', 'locale', 'biome', 'perk', 'effect', 'condition'],
  );
  // Every typed node reads at a glance in its own colour; notes stay plain.
  const colors = NODE_TYPES.filter((t) => t.id !== 'note').map((t) => t.color);
  assert.ok(colors.every(Boolean));
  assert.equal(new Set(colors).size, colors.length);
  // And every type has its own icon for the card head.
  const icons = NODE_TYPES.map((t) => t.icon);
  assert.ok(icons.every(Boolean));
  assert.equal(new Set(icons).size, icons.length);
  // Place-like types are prose cards, like notes.
  assert.deepEqual(nodeFields('place'), []);
  assert.deepEqual(nodeFields('person'), []);
  assert.deepEqual(nodeFields('biome'), []);
  assert.deepEqual(nodeFields('perk'), []);
  assert.deepEqual(nodeFields('effect'), []);
  assert.deepEqual(nodeFields('condition'), []);
  assert.equal(nodeType('STAT').id, 'stat');
  assert.equal(nodeType('nope'), null);
  assert.equal(nodeTypeOf({}, 'a').id, 'note');
  assert.equal(nodeTypeOf({ a: 'nope' }, 'a').id, 'note');
  let types = setNodeType({}, 'a', 'skill');
  assert.equal(types.a, 'skill');
  types = setNodeType(types, 'a', 'ability');
  assert.equal(types.a, 'ability');
  assert.equal(setNodeType(types, 'a', 'nope'), types);
});

test('non-note types take structured fields; notes take none', () => {
  assert.deepEqual(nodeFields('note'), []);
  assert.deepEqual(nodeFields('nope'), []);
  assert.deepEqual(nodeFields('stat').map((f) => f.id), ['value']);
  assert.deepEqual(nodeFields('skill').map((f) => f.id), ['level']);
  assert.deepEqual(nodeFields('ability').map((f) => f.id), ['min', 'max']);
  assert.deepEqual(nodeFields('rating').map((f) => f.id), ['value']);
  assert.equal(nodeFields('rating')[0].kind, 'number');
  assert.deepEqual(
    { min: nodeFields('skill')[0].min, max: nodeFields('skill')[0].max, step: nodeFields('skill')[0].step },
    { min: 0, max: 10, step: 1 },
  );
  assert.deepEqual(nodeFields('attribute').map((f) => f.id), ['key', 'value']);
  assert.deepEqual(nodeFields('property').map((f) => f.id), ['key', 'value']);
  let fields = setNodeField({}, 'stat', 'a', 'value', '42');
  assert.equal(nodeFieldOf(fields, 'a', 'value'), '42');
  fields = setNodeField(fields, 'attribute', 'a', 'key', 'temper');
  assert.equal(nodeFieldOf(fields, 'a', 'key'), 'temper');
  assert.equal(nodeFieldOf(fields, 'b', 'value'), '');
  // A note's schema is empty, so it can never grow structured data.
  assert.equal(setNodeField(fields, 'note', 'a', 'value', 'x'), fields);
  assert.equal(setNodeField(fields, 'stat', 'a', 'nope', 'x'), fields);
});

test('fieldRangeHint renders the declared range for the editor', () => {
  assert.equal(fieldRangeHint(nodeFields('skill')[0]), '0–10');
  assert.equal(fieldRangeHint({ kind: 'number', min: 2 }), '≥ 2');
  assert.equal(fieldRangeHint({ kind: 'number', max: 5 }), '≤ 5');
  assert.equal(fieldRangeHint({ kind: 'number' }), null);
  assert.equal(fieldRangeHint(nodeFields('stat')[0]), null);
  assert.equal(fieldRangeHint(null), null);
});

test('numeric fields clamp to their declared range on the way in', () => {
  let fields = {};
  fields = setNodeField(fields, 'skill', 'a', 'level', '7');
  assert.equal(nodeFieldOf(fields, 'a', 'level'), '7');
  fields = setNodeField(fields, 'skill', 'a', 'level', '12');
  assert.equal(nodeFieldOf(fields, 'a', 'level'), '10');
  fields = setNodeField(fields, 'skill', 'a', 'level', '-3');
  assert.equal(nodeFieldOf(fields, 'a', 'level'), '0');
  // Text fields ignore ranges entirely; a cleared number stays cleared.
  fields = setNodeField(fields, 'stat', 'a', 'value', '99');
  assert.equal(nodeFieldOf(fields, 'a', 'value'), '99');
  fields = setNodeField(fields, 'skill', 'a', 'level', '');
  assert.equal(nodeFieldOf(fields, 'a', 'level'), '');
});

test('an ability keeps its min/max pair ordered, last edit winning', () => {
  let fields = {};
  fields = setNodeField(fields, 'ability', 'a', 'min', '2');
  fields = setNodeField(fields, 'ability', 'a', 'max', '8');
  assert.equal(nodeFieldOf(fields, 'a', 'min'), '2');
  assert.equal(nodeFieldOf(fields, 'a', 'max'), '8');
  // Setting min past max pulls max up with it.
  fields = setNodeField(fields, 'ability', 'a', 'min', '9');
  assert.equal(nodeFieldOf(fields, 'a', 'min'), '9');
  assert.equal(nodeFieldOf(fields, 'a', 'max'), '9');
  // Setting max below min pulls min down with it.
  fields = setNodeField(fields, 'ability', 'a', 'max', '4');
  assert.equal(nodeFieldOf(fields, 'a', 'min'), '4');
  assert.equal(nodeFieldOf(fields, 'a', 'max'), '4');
  // A cleared end leaves the other alone.
  fields = setNodeField(fields, 'ability', 'a', 'min', '');
  assert.equal(nodeFieldOf(fields, 'a', 'max'), '4');
  // The ends are unbounded: an ability can outgrow a 0–10 scale.
  fields = setNodeField(fields, 'ability', 'a', 'min', '250');
  assert.equal(nodeFieldOf(fields, 'a', 'min'), '250');
  assert.equal(nodeFieldOf(fields, 'a', 'max'), '250');
  fields = setNodeField(fields, 'ability', 'a', 'max', '-12');
  assert.equal(nodeFieldOf(fields, 'a', 'min'), '-12');
  assert.equal(nodeFieldOf(fields, 'a', 'max'), '-12');
  assert.equal(fieldRangeHint(nodeFields('ability')[0]), null);
});

test('relationOf defaults to Associate and reads what was asserted', () => {
  assert.equal(relationOf({}, 'a', 'b').id, 'associate');
  assert.equal(relationOf({ 'a->b': 'controls' }, 'a', 'b').id, 'controls');
  assert.equal(relationOf({ 'a->b': 'nope' }, 'a', 'b').id, 'associate');
});

test('noteStats counts the non-note types', () => {
  const model = parseNotes('# A\n\nOne.\n## B\n\nTwo.\n');
  const stats = noteStats(model, { b: 'stat', a: 'note' });
  assert.deepEqual(stats.types, { stat: 1 });
  assert.deepEqual(noteStats(model).types, {});
});

test('zoomViewAt keeps the canvas point under the pointer fixed', () => {
  const view = { x: -100, y: -50, s: 1 };
  const next = zoomViewAt(view, 200, 150, 2);
  assert.equal(next.s, 2);
  // The canvas point at (300, 200) was under the pointer; it still is.
  assert.equal(next.x + 2 * 300, 200);
  assert.equal(next.y + 2 * 200, 150);
  assert.equal(zoomViewAt(view, 200, 150, 100).s, ZOOM_MAX);
  assert.equal(zoomViewAt(view, 200, 150, 0.001).s, ZOOM_MIN);
});

test('clampView keeps the canvas covering the viewport, with a slight overpan', () => {
  const canvas = { w: 800, h: 600 };
  const vp = { w: 400, h: 300 };
  // A canvas bigger than the viewport: translate may overshoot each exact
  // edge by PAN_OVERHANG, so wires past the canvas rect stay reachable.
  assert.deepEqual(clampView({ x: 50, y: 50, s: 1 }, 800, 600, 400, 300), { x: 50, y: 50, s: 1 });
  assert.deepEqual(clampView({ x: -9999, y: -9999, s: 1 }, 800, 600, 400, 300), { x: -520, y: -420, s: 1 });
  // Smaller than the viewport (zoomed out): the flush position may be
  // overshot by the same margin on each side.
  assert.deepEqual(clampView({ x: -99, y: -99, s: 1 }, 200, 150, 400, 300), { x: -99, y: -99, s: 1 });
  assert.deepEqual(clampView({ x: 9999, y: 9999, s: 1 }, 200, 150, 400, 300), { x: 320, y: 270, s: 1 });
  // Scale is clamped too.
  assert.equal(clampView({ x: 0, y: 0, s: 99 }, 800, 600, 400, 300).s, ZOOM_MAX);
  assert.equal(clampView({ x: 0, y: 0, s: 0 }, 800, 600, 400, 300).s, ZOOM_MIN);
});

test('a drop changes membership only on a deliberate move', () => {
  // Join: dragged across a group's border from outside it.
  assert.equal(dropMembershipKind({ distance: 40, startGroupId: null, targetId: 'g1' }), 'join');
  assert.equal(dropMembershipKind({ distance: DROP_MIN_PX, startGroupId: null, targetId: 'g1' }), 'join');
  assert.equal(dropMembershipKind({ distance: 120, startGroupId: null, targetId: 'g1' }), 'join');
  assert.equal(dropMembershipKind({ distance: 5, startGroupId: null, targetId: 'g1' }), null);
  // Leave: dragged out of the group it started the drag in.
  assert.equal(dropMembershipKind({ distance: 40, startGroupId: 'g1', targetId: null }), 'leave');
  assert.equal(dropMembershipKind({ distance: 5, startGroupId: 'g1', targetId: null }), null);
  // Stay: still inside the group it started in, however far it moved.
  assert.equal(dropMembershipKind({ distance: 40, startGroupId: 'g1', targetId: 'g1' }), null);
  assert.equal(dropMembershipKind({ distance: 3, startGroupId: 'g1', targetId: 'g1' }), null);
  // Moving between two groups counts as a join of the new one.
  assert.equal(dropMembershipKind({ distance: 60, startGroupId: 'g1', targetId: 'g2' }), 'join');
  // Ungrouped and dropped on empty canvas, or not moved at all.
  assert.equal(dropMembershipKind({ distance: 60, startGroupId: null, targetId: null }), null);
  assert.equal(dropMembershipKind({ distance: NaN, startGroupId: null, targetId: 'g1' }), null);
  assert.equal(dropMembershipKind({ distance: undefined, startGroupId: null, targetId: 'g1' }), null);
});

test('anchorOfView and viewOfAnchor round-trip a left view', () => {
  const view = { x: -863.923, y: -505.375, s: 1.64872 };
  const anchor = anchorOfView(view);
  assert.ok(Math.abs(anchor.x - 523.996) < 0.001);
  assert.ok(Math.abs(anchor.y - 306.525) < 0.001);
  const restored = viewOfAnchor(anchor);
  assert.ok(Math.abs(restored.x - view.x) < 0.001);
  assert.ok(Math.abs(restored.y - view.y) < 0.001);
  assert.equal(restored.s, view.s);
  // Junk in the record falls back to the origin, missing zoom to 1:1.
  assert.equal(viewOfAnchor(null), null);
  assert.equal(viewOfAnchor({ x: 'a', y: 1 }), null);
  assert.deepEqual(viewOfAnchor({ x: 10, y: 20 }), { x: -10, y: -20, s: 1 });
  assert.equal(viewOfAnchor({ x: 0, y: 0, s: 99 }).s, ZOOM_MAX);
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
