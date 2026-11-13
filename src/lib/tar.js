/**
 * A minimal POSIX (ustar) tar writer.
 *
 * A vault is a folder of small text files, and the backup is one tarball — so
 * the only tar feature needed is "regular file, short path, contents". Writing
 * it here keeps the CLI dependency-free, which is the same reason the rest of
 * the headless half has no build step.
 *
 * Paths longer than the ustar `name` field are split between `prefix` and
 * `name`, as the format intends. A single path segment longer than 100 bytes is
 * refused rather than silently truncated: a backup that cannot be restored is
 * worse than one that did not run.
 */

const BLOCK = 512;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Write bytes, zero-padded to the field. */
function writeBytes(target, offset, bytes) {
  target.set(bytes.subarray(0, Math.min(bytes.length, target.length - offset)), offset);
}

/** A string field: zero-padded on the right, with no NUL when it exactly fills. */
function writeText(target, offset, length, text) {
  const bytes = encoder.encode(String(text));
  target.set(bytes.subarray(0, length), offset);
}

/** An octal number field: 7 digits + NUL, or 11 digits + NUL. */
function writeOctal(target, offset, length, value) {
  const digits = Math.max(0, Math.floor(Number(value) || 0)).toString(8);
  const field = digits.padStart(length - 1, '0');
  if (field.length > length - 1) throw new Error(`tar field overflow: ${value}`);
  writeText(target, offset, length, field);
}

/** Split a path across ustar's `name` and `prefix` fields. */
function splitPath(relPath) {
  const path = String(relPath).replace(/\\/g, '/').replace(/^\/+/, '');
  const bytes = encoder.encode(path);
  if (bytes.length <= 100) return { name: path, prefix: '' };
  for (let i = path.length - 1; i > 0; i -= 1) {
    if (path[i] !== '/') continue;
    const name = path.slice(i + 1);
    const prefix = path.slice(0, i);
    if (encoder.encode(name).length <= 100 && encoder.encode(prefix).length <= 155) {
      return { name, prefix };
    }
  }
  throw new Error(`path is too long for a tar archive: ${path}`);
}

/** One 512-byte header for a regular file. */
function headerFor(entry) {
  const header = new Uint8Array(BLOCK);
  const { name, prefix } = splitPath(entry.path);
  const data = typeof entry.data === 'string' ? encoder.encode(entry.data) : entry.data;
  const size = data?.length ?? 0;
  const mtimeSeconds = Math.floor((entry.mtime ?? Date.now()) / 1000);

  writeText(header, 0, 100, name);
  writeOctal(header, 100, 8, 0o644); // mode
  writeOctal(header, 108, 8, 0); // uid
  writeOctal(header, 116, 8, 0); // gid
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, mtimeSeconds);
  header[156] = '0'.charCodeAt(0); // regular file
  writeBytes(header, 257, encoder.encode('ustar')); // magic, then its NUL
  writeBytes(header, 263, encoder.encode('00')); // version
  writeText(header, 345, 155, prefix);

  // The checksum is computed with its own field read as spaces, then written as
  // six octal digits, NUL, space.
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of header) sum += byte;
  writeBytes(header, 148, encoder.encode(sum.toString(8).padStart(6, '0')));
  header[154] = 0;
  header[155] = 0x20;
  return { header, data };
}

function readText(bytes, offset, length) {
  const slice = bytes.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return decoder.decode(end === -1 ? slice : slice.subarray(0, end));
}

function readOctal(bytes, offset, length) {
  const text = readText(bytes, offset, length).trim();
  if (!text) return 0;
  const value = Number.parseInt(text, 8);
  if (!Number.isFinite(value) || value < 0) throw new Error('invalid tar header number');
  return value;
}

/**
 * Read a ustar archive back into regular-file entries.
 *
 * Only the shape `createTar` writes is supported: regular files with short or
 * prefix-split paths. Directories are skipped; anything else is refused.
 *
 * @param {Uint8Array} bytes
 * @returns {Array<{path: string, data: Uint8Array, mtime: number}>}
 */
export function parseTar(bytes) {
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (input.length % BLOCK !== 0) throw new Error('invalid tar archive length');
  const entries = [];
  let offset = 0;
  while (offset + BLOCK <= input.length) {
    const header = input.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    const name = readText(header, 0, 100);
    const prefix = readText(header, 345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    const size = readOctal(header, 124, 12);
    const mtime = readOctal(header, 136, 12) * 1000;
    const type = String.fromCharCode(header[156] || 48);
    const dataStart = offset + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > input.length) throw new Error('truncated tar archive');
    if (type === '0' || type === '\0') {
      if (!path) throw new Error('tar entry has no path');
      entries.push({ path, data: input.slice(dataStart, dataEnd), mtime });
    } else if (type !== '5') {
      throw new Error(`unsupported tar entry type: ${type}`);
    }
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;
  }
  return entries;
}

/**
 * Build a tar archive in memory.
 *
 * @param {Array<{path: string, data: string|Uint8Array, mtime?: number}>} entries
 * @returns {Uint8Array}
 */
export function createTar(entries) {
  const prepared = entries.map((entry) => ({ ...entry, ...headerFor(entry) }));
  const total = prepared.reduce((sum, item) => sum + BLOCK + Math.ceil((item.data?.length ?? 0) / BLOCK) * BLOCK, 0) + BLOCK * 2;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const item of prepared) {
    out.set(item.header, offset);
    offset += BLOCK;
    if (item.data?.length) {
      out.set(item.data, offset);
      offset += Math.ceil(item.data.length / BLOCK) * BLOCK;
    }
  }
  // The trailing zero blocks mark the end of the archive; the buffer is already
  // zero-filled, so they are simply left as they are.
  return out;
}
