import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LIVE_META, isWatched, isLiveMeta, liveMetaName, metaChanges, metaPlan,
  planRefresh, currentOutcome, describeRefresh, describeMeta, staleBodies,
} from '../../src/lib/watch.js';

const VEINS = ['Home.md', 'Chambers/Lab/Analytical Methods.md'];

test('isWatched mirrors the vein half of the Rust filter', () => {
  // The same expectations live in src-tauri/src/watch.rs.
  for (const path of [
    '.macusanite/colors.json',
    '.macusanite/logs/session-20261012.log',
    '.git/config',
    'Chambers/.hidden/Note.md',
    'Chambers/~$Notes.md',
    'Chambers/Notes.md~',
    'Home.md.swp',
    'photo.png',
    'archive.zip',
    '.Home.md.macusanite-tmp',
    '',
    null,
  ]) {
    assert.equal(isWatched(path), false, `${path} should be ignored`);
  }
  for (const path of [
    'Home.md',
    'Chambers',
    'Chambers/Lab',
    'Chambers/Lab/Analytical Methods.md',
    'Notes.markdown',
    'Draft.mdx',
    'Chambers/Fieldwork 2026/Notes.md',
  ]) {
    assert.equal(isWatched(path), true, `${path} should be watched`);
  }
});

test('a change to a vein that exists is re-read, whatever the event claimed', () => {
  const plan = planRefresh({
    changes: [
      { path: 'Home.md', kind: 'modified' },
      // A delete-then-recreate can report "removed" for a path that is back.
      { path: 'Chambers/Lab/Analytical Methods.md', kind: 'removed' },
    ],
    veins: VEINS,
    bodies: { 'Home.md': '# Home', 'Chambers/Lab/Analytical Methods.md': '# Methods' },
  });
  assert.deepEqual(plan.relevant, ['Home.md', 'Chambers/Lab/Analytical Methods.md']);
  assert.deepEqual(plan.added, []);
  assert.deepEqual(plan.removed, []);
  assert.equal(plan.touched, true);
  assert.equal(plan.treeChanged, true);
});

test('a vein the viewer has never read counts as added, not changed', () => {
  const plan = planRefresh({
    changes: [{ path: 'Chambers/Lab/Brand New.md', kind: 'created' }],
    veins: [...VEINS, 'Chambers/Lab/Brand New.md'],
    bodies: { 'Home.md': '# Home' },
  });
  assert.deepEqual(plan.added, ['Chambers/Lab/Brand New.md']);
  assert.deepEqual(plan.relevant, []);
  assert.equal(describeRefresh(plan), 'Vault changed outside the viewer: 1 vein added');
});

test('the index decides added against changed once the vault is opened lazily', () => {
  // Two veins are indexed but neither body is held in memory, which is the
  // normal state after a warm open: the metadata came from the cache.
  const plan = planRefresh({
    changes: [
      { path: 'Home.md', kind: 'modified' },
      { path: 'Chambers/Lab/Brand New.md', kind: 'created' },
    ],
    veins: [...VEINS, 'Chambers/Lab/Brand New.md'],
    bodies: {},
    indexed: ['Home.md', 'Chambers/Lab/Analytical Methods.md'],
  });
  assert.deepEqual(plan.relevant, ['Home.md']);
  assert.deepEqual(plan.added, ['Chambers/Lab/Brand New.md']);
});

test('a vein that is gone is dropped, a chamber just refreshes the tree', () => {
  const plan = planRefresh({
    changes: [
      { path: 'Chambers/Fieldwork/Old Notes.md', kind: 'removed' },
      { path: 'Chambers/Fieldwork', kind: 'created' },
    ],
    veins: VEINS,
  });
  assert.deepEqual(plan.relevant, []);
  assert.deepEqual(plan.removed, ['Chambers/Fieldwork/Old Notes.md']);
  assert.deepEqual(plan.chambers, ['Chambers/Fieldwork']);
  assert.equal(plan.treeChanged, true);
});

