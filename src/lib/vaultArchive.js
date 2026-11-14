/**
 * Portable vault archives: one gzipped tarball carrying a vault's files and
 * its undo/redo history.
 *
 * The archive is a tar containing the vault files at their vault-relative
 * paths plus `macusanite-archive.json`, a manifest naming every file and
 * recording how much history travelled with it. Import is deliberately
 * conservative: paths must stay inside the vault, the manifest must cover
 * the archive exactly, and any existing file whose contents would change is
 * reported as a conflict for the caller to confirm before overwriting.
 */
import { createTar, parseTar } from './tar.js';

export const VAULT_ARCHIVE_FORMAT = 'macusanite-vault-archive';
export const VAULT_ARCHIVE_VERSION = 1;
export const VAULT_ARCHIVE_MANIFEST = 'macusanite-archive.json';
export const VAULT_ARCHIVE_HISTORY = '.macusanite/history.json';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class VaultArchiveError extends Error {
  constructor(message) {
    super(message);
    this.name = 'VaultArchiveError';
  }
}

function toBytes(data) {
  if (typeof data === 'string') return encoder.encode(data);
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw new VaultArchiveError('archive data must be bytes or text');
}

export function safeArchivePath(rel) {
  const cleaned = String(rel ?? '').replace(/\\/g, '/');
  if (!cleaned || cleaned.startsWith('/') || /^[A-Za-z]:/.test(cleaned)) {
    throw new VaultArchiveError(`invalid archive path: ${rel}`);
  }
  const parts = [];
  for (const part of cleaned.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..' || part.includes('\0')) throw new VaultArchiveError(`invalid archive path: ${rel}`);
    if (part === '.git') throw new VaultArchiveError(`archive must not contain .git: ${rel}`);
    parts.push(part);
  }
  if (!parts.length) throw new VaultArchiveError(`invalid archive path: ${rel}`);
  return parts.join('/');
}

function historyCounts(files) {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const raw = byPath.get(VAULT_ARCHIVE_HISTORY);
  if (!raw) return { undo: 0, redo: 0 };
  try {
    const parsed = JSON.parse(decoder.decode(toBytes(raw.data)));
    return {
      undo: Array.isArray(parsed?.undo) ? parsed.undo.length : 0,
      redo: Array.isArray(parsed?.redo) ? parsed.redo.length : 0,
    };
  } catch {
    return { undo: 0, redo: 0 };
  }
}

export function createVaultArchiveManifest({ vaultName = null, exportedAt = null, files = [] } = {}) {
  const normalized = files.map((file) => {
    const path = safeArchivePath(file.path);
    const data = toBytes(file.data);
    return { path, size: data.length };
  });
  return {
    format: VAULT_ARCHIVE_FORMAT,
    version: VAULT_ARCHIVE_VERSION,
    exportedAt: exportedAt ?? new Date().toISOString(),
    vaultName: vaultName ?? null,
    fileCount: normalized.length,
    history: historyCounts(files),
    files: normalized,
  };
}

/**
 * Collect every file an archive should carry, read as bytes.
 *
 * This is the one walk used by both the CLI's `vault.export` and the window's
 * Export vault. It keeps non-text files (images, PDFs, attachments) intact
 * byte-for-byte, skips `.git`, and never decodes a file as UTF-8. A file that
 * disappears mid-walk is left out; a file that cannot be read still throws, so
 * an export cannot quietly turn into a partial archive.
 *
 * @param {object} vault a store with `listFiles` and `readFileBytes`
 * @returns {Promise<Array<{path: string, data: Uint8Array, mtime: number}>>}
 */
