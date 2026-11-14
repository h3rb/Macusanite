import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseNotes, serializeNotes, updateNote, updateIntro, addNote, removeNote,
  noteEdges, hierarchyEdges, noteStats, countWords, DEFAULT_LEVEL,
  normalizeTag, addNoteTags, removeNoteTag, tagRecord, tagTarget,
  RELATION_KINDS, DEFAULT_RELATION, relationKind, relationKey,
  setRelation, dropRelations, relationOf, groupEndpoint, groupRelationEdges, bondEdges,
  NODE_TYPES, DEFAULT_NODE_TYPE, nodeType, nodeTypeOf, setNodeType,
  NODE_FIELDS, nodeFields, nodeFieldOf, setNodeField, fieldRangeHint, UNIT_SUGGESTIONS, normalizeUnit, rememberUnit, UNIT_VOCABULARY_LIMIT, unitSuggestions,
  ZOOM_MIN, ZOOM_MAX, clampView, zoomViewAt, anchorOfView, viewOfAnchor,
  DROP_MIN_PX, dropMembershipKind,
  canvasSnapshot, pruneSnapshotAnchors, renameAnchorIn,
  DEFAULT_STEP_NAME, normalizeHistoryEntry, cleanHistoryStack, historyJump, historyKey,
  cleanView, restoreSnapshot, canvasRecordPatch,
  pushHistoryStep, rewriteHistoryStack, renameHistoryAnchor, pruneHistoryStack, dropAnchorFromGroups, fitView,
  centreView, snapDelta, canvasHealth, layoutSelection, normalizeRouting, elbowPoints,   connectorCurve, sampleConnectorCurve, spreadConnectorCurves, prepareConnectorGeometry, CONNECTOR_LANE_PITCH, CONNECTOR_SPREAD, CONNECTOR_CUT_SPAN, cleanAnnotations,
  NODE_IMAGES_DIR, isInlineImage, nodeImageRef, nodeImageMetaName,
  nodeImageMetaNames, nodeImageMetaNamesFromSnapshot, referencedNodeImageMetaNames, orphanedNodeImageMetaNames,
  NODE_IMAGE_MAX_SIDE, NODE_IMAGE_QUALITY, nodeImageSize,
  NODE_FILES_DIR, nodeFileRef, nodeFileMetaName, nodeFileMetaNames, nodeFileMetaNamesFromSnapshot,
  referencedNodeFileMetaNames, orphanedNodeFileMetaNames, cleanNodeResources, normalizeWebUrl,
  lockedContentAnchors, sourceSectionRanges, enforceLockedSource, lockedRangeAt,
  connectedAnchors, lineageAnchors, anchorsInRect, relationshipDepths, canvasSearch,
  connectorList, connectorKey, pathAnchors, effectiveRouting, cleanCardModes, cleanCollapsedGroups, proseLinkBetween, unlinkProseBetween,
  arrangeCandidateOrigins, findArrangeOrigin,
  progressionColumns, layoutProgressionColumns, placeConnectorLabels,
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

test('connectedAnchors walks prose links and bonds, seeds included', () => {
  const model = parseNotes(VEIN);
  // Sieve series links Composition in prose; second Composition links Sieve series.
  assert.deepEqual([...connectedAnchors(model, {}, ['sieve-series'])].sort(), ['composition', 'composition-1', 'sieve-series']);
  assert.deepEqual([...connectedAnchors(model, {}, ['fieldwork'])], ['fieldwork']);
  // A bond joins the outline-only parent into the component.
  const relations = setRelation({}, 'fieldwork', 'sieve-series', 'contains');
  assert.deepEqual(
    [...connectedAnchors(model, relations, ['fieldwork'])].sort(),
    ['composition', 'composition-1', 'fieldwork', 'sieve-series'],
  );
});

test('lineageAnchors walks the heading outline without the seeds', () => {
  const model = parseNotes(VEIN);
  assert.deepEqual([...lineageAnchors(model, ['fieldwork'], 'descendants')].sort(), ['composition', 'composition-1', 'sieve-series']);
  assert.deepEqual([...lineageAnchors(model, ['composition'], 'ancestors')].sort(), ['fieldwork', 'sieve-series']);
  assert.deepEqual([...lineageAnchors(model, ['sieve-series'], 'descendants')], ['composition']);
});

test('anchorsInRect finds cards intersecting the marquee', () => {
  const rects = [
    { anchor: 'a', x: 0, y: 0, width: 100, height: 100 },
    { anchor: 'b', x: 200, y: 0, width: 100, height: 100 },
    { anchor: 'c', x: 0, y: 200, width: 100, height: 100 },
  ];
  assert.deepEqual([...anchorsInRect(rects, { x: 50, y: 50, width: 100, height: 100 })].sort(), ['a']);
  // Touching an edge counts: the box from a's corner to b's edge meets both.
  assert.deepEqual([...anchorsInRect(rects, { x: 100, y: 0, width: 100, height: 100 })].sort(), ['a', 'b']);
  assert.deepEqual([...anchorsInRect(rects, { x: 400, y: 400, width: 10, height: 10 })], []);
});

test('relationshipDepths layers a chain by longest path', () => {
  const model = parseNotes('# A\n\n[[#B]]\n\n## B\n\n[[#C]]\n\n## C\n\nEnd.\n');
  const depths = relationshipDepths(model, {}, ['a', 'b', 'c']);
  assert.deepEqual([...depths.entries()].sort(), [['a', 0], ['b', 1], ['c', 2]]);
  // A cycle still gets finite depths rather than spinning.
  const cyclic = relationshipDepths(model, setRelation({}, 'c', 'a', 'ally'), ['a', 'b', 'c']);
  assert.ok([...cyclic.values()].every((depth) => Number.isFinite(depth)));
});

test('canvasSearch matches titles, types, fields, colours and group names', () => {
  const model = parseNotes('# Alpha\n\nBody.\n\n## Beta\n\nMore.\n\n## Gamma\n\nLast.\n');
  const record = {
    types: { beta: 'stat' },
    fields: { beta: { value: '42' } },
    colors: { gamma: '#58a6ff' },
    groups: { g1: { id: 'g1', name: 'Guild', members: ['alpha', 'beta'], children: [] } },
  };
  assert.deepEqual(canvasSearch(model, record, 'alpha').map((m) => m.anchor), ['alpha']);
  assert.deepEqual(canvasSearch(model, record, 'stat').map((m) => m.anchor), ['beta']);
  assert.deepEqual(canvasSearch(model, record, '42').map((m) => m.anchor), ['beta']);
  assert.deepEqual(canvasSearch(model, record, '58a6ff').map((m) => m.anchor), ['gamma']);
  assert.deepEqual(canvasSearch(model, record, 'guild').map((m) => m.anchor), ['alpha', 'beta']);
  // Terms are ANDed: alpha is in the Guild, gamma is not.
  assert.deepEqual(canvasSearch(model, record, 'guild alpha').map((m) => m.anchor), ['alpha']);
  assert.deepEqual(canvasSearch(model, record, 'absent'), []);
  assert.deepEqual(canvasSearch(model, record, ''), []);
});

test('connectorList names every drawn connector and keys them stably', () => {
  const model = parseNotes('# A\n\n[[#B]]\n\n## B\n\nEnd.\n');
  const list = connectorList(model, {}, {});
  assert.deepEqual(list.map(connectorKey).sort(), ['contains:a->b', 'section:a->b']);
  assert.equal(connectorKey({ kind: 'bond', from: 'a', to: 'group:g1' }), 'bond:a->group:g1');
});

test('proseLinkBetween reports the markdown link a bond removal leaves behind', () => {
  const model = parseNotes('# A\n\nSee [[#B]].\n\n## B\n\nEnd.\n');
  assert.equal(proseLinkBetween(model, 'a', 'b')?.kind, 'section');
  assert.equal(proseLinkBetween(model, 'b', 'a')?.kind, 'section', 'either direction counts');
  // A mention, [[Elsewhere]], is prose too — it draws the same kind of wire.
  const mention = parseNotes('# A\n\nSee [[Elsewhere]].\n\n## Elsewhere\n\nEnd.\n');
  assert.equal(proseLinkBetween(mention, 'a', 'elsewhere')?.kind, 'mention');
  // No link in the prose, an unknown end, or the same note twice: nothing.
  const bare = parseNotes('# A\n\nBody.\n\n## B\n\nBody.\n');
  assert.equal(proseLinkBetween(bare, 'a', 'b'), null);
  assert.equal(proseLinkBetween(mention, 'a', 'missing'), null);
  assert.equal(proseLinkBetween(mention, 'a', 'a'), null);
});

test('unlinkProseBetween takes the markdown link out and keeps its words', () => {
  const model = parseNotes('# A\n\nSee [[#B]] and [[#C]].\n\n## B\n\n[[A]] again.\n\n## C\n\nEnd.\n');
  // Both directions go: the wire only leaves once neither note links the other.
  const unlinked = unlinkProseBetween(model, 'a', 'b');
  assert.equal(unlinked.removed, 2);
  assert.equal(unlinked.model.notes[0].body, 'See B and [[#C]].');
  assert.equal(unlinked.model.notes[1].body, 'A again.');
  assert.equal(proseLinkBetween(unlinked.model, 'a', 'b'), null);
  assert.equal(proseLinkBetween(unlinked.model, 'a', 'c')?.kind, 'section', 'other links stay');
  // The alias is what the reader saw, so it is what the prose keeps.
  const aliased = parseNotes('# A\n\nSee [[#B|the second one]].\n\n## B\n\nEnd.\n');
  assert.equal(unlinkProseBetween(aliased, 'a', 'b').model.notes[0].body, 'See the second one.');
  // Links parse again from the new prose, so nothing else about the note drifts.
  assert.deepEqual(unlinked.model.notes[0].links.map((link) => link.anchor), ['c']);
  // Nothing to unlink: the model comes back untouched.
  const bare = parseNotes('# A\n\nBody.\n\n## B\n\nBody.\n');
  assert.equal(unlinkProseBetween(bare, 'a', 'b').removed, 0);
  assert.equal(unlinkProseBetween(bare, 'a', 'b').model, bare);
  assert.equal(unlinkProseBetween(bare, 'a', 'a').removed, 0);
});

test('pathAnchors traces downstream and upstream along directed bonds', () => {
  const model = parseNotes('# A\n\nBody.\n\n## B\n\nBody.\n\n## C\n\nBody.\n');
  const relations = setRelation(setRelation({}, 'a', 'b', 'contains'), 'b', 'c', 'controls');
  assert.deepEqual([...pathAnchors(model, relations, ['a'], 'downstream')].sort(), ['b', 'c']);
  assert.deepEqual([...pathAnchors(model, relations, ['c'], 'upstream')].sort(), ['a', 'b']);
  assert.deepEqual([...pathAnchors(model, relations, ['b'], 'downstream')], ['c']);
});

test('routing overrides sit beside the vein default', () => {
  const routing = normalizeRouting({ elbow: true, arrows: false, cut: true, edges: { 'bond:a->b': { arrows: true, cut: false }, junk: 'x', 'bond:c->d': {} } });
  assert.deepEqual(routing, { elbow: true, arrows: false, cut: true, edges: { 'bond:a->b': { arrows: true, cut: false } } });
  assert.deepEqual(effectiveRouting(routing, 'bond:a->b'), { elbow: true, arrows: true, cut: false });
  assert.deepEqual(effectiveRouting(routing, 'bond:x->y'), { elbow: true, arrows: false, cut: true });
  assert.deepEqual(normalizeRouting(null), { elbow: false, arrows: false, cut: false, edges: {} });
});

