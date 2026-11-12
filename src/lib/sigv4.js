/**
 * AWS Signature Version 4, just enough for an S3 `PutObject`.
 *
 * The backup command speaks S3 directly instead of carrying the AWS SDK, so
 * this is the one piece of AWS protocol it needs: a canonical request built
 * from the method, the encoded path, four or five headers and the payload
 * hash, signed with the date/region/service chain. It is pure — the clock and
 * the credentials are arguments — which is what lets it be checked against the
 * published AWS examples in the test suite.
 *
 * Two details are easy to get wrong and are handled here once:
 *
 *   * the path is URI-encoded a *single* time, per segment, keeping `/`;
 *   * the `host` header is part of the signature but must not be set by
 *     `fetch`, which owns it — `signS3Request` returns it, and the caller
 *     removes it before sending (see `cli/s3Backup.js`).
 */
import { createHash, createHmac } from 'node:crypto';

/** Lower-case hex SHA-256 of a string, Buffer or Uint8Array. */
export function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

/** Raw HMAC-SHA256. */
export function hmac(key, data) {
  return createHmac('sha256', key).update(data).digest();
}

const UNRESERVED = /[A-Za-z0-9._~-]/;

/**
 * SigV4's `UriEncode`: everything except the unreserved set becomes `%XX`,
 * with upper-case hex. Spaces become `%20`, never `+`.
 */
export function uriEncode(value) {
  let out = '';
  for (const byte of Buffer.from(String(value), 'utf8')) {
    const char = byte < 128 ? String.fromCharCode(byte) : '';
    out += char && UNRESERVED.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/** An S3 object key, encoded per segment so its slashes stay slashes. */
export function encodeS3Key(key) {
  return String(key).split('/').map(uriEncode).join('/');
}

/** `20261105T131415Z` — the `x-amz-date` spelling, without milliseconds. */
export function amzTimestamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** The date/region/service key the signature is chained from. */
export function signingKey(secretKey, day, region, service = 's3') {
  return hmac(hmac(hmac(hmac(`AWS4${secretKey}`, day), region), service), 'aws4_request');
}

/** The canonical request, exposed because it is the half that fails silently. */
export function canonicalRequest({ method, path, query = '', headers, payloadHash }) {
  const normalized = {};
  for (const [name, value] of Object.entries(headers)) {
    normalized[name.toLowerCase()] = String(value).trim().replace(/\s+/g, ' ');
  }
  const names = Object.keys(normalized).sort();
  const canonicalHeaders = names.map((name) => `${name}:${normalized[name]}\n`).join('');
  const text = [
    String(method).toUpperCase(),
    path,
    query,
    canonicalHeaders,
    names.join(';'),
    payloadHash,
  ].join('\n');
  return { text, signedHeaders: names.join(';') };
}

/**
 * Sign one S3 request.
 *
 * @param {object} input
 * @param {string} input.method HTTP verb
 * @param {string} input.url absolute URL — its host and path are signed
 * @param {object} [input.headers] extra headers to sign
 * @param {string} input.payloadHash hex SHA-256 of the body
 * @param {string} input.region bucket region
 * @param {{accessKey: string, secretKey: string, sessionToken?: string|null}} input.credentials
 * @param {Date} [input.date]
 * @param {string} [input.service]
 * @returns {{headers: object, url: string, canonicalRequest: string, stringToSign: string, signature: string, scope: string, amzDate: string}}
 */
export function signS3Request({
  method,
  url,
  headers = {},
  payloadHash,
  region,
  credentials,
  date = new Date(),
  service = 's3',
}) {
  if (!credentials?.accessKey || !credentials?.secretKey) {
    throw new Error('S3 credentials need both an access key id and a secret access key');
  }
  const target = new URL(url);
  const amzDate = amzTimestamp(date);
  const day = amzDate.slice(0, 8);
  const scope = `${day}/${region}/${service}/aws4_request`;

  const toSign = {
    ...headers,
    host: target.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  if (credentials.sessionToken) toSign['x-amz-security-token'] = credentials.sessionToken;

  const canonical = canonicalRequest({
    method,
    path: target.pathname,
    query: target.search.replace(/^\?/, ''),
    headers: toSign,
    payloadHash,
  });
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonical.text)].join('\n');
  const signature = hmac(signingKey(credentials.secretKey, day, region, service), stringToSign).toString('hex');

  return {
    url: target.toString(),
    headers: {
      ...headers,
      host: target.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      ...(credentials.sessionToken ? { 'x-amz-security-token': credentials.sessionToken } : {}),
      authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKey}/${scope}, SignedHeaders=${canonical.signedHeaders}, Signature=${signature}`,
    },
    canonicalRequest: canonical.text,
    stringToSign,
    signature,
    scope,
    amzDate,
  };
}
