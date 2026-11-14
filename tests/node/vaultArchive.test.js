import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createVaultApi } from '../../src/lib/api.js';
import { sampleVaultFiles, SAMPLE_VAULT_NAME } from '../../src/lib/fixtures.js';
import { openVault } from '../../cli/vaultFs.js';
import { createVaultStore } from '../../src/lib/vaultStore.js';
import { createTar, parseTar } from '../../src/lib/tar.js';
import {
  VAULT_ARCHIVE_HISTORY,
  VAULT_ARCHIVE_MANIFEST,
  collectVaultArchiveFiles,
  createVaultArchive,
  parseVaultArchive,
  planVaultImport,
  validateVaultArchiveEntries,
  isBinaryBytes,
  strictText,
} from '../../src/lib/vaultArchive.js';

const decoder = new TextDecoder();

function sourceFiles() {
  return [
    { path: '.macusanite/vault.json', data: '{\n  "name": "Archive Notes"\n}\n', mtime: 1_700_000_000_000 },
    { path: '.macusanite/history.json', data: JSON.stringify({ undo: [{ label: 'Rename' }], redo: [] }), mtime: 1_700_000_001_000 },
    { path: 'Home.md', data: '# Home\n\n[[Lab]]\n', mtime: 1_700_000_002_000 },
    { path: 'Chambers/Lab.md', data: '# Lab\n', mtime: 1_700_000_003_000 },
  ];
}

test('tar round-trips entries exactly', () => {
  const entries = parseTar(createTar(sourceFiles()));
  assert.deepEqual(entries.map((entry) => entry.path), sourceFiles().map((file) => file.path));
  for (const [index, source] of sourceFiles().entries()) {
    assert.equal(decoder.decode(entries[index].data), source.data);
    assert.equal(entries[index].mtime, source.mtime);
  }
});

test('tar parsing rejects a truncated archive', () => {
  const bytes = createTar(sourceFiles());
  assert.throws(() => parseTar(bytes.slice(0, 700)), /truncated|invalid/);
});

test('a vault archive round-trips files, manifest and history', async () => {
  const bytes = await createVaultArchive(sourceFiles(), {
    vaultName: 'Archive Notes',
    exportedAt: '2026-11-13T00:00:00.000Z',
  });
  assert.deepEqual([...bytes.slice(0, 2)], [0x1f, 0x8b], 'gzip magic');
  const parsed = await parseVaultArchive(bytes);
  assert.equal(parsed.manifest.vaultName, 'Archive Notes');
  assert.equal(parsed.manifest.fileCount, sourceFiles().length);
  assert.deepEqual(parsed.manifest.history, { undo: 1, redo: 0 });
  assert.deepEqual(parsed.files.map((file) => file.path), sourceFiles().map((file) => file.path));
  for (const [index, source] of sourceFiles().entries()) {
    assert.equal(decoder.decode(parsed.files[index].data), source.data);
  }
});

test('archive validation rejects an unlisted file, a missing file and a bad size', () => {
  const manifest = {
    format: 'macusanite-vault-archive',
    version: 1,
    files: [
      { path: VAULT_ARCHIVE_HISTORY, size: 20 },
      { path: 'Home.md', size: 7 },
    ],
  };
  const entries = [
    { path: VAULT_ARCHIVE_MANIFEST, data: JSON.stringify(manifest) },
    { path: VAULT_ARCHIVE_HISTORY, data: 'x'.repeat(20) },
    { path: 'Home.md', data: '# Home\n' },
    { path: 'Extra.md', data: '# Extra\n' },
  ];
  assert.throws(() => validateVaultArchiveEntries(entries), /not listed/);
  const missing = entries.filter((entry) => entry.path !== 'Home.md');
  assert.throws(() => validateVaultArchiveEntries(missing), /missing listed file/);
  const badSize = entries.map((entry) => entry.path === 'Home.md' ? { ...entry, data: '# Longer\n' } : entry)
    .filter((entry) => entry.path !== 'Extra.md');
  assert.throws(() => validateVaultArchiveEntries(badSize), /size mismatch/);
});

test('archive validation refuses unsafe paths and archives without history', () => {
  const base = [
    { path: VAULT_ARCHIVE_MANIFEST, data: JSON.stringify({ format: 'macusanite-vault-archive', version: 1, files: [] }) },
    { path: '../escape.md', data: '# Escape\n' },
  ];
  assert.throws(() => validateVaultArchiveEntries(base), /invalid archive path/);
  const noHistory = [
    { path: VAULT_ARCHIVE_MANIFEST, data: JSON.stringify({ format: 'macusanite-vault-archive', version: 1, files: [{ path: 'Home.md', size: 7 }] }) },
    { path: 'Home.md', data: '# Home\n' },
  ];
  assert.throws(() => validateVaultArchiveEntries(noHistory), /missing undo\/redo history/);
});

