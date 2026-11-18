import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CANVAS_SCHEMA,
  canvasSnapshot,
  migrateCanvasRecord,
  migrateCanvasSnapshot,
  restoreSnapshot,
} from '../../src/lib/worldbuild.js';

/**
 * Fixtures of records and snapshots as older versions wrote them, kept so a
 * change to the saved canvas these days has to prove it still reads them.
 */
const fixture = (name) => JSON.parse(readFileSync(join(import.meta.dirname, '..', 'fixtures', 'canvas', name), 'utf8'));

const legacyRecord = () => fixture('legacy-record-v1.json');
const legacySnapshot = () => fixture('legacy-snapshot-v1.json');
const oldestSnapshot = () => fixture('legacy-snapshot-v0.json');

test('a legacy record is brought to the current canvas schema', () => {
  const before = legacyRecord();
  const record = migrateCanvasRecord(before);
  assert.equal(record.schema, CANVAS_SCHEMA);

  // Stack order: the early spelling becomes the one every reader uses now.
  assert.deepEqual(record.stack, ['beta', 'alpha']);
  assert.equal('stackOrder' in record, false);

  // Annotations: a list gains ids that stay the same on every migration.
  assert.deepEqual(Object.keys(record.annotations).sort(), ['ann-keep', 'ann-migrated-1']);
  assert.equal(record.annotations['ann-keep'].color, '#ffcc00');
  assert.equal(record.annotations['ann-migrated-1'].text, 'The first crossing happens here.');
  assert.equal(record.annotations['ann-migrated-1'].x, 120);

  // Groups: duplicates drop, a group cannot be its own child, and a pin from
  // before frames were stored keeps its pin and its pin time.
  assert.deepEqual(record.groups['grp-origins'].members, ['alpha', 'beta']);
  assert.equal(record.groups['grp-origins'].pinned, true);
  assert.equal(record.groups['grp-origins'].pinnedAt, '2025-03-04T10:00:00.000Z');
  assert.deepEqual(record.groups['grp-nested'].children, ['grp-origins']);

  // History: bare snapshot strings take the default step name, as they always did.
  assert.equal(record.history.past.length, 2);
  assert.equal(record.history.past[0].name, 'Canvas change');
  assert.equal(record.history.past[1].name, 'Move card');
});

test('migrating a record or a snapshot twice changes nothing', () => {
  const record = migrateCanvasRecord(legacyRecord());
  assert.deepEqual(migrateCanvasRecord(structuredClone(record)), record);
  // A snapshot may arrive as JSON text, and still may not drift on a second pass.
  const snapshot = migrateCanvasSnapshot(legacySnapshot());
  assert.deepEqual(migrateCanvasSnapshot(structuredClone(snapshot)), snapshot);
  assert.deepEqual(migrateCanvasSnapshot(JSON.stringify(snapshot)), snapshot);
});

test('a record keeps the fields this version has never heard of', () => {
  const record = migrateCanvasRecord({ ...legacyRecord(), futureField: { keep: ['me'] } });
  assert.deepEqual(record.futureField, { keep: ['me'] });
  // A newer version's own schema number is replaced with this one's, because
  // this is the shape the record is being written back in.
  const newer = migrateCanvasRecord({ ...legacyRecord(), schema: 99 });
  assert.equal(newer.schema, CANVAS_SCHEMA);
  assert.deepEqual(migrateCanvasRecord(newer), newer);
});

test('stack order is read from a per-card depth map as well', () => {
  const record = migrateCanvasRecord({ z: { beta: 3, alpha: 1, gamma: 2, junk: 'top' } });
  assert.deepEqual(record.stack, ['alpha', 'gamma', 'beta']);
  assert.equal('z' in record, false);
});

test('a history entry keeps the keys this version does not know', () => {
  const snap = JSON.stringify({ positions: { alpha: { x: 1, y: 1 } } });
  const entry = { name: 'Move card', snap, at: '2026-01-02T03:04:05.000Z', by: 'agent' };
  const record = migrateCanvasRecord({ history: { past: [entry, snap], future: [] } });
  assert.deepEqual(record.history.past[0], entry);
  // The snapshot inside a step is migrated when a restore reads it, not now.
  assert.equal(record.history.past[0].snap, snap);
  assert.deepEqual(record.history.past[1], { name: 'Canvas change', snap });
});

