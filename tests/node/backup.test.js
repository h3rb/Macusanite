/**
 * S3 backups: the signature, the archive, and one real upload.
 *
 * The signature is checked against the worked example in AWS's own SigV4
 * documentation, because a signature that is merely self-consistent uploads
 * nothing. The upload is checked against a local HTTP server that records what
 * it received: path-style addressing, the signed headers and a gunzipped tar
 * that still contains the vault's files. The last test drives the CLI as a
 * process, so the catalogue → API → backup wiring is covered too.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { signS3Request, sha256Hex } from '../../src/lib/sigv4.js';
import { createTar } from '../../src/lib/tar.js';
import { backupObjectKey, s3RequestTarget } from '../../src/lib/backup.js';
import {
  backupVaultToS3,
  collectVaultFiles,
  expandHome,
  parseIni,
  remoteUploadScript,
  resolveS3Region,
  sshArguments,
} from '../../cli/s3Backup.js';
import { backupRequestFromDraft } from '../../src/ui/backupDialog.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', '..', 'cli', 'macusanite.mjs');
const EMPTY_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

let counter = 0;
function tempDir(name = 'backup') {
  const dir = path.join(os.tmpdir(), `macusanite-${name}-${process.pid}-${counter++}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** One vault-shaped folder with meta and a vein. */
