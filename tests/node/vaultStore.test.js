/**
 * The vault store is what the CLI, the MCP server and the browser fallback all
 * drive, so these tests run it against a *real* temporary folder — the same
 * arrangement the Rust suite uses for `vault.rs` and `meta.rs`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createVaultStore, safePath, safeMetaName, VaultPathError, dayStamp } from '../../src/lib/vaultStore.js';
import { createNodeVaultFs, openVault, seedSampleVault } from '../../cli/vaultFs.js';

let counter = 0;
function tempVault(name = 'store') {
  const dir = path.join(os.tmpdir(), `macusanite-${name}-${process.pid}-${counter++}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const readFile = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const exists = (root, rel) => fs.existsSync(path.join(root, rel));

/* ── paths ─────────────────────────────────────────────────────────────── */

test('paths cannot leave the vault and meta names stay flat', () => {
  assert.equal(safePath('Chambers//Lab/./Methods.md'), 'Chambers/Lab/Methods.md');
  assert.equal(safePath('a\\b\\c.md'), 'a/b/c.md');
  assert.throws(() => safePath('../outside.md'), VaultPathError);
  assert.throws(() => safePath('Chambers/../../outside.md'), VaultPathError);
  assert.throws(() => safePath('C:/Windows/system32/x.md'), VaultPathError);
  assert.throws(() => safePath(''), VaultPathError);

  assert.equal(safeMetaName('colors.json'), 'colors.json');
  assert.throws(() => safeMetaName('../evil.json'), VaultPathError);
  assert.throws(() => safeMetaName('nested/evil.json'), VaultPathError);
  assert.throws(() => safeMetaName(''), VaultPathError);
});

/* ── identity ──────────────────────────────────────────────────────────── */

test('opening a folder gives it an identity, once', async () => {
  const root = tempVault('identity');
  const store = await openVault(root);

  assert.ok(exists(root, '.macusanite/vault.json'));
  assert.ok(exists(root, '.macusanite/settings.json'));
  assert.ok(exists(root, '.macusanite/colors.json'));
  assert.ok(exists(root, '.macusanite/history.json'));
  assert.equal(store.root, path.resolve(root));

  const first = await store.info();
  assert.equal(first.name, path.basename(root), 'the folder name becomes the vault name');
  assert.equal(first.description, '');
  assert.ok(first.created);

  // Re-opening keeps the identity rather than restamping it.
  await new Promise((resolve) => setTimeout(resolve, 5));
  const again = await store.info();
  assert.equal(again.created, first.created);

  const named = await store.updateVaultMeta({ name: 'Field Notes', description: 'Macusani project' });
  assert.equal(named.name, 'Field Notes');
  assert.equal((await store.info()).description, 'Macusani project');
});

test('creating over an existing folder updates the identity instead of ignoring it', async () => {
  const root = tempVault('recreate');
  await openVault(root, { name: 'First' });
  const store = await openVault(root, { name: 'Second', description: 'renamed' });
  const info = await store.info();
  assert.equal(info.name, 'Second');
  assert.equal(info.description, 'renamed');
});

/* ── documents ─────────────────────────────────────────────────────────── */

test('veins round-trip, and writing records undo without a no-op', async () => {
  const root = tempVault('veins');
  const store = await openVault(root);

  const created = await store.createVein('Chambers/Lab/Analytical Methods', null);
  assert.equal(created.path, 'Chambers/Lab/Analytical Methods.md');
  assert.equal(created.created, true);
  assert.match(await store.readVein(created.path), /Analytical Methods/);

  const twice = await store.createVein('Chambers/Lab/Analytical Methods');
  assert.equal(twice.created, false, 'creating twice does not clobber');

  await store.writeVein(created.path, '# Methods\n\nSieve series.\n', { label: 'edit methods' });
  assert.equal(await store.readVein(created.path), '# Methods\n\nSieve series.\n');

  await store.writeVein(created.path, '# Methods\n\nSieve series.\n', { label: 'same again' });
  const history = await store.historyState();
  assert.equal(history.undo[0].label, 'edit methods');
  assert.equal(history.undo.length, 2, 'the no-op save never entered the stack');

  await assert.rejects(() => store.readVein('Nope.md'), /vein not found: Nope.md/);
  await assert.rejects(() => store.readVein('../escape.md'), VaultPathError);
});

