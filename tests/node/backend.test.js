/**
 * The browser fallback is what makes the app testable without Tauri, so its
 * command surface has to behave like the Rust one: same names, same effects,
 * same undo semantics.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// Minimal localStorage so the fallback can persist during the test run.
globalThis.localStorage = (() => {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
})();

const { backend, virtualVault } = await import('../../src/backend.js');

test('the fallback backend is not the desktop one', () => {
  assert.equal(backend.isDesktop, false);
});

test('opening the sample vault reports its identity and settings', async () => {
  virtualVault.reset();
  const info = await backend.openVault('/sample-vault');
  assert.equal(info.name, 'Macusanite Sample Vault');
  assert.match(info.description, /Macusani/);
  assert.equal(info.settings.defaultPageColor, '#ffffff');
  assert.equal(typeof info.path, 'string');
});

test('the tree exposes chambers and veins, and never the metadata folder', async () => {
  virtualVault.reset();
  await backend.openVault('/sample-vault');
  const tree = await backend.tree();
  const names = tree.map((n) => n.name);
  assert.ok(names.includes('Home.md'));
  assert.ok(names.includes('Chambers'));
  assert.equal(names.includes('.macusanite'), false);

  const veins = await backend.veins();
  assert.ok(veins.includes('Home.md'));
  assert.ok(veins.includes('Chambers/Lab/Analytical Methods.md'));
  assert.equal(veins.some((p) => p.startsWith('.macusanite/')), false);
  assert.equal(veins.some((p) => p.endsWith('.json')), false);
});

test('reading and writing veins round trips, and records history', async () => {
  virtualVault.reset();
  await backend.openVault('/sample-vault');
  const original = await backend.readVein('Home.md');

  await backend.writeVein('Home.md', `${original}\n\nappended from a test\n`, 'edit Home.md');
  assert.match(await backend.readVein('Home.md'), /appended from a test/);

  const after = await backend.history();
  assert.equal(after.undo[0].label, 'edit Home.md');
  assert.equal(after.redo.length, 0);

  const undone = await backend.undo();
  assert.equal(undone.applied, true);
  assert.equal(await backend.readVein('Home.md'), original);

  const redone = await backend.redo();
  assert.equal(redone.applied, true);
  assert.match(await backend.readVein('Home.md'), /appended from a test/);
});

test('the newest undo entry comes first, and logs stay out of the stacks', async () => {
  virtualVault.reset();
  await backend.openVault('/sample-vault');
  const originalVein = await backend.readVein('Home.md');
  const originalColors = await backend.readMeta('colors.json');

  await backend.writeVein('Home.md', `${originalVein}\nfirst edit\n`, 'edit one');
  await backend.log('info', 'noise that must not enter the stacks');
  await backend.writeMeta('colors.json', '{"pages":{"Home.md":"#ffd700"}}', 'colour change');

  const stacked = await backend.history();
  assert.equal(stacked.undo[0].label, 'colour change', 'newest first, like the Rust side');
  assert.equal(stacked.undo[1].label, 'edit one');
  assert.equal(stacked.undo.length, 2, 'the log never enters the stack');

  const undoneColors = await backend.undo();
  assert.equal(undoneColors.path.endsWith('colors.json'), true);
  assert.equal(await backend.readMeta('colors.json'), originalColors);

  const undoneEdit = await backend.undo();
  assert.equal(undoneEdit.path, 'Home.md');
  assert.equal(await backend.readVein('Home.md'), originalVein);
});

test('creating a vein records an undo step that removes it again', async () => {
  virtualVault.reset();
  await backend.openVault('/sample-vault');
  const created = await backend.createVein('Chambers/Lab/Brand New.md', null);
  assert.equal(created.created, true);
  assert.match(await backend.readVein(created.path), /Brand New/);

  const again = await backend.createVein('Chambers/Lab/Brand New.md');
  assert.equal(again.created, false, 'creating twice does not clobber');

  await backend.undo();
  await assert.rejects(() => backend.readVein(created.path), /not found/);
});

test('create_chamber shows up in the tree as an empty chamber', async () => {
  virtualVault.reset();
  await backend.openVault('/sample-vault');
  await backend.createChamber('Chambers/Empty');
  const tree = await backend.tree();
  const chambers = tree.find((n) => n.name === 'Chambers');
  assert.ok(chambers.children.some((c) => c.name === 'Empty'));
});

test('meta files round trip and unrecorded writes stay out of the undo stack', async () => {
  virtualVault.reset();
  await backend.openVault('/sample-vault');
  const before = await backend.history();

  await backend.writeMeta('state.json', '{"lastPath":"Home.md"}', 'viewer state', false);
  const afterState = await backend.history();
  assert.equal(afterState.undo.length, before.undo.length, 'state.json is not undoable');

  assert.equal(await backend.readMeta('state.json'), '{"lastPath":"Home.md"}');

  await backend.writeMeta('colors.json', '{"pages":{"Home.md":"#ffd700"}}', 'colour page:Home.md');
  const afterColors = await backend.history();
  assert.equal(afterColors.undo[0].label, 'colour page:Home.md');
  assert.match(afterColors.undo[0].path, /colors\.json$/);
});

test('undoing a metadata write restores the previous file contents', async () => {
  virtualVault.reset();
  await backend.openVault('/sample-vault');
  const original = await backend.readMeta('settings.json');
  await backend.writeMeta('settings.json', '{"version":1,"fontSize":22}', 'settings');
  assert.equal(await backend.readMeta('settings.json'), '{"version":1,"fontSize":22}');
  await backend.undo();
  assert.equal(await backend.readMeta('settings.json'), original);
});

test('logs are appended and never disturb the undo stack', async () => {
  virtualVault.reset();
  await backend.openVault('/sample-vault');
  const before = await backend.history();
  await backend.log('info', 'hello from the test');
  await backend.log('warn', 'and again');
  assert.equal(virtualVault.logs.at(-1).message, 'and again');
  const after = await backend.history();
  assert.equal(after.undo.length, before.undo.length);
});
