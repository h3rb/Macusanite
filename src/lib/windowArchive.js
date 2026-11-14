/**
 * The window's vault-store adapter for Export and Import vault.
 *
 * It sits on the backend the window already talks to. Listing is the whole
 * vault — hidden folders included, `.git` excepted — and reads are always
 * byte-for-byte through the Rust commands, so a non-text file (an image, a PDF,
 * an attachment) is carried into the archive instead of being decoded as text
 * and dropped. Import writes through the unrecorded byte path; the browser
 * fallback has no byte writer, so its text-only refusal remains in place.
 */

import { createVaultStore } from './vaultStore.js';

const decodeText = (bytes) => new TextDecoder().decode(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));

export function createWindowArchiveStore({ backend, isDesktop, root = '' }) {
  const fs = {
    async list() {
      const rows = await backend.listVaultFiles();
      return rows.filter((file) => file.path !== '.git' && !file.path.startsWith('.git/'));
    },
    async read(path) {
      const bytes = await backend.readVaultFileBytes(path);
      return bytes === null ? null : decodeText(bytes);
    },
    async readBytes(path) {
      return backend.readVaultFileBytes(path);
    },
    async write(path, text) {
      if (isDesktop) await backend.writeVaultFileBytes(path, new TextEncoder().encode(String(text)));
      else await backend.writeVaultFile(path, String(text));
    },
    async append() {
      throw new Error('archive imports do not append');
    },
    async remove(path) {
      await backend.removeVaultFile(path);
    },
    async stat() {
      return null;
    },
    async mkdir() {
      /* writes create chambers */
    },
  };
  // A real byte writer lets Import carry binary files too; the browser's
  // in-memory vault only holds text, so its import keeps the binary refusal.
  if (isDesktop) {
    fs.writeBytes = async (path, bytes) => backend.writeVaultFileBytes(path, bytes);
  }
  return createVaultStore({ fs, root });
}