test('append and upsertSection edit a vein without rewriting it by hand', async () => {
  const root = tempVault('edit');
  const store = await openVault(root);
  await store.createVein('Notes.md', '# Notes\n\nFirst paragraph.\n', { record: false });

  await store.appendVein('Notes.md', 'Appended line.\n');
  assert.match(await store.readVein('Notes.md'), /First paragraph\.\nAppended line\./);

  const added = await store.upsertSection('Notes.md', 'Sieve series', 'Sieves are stacked.');
  assert.equal(added.replaced, false);
  assert.match(await store.readVein('Notes.md'), /## Sieve series\n\nSieves are stacked\./);

  const replaced = await store.upsertSection('Notes.md', 'Sieve series', 'Five sieves.');
  assert.equal(replaced.replaced, true);
  const text = await store.readVein('Notes.md');
  assert.match(text, /## Sieve series\n\nFive sieves\./);
  assert.equal(text.includes('Sieves are stacked'), false, 'the old body is gone');
  assert.equal((text.match(/## Sieve series/g) ?? []).length, 1, 'no duplicate heading');
});

test('delete is undoable, and redo leaves an empty vein', async () => {
  const root = tempVault('delete');
  const store = await openVault(root);
  await store.createVein('Doomed.md', '# Doomed\n\nbody\n', { record: false });

  const removed = await store.deleteVein('Doomed.md');
  assert.equal(removed.deleted, true);
  assert.equal(exists(root, 'Doomed.md'), false);

  const undone = await store.undo();
  assert.equal(undone.applied, true);
  assert.equal(await store.readVein('Doomed.md'), '# Doomed\n\nbody\n');

  const redone = await store.redo();
  assert.equal(redone.applied, true);
  assert.equal(await store.readVein('Doomed.md'), '', 'redo re-creates the file empty, as documented');

  const missing = await store.deleteVein('Never Existed.md');
  assert.equal(missing.deleted, false);
});

test('rename moves the text and leaves two single-file undo steps', async () => {
  let root = tempVault('rename');
  const store = await openVault(root);
  await store.createVein('Old.md', '# Old\n\ncontent\n', { record: false });

  const moved = await store.renameVein('Old.md', 'Chambers/New');
  assert.equal(moved.path, 'Chambers/New.md');
  assert.equal(exists(root, 'Old.md'), false);
  assert.equal(await store.readVein('Chambers/New.md'), '# Old\n\ncontent\n');

  const stacks = await store.historyState();
  assert.equal(stacks.undo.length, 2, 'one entry for the new file, one for the old');

  // Undo twice puts the vault back exactly as it was.
  await store.undo();
  await store.undo();
  assert.equal(await store.readVein('Old.md'), '# Old\n\ncontent\n');
  assert.equal(exists(root, 'Chambers/New.md'), false);

  const same = await store.renameVein('Old.md', 'Old');
  assert.equal(same.moved, false, 'renaming a vein onto itself is a no-op');
  await store.createVein('Chambers/Taken.md', '# Taken\n', { record: false });
  await assert.rejects(() => store.renameVein('Old.md', 'Chambers/Taken'), /already exists/);
});

test('chambers exist even when they hold nothing', async () => {
  const root = tempVault('chambers');
  const store = await openVault(root);
  await store.createChamber('Chambers/Empty');

  const scan = await store.scan();
  assert.deepEqual(scan.chambers, ['Chambers', 'Chambers/Empty']);

  const tree = await store.tree();
  const chambers = tree.find((node) => node.name === 'Chambers');
  const empty = chambers.children.find((node) => node.name === 'Empty');
  assert.equal(empty.kind, 'chamber');
  assert.deepEqual(empty.children, [], 'the .keep marker never shows up as a vein');
});

/* ── history ───────────────────────────────────────────────────────────── */

test('undo and redo walk the stack newest-first and clear the branch on a new edit', async () => {
  const root = tempVault('history');
  const store = await openVault(root);
  await store.createVein('A.md', 'one\n', { record: true });

  await store.writeVein('A.md', 'two\n', { label: 'edit A' });
  assert.equal((await store.historyState()).undo[0].label, 'edit A');

  await store.undo();
  assert.equal(await store.readVein('A.md'), 'one\n');
  assert.equal((await store.historyState()).redo.length, 1);

  await store.writeVein('A.md', 'three\n', { label: 'edit again' });
  assert.equal((await store.historyState()).redo.length, 0, 'a new change clears redo');
});

test('viewer state and the index cache stay out of the undo stack', async () => {
  const root = tempVault('bookkeeping');
  const store = await openVault(root);
  await store.writeState({ lastPath: 'Home.md', ui: { pane: 'tree' } });
  await store.buildIndex();

  assert.equal((await store.historyState()).undo.length, 0);
  assert.equal((await store.readState()).lastPath, 'Home.md');
  assert.ok(exists(root, '.macusanite/index.json'));
});

/* ── index, search, graph ──────────────────────────────────────────────── */

test('the document index is cached, reused, and written back for the window', async () => {
  const root = tempVault('index');
  const store = await openVault(root);
  await store.createVein('Home.md', '# Home\n\nSee [[Chambers/Lab/Methods]].\n', { record: false });
  await store.createVein('Chambers/Lab/Methods.md', '---\ntags: [lab]\n---\n\n# Methods\n\n## Sieve series\n\nStacked sieves.\n', { record: false });

  const first = await store.buildIndex();
  assert.equal(first.cached, 0, 'a cold index reads every vein');
  const cache = JSON.parse(readFile(root, '.macusanite/index.json'));
  assert.deepEqual(Object.keys(cache.entries).sort(), ['Chambers/Lab/Methods.md', 'Home.md']);
  assert.equal(cache.entries['Home.md'].entry.links.length, 1);

  // A second store — the next CLI run — reuses everything that has not moved.
  const second = await openVault(root);
  const warm = await second.buildIndex();
  assert.equal(warm.cached, 2);
  assert.equal(warm.index.find((doc) => doc.path === 'Chambers/Lab/Methods.md').tags.includes('lab'), true);

  // Touch one vein: only that one is re-read.
  await new Promise((resolve) => setTimeout(resolve, 10));
  await second.writeVein('Home.md', '# Home\n\nEdited.\n', { label: 'edit Home' });
  const third = await openVault(root);
  const before = await third.indexCacheStatus();
  assert.equal(before.stale, 1, 'the edited vein is the only stale entry');
  assert.equal(before.fresh, 1);

  const stale = await third.buildIndex();
  assert.equal(stale.cached, 1, 'the untouched vein still comes from the cache');
  assert.equal((await third.indexCacheStatus()).stale, 0, 'the read refreshes the cache');
});

test('search ranks like the search pane and reports why each vein matched', async () => {
  const root = tempVault('search');
  const store = await openVault(root);
  await store.createVein('Chambers/Lab/Analytical Methods.md',
    '---\ntags: [lab]\n---\n\n# Analytical Methods\n\n## Sieve series\n\nThe sieve series is stacked and weighed. See [[Home]].\n', { record: false });
  await store.createVein('Home.md', '# Home\n\nA note about sieves and the sieve series.\n', { record: false });
  await store.createVein('Other.md', '# Other\n\nNothing to see.\n', { record: false });

  const found = await store.search('sieve series');
  assert.equal(found.total, 2);
  assert.equal(found.results[0].path, 'Chambers/Lab/Analytical Methods.md', 'the heading match outranks the body match');
  assert.equal(found.results[0].headings.includes('Sieve series'), true);
  assert.match(found.results[0].snippet, /sieve/i);

  const phrase = await store.search('"sieve series"');
  assert.equal(phrase.total, 2);

  const nothing = await store.search('zzzznothing');
  assert.equal(nothing.total, 0);
  assert.deepEqual(nothing.results, []);
});

test('document reports headings, links, tags and colours', async () => {
  const root = tempVault('document');
  const store = await openVault(root);
  await store.createVein('Cesium.md',
    '---\ntitle: Cesium Enrichment\ntags: [petrology]\ncolor: \'#da70d6\'\n---\n\n# Cesium\n\n## Glass\n\nSee [[Fluid Inclusions#Method]] and #fieldwork.\n', { record: false });

  const doc = await store.document('Cesium.md');
  assert.equal(doc.title, 'Cesium Enrichment');
  assert.deepEqual(doc.tags.sort(), ['fieldwork', 'petrology']);
  assert.equal(doc.color, '#da70d6');
  assert.deepEqual(doc.headings.map((h) => h.text), ['Cesium', 'Glass']);
  assert.equal(doc.links[0].target, 'Fluid Inclusions');
  assert.equal(doc.links[0].section, 'Method');
  assert.ok(doc.words > 5);

  const links = await store.links('Cesium.md');
  assert.equal(links.length, 1);
});

test('ghosts, backlinks, tags and stats describe the whole vault', async () => {
  const root = tempVault('graph');
  const store = await openVault(root);
  await store.createVein('Home.md', '# Home\n\nSee [[Chambers/Lab/Methods]] and [[Not Written Yet]].\n', { record: false });
  await store.createVein('Chambers/Lab/Methods.md', '---\ntags: [lab]\n---\n\n# Methods\n\nSee [[Home]].\n', { record: false });
  await store.createVein('Orphan.md', '# Orphan\n\nNobody links here.\n', { record: false });

  const ghosts = await store.ghosts();
  assert.equal(ghosts.length, 1);
  assert.equal(ghosts[0].target, 'Not Written Yet');
  assert.equal(ghosts[0].suggestedPath, 'Not Written Yet.md');

  const back = await store.backlinks('Chambers/Lab/Methods.md');
  assert.deepEqual(back.map((entry) => entry.path), ['Home.md']);

  const tags = await store.tags();
  assert.deepEqual(tags.map((entry) => entry.tag), ['lab']);
  assert.equal(tags[0].count, 1);

  const stats = await store.stats();
  assert.equal(stats.veins, 3);
  assert.equal(stats.chambers, 2, 'Chambers and its nested Lab, like the Rust walk reports');
  assert.equal(stats.ghosts, 1);
  assert.equal(stats.orphans, 1, 'Orphan.md links nowhere and nothing links to it');
  assert.equal(stats.tags, 1);
  assert.ok(stats.bytes > 0);
  // Written last, and genuinely older files do not win the tie.
  await new Promise((resolve) => setTimeout(resolve, 12));
  await store.writeVein('Orphan.md', '# Orphan\n\nNobody links here. Touched last.\n', { label: 'edit Orphan' });
  assert.equal((await store.stats()).newest.path, 'Orphan.md');

  const resolved = await store.resolveLink('Chambers/Lab/Methods');
  assert.equal(resolved.ok, true);
  assert.equal(resolved.path, 'Chambers/Lab/Methods.md');
  const missing = await store.resolveLink('Not Written Yet');
  assert.equal(missing.ok, false);
  assert.equal(missing.ghost, true);

  const graph = await store.graph({ focus: 'Home.md' });
  assert.ok(graph.stats.nodes >= 3);
  assert.ok(graph.nodes.some((node) => node.kind === 'concept'));
  assert.ok(graph.edges.some((edge) => edge.kind === 'link'));
});

/* ── colours, settings, logs ───────────────────────────────────────────── */

test('colours assign, clear and resolve through the store', async () => {
  const root = tempVault('colors');
  const store = await openVault(root);
  await store.createVein('Home.md', '# Home\n', { record: false });

  const set = await store.setColor('page', { path: 'Home.md' }, 'gold');
  assert.equal(set.color, '#ffd700');
  assert.equal(await store.resolveColor('page', { path: 'Home.md' }), '#ffd700');

  const cleared = await store.clearColor('page', { path: 'Home.md' });
  assert.equal(cleared.key, 'Home.md');
  assert.equal(await store.resolveColor('page', { path: 'Home.md' }), '#ffffff');

  await store.setColor('concept', { name: 'Not Written Yet' }, '#da70d6');
  const colors = await store.readColors();
  assert.equal(colors.concepts['not written yet'], '#da70d6');

  await store.resetColors();
  assert.deepEqual(await store.readColors(), { pages: {}, sections: {}, links: {}, concepts: {} });
  await assert.rejects(() => store.setColor('nonsense', {}, '#fff'), /unknown colour kind/);
});

test('settings merge with the defaults and are recorded', async () => {
  const root = tempVault('settings');
  const store = await openVault(root);
  const defaults = await store.readSettings();
  assert.equal(defaults.theme, 'dark');
  assert.equal(defaults.fontSize, 16);

  const updated = await store.updateSettings({ theme: 'light', fontSize: 21, nonsense: true });
  assert.equal(updated.theme, 'light');
  assert.equal(updated.fontSize, 21);
  assert.equal('nonsense' in updated, false, 'unknown keys are dropped');
  assert.equal((await store.historyState()).undo[0].label, 'settings');
  assert.equal(JSON.parse(readFile(root, '.macusanite/settings.json')).fontSize, 21);
});

test('log lines land in the day file with the Rust core’s shape', async () => {
  const root = tempVault('logs');
  const store = await openVault(root);
  await store.appendLog('info', 'hello from the CLI');
  await store.appendLog('warn', 'and again');

  const file = `.macusanite/logs/session-${dayStamp()}.log`;
  assert.ok(exists(root, file));
  const lines = readFile(root, file).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].level, 'info');
  assert.equal(lines[1].message, 'and again');
  assert.match(lines[0].ts, /^\d{4}-\d{2}-\d{2}T/);

  const logs = await store.logs({ limit: 10 });
  assert.equal(logs.length, 2);
  assert.equal(logs.at(-1).message, 'and again');
  assert.equal((await store.historyState()).undo.length, 0, 'logs never enter the stack');
});

test('meta files round-trip verbatim, and unknown names are refused', async () => {
  const root = tempVault('meta');
  const store = await openVault(root);
  await store.writeMeta('colors.json', '{"pages":{}}', { label: 'colour change' });
  assert.equal(await store.readMeta('colors.json'), '{"pages":{}}');
  assert.equal((await store.historyState()).undo[0].path, '.macusanite/colors.json');
  await assert.rejects(() => store.readMeta('../outside.json'), VaultPathError);
  assert.equal(await store.readMeta('nothing.json'), null);
});

/* ── the whole thing, on the sample vault ──────────────────────────────── */

test('the sample vault seeds with the CLI and is then fully drivable', async () => {
  const root = tempVault('sample');
  // Seeding comes first, so the sample's own identity is what gets written.
  const store = await openVault(root, { create: true, ensure: false });
  const written = await seedSampleVault(store);
  assert.equal(written.length, 10, 'seven veins and three meta files');
  await store.ensureMeta();

  const info = await store.info();
  assert.equal(info.name, 'Macusanite Sample Vault');
  assert.match(info.description, /Macusani/);

  const stats = await store.stats();
  assert.equal(stats.veins, 7);
  assert.equal(stats.chambers, 4);

  const found = await store.search('sieve');
  assert.ok(found.total >= 1);
  assert.equal(found.results[0].path, 'Chambers/Lab/Analytical Methods.md');

  // Seeding twice does not duplicate or overwrite.
  const again = await seedSampleVault(store);
  assert.deepEqual(again, []);
});

test('the adapter refuses to write outside the vault it was given', async () => {
  const root = tempVault('escape');
  const outside = path.join(path.dirname(root), 'escaped.md');
  fs.rmSync(outside, { force: true });

  const adapter = createNodeVaultFs(root);
  await assert.rejects(() => adapter.write('../escaped.md', 'nope'), /escapes the vault/);
  await assert.rejects(() => adapter.read('../../secrets.md'), /escapes the vault/);
  assert.equal(fs.existsSync(outside), false);

  await adapter.write('inside.md', 'yes');
  assert.equal(fs.readFileSync(path.join(root, 'inside.md'), 'utf8'), 'yes');
  assert.equal((await adapter.stat('nothing.md')), null);
  await adapter.remove('nothing.md'); // a missing file is not an error
});

test('a vault store exposes the same files the window expects', async () => {
  const root = tempVault('layout');
  const store = await openVault(root);
  await store.createVein('Home.md', '# Home\n', { record: false });
  await store.buildIndex();
  const files = (await store.listFiles()).map((file) => file.path).sort();
  for (const expected of ['.macusanite/colors.json', '.macusanite/history.json', '.macusanite/index.json', '.macusanite/settings.json', '.macusanite/vault.json', 'Home.md']) {
    assert.ok(files.includes(expected), `${expected} should be on disk`);
  }
});
