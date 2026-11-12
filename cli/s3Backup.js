/**
 * Backing a vault up to S3, from Node.
 *
 * The CLI and the MCP server call this; the desktop window does the same work
 * in Rust (`src-tauri/src/s3.rs`), and the two share the layout declared in
 * [src/lib/backup.js](../src/lib/backup.js). Nothing here is incremental: a run
 * writes one gzipped tarball of the whole vault, including `.macusanite`, so a
 * restore is "untar it and open the folder".
 *
 * Credentials are resolved in the order AWS's own tools use: explicit flags,
 * then the environment, then `~/.aws/credentials`. `--secret-key-file` is the
 * file-based escape hatch for a machine that keeps the secret on disk; the file
 * is never echoed back in an error or a report.
 *
 * There are two ways to get the archive into a bucket. The direct one signs the
 * request here with AWS access keys. The other, chosen with `--ssh-host`, streams
 * the archive over SSH to a host that uploads it with its own `aws` CLI, so this
 * machine never needs an AWS credential at all; `--ssh-key` names the private
 * (PEM) key the SSH connection uses.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createTar } from '../src/lib/tar.js';
import {
  DEFAULT_S3_PREFIX,
  assertBucket,
  backupObjectKey,
  normalizeEndpoint,
  s3ObjectUrl,
  s3RequestTarget,
} from '../src/lib/backup.js';
import { sha256Hex, signS3Request } from '../src/lib/sigv4.js';

/** Sections of an INI-style file (`~/.aws/credentials`, `~/.aws/config`). */
export function parseIni(text) {
  const sections = {};
  let current = null;
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const header = line.match(/^\[(.+)]$/);
    if (header) {
      current = header[1].trim();
      sections[current] = sections[current] ?? {};
      continue;
    }
    const eq = line.indexOf('=');
    if (eq === -1 || current === null) continue;
    sections[current][line.slice(0, eq).trim().toLowerCase()] = line.slice(eq + 1).trim();
  }
  return sections;
}

/** Read one probe file, or an empty string when it is not there. */
function readIfPresent(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** The section name a profile has in `~/.aws/credentials` vs `~/.aws/config`. */
const configSection = (profile) => (profile === 'default' ? 'default' : `profile ${profile}`);

/** Region from the flag, the environment, the config file, or the S3 default. */
export function resolveS3Region({ region = null, profile = null, env = process.env, home = os.homedir() }) {
  if (region) return String(region).trim();
  if (env.AWS_REGION) return String(env.AWS_REGION).trim();
  if (env.AWS_DEFAULT_REGION) return String(env.AWS_DEFAULT_REGION).trim();
  const chosen = profile || env.AWS_PROFILE || 'default';
  const config = parseIni(readIfPresent(env.AWS_CONFIG_FILE || path.join(home, '.aws', 'config')));
  const found = config[configSection(chosen)]?.region;
  return found || 'us-east-1';
}

/**
 * Credentials, resolved without ever logging the secret.
 *
 * @returns {{accessKey: string, secretKey: string, sessionToken: string|null, source: string}}
 */
export function resolveS3Credentials({
  accessKey = null,
  secretKey = null,
  sessionToken = null,
  profile = null,
  env = process.env,
  home = os.homedir(),
}) {
  if (accessKey || secretKey) {
    if (!accessKey || !secretKey) {
      throw new Error('S3 credentials need both --access-key and a secret key (--secret-key or --secret-key-file)');
    }
    return { accessKey, secretKey, sessionToken: sessionToken ?? null, source: 'flags' };
  }
  if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) {
    return {
      accessKey: env.AWS_ACCESS_KEY_ID,
      secretKey: env.AWS_SECRET_ACCESS_KEY,
      sessionToken: sessionToken ?? env.AWS_SESSION_TOKEN ?? null,
      source: 'environment',
    };
  }
  const chosen = profile || env.AWS_PROFILE || 'default';
  const file = env.AWS_SHARED_CREDENTIALS_FILE || path.join(home, '.aws', 'credentials');
  const section = parseIni(readIfPresent(file))[chosen];
  if (section?.aws_access_key_id && section?.aws_secret_access_key) {
    return {
      accessKey: section.aws_access_key_id,
      secretKey: section.aws_secret_access_key,
      sessionToken: sessionToken ?? section.aws_session_token ?? null,
      source: file,
    };
  }
  throw new Error(
    'no S3 credentials: pass --access-key and --secret-key (or --secret-key-file), '
    + `set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, or add profile "${chosen}" to ${file}`,
  );
}

/**
 * Every regular file in the vault, vault-relative, with its contents.
 *
 * Symlinks are skipped for the same reason the vault walk skips them: a link
 * must not pull something outside the folder into a backup. `.git` is skipped
 * because a vault that happens to be a repository should back up the notes,
 * not the repository's own object store.
 */