export async function collectVaultArchiveFiles(vault) {
  const files = [];
  for (const file of await vault.listFiles()) {
    if (file.path === '.git' || String(file.path ?? '').startsWith('.git/')) continue;
    const data = await vault.readFileBytes(file.path);
    if (data !== null) files.push({ path: file.path, data, mtime: file.mtime ?? 0 });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

export function validateVaultArchiveEntries(entries) {
  if (!Array.isArray(entries) || !entries.length) throw new VaultArchiveError('archive is empty');
  const byPath = new Map();
  for (const entry of entries) {
    const path = safeArchivePath(entry?.path);
    if (byPath.has(path)) throw new VaultArchiveError(`duplicate archive path: ${path}`);
    byPath.set(path, { path, data: toBytes(entry.data), mtime: entry.mtime ?? 0 });
  }
  const manifestEntry = byPath.get(VAULT_ARCHIVE_MANIFEST);
  if (!manifestEntry) throw new VaultArchiveError(`archive is missing ${VAULT_ARCHIVE_MANIFEST}`);
  let manifest;
  try {
    manifest = JSON.parse(decoder.decode(manifestEntry.data));
  } catch {
    throw new VaultArchiveError('archive manifest is not valid JSON');
  }
  if (manifest?.format !== VAULT_ARCHIVE_FORMAT) throw new VaultArchiveError('not a Macusanite vault archive');
  if (manifest.version !== VAULT_ARCHIVE_VERSION) throw new VaultArchiveError(`unsupported archive version: ${manifest.version}`);
  if (!Array.isArray(manifest.files)) throw new VaultArchiveError('archive manifest has no file list');
  const listed = new Map();
  for (const file of manifest.files) {
    const path = safeArchivePath(file?.path);
    if (listed.has(path)) throw new VaultArchiveError(`duplicate archive path in manifest: ${path}`);
    listed.set(path, file);
  }
  for (const [path, file] of listed) {
    const entry = byPath.get(path);
    if (!entry) throw new VaultArchiveError(`archive is missing listed file: ${path}`);
    if (file.size !== entry.data.length) throw new VaultArchiveError(`archive size mismatch for ${path}`);
  }
  for (const path of byPath.keys()) {
    if (path !== VAULT_ARCHIVE_MANIFEST && !listed.has(path)) {
      throw new VaultArchiveError(`archive file is not listed in manifest: ${path}`);
    }
  }
  if (!listed.has(VAULT_ARCHIVE_HISTORY)) {
    throw new VaultArchiveError(`archive is missing undo/redo history (${VAULT_ARCHIVE_HISTORY})`);
  }
  const files = [...listed.keys()].map((path) => byPath.get(path));
  return { manifest, files };
}

async function streamBytes(stream) {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function gzipBytes(bytes) {
  const input = toBytes(bytes);
  const stream = new Blob([input]).stream().pipeThrough(new CompressionStream('gzip'));
  return streamBytes(stream);
}

export async function gunzipBytes(bytes) {
  const input = toBytes(bytes);
  if (input.length < 2 || input[0] !== 0x1f || input[1] !== 0x8b) {
    throw new VaultArchiveError('archive is not gzipped');
  }
  try {
    const stream = new Blob([input]).stream().pipeThrough(new DecompressionStream('gzip'));
    return streamBytes(stream);
  } catch (error) {
    throw new VaultArchiveError(`could not decompress archive: ${error.message}`);
  }
}

/**
 * Build one portable `.tar.gz` vault archive from vault files.
 *
 * @param {Array<{path: string, data: string|Uint8Array, mtime?: number}>} files
 * @param {{vaultName?: string|null, exportedAt?: string|null}} options
 * @returns {Promise<Uint8Array>} gzipped tar bytes
 */
export async function createVaultArchive(files, options = {}) {
  const normalized = files.map((file) => {
    const path = safeArchivePath(file.path);
    return { path, data: toBytes(file.data), mtime: file.mtime ?? 0 };
  });
  const manifest = createVaultArchiveManifest({ ...options, files: normalized });
  const entries = [
    { path: VAULT_ARCHIVE_MANIFEST, data: encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`), mtime: 0 },
    ...normalized,
  ];
  return gzipBytes(createTar(entries));
}

/**
 * Read one portable `.tar.gz` vault archive back into validated files.
 *
 * @param {Uint8Array} bytes
 * @returns {Promise<{manifest: object, files: Array<{path: string, data: Uint8Array, mtime: number}>}>}
 */
export async function parseVaultArchive(bytes) {
  const tar = await gunzipBytes(bytes);
  return validateVaultArchiveEntries(parseTar(tar));
}

/**
 * Compare an archive with the files a vault already has.
 *
 * Existing entries are `{path, bytes}` (or `{path, data}`, or legacy
 * `{path, text}`); archive entries are the validated `{path, data}` files.
 * Comparison is byte-for-byte, so a binary file that decodes lossily as text
 * is still recognised as changed — import writes `bytes`, never re-encoded
 * text, so non-text files survive the round trip. `conflicts` names existing
 * files whose bytes would change — the caller asks before overwriting those.
 * With `replace`, existing files the archive does not carry are deleted too,
 * except `.git` internals, which are never listed here.
 *
 * @returns {{writes: Array<{path, bytes, text?: string}>, …}} `text` is the
 *   strict UTF-8 decoding when there is one; binary writes carry no `text`.
 */
export function planVaultImport(existingFiles, archiveFiles, { replace = false } = {}) {
  const existing = new Map();
  for (const file of existingFiles ?? []) {
    if (file.path === '.git' || String(file.path ?? '').startsWith('.git/')) continue;
    const path = safeArchivePath(file.path);
    existing.set(path, file.bytes != null || file.data != null
      ? toBytes(file.bytes ?? file.data)
      : encoder.encode(String(file.text ?? '')));
  }
  const writes = [];
  const conflicts = [];
  const added = [];
  const updated = [];
  const unchanged = [];
  const carried = new Set();
  for (const file of archiveFiles ?? []) {
    const path = safeArchivePath(file.path);
    carried.add(path);
    const bytes = toBytes(file.data);
    const write = { path, bytes, text: strictText(bytes) };
    if (!existing.has(path)) {
      writes.push(write);
      added.push(path);
    } else if (!sameBytes(existing.get(path), bytes)) {
      writes.push(write);
      conflicts.push(path);
      updated.push(path);
    } else {
      unchanged.push(path);
    }
  }
  const deletions = replace
    ? [...existing.keys()].filter((path) => !carried.has(path)).sort()
    : [];
  return { writes, conflicts, added, updated, unchanged, deletions };
}

/** The strict UTF-8 decoding of `bytes`, or undefined when it is not text. */
export function strictText(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(toBytes(bytes));
  } catch {
    return undefined;
  }
}

/** True when `bytes` are not valid UTF-8 text (an image, a PDF, …). */
export function isBinaryBytes(bytes) {
  return strictText(bytes) === undefined;
}

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}