function makeVault() {
  const root = tempDir('vault');
  fs.mkdirSync(path.join(root, '.macusanite'), { recursive: true });
  fs.writeFileSync(path.join(root, '.macusanite', 'vault.json'), JSON.stringify({
    version: 1,
    kind: 'macusanite-vault',
    name: 'Field Notes',
    description: '',
    created: '2026-01-01T00:00:00.000Z',
  }));
  fs.mkdirSync(path.join(root, 'Chambers'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Home.md'), '# Home\n\nField notes.\n');
  fs.writeFileSync(path.join(root, 'Chambers', 'Lab.md'), '# Lab\n');
  return root;
}

/* ── the signature ──────────────────────────────────────────────────────── */

test('SigV4 matches the published AWS example', () => {
  const signed = signS3Request({
    method: 'GET',
    url: 'https://examplebucket.s3.amazonaws.com/test.txt',
    payloadHash: EMPTY_HASH,
    region: 'us-east-1',
    credentials: { accessKey: 'AKIAIOSFODNN7EXAMPLE', secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' },
    date: new Date('2013-05-24T00:00:00Z'),
    headers: { range: 'bytes=0-9' },
  });

  assert.equal(signed.amzDate, '20130524T000000Z');
  assert.equal(signed.scope, '20130524/us-east-1/s3/aws4_request');
  assert.equal(
    signed.canonicalRequest,
    `GET\n/test.txt\n\nhost:examplebucket.s3.amazonaws.com\nrange:bytes=0-9\n`
    + `x-amz-content-sha256:${EMPTY_HASH}\nx-amz-date:20130524T000000Z\n\n`
    + `host;range;x-amz-content-sha256;x-amz-date\n${EMPTY_HASH}`,
  );
  assert.equal(signed.signature, 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  assert.match(
    signed.headers.authorization,
    /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20130524\/us-east-1\/s3\/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41$/,
  );
});

test('SigV4 encodes each key segment once and signs a session token', () => {
  const signed = signS3Request({
    method: 'PUT',
    url: 'https://bucket.s3.eu-west-1.amazonaws.com/a%20b/c%24d.tar.gz',
    payloadHash: sha256Hex('x'),
    region: 'eu-west-1',
    credentials: { accessKey: 'AK', secretKey: 'SK', sessionToken: 'TOKEN' },
    date: new Date('2026-11-05T13:14:15.999Z'),
  });
  assert.match(signed.canonicalRequest, /^PUT\n\/a%20b\/c%24d\.tar\.gz\n\n/);
  assert.match(signed.canonicalRequest, /x-amz-security-token:TOKEN/);
  assert.match(signed.headers.authorization, /SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token,/);
  assert.equal(signed.headers['x-amz-security-token'], 'TOKEN');
});

test('object keys are timestamped, slugged and prefix-aware', () => {
  const key = backupObjectKey({
    vaultName: 'Macusani Field Notes!',
    prefix: '/archive/',
    date: new Date('2026-11-05T13:14:15Z'),
  });
  assert.equal(key, 'archive/macusani-field-notes/20261105T131415Z.tar.gz');
  assert.equal(
    backupObjectKey({ vaultName: '***', date: new Date('2026-11-05T13:14:15Z') }),
    'macusanite/vault/20261105T131415Z.tar.gz',
  );
});

test('AWS is virtual-host addressed and a custom endpoint is path-style', () => {
  const aws = s3RequestTarget({ bucket: 'notes', region: 'eu-west-1', key: 'macusanite/v/1.tar.gz' });
  assert.equal(aws.url, 'https://notes.s3.eu-west-1.amazonaws.com/macusanite/v/1.tar.gz');
  assert.equal(aws.style, 'virtual');

  const custom = s3RequestTarget({ bucket: 'notes', endpoint: 'http://127.0.0.1:9000', key: 'a/b.tar.gz' });
  assert.equal(custom.url, 'http://127.0.0.1:9000/notes/a/b.tar.gz');
  assert.equal(custom.style, 'path');
});

/* ── the archive ────────────────────────────────────────────────────────── */

const ascii = (buffer, offset, length) => buffer.subarray(offset, offset + length).toString('utf8').replace(/\0.*$/, '').trim();
const octal = (buffer, offset, length) => parseInt(ascii(buffer, offset, length) || '0', 8) || 0;

/** Read a tar's headers until the zero blocks, checking each checksum. */
function readTar(buffer) {
  const files = [];
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const stored = octal(header, 148, 8);
    const copy = Buffer.from(header);
    copy.fill(0x20, 148, 156);
    const computed = [...copy].reduce((sum, byte) => sum + byte, 0);
    assert.equal(stored, computed, 'tar header checksum');

    const prefix = ascii(header, 345, 155);
    const name = ascii(header, 0, 100);
    const size = octal(header, 124, 12);
    const start = offset + 512;
    files.push({
      path: prefix ? `${prefix}/${name}` : name,
      size,
      mode: octal(header, 100, 8),
      text: buffer.subarray(start, start + size).toString('utf8'),
      magic: ascii(header, 257, 6),
    });
    offset = start + Math.ceil(size / 512) * 512;
  }
  return files;
}

test('the tar writer produces readable, checksummed entries', () => {
  const archive = createTar([
    { path: 'Home.md', data: '# Home\n', mtime: 1_700_000_000_000 },
    { path: 'Chambers/Lab/Notes.md', data: '# Lab\n', mtime: 1_700_000_000_000 },
  ]);
  const files = readTar(Buffer.from(archive));
  assert.deepEqual(files.map((file) => file.path), ['Home.md', 'Chambers/Lab/Notes.md']);
  assert.equal(files[0].text, '# Home\n');
  assert.equal(files[0].size, 7);
  assert.equal(files[0].mode, 0o644);
  assert.equal(files[0].magic, 'ustar');
});

test('a file name that exactly fills the tar field survives', () => {
  const name = `${'x'.repeat(97)}.md`; // exactly 100 bytes
  assert.equal(Buffer.byteLength(name), 100);
  const files = readTar(Buffer.from(createTar([{ path: name, data: 'x' }])));
  assert.equal(files[0].path, name);
});

test('a path too long for one tar segment is refused, not truncated', () => {
  assert.throws(
    () => createTar([{ path: `${'x'.repeat(101)}.md`, data: 'x' }]),
    /too long for a tar archive/,
  );
});

test('the vault walk includes meta, skips .git and symlinks', () => {
  const root = makeVault();
  fs.mkdirSync(path.join(root, '.git', 'objects'), { recursive: true });
  fs.writeFileSync(path.join(root, '.git', 'objects', 'blob'), 'ignore me');
  fs.writeFileSync(path.join(root, 'Chambers', '.keep'), '');
  const files = collectVaultFiles(root);
  const paths = files.map((file) => file.path);
  assert.deepEqual(paths, ['.macusanite/vault.json', 'Chambers/.keep', 'Chambers/Lab.md', 'Home.md']);
  assert.equal(files.find((file) => file.path === 'Home.md').data.toString('utf8'), '# Home\n\nField notes.\n');
});

/* ── the upload ─────────────────────────────────────────────────────────── */

/** A local S3 stand-in: records one request and answers with `status`. */
async function fakeS3({ status = 200, body = '' } = {}) {
  const requests = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      requests.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: Buffer.concat(chunks),
      });
      response.writeHead(status, { 'content-type': status === 200 ? 'text/plain' : 'application/xml' });
      response.end(body);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    endpoint: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Run the CLI as a process while the fake server is still answering. */
function runCli(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, NO_COLOR: '1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('the CLI uploads one signed tarball and reports where it went', async () => {
  const root = makeVault();
  const s3 = await fakeS3();
  try {
    const result = await runCli([
      '--vault', root, '--json', 'vault', 'backup', 'field-notes-backups',
      '--endpoint', s3.endpoint,
      '--prefix', 'archive/',
      '--region', 'eu-west-1',
    ], {
      AWS_ACCESS_KEY_ID: 'AKIATEST',
      AWS_SECRET_ACCESS_KEY: 'secret-test',
      AWS_SESSION_TOKEN: '',
    });

    assert.equal(result.code, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.bucket, 'field-notes-backups');
    assert.equal(report.region, 'eu-west-1');
    // Opening the vault ensures the four `.macusanite` files, plus two veins.
    assert.equal(report.files, 6);
    assert.match(report.key, /^archive\/field-notes\/\d{8}T\d{6}Z\.tar\.gz$/);
    assert.equal(report.url, `s3://field-notes-backups/${report.key}`);

    assert.equal(s3.requests.length, 1);
    const request = s3.requests[0];
    assert.equal(request.method, 'PUT');
    assert.equal(request.url, `/field-notes-backups/${report.key}`);
    assert.match(request.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIATEST\/\d{8}\/eu-west-1\/s3\/aws4_request, /);
    assert.equal(request.headers['x-amz-content-sha256'], sha256Hex(request.body));
    assert.equal(request.headers['content-type'], 'application/gzip');

    const files = readTar(zlib.gunzipSync(request.body));
    assert.equal(files.length, 6);
    const paths = files.map((file) => file.path);
    for (const expected of ['.macusanite/vault.json', '.macusanite/settings.json', 'Chambers/Lab.md', 'Home.md']) {
      assert.ok(paths.includes(expected), `archive should hold ${expected}`);
    }
    assert.equal(files.find((file) => file.path === 'Home.md').text, '# Home\n\nField notes.\n');
  } finally {
    await s3.close();
  }
});

test('--secret-key-file keeps the secret off the command line', async () => {
  const root = makeVault();
  const secretFile = path.join(tempDir('secret'), 'vault-secret');
  fs.writeFileSync(secretFile, 'secret-from-file\n');
  const s3 = await fakeS3();
  try {
    const result = await runCli([
      '--vault', root, '--json', 'vault', 'backup', 'field-notes-backups',
      '--endpoint', s3.endpoint,
      '--access-key', 'AKIAFILE',
      '--secret-key-file', secretFile,
    ], { AWS_ACCESS_KEY_ID: '', AWS_SECRET_ACCESS_KEY: '' });

    assert.equal(result.code, 0, result.stderr);
    assert.match(s3.requests[0].headers.authorization, /Credential=AKIAFILE\//);
    assert.equal(JSON.parse(result.stdout).credentials, 'flags');
  } finally {
    await s3.close();
  }
});

test('a refused upload fails the command with S3’s own message', async () => {
  const root = makeVault();
  const s3 = await fakeS3({
    status: 403,
    body: '<?xml version="1.0"?><Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>',
  });
  try {
    const result = await runCli([
      '--vault', root, 'vault', 'backup', 'field-notes-backups', '--endpoint', s3.endpoint,
    ], { AWS_ACCESS_KEY_ID: 'AKIADENIED', AWS_SECRET_ACCESS_KEY: 'secret' });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /S3 refused the upload \(403/);
    assert.match(result.stderr, /Access Denied/);
  } finally {
    await s3.close();
  }
});

test('--dry-run assembles the archive without a request', async () => {
  const root = makeVault();
  const result = await runCli([
    '--vault', root, '--json', 'vault', 'backup', 'field-notes-backups', '--dry-run',
  ], { AWS_ACCESS_KEY_ID: 'AKIADRY', AWS_SECRET_ACCESS_KEY: 'secret' });
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.dryRun, true);
  assert.equal(report.files, 6);
  assert.ok(report.bytes > 0);
});

/* ── credential plumbing ────────────────────────────────────────────────── */

test('shared credentials files are parsed like AWS’s own tools', () => {
  const sections = parseIni(`
# comment
[default]
aws_access_key_id = AKIADEFAULT
aws_secret_access_key = secret

[profile notes]
region = eu-central-1
`);
  assert.equal(sections.default.aws_access_key_id, 'AKIADEFAULT');
  assert.equal(sections['profile notes'].region, 'eu-central-1');
});

test('region falls back through the flag, environment, config and S3’s default', () => {
  const home = tempDir('home');
  fs.mkdirSync(path.join(home, '.aws'), { recursive: true });
  fs.writeFileSync(path.join(home, '.aws', 'config'), '[profile notes]\nregion = ap-south-1\n');
  assert.equal(resolveS3Region({ region: 'us-west-2', env: {}, home }), 'us-west-2');
  assert.equal(resolveS3Region({ env: { AWS_REGION: 'eu-west-1' }, home }), 'eu-west-1');
  assert.equal(resolveS3Region({ profile: 'notes', env: {}, home }), 'ap-south-1');
  assert.equal(resolveS3Region({ env: {}, home }), 'us-east-1');
});

/* ── the SSH transport ─────────────────────────────────────────────────── */

/** A stand-in for `ssh`: records the call, then answers like a process. */
function fakeSsh({ code = 0, stderr = '', onCall = null } = {}) {
  return (binary, args) => {
    const child = new EventEmitter();
    let input = Buffer.alloc(0);
    child.stdin = {
      on() {},
      end(chunk) { input = Buffer.from(chunk ?? []); },
    };
    child.stdout = { resume() {} };
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      onCall?.({ binary, args, input });
      child.emit('close', code, null);
    });
    return child;
  };
}

