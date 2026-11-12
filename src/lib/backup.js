/**
 * Where a vault backup goes: its object key and the URL it is PUT to.
 *
 * Kept apart from the upload so both halves of the program agree on the layout,
 * and so a dry run can name the object without touching the network. The Rust
 * `s3` module mirrors these two functions exactly.
 *
 * Layout:
 *
 *     <prefix><vault-slug>/<YYYYMMDDTHHMMSSZ>.tar.gz
 *
 * One object per run, timestamped in UTC. The prefix defaults to
 * `macusanite/`, so several vaults can share a bucket without colliding.
 */
import { encodeS3Key, amzTimestamp } from './sigv4.js';

export const DEFAULT_S3_PREFIX = 'macusanite/';

/** `20261105T131415Z` — sortable, and safe in an object key. */
export function backupTimestamp(date = new Date()) {
  return amzTimestamp(date);
}

/** A vault name as a single key segment. */
export function vaultSlug(name) {
  const slug = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'vault';
}

/** The object key for one backup run. */
export function backupObjectKey({ vaultName, prefix = DEFAULT_S3_PREFIX, date = new Date() }) {
  const base = String(prefix ?? '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
  const directory = base ? `${base}/` : '';
  return `${directory}${vaultSlug(vaultName)}/${backupTimestamp(date)}.tar.gz`;
}

/** `s3://bucket/key`, for display and for logs. */
export function s3ObjectUrl(bucket, key) {
  return `s3://${bucket}/${key}`;
}

/** A bucket name S3 will accept, checked before anything is signed. */
export function assertBucket(bucket) {
  const name = String(bucket ?? '').trim();
  if (!name) throw new Error('an S3 bucket is required (--bucket)');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(name)) {
    throw new Error(`not a usable S3 bucket name: ${bucket}`);
  }
  return name;
}

/** An endpoint like `localhost:9000/minio` becomes `https://localhost:9000/minio`. */
export function normalizeEndpoint(endpoint) {
  const text = String(endpoint ?? '').trim();
  if (!text) return null;
  const withScheme = /^https?:\/\//i.test(text) ? text : `https://${text}`;
  return withScheme.replace(/\/+$/, '');
}

/**
 * The URL an object is uploaded to, and how its address was formed.
 *
 * An explicit endpoint (MinIO, Cloudflare R2, a gateway) is addressed
 * path-style — `<endpoint>/<bucket>/<key>` — because those services do not
 * promise virtual-host DNS. AWS itself is addressed virtual-host style, which
 * is what new buckets expect.
 *
 * @returns {{url: string, host: string, style: 'path'|'virtual'}}
 */
export function s3RequestTarget({ bucket, region = 'us-east-1', endpoint = null, key }) {
  const name = assertBucket(bucket);
  const encodedKey = encodeS3Key(key);
  const base = normalizeEndpoint(endpoint);
  if (base) {
    const url = `${base}/${encodeS3Key(name)}/${encodedKey}`;
    return { url, host: new URL(url).host, style: 'path' };
  }
  const zone = String(region ?? '').trim() || 'us-east-1';
  const url = `https://${name}.s3.${zone}.amazonaws.com/${encodedKey}`;
  return { url, host: new URL(url).host, style: 'virtual' };
}