export function collectVaultFiles(root) {
  const base = path.resolve(root);
  if (!fs.existsSync(base)) throw new Error(`vault folder does not exist: ${root}`);
  const files = [];
  const walk = (directory) => {
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '.git') continue;
        walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const stat = fs.statSync(absolute);
        files.push({
          path: path.relative(base, absolute).split(path.sep).join('/'),
          data: fs.readFileSync(absolute),
          mtime: Math.floor(stat.mtimeMs),
        });
      } catch {
        /* the file vanished while the backup was being assembled */
      }
    }
  };
  walk(base);
  return files;
}

/** The useful sentence out of an S3 XML error body. */
function s3ErrorDetail(text) {
  const match = String(text ?? '').match(/<Message>([\s\S]*?)<\/Message>/i);
  if (!match) return '';
  return ` — ${match[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').slice(0, 300)}`;
}

/* ── SSH transport ─────────────────────────────────────────────────────── */

/** One word, quoted for a POSIX shell. */
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** The host part of `--ssh-host`, checked before ssh is started. */
export function assertSshHost(host) {
  const name = String(host ?? '').trim();
  if (!name) throw new Error('an SSH host is required (--ssh-host user@host)');
  if (name.startsWith('-') || /[\s\u0000-\u001f]/.test(name)) {
    throw new Error(`not a usable SSH host: ${host}`);
  }
  return name;
}

/** `~/keys/backup.pem`, the way a shell would read it. */
export function expandHome(file, home = os.homedir()) {
  const text = String(file ?? '').trim();
  if (!text) return '';
  if (text === '~') return home;
  if (text.startsWith('~/') || text.startsWith('~\\')) return path.join(home, text.slice(2));
  return text;
}

/** A port number, or null when the flag was not given. */
export function sshPortNumber(port) {
  if (port === null || port === undefined || port === '') return null;
  const number = Number(port);
  if (!Number.isInteger(number) || number < 1 || number > 65535) {
    throw new Error(`not a usable SSH port: ${port}`);
  }
  return number;
}

/**
 * The script the remote host runs.
 *
 * The archive arrives on stdin and lands in a temporary file first, because
 * `aws s3 cp` needs a seekable object to size and hash; the file is removed on
 * every exit path. Only the remote host's own AWS identity is used — nothing is
 * signed on this side — and `--region`, `--profile` and `--endpoint` are passed
 * to its `aws` CLI rather than resolved locally.
 */
export function remoteUploadScript({ url, region = null, profile = null, endpoint = null }) {
  const args = ['aws', 's3', 'cp', '"$tmp"', shellQuote(url)];
  const zone = String(region ?? '').trim();
  if (zone) args.push('--region', shellQuote(zone));
  const named = String(profile ?? '').trim();
  if (named) args.push('--profile', shellQuote(named));
  const base = normalizeEndpoint(endpoint);
  if (base) args.push('--endpoint-url', shellQuote(base));
  return [
    'set -eu',
    'command -v aws >/dev/null 2>&1 || { echo "aws CLI not found on the remote host" >&2; exit 127; }',
    // BSD mktemp (macOS) wants the template to end in Xs, so no suffix here.
    'tmp=$(mktemp "${TMPDIR:-/tmp}/macusanite.XXXXXX")',
    'trap \'rm -f "$tmp"\' EXIT HUP INT TERM',
    'cat > "$tmp"',
    args.join(' '),
  ].join('\n');
}

/** The arguments ssh is given, without the program name. */
export function sshArguments({ host, keyFile = null, port = null, script }) {
  const name = assertSshHost(host);
  // `-T` matters: an ssh config that asks for a tty would corrupt the binary
  // archive on the way through.
  const args = ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new'];
  const key = String(keyFile ?? '').trim();
  if (key) args.push('-i', key);
  const number = sshPortNumber(port);
  if (number !== null) args.push('-p', String(number));
  // The host is not an option (it may not start with `-`), and ssh joins the
  // remaining words into the single command the remote shell runs.
  args.push(name, script);
  return args;
}

/**
 * Run one ssh command, feeding it the archive on stdin.
 *
 * `spawnImpl` exists so the transport can be tested without an SSH server; the
 * real caller leaves it at `node:child_process`'s `spawn`.
 */