test('import planning separates added, updated/conflicting and unchanged files', () => {
  const plan = planVaultImport([
    { path: 'Home.md', text: '# Old\n' },
    { path: 'Chambers/Lab.md', text: '# Lab\n' },
    { path: 'Untouched.md', text: '# Untouched\n' },
  ], [
    { path: 'Home.md', data: '# New\n' },
    { path: 'Chambers/Lab.md', data: '# Lab\n' },
    { path: 'New.md', data: '# New\n' },
  ]);
  assert.deepEqual(plan.conflicts, ['Home.md']);
  assert.deepEqual(plan.added, ['New.md']);
  assert.deepEqual(plan.updated, ['Home.md']);
  assert.deepEqual(plan.unchanged, ['Chambers/Lab.md']);
  assert.deepEqual(plan.writes.map((write) => write.path), ['Home.md', 'New.md']);
  assert.deepEqual(plan.deletions, [], 'update-only plans no deletions');
});

test('replace planning names local files missing from the archive, never .git', () => {
  const plan = planVaultImport([
    { path: 'Home.md', text: '# Home\n' },
    { path: 'Stale.md', text: '# Gone\n' },
    { path: '.macusanite/state.json', text: '{}' },
    { path: '.git/config', text: 'git' },
  ], [
    { path: 'Home.md', data: '# New\n' },
  ], { replace: true });
  assert.deepEqual(plan.deletions, ['.macusanite/state.json', 'Stale.md']);
  assert.deepEqual(plan.conflicts, ['Home.md']);
});

test('the committed sample archive is the sample vault, and imports back end to end', async () => {
  const bytes = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'reference-vault.tar.gz'));
  const parsed = await parseVaultArchive(bytes);
  assert.equal(parsed.manifest.vaultName, SAMPLE_VAULT_NAME);
  const byPath = new Map(parsed.files.map((file) => [file.path, decoder.decode(file.data)]));
  for (const [rel, contents] of Object.entries(sampleVaultFiles())) {
    assert.equal(byPath.get(rel), contents, `archive carries ${rel} verbatim`);
  }
  assert.deepEqual(JSON.parse(byPath.get(VAULT_ARCHIVE_HISTORY)), { version: 1, undo: [], redo: [] });

  // Import into an empty folder: every file lands, and the vault opens with
  // the sample's veins and its canvas record in state.json.
  const plan = planVaultImport([], parsed.files);
  assert.deepEqual(plan.conflicts, []);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'macusanite-sample-import-'));
  for (const write of plan.writes) {
    const target = path.join(root, write.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, write.text);
  }
  const store = await openVault(root);
  const scan = await store.scan();
  assert.ok(scan.veins.includes('Home.md'));
  assert.equal(scan.veins.length, 7, 'the seven sample veins');
  const state = JSON.parse(await store.readMeta('state.json'));
  assert.equal(state.world['Home.md'].marked, true, 'the canvas record travelled with the archive');
  assert.deepEqual((await store.historyState()).undo, [], 'the empty history travelled too');
});

test('vault.export and vault.import move files and history between vaults, with overwrite confirmation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'macusanite-archive-'));
  const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'macusanite-archive-target-'));
  const archivePath = path.join(root, '..', `macusanite-${process.pid}.tar.gz`);
  const memory = new Map();
  const api = createVaultApi({
    store: await openVault(root),
    root,
    readBinaryFile: async (target) => memory.get(target) ?? fs.readFileSync(target),
    writeBinaryFile: async (target, bytes) => {
      memory.set(target, bytes);
      return { path: target, bytes: bytes.length };
    },
  });
  await api.dispatch('vein.create', { path: 'Home.md', text: '# Home\n' });
  const exported = await api.dispatch('vault.export', { path: archivePath });
  assert.ok(exported.files >= 3);
  assert.equal(memory.has(archivePath), true);

  let archiveReads = 0;
  const targetApi = createVaultApi({
    store: await openVault(targetRoot),
    root: targetRoot,
    readBinaryFile: async (target) => {
      archiveReads += 1;
      return memory.get(target);
    },
  });
  const imported = await targetApi.dispatch('vault.import', { path: archivePath, overwrite: true });
  assert.equal(archiveReads, 1, 'the confirmed import reads and parses the archive once');
  assert.ok(imported.added.includes('Home.md'));
  assert.equal(fs.readFileSync(path.join(targetRoot, 'Home.md'), 'utf8'), '# Home\n');
  assert.ok(fs.existsSync(path.join(targetRoot, '.macusanite/history.json')));

  fs.writeFileSync(path.join(targetRoot, 'Home.md'), '# Changed\n');
  archiveReads = 0;
  await assert.rejects(() => targetApi.dispatch('vault.import', { path: archivePath }), /overwrite-required|--overwrite/);
  assert.equal(archiveReads, 1, 'a refused import still reads the archive only once');
  archiveReads = 0;
  const confirmed = await targetApi.dispatch('vault.import', { path: archivePath, overwrite: true });
  assert.equal(archiveReads, 1, 'the overwrite confirmation does not re-read the archive');
  assert.deepEqual(confirmed.conflicts, ['Home.md']);
  assert.equal(fs.readFileSync(path.join(targetRoot, 'Home.md'), 'utf8'), '# Home\n');
});

