import assert from 'node:assert/strict';
import test from 'node:test';
import { createWindowArchiveStore } from '../../src/lib/windowArchive.js';
import {
  collectVaultArchiveFiles,
  createVaultArchive,
  parseVaultArchive,
} from '../../src/lib/vaultArchive.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

test('the desktop window archive store carries non-text files byte-for-byte', async () => {
  const binary = new Uint8Array([0x00, 0xff, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xfe]);
  const backend = {
    listVaultFiles: async () => [
      { path: 'Home.md', mtime: 1, size: 7 },
      { path: '.macusanite/history.json', mtime: 2, size: 24 },
      { path: '.macusanite/node-files/scan.pdf', mtime: 3, size: binary.length },
      { path: '.git/config', mtime: 4, size: 6 },
    ],
    readVaultFileBytes: async (path) => {
      if (path === '.macusanite/node-files/scan.pdf') return binary;
      if (path === '.macusanite/history.json') return encoder.encode('{"undo":[],"redo":[]}');
      if (path === 'Home.md') return encoder.encode('# Home\n');
      return null;
    },
  };

  const store = createWindowArchiveStore({ backend, isDesktop: true, root: '/window-vault' });
  assert.equal(store.canWriteFileBytes, true, 'the desktop import path has a byte writer');
  const files = await collectVaultArchiveFiles(store);
  assert.deepEqual(
    files.map((file) => file.path),
    ['.macusanite/history.json', '.macusanite/node-files/scan.pdf', 'Home.md'],
    '.git is skipped and every other file, hidden or not, is carried',
  );
  assert.deepEqual(files[1].data, binary, 'the PDF is read as bytes, not decoded text');

  const archive = await parseVaultArchive(await createVaultArchive(files, { vaultName: 'Window' }));
  const carried = archive.files.find((file) => file.path === '.macusanite/node-files/scan.pdf');
  assert.deepEqual(carried.data, binary, 'the non-text file survives archive creation byte-for-byte');
  assert.equal(decoder.decode(archive.files.find((file) => file.path === 'Home.md').data), '# Home\n');
});