test('a legacy snapshot restores stack order, annotations and table prose', () => {
  const live = new Set(['alpha', 'beta', 'group:grp-origins']);
  const restored = restoreSnapshot(JSON.stringify(legacySnapshot()), live, {});
  assert.deepEqual(restored.stack, ['alpha', 'beta']);
  assert.equal(restored.groups['grp-origins'].pinned, true);
  assert.deepEqual(Object.keys(restored.annotations), ['ann-migrated-1']);
  assert.deepEqual(restored.tables, {
    alpha: '| who | where |\n| --- | --- |\n| Alda | north gate |',
  });
  assert.deepEqual(restored.view, { x: -20, y: 10, s: 0.8 });
});

test('a snapshot from before types, fields and colours restores the current ones', () => {
  const current = { types: { alpha: 'person' }, fields: {}, colors: { beta: '#ef4444' } };
  const restored = restoreSnapshot(oldestSnapshot(), new Set(['alpha', 'beta', 'group:grp-origins']), current);
  assert.deepEqual(restored.types, { alpha: 'person' });
  assert.deepEqual(restored.colors, { beta: '#ef4444' });
  assert.deepEqual(restored.stack, []);
  assert.deepEqual(restored.annotations, {});
  assert.equal(restored.tables, null);
  assert.deepEqual(restored.view, { x: 0, y: 0, s: 1.25 });
});

test('a current snapshot round-trips through a restore without losing a field', () => {
  const state = {
    positions: { alpha: { x: 40, y: 40 }, beta: { x: 420, y: 90 } },
    groups: { 'grp-origins': { id: 'grp-origins', name: 'Origins', members: ['alpha', 'beta'] } },
    relations: { 'alpha->beta': 'leads to' },
    bondNotes: { 'alpha->beta': 'written in the margin' },
    folded: { beta: true },
    types: { alpha: 'place' },
    fields: { alpha: { era: 'first' } },
    colors: { alpha: '#3b82f6' },
    images: { beta: '.macusanite/node-images/beta.png' },
    resources: { alpha: ['vault://atlas.md'] },
    pinned: { alpha: true },
    locked: { beta: true },
    cardModes: { alpha: 'table' },
    cardSizes: { beta: { width: 320, height: 260 } },
    cardDims: { alpha: { width: 300, height: 180 } },
    stack: ['beta', 'alpha'],
    collapsedGroups: { 'grp-origins': true },
    annotations: { 'ann-1': { id: 'ann-1', x: 10, y: 20, text: 'A note on the canvas.', color: '#facc15' } },
    tables: { alpha: '| who | where |\n| --- | --- |\n| Alda | north gate |' },
    view: { x: -20, y: 10, s: 0.8 },
  };
  const live = new Set(['alpha', 'beta', 'group:grp-origins']);
  const snap = canvasSnapshot(state);
  assert.equal(JSON.parse(snap).schema, CANVAS_SCHEMA);
  const restored = restoreSnapshot(snap, live, {});
  // Nothing a record carries is dropped on the way back, whatever the shape
  // the restore normalises it into. Groups are checked on their own, because a
  // restore always writes an explicit (possibly empty) children list.
  const withoutGroups = (record) => {
    const { groups, schema, ...rest } = record;
    return rest;
  };
  assert.deepEqual(withoutGroups(restored), withoutGroups(JSON.parse(snap)));
  assert.equal(restored.groups['grp-origins'].name, 'Origins');
  assert.deepEqual(restored.groups['grp-origins'].members, ['alpha', 'beta']);
  // And the shape it normalises into is stable: a second pass changes nothing.
  const again = restoreSnapshot(canvasSnapshot(restored), live, {});
  assert.equal(canvasSnapshot(again), canvasSnapshot(restored));
});

test('something that is not a snapshot comes back null', () => {
  assert.equal(migrateCanvasSnapshot('{'), null);
  assert.equal(migrateCanvasSnapshot('[]'), null);
  assert.equal(migrateCanvasSnapshot(null), null);
  assert.equal(restoreSnapshot('[1,2]', new Set(['alpha'])), null);
});
