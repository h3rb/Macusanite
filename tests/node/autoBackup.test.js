/**
 * Automatic backups for the headless half.
 *
 * The API tests use a recording backup provider, so what is checked is the
 * wiring — which commands upload, what settings reach the upload, and what the
 * result says — without a network. The CLI and MCP tests drive real processes
 * against a local S3 stand-in, because "armed once, uploads on the next write"
 * and "a burst becomes one archive" are claims about whole invocations.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { createVaultApi } from '../../src/lib/api.js';
import { openVault } from '../../cli/vaultFs.js';
import { AUTO_BACKUP_PATH, parseAutoBackup, triggersAutoBackup } from '../../src/lib/autoBackup.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', '..', 'cli', 'macusanite.mjs');

let counter = 0;
function tempDir(name = 'auto-backup') {
  const dir = path.join(os.tmpdir(), `macusanite-${name}-${process.pid}-${counter++}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** A vault folder with its identity, ready for `openVault`. */
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
  fs.writeFileSync(path.join(root, 'Home.md'), '# Home\n\nField notes.\n');
  return root;
}

const REPORT = {
  ok: true,
  transport: 'direct',
  bucket: 'notes',
  key: 'macusanite/field-notes/20261113T000000Z.tar.gz',
  url: 's3://notes/macusanite/field-notes/20261113T000000Z.tar.gz',
  files: 5,
  bytes: 1234,
};

/** An API session on a fresh vault, with an upload that records its request. */
async function armedSession({ upload = null, quietMs = 0 } = {}) {
  const root = makeVault();
  const calls = [];
  const store = await openVault(root);
  const api = createVaultApi({
    openVault,
    autoBackupQuietMs: quietMs,
    backupS3: upload ?? (async (request) => {
      calls.push(request);
      return {
        ...REPORT,
        transport: request.sshHost ? 'ssh' : 'direct',
        bucket: request.bucket,
        url: `s3://${request.bucket}/${REPORT.key}`,
      };
    }),
  });
  api.attach(store, root);
  return { api, root, calls };
}

/* ── which writes upload ────────────────────────────────────────────────── */

test('writes upload, bookkeeping does not', () => {
  for (const command of ['vein.write', 'vein.create', 'vein.append', 'vein.section', 'vein.rename', 'vein.delete',
    'chamber.create', 'color.set', 'color.reset', 'vault.update', 'vault.settings.set', 'undo', 'redo']) {
    assert.equal(triggersAutoBackup(command), true, `${command} should back up`);
  }
  for (const command of ['vault.open', 'vault.create', 'vault.autobackup', 'vault.backup', 'vault.state.set',
    'vault.log', 'vault.index.rebuild', 'vault.index.drop', 'vault.stats', 'vein.read', 'search']) {
    assert.equal(triggersAutoBackup(command), false, `${command} should not back up`);
  }
});

test('the setting drops unknown keys, so no credential can be stored in it', () => {
  const parsed = parseAutoBackup(JSON.stringify({
    enabled: true,
    bucket: ' notes ',
    sshHost: ' backup@example.com ',
    sshPort: '2222',
    accessKey: 'AKIASTORED',
    secretKey: 'stored-secret',
  }));
  assert.equal(parsed.enabled, true);
  assert.equal(parsed.bucket, 'notes');
  assert.equal(parsed.sshHost, 'backup@example.com');
  assert.equal(parsed.sshPort, 2222);
  assert.equal('accessKey' in parsed, false);
  assert.equal('secretKey' in parsed, false);

  assert.equal(parseAutoBackup(null), null);
  assert.equal(parseAutoBackup(JSON.stringify({ sshPort: 70000 })).sshPort, null);
  assert.throws(() => parseAutoBackup('{oops'), /not valid JSON/);
  assert.throws(() => parseAutoBackup('[]'), /should hold a JSON object/);
});

/* ── the armed vault ───────────────────────────────────────────────────── */

test('an armed vault uploads after a write and stays quiet for reads', async () => {
  const { api, root, calls } = await armedSession();

  const armed = await api.dispatch('vault.autobackup', {
    bucket: 'notes',
    prefix: 'auto/',
    region: 'eu-west-1',
    on: true,
  });
  assert.equal(armed.enabled, true);
  assert.equal(armed.sshHost, '');
  assert.equal(armed.path, AUTO_BACKUP_PATH);

  const stored = JSON.parse(fs.readFileSync(path.join(root, '.macusanite', 'backup.json'), 'utf8'));
  assert.equal(stored.enabled, true);
  assert.equal(stored.bucket, 'notes');
  assert.equal(stored.prefix, 'auto/');
  assert.equal(stored.region, 'eu-west-1');
  assert.equal(/access|secret|token/i.test(JSON.stringify(stored)), false, 'no credential is written');

  const write = await api.dispatch('vein.write', { path: 'Home.md', text: '# Home\n\nBacked up.\n' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].bucket, 'notes');
  assert.equal(calls[0].prefix, 'auto/');
  assert.equal(calls[0].region, 'eu-west-1');
  assert.equal(calls[0].accessKey, null);
  assert.equal(calls[0].secretKey, null);
  assert.equal(write.path, 'Home.md');
  assert.equal(write.autoBackup.ok, true);
  assert.equal(write.autoBackup.url, `s3://notes/${REPORT.key}`);
  assert.equal(write.autoBackup.files, 5);

  await api.dispatch('vein.read', { path: 'Home.md' });
  await api.dispatch('vault.stats', {});
  await api.dispatch('vault.log', { message: 'a note in the log' });
  assert.equal(calls.length, 1, 'reads and log lines must not upload');

  await api.dispatch('undo', {});
  assert.equal(calls.length, 2, 'undo changes the vault, so it uploads');

  const off = await api.dispatch('vault.autobackup', { off: true });
  assert.equal(off.enabled, false);
  assert.equal(off.bucket, 'notes', 'disarming keeps the destination');
  await api.dispatch('vein.write', { path: 'Home.md', text: '# Home\n' });
  assert.equal(calls.length, 2);
});