test('the remote script quotes the object, profile and endpoint', () => {
  const script = remoteUploadScript({
    url: "s3://notes/it's.tar.gz",
    region: 'eu-west-1',
    profile: 'backup',
    endpoint: 'minio.local:9000',
  });
  assert.match(script, /^set -eu$/m);
  assert.match(script, /trap 'rm -f "\$tmp"' EXIT HUP INT TERM/);
  assert.match(
    script,
    /aws s3 cp "\$tmp" 's3:\/\/notes\/it'\\''s\.tar\.gz' --region 'eu-west-1' --profile 'backup' --endpoint-url 'https:\/\/minio\.local:9000'/,
  );

  const bare = remoteUploadScript({ url: 's3://notes/k' });
  assert.ok(!bare.includes('--region'));
  assert.ok(!bare.includes('--endpoint-url'));
});

test('ssh arguments carry the key and port, and refuse a host that looks like an option', () => {
  const args = sshArguments({ host: 'backup@example.com', keyFile: '/keys/backup.pem', port: 2222, script: 'echo hi' });
  assert.ok(args.includes('BatchMode=yes'));
  assert.equal(args[args.indexOf('-i') + 1], '/keys/backup.pem');
  assert.equal(args[args.indexOf('-p') + 1], '2222');
  assert.equal(args[args.length - 2], 'backup@example.com');
  assert.equal(args[args.length - 1], 'echo hi');

  assert.throws(() => sshArguments({ host: '-oProxyCommand=bad', script: 'x' }), /not a usable SSH host/);
  assert.throws(() => sshArguments({ host: 'backup@example.com', port: 70000, script: 'x' }), /not a usable SSH port/);
});