export function runSsh({ host, keyFile = null, port = null, script, body, spawnImpl = spawn }) {
  const args = sshArguments({ host, keyFile, port, script });
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      reject(new Error(`could not start ssh: ${error?.message ?? error}`));
      return;
    }
    let stderr = '';
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    // Nothing on stdout is needed, but draining it keeps a chatty remote (an
    // `aws` progress display, say) from filling a pipe.
    child.stdout?.resume?.();
    child.on('error', (error) => {
      reject(new Error(error?.code === 'ENOENT'
        ? 'the ssh command was not found — install an OpenSSH client'
        : `could not run ssh: ${error?.message ?? error}`));
    });
    // A remote that exits early (unknown host, denied key) closes the pipe
    // under us; its exit status is the useful error, not EPIPE.
    child.stdin?.on('error', () => {});
    child.stdin?.end(body);
    child.on('close', (code, signal) => {
      if (code === 0) {
        resolve(null);
        return;
      }
      const detail = stderr.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' ');
      reject(new Error(
        `ssh ${host} could not upload the archive (${signal ? `signal ${signal}` : `exit ${code}`})`
        + (detail ? `: ${detail}` : ''),
      ));
    });
  });
}

/** The SSH half of `backupVaultToS3`: same archive, different transport. */
async function backupVaultOverSsh({
  root,
  vaultName,
  bucket,
  region = null,
  prefix = null,
  endpoint = null,
  profile = null,
  sshHost,
  sshKey = null,
  sshPort = null,
  dryRun = false,
  now = new Date(),
  spawnImpl = spawn,
}) {
  const host = assertSshHost(sshHost);
  const name = assertBucket(bucket);
  const key = backupObjectKey({ vaultName, prefix: prefix ?? DEFAULT_S3_PREFIX, date: now });
  const files = collectVaultFiles(root);
  const body = zlib.gzipSync(createTar(files));
  const url = s3ObjectUrl(name, key);
  const report = {
    dryRun: dryRun === true,
    transport: 'ssh',
    sshHost: host,
    bucket: name,
    key,
    region: String(region ?? '').trim() || null,
    endpoint: normalizeEndpoint(endpoint),
    files: files.length,
    bytes: body.length,
    url,
    credentials: 'remote',
  };
  if (report.dryRun) return report;

  const keyFile = expandHome(sshKey);
  if (keyFile && !fs.existsSync(keyFile)) {
    throw new Error(`private key not found: ${keyFile}`);
  }
  const script = remoteUploadScript({ url, region: report.region, profile, endpoint });
  await runSsh({ host, keyFile, port: sshPort, script, body, spawnImpl });
  return { ...report, ok: true };
}

/**
 * Write one timestamped tarball of the vault to S3.
 *
 * @returns {Promise<object>} the report the CLI/MCP command returns
 */
export async function backupVaultToS3({
  root,
  vaultName,
  bucket,
  region = null,
  prefix = null,
  endpoint = null,
  accessKey = null,
  secretKey = null,
  sessionToken = null,
  profile = null,
  sshHost = null,
  sshKey = null,
  sshPort = null,
  dryRun = false,
  now = new Date(),
  env = process.env,
  home = os.homedir(),
  fetchImpl = globalThis.fetch,
  spawnImpl = spawn,
} = {}) {
  if (sshHost) {
    if (accessKey || secretKey || sessionToken) {
      throw new Error(
        'an SSH backup uploads with the remote host\'s credentials — drop the local access key, secret key and session token',
      );
    }
    return backupVaultOverSsh({
      root, vaultName, bucket, region, prefix, endpoint, profile,
      sshHost, sshKey, sshPort, dryRun, now, spawnImpl,
    });
  }
  const name = assertBucket(bucket);
  const zone = resolveS3Region({ region, profile, env, home });
  const credentials = resolveS3Credentials({ accessKey, secretKey, sessionToken, profile, env, home });
  const files = collectVaultFiles(root);
  const key = backupObjectKey({ vaultName, prefix: prefix ?? DEFAULT_S3_PREFIX, date: now });
  const body = zlib.gzipSync(createTar(files));
  const report = {
    dryRun: dryRun === true,
    transport: 'direct',
    bucket: name,
    key,
    region: zone,
    endpoint: normalizeEndpoint(endpoint),
    files: files.length,
    bytes: body.length,
    url: s3ObjectUrl(name, key),
    credentials: credentials.source,
  };
  if (dryRun) return report;

  const target = s3RequestTarget({ bucket: name, region: zone, endpoint, key });
  const signed = signS3Request({
    method: 'PUT',
    url: target.url,
    payloadHash: sha256Hex(body),
    region: zone,
    credentials,
    date: now,
    headers: { 'content-type': 'application/gzip' },
  });

  // `fetch` owns Host and forbids callers setting it; the signature already
  // commits to the same value, which is what S3 checks.
  const headers = { ...signed.headers };
  delete headers.host;

  let response;
  try {
    response = await fetchImpl(signed.url, { method: 'PUT', headers, body });
  } catch (error) {
    throw new Error(`could not reach ${target.host}: ${error?.message ?? error}`);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`S3 refused the upload (${response.status} ${response.statusText})${s3ErrorDetail(text)}`);
  }
  return { ...report, ok: true };
}