test('a binary vault file survives an export/import round trip byte-for-byte', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'macusanite-binary-src-'));
  const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'macusanite-binary-dst-'));
  const archivePath = path.join(root, '..', `macusanite-binary-${process.pid}.tar.gz`);
  const binary = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xfe, 0x80]);
  assert.equal(isBinaryBytes(binary), true);
  assert.equal(strictText(binary), undefined);
  fs.writeFileSync(path.join(root, 'photo.bin'), binary);
  const memory = new Map();
  const api = createVaultApi({
    store: await openVault(root),
    root,
    readBinaryFile: async (target) => memory.get(target) ?? fs.readFileSync(target),
    writeBinaryFile: async (target, bytes) => {
      memory.set(target, bytes);
      return { path: target, bytes: bytes.length };
    },
  });
  await api.dispatch('vein.create', { path: 'Home.md', text: '# Home\n' });
  await api.dispatch('vault.export', { path: archivePath });

  const targetApi = createVaultApi({
    store: await openVault(targetRoot),
    root: targetRoot,
    readBinaryFile: async (target) => memory.get(target),
  });
  const imported = await targetApi.dispatch('vault.import', { path: archivePath, overwrite: true });
  assert.ok(imported.added.includes('photo.bin'));
  assert.deepEqual(new Uint8Array(fs.readFileSync(path.join(targetRoot, 'photo.bin'))), binary);
});

test('the shared archive collector carries non-text files byte-for-byte and skips .git', async () => {
  const binary = new Uint8Array([0x00, 0xff, 0x89, 0x50, 0x4e, 0x47, 0x7f]);
  const store = {
    listFiles: async () => [
      { path: 'Home.md', mtime: 1 },
      { path: '.macusanite/history.json', mtime: 4 },
      { path: '.macusanite/node-files/scan.pdf', mtime: 2 },
      { path: '.git/config', mtime: 3 },
    ],
    readFileBytes: async (target) => target === '.macusanite/node-files/scan.pdf'
      ? binary
      : new TextEncoder().encode(target.endsWith('history.json') ? '{"undo":[],"redo":[]}' : '# Home\n'),
  };
  const files = await collectVaultArchiveFiles(store);
  assert.deepEqual(files.map((file) => file.path), ['.macusanite/history.json', '.macusanite/node-files/scan.pdf', 'Home.md']);
  assert.deepEqual(files[1].data, binary);

  const archive = await parseVaultArchive(await createVaultArchive(files, { vaultName: 'Window export' }));
  assert.deepEqual(archive.files.find((file) => file.path === '.macusanite/node-files/scan.pdf').data, binary);
  assert.equal(archive.files.some((file) => file.path.startsWith('.git/')), false);
});

test('a text-only session refuses binary data clearly instead of corrupting it', async () => {
  const mem = new Map();
  const textFs = {
    list: async () => [...mem.keys()].map((p) => ({ path: p, mtime: 0, size: mem.get(p).length })),
    read: async (p) => mem.get(p) ?? null,
    write: async (p, t) => mem.set(p, String(t)),
    append: async () => {},
    remove: async (p) => mem.delete(p),
    stat: async () => null,
  };
  const store = createVaultStore({ fs: textFs, root: '/mem' });
  assert.equal(store.canWriteFileBytes, false);
  await assert.rejects(() => store.writeFileBytes('a.bin', new Uint8Array([0xff, 0x00])), /binary file.*refusing instead/);
  assert.equal(mem.has('a.bin'), false, 'nothing was written');
  await store.writeFileBytes('a.md', new TextEncoder().encode('# Hi\n'));
  assert.equal(mem.get('a.md'), '# Hi\n', 'text still writes fine');
  // Byte comparison: one differing byte is a conflict, not unchanged.
  const plan = planVaultImport(
    [{ path: 'a.bin', bytes: new Uint8Array([0xff, 0x00]) }],
    [{ path: 'a.bin', data: new Uint8Array([0xff, 0x01]) }],
  );
  assert.deepEqual(plan.conflicts, ['a.bin']);
  assert.equal(plan.writes[0].text, undefined, 'binary writes carry bytes, not text');
});
