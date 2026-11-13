import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createVaultApi } from '../../src/lib/api.js';
import { openVault } from '../../cli/vaultFs.js';
import { createTar, parseTar } from '../../src/lib/tar.js';
import {
  VAULT_ARCHIVE_HISTORY,
  VAULT_ARCHIVE_MANIFEST,
  createVaultArchive,
  parseVaultArchive,
  planVaultImport,
  validateVaultArchiveEntries,
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

  const targetApi = createVaultApi({
    store: await openVault(targetRoot),
    root: targetRoot,
    readBinaryFile: async (target) => memory.get(target),
  });
  const imported = await targetApi.dispatch('vault.import', { path: archivePath, overwrite: true });
  assert.ok(imported.added.includes('Home.md'));
  assert.equal(fs.readFileSync(path.join(targetRoot, 'Home.md'), 'utf8'), '# Home\n');
  assert.ok(fs.existsSync(path.join(targetRoot, '.macusanite/history.json')));

  fs.writeFileSync(path.join(targetRoot, 'Home.md'), '# Changed\n');
  await assert.rejects(() => targetApi.dispatch('vault.import', { path: archivePath }), /overwrite-required|--overwrite/);
  const confirmed = await targetApi.dispatch('vault.import', { path: archivePath, overwrite: true });
  assert.deepEqual(confirmed.conflicts, ['Home.md']);
  assert.equal(fs.readFileSync(path.join(targetRoot, 'Home.md'), 'utf8'), '# Home\n');
});