test('cleanCardModes keeps only compact and thumbnail', () => {
  assert.deepEqual(cleanCardModes({ a: 'compact', b: 'thumbnail', c: 'full', d: 'huge', '': 'compact' }), { a: 'compact', b: 'thumbnail' });
  assert.deepEqual(cleanCardModes(null), {});
});

test('cleanCollapsedGroups keeps only true entries', () => {
  assert.deepEqual(cleanCollapsedGroups({ g1: true, g2: false, g3: 'yes' }), { g1: true });
  assert.deepEqual(cleanCollapsedGroups(null), {});
});

test('canvas snapshots carry card modes and group collapse through an undo', () => {
  const snap = canvasSnapshot({
    positions: { a: { x: 1, y: 2 }, b: { x: 3, y: 4 } },
    groups: { g1: { members: ['a', 'b'] } },
    cardModes: { a: 'compact' }, collapsedGroups: { g1: true },
  });
  const restored = restoreSnapshot(snap, new Set(['a', 'b']), {});
  assert.deepEqual(restored.cardModes, { a: 'compact' });
  assert.deepEqual(restored.collapsedGroups, { g1: true });
  // Legacy snapshots without the slices restore clean.
  const legacy = restoreSnapshot(JSON.stringify({ positions: { a: { x: 1, y: 2 } } }), new Set(['a']), {});
  assert.deepEqual(legacy.cardModes, {});
  assert.deepEqual(legacy.collapsedGroups, {});
});

test('arrangement search keeps going past a huge blocker', () => {
  const overlaps = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
  const blockers = [{ x: -1000, y: -1000, width: 200000, height: 2000 }];
  const fits = (at) => !blockers.some((blocker) => overlaps({ x: at.x, y: at.y, width: 300, height: 260 }, blocker));
  const found = findArrangeOrigin(
    arrangeCandidateOrigins('rows', { x: 0, y: 0 }, { stepX: 100, stepY: 100 }),
    fits,
  );
  assert.equal(found.x, 199000);
  assert.equal(found.y, 0);
});

test('arrangement search stops at its safety bound', () => {
  let checks = 0;
  const found = findArrangeOrigin(
    arrangeCandidateOrigins('rows', { x: 0, y: 0 }, { stepX: 1, stepY: 1 }),
    () => {
      checks += 1;
      return false;
    },
    3,
  );
  assert.equal(found, null);
  assert.equal(checks, 3);
});

test('progressionColumns puts top tree items left and deeper tiers right', () => {
  const model = parseNotes(VEIN);
  const columns = progressionColumns(model, ['fieldwork', 'sieve-series', 'composition', 'composition-1']);
  assert.deepEqual([...columns.entries()], [
    ['fieldwork', 0],
    ['sieve-series', 1],
    ['composition', 2],
    ['composition-1', 1],
  ]);
  // A card whose parent is outside the set is a top item of the set.
  const subset = progressionColumns(model, ['composition']);
  assert.deepEqual([...subset.entries()], [['composition', 0]]);
  assert.deepEqual([...progressionColumns(model, []).entries()], []);
});

test('layoutProgressionColumns stacks each column top to bottom', () => {
  const next = layoutProgressionColumns([
    { key: 'a', column: 0, height: 100 },
    { key: 'b', column: 1, height: 100 },
    { key: 'c', column: 0, height: 50 },
    { key: 'd', column: 2, height: 100 },
  ], { origin: { x: 10, y: 20 }, stepX: 300, stepY: 40 });
  assert.deepEqual(next.get('a'), { x: 10, y: 20 });
  assert.deepEqual(next.get('b'), { x: 310, y: 20 });
  assert.deepEqual(next.get('c'), { x: 10, y: 160 });
  assert.deepEqual(next.get('d'), { x: 610, y: 20 });
});