test('a failed upload is reported but the write still succeeds', async () => {
  const { api, root } = await armedSession({
    upload: async () => {
      throw new Error('S3 refused the upload (403): Access Denied');
    },
  });
  await api.dispatch('vault.autobackup', { bucket: 'notes', on: true });

  const write = await api.dispatch('vein.write', { path: 'Home.md', text: '# Still written\n' });
  assert.equal(write.path, 'Home.md');
  assert.equal(write.bytes, 16);
  assert.equal(write.autoBackup.ok, false);
  assert.match(write.autoBackup.error, /Access Denied/);
  assert.equal(fs.readFileSync(path.join(root, 'Home.md'), 'utf8'), '# Still written\n');

  const logs = await api.dispatch('vault.logs', {});
  assert.ok(logs.some((line) => line.level === 'warn' && /automatic backup failed/.test(line.message)));
});

test('an SSH destination carries the host and the port, and no local credential', async () => {
  const { api, calls } = await armedSession();
  const armed = await api.dispatch('vault.autobackup', {
    bucket: 'notes',
    'ssh-host': 'backup@notes.example',
    'ssh-key': '~/keys/backup.pem',
    'ssh-port': 2222,
    profile: 'remote',
    on: true,
  });
  assert.equal(armed.sshHost, 'backup@notes.example');

  await api.dispatch('vein.append', { path: 'Home.md', text: '\nMore.\n' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sshHost, 'backup@notes.example');
  assert.equal(calls[0].sshKey, '~/keys/backup.pem');
  assert.equal(calls[0].sshPort, 2222);
  assert.equal(calls[0].profile, 'remote');
  assert.equal(calls[0].accessKey, null);
  assert.equal(calls[0].secretKey, null);

  await assert.rejects(
    () => api.dispatch('vault.autobackup', { 'ssh-port': 70000 }),
    /not a usable SSH port/,
  );
});

test('a corrupt setting never blocks a write, and says why', async () => {
  const { api, root, calls } = await armedSession();
  fs.writeFileSync(path.join(root, '.macusanite', 'backup.json'), '{ not json');

  const write = await api.dispatch('vein.write', { path: 'Home.md', text: '# Home again\n' });
  assert.equal(write.path, 'Home.md');
  assert.equal(write.autoBackup.ok, false);
  assert.match(write.autoBackup.error, /not valid JSON/);
  assert.equal(calls.length, 0);

  await assert.rejects(() => api.dispatch('vault.autobackup', { on: true }), /not valid JSON/);
});

test('arming without a bucket is refused before anything is written', async () => {
  const { api, root } = await armedSession();
  await assert.rejects(() => api.dispatch('vault.autobackup', { on: true }), /an S3 bucket is required/);
  assert.equal(fs.existsSync(path.join(root, '.macusanite', 'backup.json')), false);
  await assert.rejects(() => api.dispatch('vault.autobackup', { bucket: 'notes', on: true, off: true }), /not both/);
});

/* ── the quiet window ──────────────────────────────────────────────────── */

test('a quiet window coalesces writes into one upload', async () => {
  const { api, calls } = await armedSession({ quietMs: 100 });
  await api.dispatch('vault.autobackup', { bucket: 'notes', on: true });

  const first = await api.dispatch('vein.write', { path: 'Home.md', text: '# One\n' });
  const second = await api.dispatch('vein.create', { path: 'Two.md', text: '# Two\n' });
  assert.equal(first.autoBackup, undefined, 'a held-back upload is not in the result');
  assert.equal(second.autoBackup, undefined);
  assert.equal(calls.length, 0, 'nothing uploads while the writes are still coming');

  // The window uploads on its own once the writes stop.
  await new Promise((resolve) => setTimeout(resolve, 350));
  await api.flushAutoBackup();
  assert.equal(calls.length, 1);

  const logs = await api.dispatch('vault.logs', {});
  assert.ok(logs.some((line) => line.level === 'info' && /automatic backup to s3:/.test(line.message)));
});

test('a vault disarmed inside the quiet window uploads nothing', async () => {
  const { api, calls } = await armedSession({ quietMs: 500 });
  await api.dispatch('vault.autobackup', { bucket: 'notes', on: true });
  await api.dispatch('vein.write', { path: 'Home.md', text: '# Held\n' });
  await api.dispatch('vault.autobackup', { off: true });
  await api.flushAutoBackup();
  assert.equal(calls.length, 0, 'the setting is read when the upload runs, not when it is scheduled');
});

/* ── the CLI, across two invocations ───────────────────────────────────── */

/** A local S3 stand-in: records requests and answers with `status`. */
async function fakeS3({ status = 200, body = '' } = {}) {
  const requests = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      requests.push({ method: request.method, url: request.url, headers: request.headers, body: Buffer.concat(chunks) });
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

function runCli(args, env = {}) {
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

/** Send several JSON-RPC requests to `mcp stdio`, then close stdin. */
function runMcpStdio(args, requests, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, NO_COLOR: '1', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`);
    child.stdin.end();
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const CREDENTIALS = { AWS_ACCESS_KEY_ID: 'AKIAAUTO', AWS_SECRET_ACCESS_KEY: 'secret-auto', AWS_SESSION_TOKEN: '' };

test('the CLI uploads after the next write once the vault is armed', async () => {
  const root = makeVault();
  const s3 = await fakeS3();
  try {
    const arm = await runCli([
      '--vault', root, '--json', 'vault', 'autobackup',
      '--bucket', 'field-notes-backups', '--endpoint', s3.endpoint, '--region', 'eu-west-1', '--on',
    ]);
    assert.equal(arm.code, 0, arm.stderr);
    const armed = JSON.parse(arm.stdout);
    assert.equal(armed.enabled, true);
    assert.equal(s3.requests.length, 0, 'configuring does not upload');

    const write = await runCli([
      '--vault', root, '--json', 'vein', 'write', 'Home.md', '--text', '# Home\n\nUploaded.\n',
    ], CREDENTIALS);
    assert.equal(write.code, 0, write.stderr);
    const result = JSON.parse(write.stdout);
    assert.equal(result.autoBackup.ok, true, write.stderr);
    assert.equal(result.autoBackup.bucket, 'field-notes-backups');

    assert.equal(s3.requests.length, 1);
    assert.match(s3.requests[0].url, /^\/field-notes-backups\/macusanite\/field-notes\/\d{8}T\d{6}Z\.tar\.gz$/);
    assert.match(s3.requests[0].headers.authorization, /Credential=AKIAAUTO\//);

    // A read in a third process uploads nothing.
    const read = await runCli(['--vault', root, '--json', 'vein', 'read', 'Home.md'], CREDENTIALS);
    assert.equal(read.code, 0, read.stderr);
    assert.equal(s3.requests.length, 1);
  } finally {
    await s3.close();
  }
});

test('an MCP server uploads a burst of writes once, as it stops', async () => {
  const root = makeVault();
  const s3 = await fakeS3();
  fs.writeFileSync(path.join(root, '.macusanite', 'backup.json'), JSON.stringify({
    enabled: true,
    bucket: 'field-notes-backups',
    endpoint: s3.endpoint,
    region: 'eu-west-1',
  }));
  try {
    const result = await runMcpStdio(['--vault', root, 'mcp', 'stdio'], [1, 2, 3].map((n) => ({
      jsonrpc: '2.0',
      id: n,
      method: 'tools/call',
      params: { name: 'vein_write', arguments: { path: `Burst ${n}.md`, text: `# Burst ${n}\n` } },
    })), CREDENTIALS);

    assert.equal(result.code, 0, result.stderr);
    const responses = result.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(responses.length, 3);
    for (const response of responses) {
      assert.match(response.result.content[0].text, /wrote Burst \d\.md/);
      assert.equal(response.result.structuredContent.autoBackup, undefined, 'a coalesced upload has no tool result');
    }

    assert.equal(s3.requests.length, 1, 'one archive for the whole burst');
    const archive = zlib.gunzipSync(s3.requests[0].body).toString('utf8');
    for (const n of [1, 2, 3]) assert.ok(archive.includes(`Burst ${n}.md`), `the archive holds vein ${n}`);
  } finally {
    await s3.close();
  }
});

test('a refused automatic upload warns but leaves the write successful', async () => {
  const root = makeVault();
  const s3 = await fakeS3({
    status: 403,
    body: '<?xml version="1.0"?><Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>',
  });
  try {
    const arm = await runCli([
      '--vault', root, 'vault', 'autobackup',
      '--bucket', 'field-notes-backups', '--endpoint', s3.endpoint, '--on',
    ], CREDENTIALS);
    assert.equal(arm.code, 0, arm.stderr);
    assert.match(arm.stdout, /on — direct upload/);

    const write = await runCli([
      '--vault', root, 'vein', 'write', 'Home.md', '--text', '# Written anyway\n',
    ], CREDENTIALS);
    assert.equal(write.code, 0, 'the write succeeded, so the command succeeded');
    assert.match(write.stdout, /wrote Home\.md/);
    assert.match(write.stderr, /warning: automatic backup failed: S3 refused the upload \(403/);
    assert.match(write.stderr, /Access Denied/);
  } finally {
    await s3.close();
  }
});
