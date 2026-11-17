import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sampleVaultFiles } from '../../src/lib/fixtures.js';
import { parseNotes, canvasSnapshot, canvasHealth, cleanHistoryStack, cleanAnnotations, normalizeRouting, progressionColumns, layoutProgressionColumns, rectsOverlap } from '../../src/lib/worldbuild.js';

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

  // The labelled feature gallery, in one place. Each demo cluster has a state
  // the reader can inspect immediately: locked, frozen/Static, pinned, a
  // collapsed summary, and a deliberately thin group for Health.
  assert.equal(record.groups['g-locked'].locked, true);
  assert.deepEqual(record.groups['g-locked'].members, ['where-to-go-next', 'colour-everywhere']);
  assert.equal(record.groups['g-frozen'].locked, 'frozen');
  assert.deepEqual(record.groups['g-frozen'].members, ['freeze-and-static', 'unfreeze-from-the-menu']);
  assert.equal(record.groups['g-pinned'].pinned, true);
  assert.deepEqual(record.groups['g-modes'].members, ['card-display-modes', 'compact-card', 'thumbnail-card', 'folded-card']);
  assert.equal(record.cardModes['compact-card'], 'compact');
  assert.equal(record.cardModes['thumbnail-card'], 'thumbnail');
  assert.equal(record.folded['folded-card'].card, true);
  assert.equal(record.groups['g-collapsed'].members.length, 2);
  assert.equal(record.collapsedGroups['g-collapsed'], true);
  assert.deepEqual(record.groups['g-thin'].members, ['health-and-orphans']);
  assert.equal(record.cardSizes['health-and-orphans'], 'content');
  assert.equal(record.positions['orphan-card'].x, 436);

  // The nested-group cluster: one outer group with a direct card and two child
  // groups, plus a deliberately resized card in the first child.
  const nested = record.groups['g-nested-outer'];
  assert.deepEqual(nested.members, ['nested-groups']);
  assert.deepEqual(nested.children, ['g-nested-field', 'g-nested-results']);
  assert.deepEqual(record.groups['g-nested-field'].members, ['nested-group-field-notes', 'nested-group-lab-notes']);
  assert.deepEqual(record.groups['g-nested-results'].members, ['nested-group-samples', 'nested-group-results']);
  assert.deepEqual(record.cardDims['nested-group-field-notes'], { width: 420, height: 180 });

  const health = canvasHealth(model, { relations: record.relations, groups: record.groups });
  assert.ok(health.thinGroups.some((group) => group.id === 'g-thin'), 'the thin group is a health warning');
  assert.ok(health.orphans.some((note) => note.anchor === 'orphan-card'), 'the unconnected card is an orphan');

  // No card belongs to two groups: every cluster is disjoint.
  const grouped = Object.values(record.groups).flatMap((group) => group.members);
  assert.equal(new Set(grouped).size, grouped.length, 'group membership is disjoint');

  // The gallery must open as a gallery: no card covers another, no group box
  // covers another or a foreign card, and no annotation covers a card or box.
  // These are conservative box sizes: compact and folded cards are measured
  // larger than their rendered minimums, so the check has breathing room.
  const cardRect = (anchor) => {
    const mode = record.cardModes[anchor];
    const folded = record.folded[anchor]?.card === true;
    const dims = record.cardDims?.[anchor];
    return {
      x: record.positions[anchor].x,
      y: record.positions[anchor].y,
      width: mode === 'thumbnail' ? 128 : mode === 'compact' ? 220 : dims?.width ?? 300,
      height: mode === 'thumbnail' ? 128 : mode === 'compact' ? 96 : dims?.height ?? (folded ? 56 : 260),
    };
  };
  const cardBoxes = Object.fromEntries(Object.keys(record.positions).map((anchor) => [anchor, cardRect(anchor)]));
  const effectiveMembers = (group, seen = new Set()) => {
    const out = new Set();
    const visit = (id) => {
      if (seen.has(id)) return;
      seen.add(id);
      const current = record.groups[id];
      if (!current) return;
      for (const anchor of current.members) out.add(anchor);
      for (const child of current.children ?? []) visit(child);
    };
    visit(group.id);
    return out;
  };
  const groupBox = (group) => {
    const rects = [...effectiveMembers(group)].map((anchor) => cardBoxes[anchor]);
    const topPad = group.layout === 'progression' ? 30 : 12;
    return {
      x: Math.min(...rects.map((rect) => rect.x)) - 12,
      y: Math.min(...rects.map((rect) => rect.y)) - topPad,
      width: Math.max(...rects.map((rect) => rect.x + rect.width)) - Math.min(...rects.map((rect) => rect.x)) + 24,
      height: Math.max(...rects.map((rect) => rect.y + rect.height)) - Math.min(...rects.map((rect) => rect.y)) + topPad + 12,
    };
  };
  const groupBoxes = Object.fromEntries(Object.entries(record.groups).map(([id, group]) => [id, groupBox(group)]));
  const isAncestor = (parent, child) => {
    if (parent === child) return false;
    return (record.groups[parent]?.children ?? []).some((id) => id === child || isAncestor(id, child));
  };
  const contains = (outer, inner) => outer.x <= inner.x && outer.y <= inner.y
    && outer.x + outer.width >= inner.x + inner.width
    && outer.y + outer.height >= inner.y + inner.height;
  const annotationBoxes = Object.values(record.annotations).map((annotation) => ({
    x: annotation.x, y: annotation.y, width: 220, height: 160, id: annotation.id,
  }));
  const anchorsList = Object.keys(cardBoxes);
  for (let i = 0; i < anchorsList.length; i += 1) {
    for (let j = i + 1; j < anchorsList.length; j += 1) {
      assert.equal(rectsOverlap(cardBoxes[anchorsList[i]], cardBoxes[anchorsList[j]]), false,
        `${anchorsList[i]} overlaps ${anchorsList[j]}`);
    }
  }
  for (const [idA, a] of Object.entries(groupBoxes)) {
    for (const [idB, b] of Object.entries(groupBoxes)) {
      if (idA >= idB) continue;
      if (isAncestor(idA, idB)) {
        assert.ok(contains(a, b), `${idA} contains its nested group ${idB}`);
        continue;
      }
      if (isAncestor(idB, idA)) {
        assert.ok(contains(b, a), `${idB} contains its nested group ${idA}`);
        continue;
      }
      assert.equal(rectsOverlap(a, b), false, `${idA} box overlaps ${idB} box`);
    }
    for (const [anchor, card] of Object.entries(cardBoxes)) {
      if (effectiveMembers(record.groups[idA]).has(anchor)) continue;
      assert.equal(rectsOverlap(a, card), false, `${idA} box covers foreign card ${anchor}`);
    }
  }
  for (const annotation of annotationBoxes) {
    for (const [anchor, card] of Object.entries(cardBoxes)) {
      assert.equal(rectsOverlap(annotation, card), false, `${annotation.id} overlaps ${anchor}`);
    }
    for (const [id, box] of Object.entries(groupBoxes)) {
      assert.equal(rectsOverlap(annotation, box), false, `${annotation.id} overlaps ${id} box`);
    }
    for (const other of annotationBoxes) {
      if (annotation.id >= other.id) continue;
      assert.equal(rectsOverlap(annotation, other), false, `${annotation.id} overlaps ${other.id}`);
    }
  }
  assert.equal(record.pinned['the-three-panes'], true);
  assert.equal(record.locked['where-to-go-next'], true, 'one node content-locked');
  assert.deepEqual(normalizeRouting(record.routing), { elbow: true, arrows: true, cut: false, edges: {} });
  const annotations = cleanAnnotations(record.annotations);
  assert.equal(Object.keys(annotations).length, 4);
  assert.equal(annotations['ann-static'].folded, true);
  assert.equal(annotations['ann-nested'].folded, true);
  assert.equal(annotations['ann-static'].color, '#58a6ff');
  assert.equal(annotations['ann-wires'].color, '#57d364');
  assert.equal(annotations['ann-nested'].color, '#da70d6');
  assert.equal(record.types.diagramming, 'stat');
  assert.equal(record.types['the-three-panes'], 'table');
  assert.deepEqual(record.fields.diagramming, { value: '3 diagrams' });
  assert.equal(record.images['reference-cards-and-hand-written-links'], '.macusanite/node-images/macusanite-lens.svg');
  assert.match(files['.macusanite/node-images/macusanite-lens.svg'], /^data:image\//, 'the image lives as a file');
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
  assert.match(notes, /Frozen \/ Static/);
  assert.match(notes, /Card modes and folds/);
  assert.match(notes, /Collapsed group \+ summary/);
  assert.match(files['Home.md'], /Freeze and Static/);
  assert.match(files['Home.md'], /unrelated cards, group boxes, annotations and group tabs/);
  assert.match(files['Home.md'], /Nested groups/);
  assert.match(files['Home.md'], /420 × 180/);
  assert.match(notes, /Nested groups/);
  assert.match(notes, /Resized cards/);
  assert.match(notes, /Annotation colour and fold/);
});