test('the SSH transport streams one tarball and needs no AWS key', async () => {
  const root = makeVault();
  const keyFile = path.join(tempDir('ssh'), 'backup.pem');
  fs.writeFileSync(keyFile, 'FAKE PRIVATE KEY');
  let call = null;
  const report = await backupVaultToS3({
    root,
    vaultName: 'Field Notes',
    bucket: 'field-notes-backups',
    prefix: 'archive/',
    sshHost: 'backup@example.com',
    sshKey: keyFile,
    sshPort: 2222,
    now: new Date('2026-11-05T13:14:15Z'),
    env: {},
    spawnImpl: fakeSsh({ onCall: (seen) => { call = seen; } }),
  });

  assert.equal(report.ok, true);
  assert.equal(report.transport, 'ssh');
  assert.equal(report.sshHost, 'backup@example.com');
  assert.equal(report.credentials, 'remote');
  assert.equal(report.region, null);
  assert.equal(report.key, 'archive/field-notes/20261105T131415Z.tar.gz');
  assert.equal(report.url, 's3://field-notes-backups/archive/field-notes/20261105T131415Z.tar.gz');

  assert.equal(call.binary, 'ssh');
  assert.equal(call.args[call.args.indexOf('-i') + 1], keyFile);
  assert.ok(call.args.at(-1).includes(`'${report.url}'`));
  // The fixture folder, without a vault open, is three files: meta plus two veins.
  assert.equal(report.files, 3);
  assert.equal(readTar(zlib.gunzipSync(call.input)).length, 3);
});