test('progression arrangement walks down one column', () => {
  const candidates = arrangeCandidateOrigins('progression', { x: 5, y: 7 }, { stepX: 300, stepY: 100, column: 2 });
  assert.deepEqual(candidates.next().value, { x: 605, y: 7 });
  assert.deepEqual(candidates.next().value, { x: 605, y: 107 });
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

test('tagTarget finds the node a tag names, and nothing else', () => {
  const model = parseNotes('# Field checklist\n\nBody.\n\n## Field notes\n\nText.\n');
  assert.equal(tagTarget('field-checklist', model.notes)?.anchor, 'field-checklist');
  assert.equal(tagTarget('#field-checklist', model.notes)?.title, 'Field checklist');
  assert.equal(tagTarget('FIELD-CHECKLIST', model.notes)?.anchor, 'field-checklist');
  // Only an exact anchor match counts — a prefix or a space is no node.
  assert.equal(tagTarget('field', model.notes), null);
  assert.equal(tagTarget('field checklist', model.notes), null);
  assert.equal(tagTarget('missing', model.notes), null);
  assert.equal(tagTarget('', model.notes), null);
  assert.equal(tagTarget('glass', null), null);
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

test('a content-locked node\'s tags cannot change; linking is not a tag', () => {
  const model = parseNotes('## Sieve\n\nCoarse to fine.\n\n#glass\n');
  // Locked: add and remove both hand the same model back, prose untouched.
  assert.equal(addNoteTags(model, 0, ['petrology'], { locked: true }), model);
  assert.equal(removeNoteTag(model, 0, 'glass', { locked: true }), model);
  assert.equal(serializeNotes(model), '## Sieve\n\nCoarse to fine.\n\n#glass\n');
  // Unlocked: the same calls still work, as the tests above pin down.
  assert.deepEqual(addNoteTags(model, 0, ['petrology']).notes[0].tags, ['glass', 'petrology']);
  assert.deepEqual(removeNoteTag(model, 0, 'glass').notes[0].tags, []);
  // The lock combination the panel gates on: a node lock and a locked group
  // both count as content-locked, exactly as for title/body/type/fields.
  assert.deepEqual([...lockedContentAnchors({ g: { members: ['sieve'], locked: true } }, { sieve: false })], ['sieve']);
  assert.deepEqual([...lockedContentAnchors({}, { sieve: true })], ['sieve']);
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
  assert.deepEqual(nodeFields('attribute').map((f) => f.id), ['key', 'value', 'unit']);
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

test('an attribute is a value and unit pair; units normalise and join the autocomplete', () => {
  let fields = setNodeField({}, 'attribute', 'a', 'value', '1200');
  fields = setNodeField(fields, 'attribute', 'a', 'unit', '  °C  ');
  assert.equal(nodeFieldOf(fields, 'a', 'value'), '1200');
  assert.equal(nodeFieldOf(fields, 'a', 'unit'), '°C');
  // Inner whitespace collapses; property (the other key/value type) has no unit.
  fields = setNodeField(fields, 'attribute', 'a', 'unit', 'tokens  per  day');
  assert.equal(nodeFieldOf(fields, 'a', 'unit'), 'tokens per day');
  assert.equal(setNodeField(fields, 'property', 'a', 'unit', '°C'), fields);
  assert.deepEqual(nodeFields('attribute').find((f) => f.id === 'unit'), { id: 'unit', label: 'Unit', kind: 'unit' });
  // The predetermined list leads; hand-entered units join it, de-duplicated
  // case-insensitively, across every record handed in.
  const suggestions = unitSuggestions([fields, { b: { unit: 'furlongs' } }, { c: { unit: 'TOKENS PER DAY' } }]);
  assert.deepEqual(suggestions.slice(0, UNIT_SUGGESTIONS.length), UNIT_SUGGESTIONS);
  assert.ok(suggestions.includes('tokens per day'));
  assert.ok(suggestions.includes('furlongs'));
  assert.equal(suggestions.filter((u) => u.toLowerCase() === 'tokens per day').length, 1);
  assert.equal(normalizeUnit('  kg  '), 'kg');
  assert.equal(normalizeUnit(''), '');
});

test('hand-typed units stay offered after their field is cleared or card deleted', () => {
  let fields = setNodeField({}, 'attribute', 'a', 'unit', '  furlongs  per  day ');
  let learned = rememberUnit([], nodeFieldOf(fields, 'a', 'unit'));
  assert.deepEqual(learned, ['furlongs per day']);
  assert.ok(unitSuggestions(fields, learned).includes('furlongs per day'));

  // Clearing the unit removes it from the stored fields, but not from the
  // vocabulary that feeds the autocomplete.
  fields = setNodeField(fields, 'attribute', 'a', 'unit', '');
  assert.equal(nodeFieldOf(fields, 'a', 'unit'), '');
  assert.ok(unitSuggestions(fields, learned).includes('furlongs per day'));

  // Deleting the card removes its fields record entirely; the suggestion stays.
  delete fields.a;
  assert.ok(unitSuggestions(fields, learned).includes('furlongs per day'));

  // Learned units lead the non-predetermined suggestions, newest first, and
  // de-duplicate case-insensitively against both learned and stored values.
  learned = rememberUnit(learned, 'Tokens');
  learned = rememberUnit(learned, 'tokens');
  const suggestions = unitSuggestions({ b: { unit: 'FURLONGS PER DAY' } }, learned);
  assert.deepEqual(suggestions.slice(UNIT_SUGGESTIONS.length, UNIT_SUGGESTIONS.length + 2), ['tokens', 'furlongs per day']);
  assert.equal(suggestions.filter((unit) => unit.toLowerCase() === 'tokens').length, 1);
  assert.equal(suggestions.filter((unit) => unit.toLowerCase() === 'furlongs per day').length, 1);

  // An empty input never adds a blank suggestion, and the list is bounded.
  assert.deepEqual(rememberUnit(learned, '   '), learned);
  let many = [];
  for (let i = 0; i <= UNIT_VOCABULARY_LIMIT; i++) many = rememberUnit(many, `unit ${i}`);
  assert.equal(many.length, UNIT_VOCABULARY_LIMIT);
  assert.equal(many[0], `unit ${UNIT_VOCABULARY_LIMIT}`);
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

test('canvasSnapshot carries every canvas slice, node types, fields and colours included', () => {
  const str = canvasSnapshot({
    positions: { a: { x: 10, y: 20 } },
    groups: { g: { members: ['a', 'b'], locked: true } },
    relations: { 'a->b': 'ally' },
    folded: { a: { card: true } },
    types: { a: 'stat', b: 'perk' },
    fields: { a: { min: '5', max: '10' }, b: {} },
    colors: { a: '#ff0000', b: '#00ff00' },
    images: { a: 'data:image/png;base64,AAA' },
    locked: { a: true },
    cardSizes: { a: 'content', b: 'fixed' },
    resources: { a: { files: [{ name: 'field.pdf', ref: '.macusanite/node-files/field.pdf', size: 2048 }], urls: [{ label: 'example.com', url: 'https://example.com/' }] } },
    view: { x: 3, y: 4, s: 1.5 },
  });
  const back = JSON.parse(str);
  assert.deepEqual(back.positions, { a: { x: 10, y: 20 } });
  assert.deepEqual(back.groups, { g: { members: ['a', 'b'], locked: true } });
  assert.deepEqual(back.relations, { 'a->b': 'ally' });
  assert.deepEqual(back.folded, { a: { card: true } });
  assert.deepEqual(back.types, { a: 'stat', b: 'perk' });
  assert.deepEqual(back.fields, { a: { min: '5', max: '10' }, b: {} });
  assert.deepEqual(back.colors, { a: '#ff0000', b: '#00ff00' });
  assert.deepEqual(back.images, { a: 'data:image/png;base64,AAA' });
  assert.deepEqual(back.locked, { a: true });
  // Both heights survive: `fixed` is an override of a content-sized vault.
  assert.deepEqual(back.cardSizes, { a: 'content', b: 'fixed' });
  assert.deepEqual(back.resources.a.urls, [{ label: 'example.com', url: 'https://example.com/' }]);
  assert.equal(back.resources.a.files[0].ref, '.macusanite/node-files/field.pdf');
  assert.deepEqual(back.view, { x: 3, y: 4, s: 1.5 });
  // Missing slices default, camera included.
  const bare = JSON.parse(canvasSnapshot());
  assert.deepEqual(bare, {
    positions: {}, groups: {}, relations: {}, folded: {}, types: {}, fields: {}, colors: {}, images: {}, resources: {}, pinned: {}, locked: {}, cardModes: {}, cardSizes: {}, collapsedGroups: {}, annotations: {}, view: { x: 0, y: 0, s: 1 },
  });
});

test('pruneSnapshotAnchors drops dead anchors, thin groups and their bonds', () => {
  const snap = JSON.parse(canvasSnapshot({
    positions: { a: { x: 1, y: 2 }, gone: { x: 3, y: 4 }, b: { x: 5, y: 6 } },
    groups: {
      main: { members: ['a', 'b', 'gone'] },
      thin: { members: ['a', 'gone'] },
    },
    relations: {
      'a->b': 'ally', 'a->gone': 'foe',
      'a->group:main': 'affects', 'a->group:thin': 'foe',
    },
    collapsedGroups: { main: true, thin: true },
    folded: { gone: { card: true }, a: { links: true } },
    types: { gone: 'stat', a: 'perk' },
    fields: { gone: { min: '1' }, a: { max: '9' } },
    colors: { gone: '#ff0000', a: '#0000ff' },
    images: { gone: 'data:image/png;base64,XXX', a: 'data:image/png;base64,YYY' },
    pinned: { gone: true, a: true },
    locked: { gone: true, a: true },
    annotations: { note: { x: 10, y: 20, text: 'check this later' }, bad: { x: 'no', y: 0, text: 'junk' } },
  }));
  const pruned = pruneSnapshotAnchors(snap, new Set(['a', 'b']));
  assert.deepEqual(pruned.positions, { a: { x: 1, y: 2 }, b: { x: 5, y: 6 } });
  assert.deepEqual(pruned.folded, { a: { links: true } });
  assert.deepEqual(pruned.types, { a: 'perk' });
  assert.deepEqual(pruned.fields, { a: { max: '9' } });
  assert.deepEqual(pruned.colors, { a: '#0000ff' });
  assert.deepEqual(pruned.images, { a: 'data:image/png;base64,YYY' });
  assert.deepEqual(pruned.pinned, { a: true });
  assert.deepEqual(pruned.locked, { a: true });
  assert.deepEqual(pruned.annotations, { note: { id: 'note', x: 10, y: 20, text: 'check this later' } });
  // A group left under two cards dissolves with its bonds; one that survives
  // sheds only the dead members.
  assert.deepEqual(Object.keys(pruned.groups), ['main']);
  assert.deepEqual(pruned.groups.main.members, ['a', 'b']);
  assert.deepEqual(pruned.relations, { 'a->b': 'ally', 'a->group:main': 'affects' });
  assert.deepEqual(pruned.collapsedGroups, { main: true });
  // Snapshots written before types, fields and colours existed gain none here.
  const old = JSON.parse(JSON.stringify(snap));
  delete old.types;
  delete old.fields;
  delete old.colors;
  delete old.images;
  delete old.pinned;
  delete old.annotations;
  const repruned = pruneSnapshotAnchors(old, new Set(['a', 'b']));
  assert.equal('types' in repruned, false);
  assert.equal('fields' in repruned, false);
  assert.equal('colors' in repruned, false);
  assert.equal('images' in repruned, false);
  assert.equal('pinned' in repruned, false);
  assert.equal('annotations' in repruned, false);
});

test('snapshots round float drag positions to the persisted integers exactly', () => {
  // A drag ends between pixels, but the record persists whole pixels —
  // so the snapshot, and therefore one undo, must carry the same integer.
  const snap = canvasSnapshot({ positions: { a: { x: 2349.199, y: 412.6 } } });
  const parsed = JSON.parse(snap);
  assert.deepEqual(parsed.positions, { a: { x: 2349, y: 413 } });
  // Undo restores exactly what was saved, not the live float.
  const restored = restoreSnapshot(snap, new Set(['a']), {});
  assert.deepEqual(restored.positions, { a: { x: 2349, y: 413 } });
  // Even a legacy snapshot holding the raw float restores the integer.
  const legacy = JSON.stringify({ positions: { a: { x: 2349.199, y: 412.6 } } });
  assert.deepEqual(restoreSnapshot(legacy, new Set(['a']), {}).positions, { a: { x: 2349, y: 413 } });
});

test('node image references are file paths, with legacy data URLs still recognised', () => {
  assert.equal(NODE_IMAGES_DIR, '.macusanite/node-images');
  assert.equal(nodeImageRef('lens.png'), '.macusanite/node-images/lens.png');
  assert.equal(nodeImageMetaName('.macusanite/node-images/lens.png'), 'node-images/lens.png');
  assert.equal(isInlineImage('data:image/png;base64,AAA'), true);
  assert.equal(nodeImageMetaName('data:image/png;base64,AAA'), null);
  assert.equal(isInlineImage('.macusanite/node-images/lens.png'), false);
});

test('replaced or removed node images are orphaned only once nothing references them', () => {
  const snap = (images) => JSON.stringify({ images });
  const referenced = referencedNodeImageMetaNames({
    images: { b: '.macusanite/node-images/b.png', inline: 'data:image/png;base64,AAA' },
    history: { past: [{ name: 'Set image', snap: snap({ a: '.macusanite/node-images/a.png' }) }], future: [] },
    worlds: {
      'Other.md': {
        images: { c: '.macusanite/node-images/c.png' },
        history: { past: [], future: [{ name: 'redo', snap: snap({ d: '.macusanite/node-images/d.png' }) }] },
      },
    },
  });
  assert.deepEqual([...referenced].sort(), [
    'node-images/a.png', 'node-images/b.png', 'node-images/c.png', 'node-images/d.png',
  ]);
  // a.png is gone from the nodes but an undo snapshot still names it: kept.
  assert.deepEqual(
    orphanedNodeImageMetaNames(['.macusanite/node-images/a.png', '.macusanite/node-images/gone.png', 'data:image/png;base64,AAA'], referenced),
    ['node-images/gone.png'],
  );
  // Once the snapshot is dropped, a.png is an orphan too.
  assert.deepEqual(
    orphanedNodeImageMetaNames(['node-images/a.png'], new Set()),
    ['node-images/a.png'],
  );
  // A file shared by two nodes is never orphaned while one still names it.
  assert.deepEqual(nodeImageMetaNames({ x: '.macusanite/node-images/s.png', y: '.macusanite/node-images/s.png' }), ['node-images/s.png']);
  assert.deepEqual(nodeImageMetaNamesFromSnapshot('not json'), []);
});

test('node resources attach files under node-files and validate web URLs', () => {
  assert.equal(NODE_FILES_DIR, '.macusanite/node-files');
  assert.equal(nodeFileRef('brief.pdf'), '.macusanite/node-files/brief.pdf');
  assert.equal(nodeFileMetaName('.macusanite/node-files/brief.pdf'), 'node-files/brief.pdf');
  assert.equal(nodeFileMetaName('node-files/brief.pdf'), 'node-files/brief.pdf');
  assert.equal(nodeFileMetaName('.macusanite/node-images/x.png'), null);
  assert.equal(nodeFileMetaName('../secret.txt'), null);
  assert.equal(normalizeWebUrl('https://example.com/a b'), 'https://example.com/a%20b');
  assert.equal(normalizeWebUrl('http://example.com'), 'http://example.com/');
  assert.equal(normalizeWebUrl('javascript:alert(1)'), null);
  assert.equal(normalizeWebUrl('file:///etc/passwd'), null);
  assert.equal(normalizeWebUrl('not a url'), null);

  const cleaned = cleanNodeResources({
    a: {
      files: [
        { name: 'brief.pdf', ref: '.macusanite/node-files/brief.pdf', size: 2048, type: 'application/pdf' },
        { name: 'again.pdf', ref: '.macusanite/node-files/brief.pdf' },
        { name: 'escape', ref: '../secret.txt' },
      ],
      urls: [
        { label: 'Example', url: 'https://example.com/' },
        { label: 'dup', url: 'https://example.com/' },
        { label: 'bad', url: 'file:///etc/passwd' },
      ],
    },
    empty: { files: [], urls: [] },
    junk: 'nope',
  });
  assert.deepEqual(Object.keys(cleaned), ['a']);
  assert.equal(cleaned.a.files.length, 1);
  assert.deepEqual(cleaned.a.files[0], {
    name: 'brief.pdf', ref: '.macusanite/node-files/brief.pdf', size: 2048, type: 'application/pdf',
  });
  assert.deepEqual(cleaned.a.urls, [{ label: 'Example', url: 'https://example.com/' }]);
});

test('attachment files are orphans only when no record or snapshot names them', () => {
  const snap = (resources) => JSON.stringify({ resources });
  const resources = { a: { files: [{ ref: '.macusanite/node-files/keep.pdf' }] } };
  const referenced = referencedNodeFileMetaNames({
    resources,
    history: { past: [{ name: 'Attach', snap: snap(resources) }], future: [] },
    worlds: { 'Other.md': { resources: { b: { files: [{ ref: '.macusanite/node-files/undo.pdf' }] } } } },
  });
  assert.deepEqual([...referenced].sort(), ['node-files/keep.pdf', 'node-files/undo.pdf']);
  assert.deepEqual(
    orphanedNodeFileMetaNames(['.macusanite/node-files/gone.pdf', '.macusanite/node-files/keep.pdf'], referenced),
    ['node-files/gone.pdf'],
  );
  assert.deepEqual(nodeFileMetaNames(resources), ['node-files/keep.pdf']);
  assert.deepEqual(nodeFileMetaNamesFromSnapshot('not json'), []);
});

test('node images are capped at 320px on the longest side and never upscaled', () => {
  assert.equal(NODE_IMAGE_MAX_SIDE, 320);
  assert.equal(NODE_IMAGE_QUALITY, 0.8);
  assert.deepEqual(nodeImageSize(4000, 3000), [320, 240]);
  assert.deepEqual(nodeImageSize(100, 50), [100, 50]);
  assert.deepEqual(nodeImageSize(320, 320), [320, 320]);
  assert.deepEqual(nodeImageSize(321, 10), [320, 10]);
});

test('locked content anchors include nested group members and node locks', () => {
  const anchors = lockedContentAnchors({
    outer: { id: 'outer', members: ['a'], children: ['inner'], locked: true },
    inner: { id: 'inner', members: ['b'], children: [] },
    free: { id: 'free', members: ['c'], children: [] },
  }, { d: true, e: false });
  assert.deepEqual([...anchors].sort(), ['a', 'b', 'd']);
});

test('source sections map headings to their prose ranges', () => {
  const text = '---\ntitle: Demo\n---\n# Title\n\nIntro ignored.\n\n## Locked\n\nKeep me.\n\n## Free\n\nChange me.\n';
  const ranges = sourceSectionRanges(text);
  assert.deepEqual(ranges.map((range) => [range.anchor, range.startLine, range.endLine]), [
    ['title', 3, 7],
    ['locked', 7, 11],
    ['free', 11, 15],
  ]);
  assert.equal(text.slice(ranges[1].start, ranges[1].end), '## Locked\n\nKeep me.\n\n');
});

test('locked ranges block carets and selections that touch them', () => {
  const ranges = [{ anchor: 'locked', start: 10, end: 20 }];
  assert.equal(lockedRangeAt(ranges, 10, 10)?.anchor, 'locked');
  assert.equal(lockedRangeAt(ranges, 15, 15)?.anchor, 'locked');
  assert.equal(lockedRangeAt(ranges, 20, 20), null);
  assert.equal(lockedRangeAt(ranges, 0, 10), null);
  assert.equal(lockedRangeAt(ranges, 9, 11)?.anchor, 'locked');
  assert.equal(lockedRangeAt(ranges, 19, 30)?.anchor, 'locked');
});

test('enforcing locked source keeps outside edits and restores locked prose', () => {
  const base = '---\ntitle: Demo\n---\n# Title\n\n## Locked\n\nKeep me.\n\n## Free\n\nOriginal.\n';
  const draft = base.replace('Original.', 'Changed.').replace('Keep me.', 'Changed too.');
  const enforced = enforceLockedSource(base, draft, new Set(['locked']));
  assert.equal(enforced.ok, true);
  assert.match(enforced.text, /Keep me\./);
  assert.match(enforced.text, /Changed\./);
  assert.doesNotMatch(enforced.text, /Changed too\./);
});

test('enforcing locked source refuses structural escapes', () => {
  const base = '# Title\n\n## Locked\n\nKeep me.\n\n## Free\n\nOriginal.\n';
  const renamed = enforceLockedSource(base, base.replace('## Locked', '## Renamed'), new Set(['locked']));
  assert.equal(renamed.ok, false);
  assert.deepEqual(renamed.blocked, ['locked']);
  const inserted = enforceLockedSource(base, base.replace('Keep me.\n\n## Free', 'Keep me.\n## New\n\nInside.\n\n## Free'), new Set(['locked']));
  assert.equal(inserted.ok, false);
  assert.ok(inserted.blocked.includes('new'));
});

test('node content locks survive snapshot, restore and rename', () => {
  const snap = JSON.parse(canvasSnapshot({
    positions: { a: { x: 1, y: 2 } },
    locked: { a: true },
  }));
  const restored = restoreSnapshot(canvasSnapshot(JSON.parse(JSON.stringify(snap))), new Set(['a']), { locked: {} });
  assert.deepEqual(restored.locked, { a: true });
  const renamed = renameAnchorIn(snap, 'a', 'b');
  assert.deepEqual(renamed.locked, { b: true });
  const patch = canvasRecordPatch({ positions: {}, groups: {}, relations: {}, folded: {}, locked: { b: true } });
  assert.deepEqual(patch.locked, { b: true });
});

test('renameAnchorIn carries types and fields onto the new name', () => {
  const snap = JSON.parse(canvasSnapshot({
    positions: { old: { x: 1, y: 2 } },
    folded: { old: { card: true } },
    types: { old: 'stat' },
    fields: { old: { min: '5' } },
    relations: { 'old->a': 'ally', 'a->b': 'foe' },
    groups: { g: { members: ['old', 'a'] } },
    view: { x: 0, y: 0, s: 1 },
  }));
  const renamed = renameAnchorIn(snap, 'old', 'new');
  assert.deepEqual(renamed.positions, { new: { x: 1, y: 2 } });
  assert.deepEqual(renamed.folded, { new: { card: true } });
  assert.deepEqual(renamed.types, { new: 'stat' });
  assert.deepEqual(renamed.fields, { new: { min: '5' } });
  // Bonds naming the old name drop, as the record's do; members follow.
  assert.deepEqual(renamed.relations, { 'a->b': 'foe' });
  assert.deepEqual(renamed.groups.g.members, ['new', 'a']);
  // Snapshots without types/fields stay that way.
  const old = JSON.parse(JSON.stringify(snap));
  delete old.types;
  delete old.fields;
  const r2 = renameAnchorIn(old, 'old', 'new');
  assert.equal('types' in r2, false);
  assert.equal('fields' in r2, false);
});

const step = (name, snap) => ({ name, snap });
const S = (n) => JSON.stringify({ n });

test('historyKey keeps identical vein paths in different vaults apart', () => {
  assert.equal(historyKey('/vaults/one', 'thoughts/a.md'), '/vaults/one\0thoughts/a.md');
  assert.notEqual(historyKey('/vaults/one', 'thoughts/a.md'), historyKey('/vaults/two', 'thoughts/a.md'));
  assert.equal(historyKey(null, 'thoughts/a.md'), '\0thoughts/a.md');
});

test('normalizeHistoryEntry settles stored entries to name and snap', () => {
  assert.deepEqual(normalizeHistoryEntry(S(1)), { name: DEFAULT_STEP_NAME, snap: S(1) });
  assert.deepEqual(normalizeHistoryEntry({ name: 'Arrange', snap: S(2) }), { name: 'Arrange', snap: S(2) });
  assert.deepEqual(normalizeHistoryEntry({ name: '  ', snap: S(3) }), { name: DEFAULT_STEP_NAME, snap: S(3) });
  assert.deepEqual(normalizeHistoryEntry({ snap: S(4) }), { name: DEFAULT_STEP_NAME, snap: S(4) });
  assert.equal(normalizeHistoryEntry(null), null);
  assert.equal(normalizeHistoryEntry({ name: 'Arrange' }), null);
  assert.equal(normalizeHistoryEntry({ name: 'Arrange', snap: 42 }), null);
  assert.equal(normalizeHistoryEntry(17), null);
});

test('cleanHistoryStack keeps entries, drops junk and caps the length', () => {
  assert.deepEqual(cleanHistoryStack(undefined), { past: [], future: [] });
  assert.deepEqual(cleanHistoryStack({ past: 'nope', future: null }), { past: [], future: [] });
  const cleaned = cleanHistoryStack({
    past: [S(1), { name: 'Arrange', snap: S(2) }, null, { name: 'Odd', snap: 3 }],
    future: [{ name: 'Move card', snap: S(4) }, 17],
  });
  assert.deepEqual(cleaned, {
    past: [{ name: DEFAULT_STEP_NAME, snap: S(1) }, step('Arrange', S(2))],
    future: [step('Move card', S(4))],
  });
  const capped = cleanHistoryStack({ past: [S(1), S(2), S(3)], future: [S(4), S(5)] }, 2);
  assert.deepEqual(capped.past.map((entry) => entry.snap), [S(2), S(3)]);
  assert.deepEqual(capped.future.map((entry) => entry.snap), [S(4), S(5)]);
});

test('historyJump undoes several steps at once, and single-stepping works back', () => {
  const stack = { past: [step('A', S(0)), step('B', S(1)), step('C', S(2))], future: [] };
  const jumped = historyJump(stack, 'undo', 2, S(3));
  assert.equal(jumped.restore, S(1));
  assert.deepEqual(jumped.past, [step('A', S(0))]);
  assert.deepEqual(jumped.future, [step('C', S(3)), step('B', S(2))]);
  // Redoing from here walks the same two states back, newest name first.
  const again = historyJump(jumped, 'redo', 1, S(1));
  assert.equal(again.restore, S(2));
  const home = historyJump(again, 'redo', 1, S(2));
  assert.equal(home.restore, S(3));
  assert.deepEqual(home.future, []);
  assert.deepEqual(home.past, [step('A', S(0)), step('B', S(1)), step('C', S(2))]);
});

test('historyJump redoes several steps at once, and undo returns to the current canvas', () => {
  const stack = { past: [], future: [step('C', S(3)), step('B', S(2)), step('A', S(1))] };
  const jumped = historyJump(stack, 'redo', 2, S(0));
  assert.equal(jumped.restore, S(2));
  assert.deepEqual(jumped.future, [step('C', S(3))]);
  assert.deepEqual(jumped.past, [step('A', S(0)), step('B', S(1))]);
  const back = historyJump(jumped, 'undo', 1, S(2));
  assert.equal(back.restore, S(1));
  assert.deepEqual(back.past, [step('A', S(0))]);
  assert.deepEqual(back.future, [step('C', S(3)), step('B', S(2))]);
});

test('historyJump refuses a jump it cannot make', () => {
  const stack = { past: [S(0)].map((snap) => step('A', snap)), future: [] };
  assert.equal(historyJump(stack, 'undo', 0, S(1)), null);
  assert.equal(historyJump(stack, 'undo', 2, S(1)), null);
  assert.equal(historyJump(stack, 'redo', 1, S(1)), null);
  assert.equal(historyJump(stack, 'up', 1, S(1)), null);
  assert.equal(historyJump(null, 'undo', 1, S(1)), null);
});

test('cleanView keeps the camera, clamped, or keeps the fallback', () => {
  assert.deepEqual(cleanView({ x: 10, y: -20, s: 1.5 }), { x: 10, y: -20, s: 1.5 });
  assert.deepEqual(cleanView({ x: 10, y: -20 }), { x: 10, y: -20, s: 1 });
  assert.equal(cleanView({ x: 0, y: 0, s: 99 }).s, ZOOM_MAX);
  assert.equal(cleanView({ x: 0, y: 0, s: 0.01 }).s, ZOOM_MIN);
  // An unusable stored view keeps whatever camera was there.
  const current = { x: 5, y: 6, s: 2 };
  assert.deepEqual(cleanView(null, current), current);
  assert.deepEqual(cleanView({ x: 'a', y: 1 }, current), current);
  assert.deepEqual(cleanView({ y: 1 }, current), current);
  assert.equal(cleanView({ y: 1 }), null);
});

test('restoreSnapshot restores only references to anchors and groups that are live', () => {
  const snap = canvasSnapshot({
    positions: { a: { x: 1, y: 2 }, gone: { x: 3, y: 4 } },
    groups: { main: { members: ['a', 'b', 'gone'] } },
    relations: {
      'a->b': 'ally', 'a->gone': 'foe',
      'a->group:main': 'affects', 'group:main->gone': 'foe',
    },
    collapsedGroups: { main: true, stale: true },
    folded: { gone: { card: true } },
    types: { a: 'stat', gone: 'perk' },
    fields: { a: { min: '5' }, gone: { min: '1' } },
    colors: { a: '#ff0000', gone: '#00ff00' },
    images: { a: 'data:image/png;base64,AAA', gone: 'data:image/png;base64,BBB' },
    pinned: { a: true, gone: true },
    annotations: { note: { x: 3, y: 4, text: 'margin scribble' } },
    view: { x: 7, y: 8, s: 2 },
  });
  const restored = restoreSnapshot(snap, new Set(['a', 'b']), {
    types: { b: 'note' }, fields: { b: {} }, colors: { b: '#111111' }, images: { b: 'data:image/png;base64,CCC' }, view: { x: 0, y: 0, s: 1 },
  });
  assert.deepEqual(restored.positions, { a: { x: 1, y: 2 } });
  assert.deepEqual(restored.groups, { main: { members: ['a', 'b'], children: [] } });
  assert.deepEqual(restored.relations, { 'a->b': 'ally', 'a->group:main': 'affects' });
  assert.deepEqual(restored.collapsedGroups, { main: true });
  assert.deepEqual(restored.folded, {});
  assert.deepEqual(restored.types, { a: 'stat' });
  assert.deepEqual(restored.fields, { a: { min: '5' } });
  assert.deepEqual(restored.colors, { a: '#ff0000' });
  assert.deepEqual(restored.images, { a: 'data:image/png;base64,AAA' });
  assert.deepEqual(restored.pinned, { a: true });
  assert.deepEqual(restored.annotations, { note: { id: 'note', x: 3, y: 4, text: 'margin scribble' } });
  assert.deepEqual(restored.view, { x: 7, y: 8, s: 2 });
  // A pre-types snapshot keeps the current types, fields, colours, images, pins, locks and camera.
  const legacy = JSON.parse(snap);
  delete legacy.types;
  delete legacy.fields;
  delete legacy.colors;
  delete legacy.images;
  delete legacy.pinned;
  delete legacy.locked;
  delete legacy.view;
  const kept = restoreSnapshot(legacy, new Set(['a', 'b']), {
    types: { b: 'note' }, fields: { b: { max: '3' } }, colors: { b: '#222222' }, images: { b: 'data:image/png;base64,DDD' },
    pinned: { b: true }, locked: { b: true }, view: { x: 9, y: 9, s: 1 },
  });
  assert.deepEqual(kept.types, { b: 'note' });
  assert.deepEqual(kept.fields, { b: { max: '3' } });
  assert.deepEqual(kept.colors, { b: '#222222' });
  assert.deepEqual(kept.images, { b: 'data:image/png;base64,DDD' });
  assert.deepEqual(kept.pinned, { b: true });
  assert.deepEqual(kept.locked, { b: true });
  assert.deepEqual(kept.view, { x: 9, y: 9, s: 1 });
  // A snapshot that is not one restores nothing.
  assert.equal(restoreSnapshot('{not json', new Set(['a'])), null);
  assert.equal(restoreSnapshot(JSON.stringify(42), new Set(['a'])), null);
  assert.equal(restoreSnapshot(null, new Set(['a'])), null);
});

test('restoreSnapshot preserves the view however the snapshot wrote it', () => {
  const base = JSON.parse(canvasSnapshot({ positions: { a: { x: 1, y: 1 } } }));
  // Zoom past the limits clamps, as leaving the canvas does.
  const zoomed = restoreSnapshot({ ...base, view: { x: 4, y: 5, s: 42 } }, new Set(['a']));
  assert.deepEqual(zoomed.view, { x: 4, y: 5, s: ZOOM_MAX });
  // A view the record cannot use leaves the current camera alone.
  const broken = restoreSnapshot({ ...base, view: { x: NaN, y: 5, s: 2 } }, new Set(['a']), { view: { x: 1, y: 1, s: 1 } });
  assert.deepEqual(broken.view, { x: 1, y: 1, s: 1 });
});

test('canvasRecordPatch writes a step whole, or not at all', () => {
  const patch = canvasRecordPatch({
    positions: { a: { x: 1, y: 2 } },
    groups: {}, relations: {}, folded: {},
    types: { a: 'stat' }, fields: {},     colors: { a: '#ff0000' }, images: { a: 'data:image/png;base64,AAA' }, pinned: { a: true }, annotations: { note: { x: 1.4, y: 2.6, text: ' check later ' } },
    view: { x: 1, y: 2, s: 99 },
  });
  assert.deepEqual(patch, {
    positions: { a: { x: 1, y: 2 } }, groups: {}, relations: {}, folded: {},
    types: { a: 'stat' }, fields: {}, colors: { a: '#ff0000' }, images: { a: 'data:image/png;base64,AAA' }, pinned: { a: true }, annotations: { note: { id: 'note', x: 1, y: 3, text: 'check later' } }, view: { x: 1, y: 2, s: ZOOM_MAX },
  });
  // No types, fields, colours, images or view in the step: none are written.
  const bare = canvasRecordPatch({});
  assert.deepEqual(bare, { positions: {}, groups: {}, relations: {}, folded: {} });
  assert.equal('types' in bare, false);
  assert.equal('colors' in bare, false);
  assert.equal('images' in bare, false);
  assert.equal('pinned' in bare, false);
  assert.equal('annotations' in bare, false);
  assert.equal('view' in bare, false);
});

test('pushHistoryStep records a change once, caps the past and clears redo', () => {
  const stack = { past: [step('A', S(0))], future: [step('B', S(1))] };
  // A change that changed nothing lands no step and keeps the redo branch.
  assert.equal(pushHistoryStep(stack, S(1), S(1), 'Move card'), false);
  assert.deepEqual(stack.future, [step('B', S(1))]);
  // A real change lands named, and the redo branch is gone.
  assert.equal(pushHistoryStep(stack, S(1), S(2), 'Move card', 2), true);
  assert.deepEqual(stack, { past: [step('A', S(0)), step('Move card', S(2))], future: [] });
  // Past the limit, the oldest step gives way.
  assert.equal(pushHistoryStep(stack, S(2), S(3), 'Arrange', 2), true);
  assert.deepEqual(stack.past, [step('Move card', S(2)), step('Arrange', S(3))]);
});

test('renameHistoryAnchor follows a rename in both stacks, names intact', () => {
  const stack = {
    past: [step('A', canvasSnapshot({ positions: { old: { x: 1, y: 1 } } }))],
    future: [step('B', canvasSnapshot({ positions: { old: { x: 2, y: 2 }, a: { x: 0, y: 0 } } }))],
  };
  renameHistoryAnchor(stack, 'old', 'new');
  assert.equal(stack.past[0].name, 'A');
  assert.deepEqual(JSON.parse(stack.past[0].snap).positions, { new: { x: 1, y: 1 } });
  assert.deepEqual(JSON.parse(stack.future[0].snap).positions, { new: { x: 2, y: 2 }, a: { x: 0, y: 0 } });
});

test('renameHistoryAnchor moves every anchored slice in every past and future snapshot', () => {
  const snapshot = canvasSnapshot({
    positions: { old: { x: 1, y: 1 }, a: { x: 0, y: 0 } },
    groups: { g: { id: 'g', members: ['old', 'a'], children: [] } },
    relations: { 'old->a': 'ally', 'a->old': 'foe', 'a->b': 'contains' },
    folded: { old: { card: true } },
    types: { old: 'stat', a: 'note' },
    fields: { old: { value: '1' }, a: {} },
    colors: { old: '#ff0000', a: '#00ff00' },
    images: { old: '.macusanite/node-images/x.png' },
    resources: { old: { files: [{ ref: '.macusanite/node-files/x.pdf' }], urls: [] } },
    pinned: { old: true },
    locked: { old: true },
    cardModes: { old: 'compact' },
    cardSizes: { old: 'content' },
    collapsedGroups: { g: true },
    view: { x: 1, y: 2, s: 1.5 },
  });
  const stack = {
    past: [step('Move card', snapshot), step('Arrange', snapshot)],
    future: [step('Redo arrange', snapshot)],
  };

  renameHistoryAnchor(stack, 'old', 'new');

  const slices = ['positions', 'folded', 'types', 'fields', 'colors', 'images', 'resources', 'pinned', 'locked', 'cardModes', 'cardSizes'];
  for (const entry of [...stack.past, ...stack.future]) {
    const snap = JSON.parse(entry.snap);
    for (const slice of slices) {
      // Older snapshots do not carry every slice yet; the ones they do carry
      // are all anchor-keyed and must follow the rename.
      if (!snap[slice]) continue;
      assert.equal('old' in snap[slice], false, `${slice} keeps no old anchor`);
      assert.ok('new' in snap[slice], `${slice} carries the new anchor`);
    }
    assert.deepEqual(snap.groups.g.members, ['new', 'a']);
    assert.deepEqual(snap.relations, { 'a->b': 'contains' }, 'bonds naming the old name drop');
    assert.deepEqual(snap.collapsedGroups, { g: true }, 'group ids are not note anchors');
    assert.deepEqual(snap.view, { x: 1, y: 2, s: 1.5 });
  }
  assert.deepEqual(stack.past.map((entry) => entry.name), ['Move card', 'Arrange']);
  assert.deepEqual(stack.future.map((entry) => entry.name), ['Redo arrange']);
});

test('renameHistoryAnchor keeps a malformed legacy snapshot and still renames the valid ones', () => {
  const good = canvasSnapshot({ positions: { old: { x: 1, y: 1 } }, colors: { old: '#ff0000' } });
  const bad = '{not json';
  const stack = {
    past: [step('Broken', bad), step('Good', good)],
    future: [step('Good again', good), step('Broken again', bad)],
  };

  renameHistoryAnchor(stack, 'old', 'new');

  assert.equal(stack.past[0].snap, bad, 'the malformed entry is left exactly as it was');
  assert.equal(stack.future[1].snap, bad);
  assert.deepEqual(JSON.parse(stack.past[1].snap).positions, { new: { x: 1, y: 1 } });
  assert.deepEqual(JSON.parse(stack.future[0].snap).colors, { new: '#ff0000' });
  assert.deepEqual([...stack.past, ...stack.future].map((entry) => entry.name), ['Broken', 'Good', 'Good again', 'Broken again']);
});

test('pruneHistoryStack clears every anchored slice on both sides of the stack', () => {
  const snapshot = canvasSnapshot({
    positions: { a: { x: 0, y: 0 }, gone: { x: 3, y: 3 } },
    groups: {
      pair: { id: 'pair', members: ['a', 'b'], children: [] },
      thin: { id: 'thin', members: ['a', 'gone'], children: [] },
    },
    relations: { 'a->b': 'ally', 'a->gone': 'foe', 'a->group:thin': 'contains' },
    folded: { gone: { card: true } },
    types: { gone: 'stat' },
    fields: { gone: { value: '1' } },
    colors: { gone: '#ff0000' },
    images: { gone: '.macusanite/node-images/x.png' },
    resources: { gone: { files: [{ ref: '.macusanite/node-files/x.pdf' }], urls: [] } },
    pinned: { gone: true },
    locked: { gone: true },
    cardModes: { gone: 'compact' },
    cardSizes: { gone: 'content' },
    collapsedGroups: { thin: true },
  });
  const stack = {
    past: [step('Delete', snapshot), step('Broken', 'nope')],
    future: [step('Redo delete', snapshot)],
  };

  pruneHistoryStack(stack, new Set(['a', 'b']));

  const slices = ['positions', 'folded', 'types', 'fields', 'colors', 'images', 'resources', 'pinned', 'locked', 'cardModes', 'cardSizes'];
  for (const entry of [stack.past[0], stack.future[0]]) {
    const snap = JSON.parse(entry.snap);
    for (const slice of slices) {
      if (!snap[slice]) continue;
      assert.equal('gone' in snap[slice], false, `${slice} drops the deleted anchor`);
    }
    assert.deepEqual(snap.groups, { pair: { id: 'pair', members: ['a', 'b'], children: [] } });
    assert.deepEqual(snap.relations, { 'a->b': 'ally' }, 'bonds to the deleted card and its dissolved group drop');
    assert.deepEqual(snap.collapsedGroups, {}, 'a dissolved group takes its collapse with it');
  }
  assert.equal(stack.past[1].snap, 'nope', 'a malformed entry is kept unchanged');
  assert.deepEqual([...stack.past, ...stack.future].map((entry) => entry.name), ['Delete', 'Broken', 'Redo delete']);
});

test('pruneHistoryStack removes deleted anchors from past and future, dissolving thin groups', () => {
  const snapshot = canvasSnapshot({
    positions: { a: { x: 1, y: 1 }, b: { x: 2, y: 2 }, gone: { x: 3, y: 3 } },
    groups: {
      surviving: { members: ['a', 'b', 'gone'] },
      thin: { members: ['a', 'gone'] },
    },
    relations: {
      'a->b': 'ally', 'a->group:surviving': 'affects',
      'a->group:thin': 'foe', 'b->gone': 'foe',
    },
    collapsedGroups: { surviving: true, thin: true },
  });
  const stack = {
    past: [step('Delete', snapshot)],
    future: [step('Redo delete', snapshot)],
  };

  pruneHistoryStack(stack, new Set(['a', 'b']));
  for (const entry of [...stack.past, ...stack.future]) {
    const pruned = JSON.parse(entry.snap);
    assert.deepEqual(pruned.positions, { a: { x: 1, y: 1 }, b: { x: 2, y: 2 } });
    assert.deepEqual(pruned.groups, { surviving: { members: ['a', 'b'], children: [] } });
    assert.deepEqual(pruned.relations, { 'a->b': 'ally', 'a->group:surviving': 'affects' });
    assert.deepEqual(pruned.collapsedGroups, { surviving: true });
  }
  assert.equal(stack.past[0].name, 'Delete');
  assert.equal(stack.future[0].name, 'Redo delete');
});

test('historyJump takes single steps the way undoCanvas and redoCanvas do', () => {
  const stack = { past: [step('Fold', S(0)), step('Arrange', S(1))], future: [] };
  const undone = historyJump(stack, 'undo', 1, S(2));
  assert.equal(undone.restore, S(1));
  assert.deepEqual(undone.past, [step('Fold', S(0))]);
  // The step going forward keeps its name, with the canvas as it stood.
  assert.deepEqual(undone.future, [step('Arrange', S(2))]);
  const redone = historyJump(undone, 'redo', 1, S(1));
  assert.equal(redone.restore, S(2));
  assert.deepEqual(redone.past, [step('Fold', S(0)), step('Arrange', S(1))]);
  assert.deepEqual(redone.future, []);
});

test('canvas history restores node type and structured field edits on undo and redo', () => {
  const live = new Set(['a']);
  let current = {
    types: {},
    fields: {},
  };
  const stack = { past: [], future: [] };

  const beforeType = canvasSnapshot(current);
  current = { ...current, types: setNodeType(current.types, 'a', 'stat') };
  const typed = canvasSnapshot(current);
  assert.equal(pushHistoryStep(stack, typed, beforeType, 'Set type to Stat'), true);

  const beforeField = typed;
  current = { ...current, fields: setNodeField(current.fields, 'stat', 'a', 'value', '7') };
  const valued = canvasSnapshot(current);
  assert.equal(pushHistoryStep(stack, valued, beforeField, 'Set value on “A”'), true);

  let jumped = historyJump(stack, 'undo', 1, valued);
  stack.past = jumped.past;
  stack.future = jumped.future;
  current = restoreSnapshot(jumped.restore, live, current);
  assert.equal(current.types.a, 'stat');
  assert.deepEqual(current.fields, {});

  jumped = historyJump(stack, 'undo', 1, canvasSnapshot(current));
  stack.past = jumped.past;
  stack.future = jumped.future;
  current = restoreSnapshot(jumped.restore, live, current);
  assert.equal(current.types.a, undefined);
  assert.deepEqual(current.fields, {});

  jumped = historyJump(stack, 'redo', 1, canvasSnapshot(current));
  stack.past = jumped.past;
  stack.future = jumped.future;
  current = restoreSnapshot(jumped.restore, live, current);
  assert.equal(current.types.a, 'stat');

  jumped = historyJump(stack, 'redo', 1, canvasSnapshot(current));
  current = restoreSnapshot(jumped.restore, live, current);
  assert.equal(current.types.a, 'stat');
  assert.equal(nodeFieldOf(current.fields, 'a', 'value'), '7');
});

test('dropAnchorFromGroups drops one card and dissolves thin groups', () => {
  const { groups, dissolved } = dropAnchorFromGroups({
    trio: { members: ['a', 'b', 'gone'] },
    pair: { members: ['gone', 'solo'] },
    parent: { members: ['a'], children: ['trio'] },
  }, 'gone');
  // A thinned pair dissolves; a trio that still holds two cards survives.
  assert.deepEqual(dissolved, ['pair']);
  assert.deepEqual(groups.trio.members, ['a', 'b']);
  // A parent can live on its children's cards alone.
  assert.deepEqual(groups.parent, { members: ['a'], children: ['trio'] });
  // Deleting the last of a nested line dissolves the whole nest.
  const nested = dropAnchorFromGroups({
    child: { members: ['a', 'gone'] },
    parent: { members: [], children: ['child'] },
  }, 'gone');
  assert.deepEqual(nested.groups, {});
  assert.deepEqual([...nested.dissolved].sort(), ['child', 'parent']);
});

test('renameAnchor in a record carries colours onto the new name', () => {
  const record = {
    positions: { old: { x: 1, y: 2 } },
    colors: { old: '#ff0000', a: '#00ff00' },
    images: { old: 'data:image/png;base64,AAA', a: 'data:image/png;base64,BBB' },
    pinned: { old: true, a: true },
    types: { old: 'stat' },
    groups: { g: { members: ['old', 'a'] } },
    relations: { 'old->a': 'ally', 'a->b': 'foe' },
    folded: { old: { card: true } },
  };
  const renamed = renameAnchorIn(record, 'old', 'new');
  assert.deepEqual(renamed.colors, { new: '#ff0000', a: '#00ff00' });
  assert.deepEqual(renamed.images, { new: 'data:image/png;base64,AAA', a: 'data:image/png;base64,BBB' });
  assert.deepEqual(renamed.pinned, { new: true, a: true });
  assert.deepEqual(renamed.positions, { new: { x: 1, y: 2 } });
  assert.deepEqual(renamed.types, { new: 'stat' });
  assert.deepEqual(renamed.folded, { new: { card: true } });
  assert.deepEqual(renamed.groups.g.members, ['new', 'a']);
  assert.deepEqual(renamed.relations, { 'a->b': 'foe' });
  // Snapshots without colours stay that way.
  const plain = JSON.parse(canvasSnapshot({ positions: { old: { x: 1, y: 1 } } }));
  delete plain.colors;
  assert.equal('colors' in renameAnchorIn(plain, 'old', 'new'), false);
});

test('fitView centres content in the viewport with a margin', () => {
  // Wide content in a squarer viewport: the width decides the scale.
  const wide = fitView({ minX: 0, minY: 0, maxX: 800, maxY: 200 }, 400, 400, 0);
  assert.equal(wide.s, 0.5);
  assert.deepEqual({ x: wide.x, y: wide.y }, { x: 0, y: 150 });
  // Tall content: the height decides.
  const tall = fitView({ minX: 0, minY: 0, maxX: 200, maxY: 800 }, 400, 400, 0);
  assert.equal(tall.s, 0.5);
  assert.deepEqual({ x: tall.x, y: tall.y }, { x: 150, y: 0 });
  // An offset origin shifts the translate, so the content — not the canvas
  // corner — is what centres.
  const offset = fitView({ minX: 100, minY: 50, maxX: 400, maxY: 250 }, 600, 400, 0);
  assert.equal(offset.s, 2);
  assert.deepEqual({ x: offset.x, y: offset.y }, { x: -200, y: -100 });
  // The content's corner lands centred: (vp - size*s)/2 from each edge.
  assert.equal(offset.x + 100 * offset.s, 0);
  assert.equal(offset.y + 50 * offset.s, 0);
});

test('fitView keeps its margin and clamps to the zoom limits', () => {
  const content = { minX: 0, minY: 0, maxX: 1000, maxY: 1000 };
  // A 40px margin per side leaves 920 of 1000px at 1:1 in a 1000px viewport.
  const margined = fitView(content, 1000, 1000);
  assert.ok(Math.abs(margined.s - 0.92) < 1e-9);
  assert.ok(Math.abs(margined.x - 40) < 1e-9);
  // Content far wider than any viewport bottoms out at minimum zoom.
  const huge = fitView({ minX: 0, minY: 0, maxX: 100000, maxY: 100 }, 800, 600);
  assert.equal(huge.s, ZOOM_MIN);
  // A single small card tops out at maximum zoom, centred.
  const small = fitView({ minX: 26, minY: 26, maxX: 326, maxY: 286 }, 1200, 800, 0);
  assert.equal(small.s, ZOOM_MAX);
  assert.deepEqual({ x: small.x, y: small.y }, { x: 72, y: -68 });
});

test('fitView refuses to fit nothing into nothing', () => {
  assert.equal(fitView(null, 800, 600), null);
  assert.equal(fitView({ minX: 0, minY: 0, maxX: 0, maxY: 10 }, 800, 600), null);
  assert.equal(fitView({ minX: 0, minY: 0, maxX: 10, maxY: 0 }, 800, 600), null);
  assert.equal(fitView({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, 0, 600), null);
  assert.equal(fitView({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, 800, 0), null);
});

test('cleanAnnotations keeps usable margin notes only', () => {
  assert.deepEqual(cleanAnnotations(null), {});
  assert.deepEqual(cleanAnnotations({
    memo: { x: 12.4, y: 30.6, text: '  check this later  ' },
    colored: { x: 20, y: 40, text: 'remember color', color: '#57D364' },
    invalidColor: { x: 50, y: 60, text: 'ignore invalid color', color: 'red' },
    blank: { x: 0, y: 0, text: '   ' },
    broken: { x: 'east', y: 0, text: 'junk' },
  }), {
    memo: { id: 'memo', x: 12, y: 31, text: 'check this later' },
    colored: { id: 'colored', x: 20, y: 40, text: 'remember color', color: '#57d364' },
    invalidColor: { id: 'invalidColor', x: 50, y: 60, text: 'ignore invalid color' },
  });
});

test('normalizeRouting keeps only the three connector switches', () => {
  assert.deepEqual(normalizeRouting(null), { elbow: false, arrows: false, cut: false, edges: {} });
  assert.deepEqual(normalizeRouting({ elbow: 'yes', arrows: 1, cut: 0, junk: true }), { elbow: true, arrows: true, cut: false, edges: {} });
  assert.deepEqual(normalizeRouting({ elbow: false }), { elbow: false, arrows: false, cut: false, edges: {} });
  assert.deepEqual(normalizeRouting({ elbow: false, cut: true }), { elbow: false, arrows: false, cut: true, edges: {} });
});

test('elbowPoints turns once on each side of the wire', () => {
  const horizontal = elbowPoints(
    { x: 0, y: 0, width: 100, height: 50 },
    { x: 200, y: 100, width: 100, height: 50 },
  );
  assert.deepEqual(horizontal, [
    { x: 100, y: 25 },
    { x: 150, y: 25 },
    { x: 150, y: 125 },
    { x: 200, y: 125 },
  ]);
  const vertical = elbowPoints(
    { x: 0, y: 0, width: 100, height: 50 },
    { x: 100, y: 100, width: 100, height: 50 },
    true,
  );
  assert.deepEqual(vertical, [
    { x: 50, y: 50 },
    { x: 50, y: 75 },
    { x: 150, y: 75 },
    { x: 150, y: 100 },
  ]);
});

test('the occlusion sampler is the drawn curve: sampled points lie on the SVG path', () => {
  // Parse the drawn path the way the browser would, then Bernstein-sample
  // that parsed cubic: the scorer's points must land on it exactly.
  const parseCubic = (path) => {
    const nums = path.match(/-?\d+(\.\d+)?/g).map(Number);
    assert.equal(nums.length, 8, `cubic path carries 4 points: ${path}`);
    return [[nums[0], nums[1]], [nums[2], nums[3]], [nums[4], nums[5]], [nums[6], nums[7]]];
  };
  const bernstein = (pts, t) => {
    const m = 1 - t;
    const w = [m ** 3, 3 * m * m * t, 3 * m * t * t, t ** 3];
    return {
      x: w.reduce((sum, weight, i) => sum + weight * pts[i][0], 0),
      y: w.reduce((sum, weight, i) => sum + weight * pts[i][1], 0),
    };
  };
  const pairs = [
    [{ x: 0, y: 0, width: 100, height: 50 }, { x: 300, y: 100, width: 100, height: 50 }, {}],
    [{ x: 300, y: 100, width: 100, height: 50 }, { x: 0, y: 0, width: 100, height: 50 }, {}],
    [{ x: 0, y: 0, width: 100, height: 50 }, { x: 120, y: 200, width: 100, height: 50 }, { vertical: true }],
    [{ x: 0, y: 0, width: 100, height: 50 }, { x: 300, y: 100, width: 100, height: 50 }, { elbow: true }],
  ];
  for (const [from, to, opts] of pairs) {
    const curve = connectorCurve(from, to, opts);
    const scored = sampleConnectorCurve(from, to, { ...opts, steps: 16 });
    // The scorer samples the very function the drawing exposes.
    assert.deepEqual(scored, Array.from({ length: 17 }, (_, i) => curve.at(i / 16)));
    assert.deepEqual(scored[0], curve.at(0));
    assert.deepEqual(scored.at(-1), curve.at(1));
    if (!opts.elbow) {
      const drawn = parseCubic(curve.path);
      for (let i = 0; i <= 16; i += 1) {
        const onTheWire = bernstein(drawn, i / 16);
        assert.ok(Math.abs(onTheWire.x - scored[i].x) < 1e-9 && Math.abs(onTheWire.y - scored[i].y) < 1e-9,
          `scored point ${i} lies on the drawn path`);
      }
    } else {
      // Elbow: sampled points walk the polyline end to end, never leaving it.
      const pts = elbowPoints(from, to, opts.vertical ?? false);
      assert.deepEqual(scored[0], pts[0]);
      assert.deepEqual(scored.at(-1), pts.at(-1));
      for (const point of scored) {
        const onSegment = pts.some((seg, i) => i === 0 ||
          (point.y === seg.y && point.x >= Math.min(pts[i - 1].x, seg.x) && point.x <= Math.max(pts[i - 1].x, seg.x)) ||
          (point.x === seg.x && point.y >= Math.min(pts[i - 1].y, seg.y) && point.y <= Math.max(pts[i - 1].y, seg.y)));
        assert.ok(onSegment, `elbow sample on a segment: ${JSON.stringify(point)}`);
      }
    }
  }
  // The bend itself: 45% of the side gap, floored at 36px — one definition,
  // pinned here so a change is a deliberate, visible edit.
  const wide = connectorCurve({ x: 0, y: 0, width: 100, height: 50 }, { x: 300, y: 100, width: 100, height: 50 });
  assert.match(wide.path, /^M 100 25 C 190 25 210 125 300 125$/);
  const narrow = connectorCurve({ x: 0, y: 0, width: 100, height: 50 }, { x: 130, y: 0, width: 100, height: 50 });
  assert.match(narrow.path, /^M 100 25 C 136 25 94 25 130 25$/);
});

test('connector preparation uses actual card rects, lane offsets and per-edge routing', () => {
  const a = { x: 0, y: 0, width: 300, height: 500 };
  const b = { x: 500, y: 0, width: 320, height: 100 };
  const c = { x: 500, y: 300, width: 300, height: 100 };
  const connectors = [
    { from: 'a', to: 'b', kind: 'mention' },
    { from: 'a', to: 'c', kind: 'mention' },
  ];
  const prepared = prepareConnectorGeometry(connectors, {
    rectFor: (endpoint) => ({ a, b, c })[endpoint] ?? null,
    routing: normalizeRouting({ edges: { 'mention:a->b': { elbow: true } } }),
    isStacked: () => false,
  });
  assert.equal(prepared.length, 2);
  // a has two wires: half a lane above and half below its real centre.
  assert.equal(CONNECTOR_LANE_PITCH, 16);
  assert.equal(prepared[0].from.y, -8);
  assert.equal(prepared[1].from.y, 8);
  assert.equal(prepared[0].from.height, 500, 'the content-sized height is not CARD_H');
  assert.equal(prepared[0].elbow, true);
  assert.equal(prepared[1].elbow, false);
  // The drawn start uses a's 500px height and the first lane offset, not a
  // plain 260px card: 0 + 500/2 - 8.
  assert.match(
    connectorCurve(prepared[0].from, prepared[0].to, prepared[0]).path,
    /^M 300 242 /,
  );
  // The second wire is a horizontal curve on the lower lane, while the first
  // takes its own elbow routing.
  assert.match(
    connectorCurve(prepared[1].from, prepared[1].to, prepared[1]).path,
    /^M 300 258 C /,
  );
  assert.match(
    connectorCurve(prepared[0].from, prepared[0].to, prepared[0]).path,
    /^M 300 242 L /,
  );

  // A stacked pair skips the lane offset and stays vertical.
  const stacked = prepareConnectorGeometry([connectors[0]], {
    rectFor: (endpoint) => ({ a, b })[endpoint] ?? null,
    isStacked: () => true,
  });
  assert.equal(stacked[0].vertical, true);
  assert.equal(stacked[0].from.y, 0);
});

test('connector labels with zero-size measurements still keep clear of neighbours', () => {
  const label = (y) => ({
    label: 'ally',
    width: 0,
    height: 0,
    at: (t) => ({ x: t * 400, y }),
  });
  const [first, second] = placeConnectorLabels([label(0), label(16)]);

  assert.deepEqual(first, { x: 200, y: 0 });
  assert.deepEqual(second, { x: 152, y: 16 }, 'the second word slides along its wire using the fallback text box');
  const fallbackWidth = 'ally'.length * 6 + 6;
  const fallbackHeight = 12 + 6;
  const apartX = Math.abs(first.x - second.x) - fallbackWidth;
  const apartY = Math.abs(first.y - second.y) - fallbackHeight;
  assert.ok(apartX >= 14 || apartY >= 14, 'estimated text boxes retain the label gap');

  const stuck = { label: 'ally', width: 0, height: 0, at: () => ({ x: 40, y: 40 }) };
  const [onWire, fallback] = placeConnectorLabels([stuck, stuck]);
  assert.deepEqual(onWire, { x: 40, y: 40 });
  assert.deepEqual(fallback, { x: 40, y: 76, leader: { x: 40, y: 40 } },
    'coincident wire labels move off the midpoint and get a leader instead of overlapping');
});

test('connector labels stay off a node instead of sitting behind it', () => {
  const wire = (t) => ({ x: t * 800, y: 100 });
  const card = { x: 320, y: 20, width: 300, height: 200 };
  const [spot] = placeConnectorLabels([{ label: 'ally', width: 40, height: 12, at: wire, rects: [card] }]);
  assert.ok(spot, 'the word is still placed');
  // The midpoint (400, 100) is inside the card; the word slides along its wire.
  assert.ok(spot.x < card.x - 4 || spot.x > card.x + card.width + 4, `clear of the card, got ${spot.x}`);
});

test('connector labels clear a group border and its title tab', () => {
  const band = { x: 100, y: 100, width: 400, height: 8 };
  const down = (t) => ({ x: 300, y: t * 300 });
  const [overBand] = placeConnectorLabels([{ label: 'ally', width: 40, height: 12, at: down, rects: [band] }]);
  assert.ok(overBand);
  assert.ok(overBand.y < band.y - 4 || overBand.y > band.y + band.height + 4,
    `the word leaves the border band, got ${overBand.y}`);

  // A group's fill is not a surface: the same wire may keep its midpoint word.
  const [insideBox] = placeConnectorLabels([{ label: 'ally', width: 40, height: 12, at: down }]);
  assert.deepEqual(insideBox, { x: 300, y: 150 });
});

test('connector labels stay visible when every slot is covered', () => {
  const card = { x: 0, y: 0, width: 800, height: 300 };
  const wire = (t) => ({ x: t * 800, y: 100 });
  const [spot] = placeConnectorLabels([{ label: 'ally', width: 40, height: 12, at: wire, rects: [card] }]);
  // No slot or leader is clear, so the least-covered slot is kept rather than
  // hiding the relationship word entirely.
  assert.ok(spot);
  assert.equal(typeof spot.x, 'number');
});

test('connector labels move away from another wire crossing their candidate position', () => {
  const horizontal = (y) => (t) => ({ x: t * 400, y });
  const verticalCrossing = (t) => ({ x: 200, y: -80 + t * 160 });
  const [spot] = placeConnectorLabels([{
    label: 'ally', width: 0, height: 0,
    at: horizontal(0),
    obstacles: [verticalCrossing],
  }]);

  assert.deepEqual(spot, { x: 176, y: 0 }, 'the midpoint crossing is avoided using the next along-wire slot');
});

test('a trimmed wire can point at a card hidden by a collapsed group', () => {
  const source = { x: 0, y: 0, width: 300, height: 100 };
  const hidden = { x: 2400, y: 0, width: 300, height: 100 };
  const connectors = [{ from: 'source', to: 'hidden', kind: 'mention' }];
  // The far card is inside a collapsed group, so the canvas has no visible
  // rect for it; its real place comes only from the cut-wire proxy.
  const rectFor = (endpoint) => (endpoint === 'source' ? source : null);
  let proxied = 0;
  const proxyRectFor = (endpoint) => {
    proxied += 1;
    return endpoint === 'hidden' ? hidden : null;
  };

  // Without Trim the hidden end stays hidden, exactly as before.
  assert.deepEqual(prepareConnectorGeometry(connectors, { rectFor, proxyRectFor }), []);
  assert.equal(proxied, 0);

  for (const elbow of [false, true]) {
    const prepared = prepareConnectorGeometry(connectors, {
      rectFor,
      proxyRectFor,
      routing: normalizeRouting({ cut: true, elbow }),
    });
    assert.equal(prepared.length, 1);
    assert.equal(prepared[0].edge.to, 'hidden');
    assert.equal(prepared[0].to.x, hidden.x);
    assert.equal(prepared[0].limit, CONNECTOR_CUT_SPAN);
    const [wire] = spreadConnectorCurves(prepared);
    assert.ok(wire.cut, `${elbow ? 'elbow' : 'curve'} wire is cut`);
    assert.ok(wire.cut.total > CONNECTOR_CUT_SPAN);
    assert.ok(wire.cut.x >= CONNECTOR_CUT_SPAN - 1);
  }
});

test('connectors that would share a path are spread apart', () => {
  const a = { x: 0, y: 0, width: 100, height: 50 };
  const b = { x: 300, y: 0, width: 100, height: 50 };
  const entries = [
    { from: a, to: b, key: 'first' },
    { from: a, to: b, key: 'second' },
    { from: a, to: b, key: 'third' },
    { from: b, to: a, key: 'reverse' },
  ];
  const curves = spreadConnectorCurves(entries);
  const paths = curves.map((curve) => curve.path);
  assert.equal(new Set(paths).size, paths.length, 'every wire has its own path');
  assert.equal(curves[0].path, connectorCurve(a, b).path, 'the first wire keeps its place');
  // Spread is perpendicular, in even lanes, and the caller's fields survive.
  assert.equal(curves[1].from.y - a.y, CONNECTOR_SPREAD);
  assert.equal(curves[2].from.y - a.y, -CONNECTOR_SPREAD);
  assert.equal(curves[1].key, 'second');
  assert.deepEqual(spreadConnectorCurves(entries).map((curve) => curve.path), paths, 'stable for the same order');
  // An uncrowded canvas is untouched.
  const alone = spreadConnectorCurves([{ from: a, to: b }]);
  assert.equal(alone[0].path, connectorCurve(a, b).path);
});

test('stacked connectors spread sideways, keeping their column height', () => {
  const top = { x: 0, y: 0, width: 100, height: 50 };
  const bottom = { x: 0, y: 120, width: 100, height: 50 };
  const [first, second] = spreadConnectorCurves([
    { from: top, to: bottom, vertical: true, kind: 'section' },
    { from: top, to: bottom, vertical: true, kind: 'mention' },
  ]);
  assert.notEqual(first.path, second.path);
  assert.equal(second.from.x - top.x, CONNECTOR_SPREAD);
  assert.equal(second.from.y, top.y);
  assert.equal(second.to.y, bottom.y);
});

test('a long wire is cut off at the limit, facing the card beyond it', () => {
  const from = { x: 0, y: 0, width: 300, height: 260 };
  const to = { x: 4000, y: 1200, width: 300, height: 260 };
  const full = connectorCurve(from, to);
  assert.equal(full.cut, undefined);
  const cut = connectorCurve(from, to, { limit: 500 });
  assert.ok(cut.cut);
  assert.equal(cut.cut.length, 500);
  assert.ok(cut.cut.total > 1000, `the whole wire is longer than the cut: ${cut.cut.total}`);
  // The drawn wire stops 500px along the whole curve and ends exactly there.
  let walked = 0;
  let previous = full.at(0);
  let reached = null;
  for (let i = 1; i <= 4000 && !reached; i += 1) {
    const next = full.at(i / 4000);
    walked += Math.hypot(next.x - previous.x, next.y - previous.y);
    if (walked >= 500) reached = next;
    previous = next;
  }
  assert.ok(reached);
  assert.ok(Math.hypot(cut.cut.x - reached.x, cut.cut.y - reached.y) < 2);
  assert.ok(Math.hypot(cut.at(1).x - cut.cut.x, cut.at(1).y - cut.cut.y) < 1e-9);
  // The marker faces the destination, along the curve's own tangent.
  assert.ok(Math.abs(Math.hypot(cut.cut.dir.x, cut.cut.dir.y) - 1) < 1e-9);
  assert.ok(cut.cut.dir.x > 0.8 && cut.cut.dir.y >= 0);
  // A wire that fits its limit is drawn whole, with no marker.
  const short = connectorCurve(from, { x: 600, y: 0, width: 300, height: 260 }, { limit: 500 });
  assert.equal(short.cut, undefined);
  assert.match(short.path, /^M /);
  assert.ok(CONNECTOR_CUT_SPAN > 500);
});

test('an elbow wire cuts on its first segment, pointing along it', () => {
  const from = { x: 0, y: 0, width: 300, height: 260 };
  const to = { x: 3000, y: 900, width: 300, height: 260 };
  const points = elbowPoints(from, to, false);
  const cut = connectorCurve(from, to, { elbow: true, limit: 400 });
  assert.ok(cut.cut);
  assert.deepEqual(cut.at(0), points[0]);
  // The first segment runs 1350px here, so the cut lands 400px along it.
  assert.ok(Math.abs(cut.cut.x - (points[0].x + 400)) < 1e-9);
  assert.equal(cut.cut.y, points[0].y);
  assert.deepEqual(cut.cut.dir, { x: 1, y: 0 });
  // Two points only: where it starts, and where it stops.
  assert.equal(cut.path.split(' ').filter((part) => part !== 'M' && part !== 'L').length, 4);
  const short = connectorCurve(from, { x: 600, y: 0, width: 300, height: 260 }, { elbow: true, limit: 400 });
  assert.equal(short.cut, undefined);
});

test('centreView centres a rect at the current scale', () => {
  const centred = centreView({ x: 100, y: 50, width: 300, height: 260 }, 800, 600, 2);
  assert.equal(centred.s, 2);
  assert.deepEqual({ x: centred.x, y: centred.y }, { x: -100, y: -60 });
  // The scale clamps, and a missing scale means 1:1.
  assert.equal(centreView({ x: 0, y: 0, width: 10, height: 10 }, 800, 600, 99).s, ZOOM_MAX);
  assert.equal(centreView({ x: 0, y: 0, width: 10, height: 10 }, 800, 600).s, 1);
  assert.equal(centreView(null, 800, 600), null);
  assert.equal(centreView({ x: 0, y: 0, width: 10, height: 10 }, 0, 600), null);
});

test('snapDelta lines up edges and centrelines within the threshold', () => {
  const other = { x: 200, y: 100, width: 300, height: 260 };
  // A drag whose left edge is 4px from the other's left edge snaps left.
  const drag = { x: 204, y: 300, width: 300, height: 260 };
  const snapped = snapDelta(drag, [other], 8);
  assert.equal(snapped.dx, -4);
  assert.deepEqual(snapped.guides, [{ axis: 'x', at: 200 }]);
  // Centre-to-centre also snaps: 3px out on the vertical centre.
  const centred = snapDelta({ x: 203, y: 103, width: 300, height: 260 }, [other], 8);
  assert.equal(centred.dx, -3);
  assert.equal(centred.dy, -3);
  assert.equal(centred.guides.length, 2);
  // Beyond the threshold nothing snaps and no guides draw.
  const far = snapDelta({ x: 300, y: 300, width: 300, height: 260 }, [other], 8);
  assert.deepEqual(far, { dx: 0, dy: 0, guides: [] });
  // The closest alignment wins when several are in range.
  const crowded = snapDelta(
    { x: 206, y: 500, width: 300, height: 260 },
    [{ x: 200, y: 0, width: 300, height: 260 }, { x: 210, y: 0, width: 300, height: 260 }],
    8,
  );
  assert.equal(crowded.dx, 4);
  assert.deepEqual(crowded.guides, [{ axis: 'x', at: 210 }]);
});

test('layoutSelection aligns and distributes a selected set', () => {
  const rects = [
    { key: 'a', x: 10, y: 20, width: 100, height: 40 },
    { key: 'b', x: 200, y: 90, width: 80, height: 60 },
    { key: 'c', x: 430, y: 10, width: 120, height: 30 },
  ];
  const left = layoutSelection(rects, 'left');
  assert.deepEqual([...left.values()].map(({ x }) => x), [10, 10, 10]);
  assert.deepEqual([...left.values()].map(({ y }) => y), [20, 90, 10]);
  const centred = layoutSelection(rects, 'center-x');
  assert.deepEqual([...centred.values()].map(({ x }) => x), [230, 240, 220]);
  const bottom = layoutSelection(rects, 'bottom');
  assert.deepEqual([...bottom.values()].map(({ y }) => y), [110, 90, 120]);
  const across = layoutSelection(rects, 'distribute-x');
  assert.deepEqual(across.get('a'), { x: 10, y: 20 });
  assert.deepEqual(across.get('b'), { x: 235, y: 90 });
  assert.deepEqual(across.get('c'), { x: 430, y: 10 });
  const vertical = [
    { key: 'a', x: 10, y: 0, width: 100, height: 40 },
    { key: 'b', x: 200, y: 10, width: 80, height: 40 },
    { key: 'c', x: 430, y: 200, width: 120, height: 40 },
  ];
  const down = layoutSelection(vertical, 'distribute-y');
  assert.deepEqual(down.get('b'), { x: 200, y: 100 });
  // A pair cannot be distributed and an unknown mode changes nothing.
  assert.deepEqual(layoutSelection(rects.slice(0, 2), 'distribute-x').get('b'), { x: 200, y: 90 });
  assert.deepEqual(layoutSelection(rects, 'sideways').get('b'), { x: 200, y: 90 });
});

test('canvasHealth finds orphans and thin groups', () => {
  const model = parseNotes(VEIN);
  // VEIN: Fieldwork (h1) > Sieve series (h2) > Composition (h3), and a second
  // Composition (h2) linking [[Sieve series]]. Every note has a wire.
  const healthy = canvasHealth(model, { relations: {}, groups: {} });
  assert.equal(healthy.notes, 4);
  assert.deepEqual(healthy.orphans, []);
  assert.deepEqual(healthy.thinGroups, []);
  // A lone flat card attached to nothing is an orphan; a card in a group is not.
  const flat = parseNotes('# Alone\n\ntext\n\n# Linked\n\nsee [[Alone]]\n');
  const withOrphan = canvasHealth(flat, { relations: {}, groups: {} });
  assert.deepEqual(withOrphan.orphans.map((orphan) => orphan.anchor), []);
  const lone = parseNotes('# Alone\n\ntext\n\n# Also alone\n\nmore\n');
  const isolated = canvasHealth(lone, { relations: {}, groups: {} });
  assert.deepEqual(isolated.orphans.map((orphan) => orphan.anchor), ['alone', 'also-alone']);
  const grouped = canvasHealth(lone, { relations: {}, groups: { g: { members: ['alone', 'also-alone'] } } });
  assert.deepEqual(grouped.orphans, []);
  assert.deepEqual(grouped.thinGroups, []);
  const thin = canvasHealth(lone, { relations: {}, groups: { g: { members: ['alone'], name: 'Thin' } } });
  assert.deepEqual(thin.thinGroups, [{ id: 'g', name: 'Thin' }]);
  assert.deepEqual(thin.orphans.map((orphan) => orphan.anchor), ['also-alone']);
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
