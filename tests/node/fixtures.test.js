import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sampleVaultFiles } from '../../src/lib/fixtures.js';
import { parseNotes, canvasSnapshot, cleanHistoryStack, cleanAnnotations, normalizeRouting, progressionColumns, layoutProgressionColumns } from '../../src/lib/worldbuild.js';

test('the sample vault ships a working Worldbuilding canvas on Home', () => {
  const files = sampleVaultFiles();
  const state = JSON.parse(files['.macusanite/state.json']);
  const record = state.world['Home.md'];
  assert.ok(record, 'Home has a world record');
  assert.equal(record.marked, true, 'Home opens as a canvas');

  const anchors = new Set(parseNotes(files['Home.md']).notes.map((note) => note.anchor));
  for (const anchor of Object.keys(record.positions)) {
    assert.ok(anchors.has(anchor), `position for a real card: ${anchor}`);
    assert.ok(Number.isFinite(record.positions[anchor].x));
    assert.ok(Number.isFinite(record.positions[anchor].y));
  }

  // The progression board: real heading-tree tiers on Home, visible on first
  // open. Tier 0 is the top card, tier 1 its sections, tier 2 the `###`
  // subsections under Diagramming.
  const board = record.groups['g-progression'];
  assert.ok(board, 'Home has a progression group');
  assert.equal(board.layout, 'progression');
  assert.deepEqual(board.members, ['welcome-to-your-vault', 'diagramming', 'reference-cards-and-hand-written-links', 'flowchart', 'sequence-diagram']);
  const model = parseNotes(files['Home.md']);
  const columns = progressionColumns(model, board.members);
  assert.equal(columns.get('welcome-to-your-vault'), 0);
  assert.equal(columns.get('diagramming'), 1);
  assert.equal(columns.get('reference-cards-and-hand-written-links'), 1);
  assert.equal(columns.get('flowchart'), 2);
  assert.equal(columns.get('sequence-diagram'), 2);
  assert.equal(new Set(columns.values()).size, 3, 'three real tiers');
  // Seeded positions already sit in the board's columns, left to right.
  const laid = layoutProgressionColumns(
    board.members.map((anchor) => ({ key: anchor, column: columns.get(anchor), height: 260 })),
    { origin: { x: 40, y: 40 }, stepX: 396, stepY: 76 },
  );
  for (const anchor of board.members) {
    assert.deepEqual(record.positions[anchor], laid.get(anchor), `seeded in-column position: ${anchor}`);
  }
  assert.match(files['Home.md'], /^### Flowchart$/m);
  assert.match(files['Home.md'], /^### Sequence diagram$/m);

  // The feature tour, in one place.
  assert.equal(record.groups['g-locked'].locked, true);
  assert.deepEqual(record.groups['g-locked'].members, ['where-to-go-next', 'colour-everywhere']);
  assert.equal(record.groups['g-pinned'].pinned, true);
  // No card belongs to two groups: board, locked and pinned sets are disjoint.
  const grouped = Object.values(record.groups).flatMap((group) => group.members);
  assert.equal(new Set(grouped).size, grouped.length, 'group membership is disjoint');
  assert.equal(record.pinned['colour-everywhere'], true);
  assert.equal(record.locked['where-to-go-next'], true, 'one node content-locked');
  assert.deepEqual(normalizeRouting(record.routing), { elbow: true, arrows: true, edges: {} });
  assert.equal(Object.keys(cleanAnnotations(record.annotations)).length, 2);
  assert.equal(record.types.diagramming, 'stat');
  assert.deepEqual(record.fields.diagramming, { value: '3 diagrams' });
  assert.equal(record.images['reference-cards-and-hand-written-links'], '.macusanite/node-images/demo.png');
  assert.match(files['.macusanite/node-images/demo.png'], /^data:image\//, 'the image lives as a file');
  assert.ok(record.colors.diagramming);

  // Named canvas history whose snapshots parse and restore to real anchors.
  const stack = cleanHistoryStack(record.history);
  assert.equal(stack.past.length, 3);
  assert.ok(stack.past.every((entry) => entry.name && entry.name !== 'Canvas change'));
  for (const entry of stack.past) {
    const snap = JSON.parse(entry.snap);
    assert.equal(entry.snap, canvasSnapshot(snap), 'snapshots are canonical');
    for (const anchor of Object.keys(snap.positions)) assert.ok(anchors.has(anchor));
  }
});

test('the sample vault documents the canvas tour and portable export/import', () => {
  const files = sampleVaultFiles();
  const notes = files['Chambers/Vault Notes.md'];
  assert.match(notes, /Worldbuilding canvas tour/);
  assert.match(notes, /Overview/);
  assert.match(notes, /vault export/);
  assert.match(notes, /--overwrite/);
  assert.match(files['Home.md'], /Try the Worldbuilding canvas/);
  assert.match(notes, /Progression columns/);
  assert.match(files['Home.md'], /Progression board/);
});