test('an SSH failure reports what the remote said', async () => {
  const root = makeVault();
  await assert.rejects(
    backupVaultToS3({
      root, vaultName: 'Field Notes', bucket: 'notes', sshHost: 'backup@example.com',
      spawnImpl: fakeSsh({ code: 127, stderr: 'aws CLI not found on the remote host\n' }),
    }),
    /ssh backup@example\.com could not upload the archive \(exit 127\): aws CLI not found on the remote host/,
  );
});

test('an SSH backup refuses local AWS credentials', async () => {
  await assert.rejects(
    backupVaultToS3({
      root: makeVault(), vaultName: 'x', bucket: 'notes', sshHost: 'backup@example.com',
      accessKey: 'AKIA', secretKey: 'secret', spawnImpl: fakeSsh(),
    }),
    /remote host's credentials/,
  );
});

test('a leading ~ in the key path is the user’s home, not a literal folder', () => {
  assert.equal(expandHome('', '/home/me'), '');
  assert.equal(expandHome('~', '/home/me'), '/home/me');
  assert.equal(expandHome('~/.ssh/backup.pem', '/home/me'), path.join('/home/me', '.ssh/backup.pem'));
  assert.equal(expandHome('/keys/backup.pem', '/home/me'), '/keys/backup.pem');
});

test('the CLI routes --ssh-host through the catalogue without local credentials', async () => {
  const root = makeVault();
  const result = await runCli([
    '--vault', root, '--json', 'vault', 'backup', 'field-notes-backups',
    '--ssh-host', 'backup@example.com', '--ssh-key', '/keys/backup.pem', '--dry-run',
  ], { AWS_ACCESS_KEY_ID: '', AWS_SECRET_ACCESS_KEY: '' });
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.dryRun, true);
  assert.equal(report.transport, 'ssh');
  assert.equal(report.sshHost, 'backup@example.com');
  assert.equal(report.files, 6);
});

/* ── automatic uploads ─────────────────────────────────────────────────── */

test('a remembered draft becomes the automatic upload request', () => {
  const direct = backupRequestFromDraft({
    bucket: '  notes  ',
    transport: 'direct',
    region: 'eu-west-1',
    prefix: 'archive/',
    endpoint: 'https://minio.local:9000',
    profile: 'backup',
    // Credentials never come from the stored draft.
    accessKey: 'stored-ignored',
    secretKey: 'stored-ignored',
  }, { accessKey: 'AKIA', secretKey: 'SECRET', sessionToken: 'TOKEN' });
  assert.deepEqual(direct, {
    bucket: 'notes',
    region: 'eu-west-1',
    prefix: 'archive/',
    endpoint: 'https://minio.local:9000',
    profile: 'backup',
    accessKey: 'AKIA',
    secretKey: 'SECRET',
    sessionToken: 'TOKEN',
    ssh: null,
  });

  const ssh = backupRequestFromDraft({
    bucket: 'notes',
    transport: 'ssh',
    sshHost: ' backup@example.com ',
    sshKey: '~/keys/backup.pem',
    sshPort: '2222',
    sshProfile: 'remote',
  }, { accessKey: 'AKIA', secretKey: 'SECRET' });
  assert.deepEqual(ssh.ssh, { host: 'backup@example.com', keyFile: '~/keys/backup.pem', port: 2222 });
  assert.equal(ssh.profile, 'remote');
  assert.equal(ssh.accessKey, null);
  assert.equal(ssh.secretKey, null);
  assert.equal(ssh.sessionToken, null);
});

test('a draft that cannot run yet schedules no automatic upload', () => {
  assert.equal(backupRequestFromDraft(null), null);
  assert.equal(backupRequestFromDraft({ bucket: '   ' }), null);
  assert.equal(backupRequestFromDraft({ bucket: 'notes', transport: 'ssh' }), null);
  assert.equal(backupRequestFromDraft({ bucket: 'notes', transport: 'ssh', sshHost: 'backup@example.com', sshPort: 70_000 }), null);
  // A fresh dialog has no prefix typed yet; the shared default still applies.
  assert.equal(backupRequestFromDraft({ bucket: 'notes' }).prefix, 'macusanite/');
});