test('changes the viewer never renders are ignored entirely', () => {
  const plan = planRefresh({
    changes: [
      { path: '.macusanite/colors.json', kind: 'modified' },
      { path: 'assets/photo.png', kind: 'created' },
      { path: 'Home.md.swp', kind: 'created' },
    ],
    veins: VEINS,
  });
  assert.equal(plan.touched, false);
  assert.equal(plan.treeChanged, false);
  assert.deepEqual(plan.relevant, []);
});

test('the open vein is re-rendered only when the disk really differs', () => {
  const base = { currentPath: 'Home.md', raw: '# Home\n' };
  // Same text as the document was rendered from: nothing to do.
  assert.equal(currentOutcome({ ...base, diskText: '# Home\n', dirty: false }), 'none');
  // Changed externally, editor clean: adopt the new text.
  assert.equal(currentOutcome({ ...base, diskText: '# Home\n\nmore\n', dirty: false }), 'reload');
  // Changed externally while the editor holds unsaved text: the draft wins.
  assert.equal(currentOutcome({ ...base, diskText: '# Home\n\nmore\n', dirty: true }), 'keep-draft');
  // Unreadable: leave the screen alone rather than blaming the reader.
  assert.equal(currentOutcome({ ...base, diskText: null, dirty: false }), 'none');
  // No document open at all.
  assert.equal(currentOutcome({}), 'none');
});

test('the open vein disappearing is reported without throwing the text away', () => {
  const outcome = currentOutcome({ currentPath: 'Home.md', exists: false, raw: '# Home\n', dirty: false });
  assert.equal(outcome, 'removed');
});

test('describeRefresh reads like a sentence in the toast', () => {
  assert.equal(
    describeRefresh({ relevant: ['Home.md'], removed: [], chambers: [] }),
    'Vault changed outside the viewer: 1 vein changed',
  );
  assert.equal(
    describeRefresh({ relevant: ['a.md', 'b.md'], removed: ['c.md'], chambers: ['Lab'] }),
    'Vault changed outside the viewer: 2 veins changed, 1 removed, 1 chamber',
  );
  assert.equal(
    describeRefresh({ added: ['New.md'], relevant: [], removed: [], chambers: [] }),
    'Vault changed outside the viewer: 1 vein added',
  );
  assert.equal(describeRefresh({ rereadAll: true }), 'Vault changed outside the viewer — reloading');
  assert.equal(describeRefresh({}), 'Vault changed outside the viewer');
});

test('the two hand-editable metadata files are followed and no others are', () => {
  // The same pair is named in src-tauri/src/watch.rs.
  assert.deepEqual(LIVE_META, ['.macusanite/settings.json', '.macusanite/colors.json']);
  for (const path of LIVE_META) {
    assert.equal(isLiveMeta(path), true, `${path} should be followed`);
  }
  assert.equal(liveMetaName('.macusanite/settings.json'), 'settings');
  assert.equal(liveMetaName('.macusanite/colors.json'), 'colors');

  // Windows spelling, and case, name the same file.
  assert.equal(liveMetaName('.macusanite\\settings.json'), 'settings');
  assert.equal(liveMetaName('.macusanite/Colors.JSON'), 'colors');
  // The spelling is normalised, so the caller does not carry two versions around.
  assert.deepEqual(metaChanges([{ path: '.macusanite\\Colors.JSON' }]).paths, ['.macusanite/colors.json']);

  // The viewer's own bookkeeping stays quiet — it is written constantly, and
  // following it would be a feedback loop. So does anything that is not metadata.
  for (const path of [
    '.macusanite/vault.json',
    '.macusanite/state.json',
    '.macusanite/index.json',
    '.macusanite/history.json',
    '.macusanite/logs/session-20261012.log',
    '.macusanite/settings.json.bak',
    'settings.json',
    'Home.md',
    '',
    null,
    undefined,
  ]) {
    assert.equal(isLiveMeta(path), false, `${path} should not be followed`);
    assert.equal(liveMetaName(path), null, `${path} should have no name`);
  }

  // Nothing is both: a path is either a vein the document view renders or a
  // metadata file the window follows, and the batch handles them separately.
  for (const path of [...LIVE_META, ...VEINS]) {
    assert.notEqual(isWatched(path), isLiveMeta(path), `${path} must be exactly one of the two`);
  }
});

test('a batch names each followed metadata file once, and only what it mentions', () => {
  const quiet = metaChanges([{ path: 'Home.md', kind: 'modified' }]);
  assert.deepEqual(quiet.paths, []);
  assert.equal(quiet.settings, false);
  assert.equal(quiet.colors, false);

  const both = metaChanges([
    { path: '.macusanite/settings.json', kind: 'modified' },
    { path: 'Home.md', kind: 'modified' },
    { path: '.macusanite/colors.json', kind: 'created' },
    // The same file twice in one burst is one file.
    { path: '.macusanite/settings.json', kind: 'removed' },
    // …and the viewer's own writes are not mentioned at all.
    { path: '.macusanite/index.json', kind: 'modified' },
  ]);
  assert.deepEqual(both.paths, ['.macusanite/settings.json', '.macusanite/colors.json']);
  assert.equal(both.settings, true);
  assert.equal(both.colors, true);

  // A bare string change (the browser fallback delivers objects; tests do not)
  // and an unreadable entry are both tolerated.
  assert.deepEqual(metaChanges(['.macusanite/colors.json', null, undefined]).paths, ['.macusanite/colors.json']);
  assert.deepEqual(metaChanges().paths, []);
  assert.deepEqual(metaPlan([]).paths, []);
});

test('a metadata-only batch touches no vein', () => {
  // This is what lets `applyExternalBatch` handle settings and colours before it
  // decides whether to walk the vault: the planner says nothing moved.
  const plan = planRefresh({
    changes: [{ path: '.macusanite/settings.json', kind: 'modified' }],
    veins: VEINS,
  });
  assert.equal(plan.touched, false);
  assert.deepEqual([plan.added, plan.relevant, plan.removed, plan.chambers], [[], [], [], []]);
  // A vein edited in the same breath as the settings still plans normally.
  const mixed = planRefresh({
    changes: [
      { path: '.macusanite/colors.json', kind: 'modified' },
      { path: 'Home.md', kind: 'modified' },
    ],
    veins: VEINS,
    bodies: { 'Home.md': '# Home' },
  });
  assert.deepEqual(mixed.relevant, ['Home.md']);
  assert.equal(describeRefresh(mixed), 'Vault changed outside the viewer: 1 vein changed');
});

test('describeMeta says which of the two files was applied', () => {
  assert.equal(
    describeMeta(['.macusanite/settings.json']),
    'Settings edited outside the viewer — applied',
  );
  assert.equal(
    describeMeta(['.macusanite/colors.json']),
    'Colours edited outside the viewer — applied',
  );
  assert.equal(
    describeMeta(['.macusanite/settings.json', '.macusanite/colors.json']),
    'Settings and colours edited outside the viewer — applied',
  );
  assert.equal(describeMeta([]), 'Metadata edited outside the viewer');
  assert.equal(describeMeta(), 'Metadata edited outside the viewer');
});

test('staleBodies names the cached veins that no longer exist', () => {
  const bodies = {
    'Home.md': '# Home',
    'Chambers/Lab/Analytical Methods.md': '# Methods',
    'Chambers/Lab/Deleted.md': '# Gone',
  };
  assert.deepEqual(staleBodies(bodies, VEINS), ['Chambers/Lab/Deleted.md']);
  assert.deepEqual(staleBodies({}, VEINS), []);
  assert.deepEqual(staleBodies(null, VEINS), []);
});
