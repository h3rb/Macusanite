/**
 * The MCP server: protocol behaviour first, transports second.
 *
 * `createServer` is driven directly for the protocol (no socket, no spawn), and
 * the transports are exercised through their real interfaces — a real HTTP
 * listener on an ephemeral port and a real spool directory — because those are
 * what an agent actually talks to.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createVaultApi } from '../../src/lib/api.js';
import { openVault } from '../../cli/vaultFs.js';
import { mcpCommands, toolName, inputSchema, commandForTool } from '../../src/lib/catalogue.js';
import { buildHelpMarkdown } from '../../src/lib/helpDoc.js';
import {
  createServer,
  serveHttp,
  serveIntake,
  SUPPORTED_VERSIONS,
  LATEST_LEGACY,
  ERRORS,
} from '../../cli/mcp.js';

let counter = 0;
function tempDir(name = 'mcp') {
  const dir = path.join(os.tmpdir(), `macusanite-${name}-${process.pid}-${counter++}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** A server with the sample vault open, ready to answer requests. */
async function makeServer() {
  const root = tempDir('server');
  const store = await openVault(root, { create: true, name: 'MCP Test Vault' });
  const { seedSampleVault } = await import('../../cli/vaultFs.js');
  await seedSampleVault(store);
  const api = createVaultApi({
    openVault,
    writeFile: async (target, contents) => {
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, contents, 'utf8');
      return { bytes: contents.length };
    },
  });
  api.attach(store, store.root);
  return { server: createServer({ api, log: () => {} }), root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const call = (server, method, params = {}, context = {}) => server.handle({ jsonrpc: '2.0', id: 1, method, params }, context);

/* ── tools ─────────────────────────────────────────────────────────────── */

test('every catalogue command is exposed as a tool, documented and annotated', async () => {
  const { server, cleanup } = await makeServer();
  const { result } = await call(server, 'tools/list');
  const expected = mcpCommands();
  assert.equal(result.tools.length, expected.length);
  assert.equal(server.tools.length, expected.length);

  const byName = new Map(result.tools.map((tool) => [tool.name, tool]));
  for (const command of expected) {
    const tool = byName.get(toolName(command.name));
    assert.ok(tool, `${command.name} should be a tool`);
    assert.equal(commandForTool(tool.name), command.name);
    assert.ok(tool.description.length > command.summary.length, 'the description carries the arguments too');
    assert.match(tool.description, /Full documentation: the `docs` tool/);
    assert.deepEqual(tool.inputSchema, inputSchema(command.name));
    // Tool names must survive the round trip: dots are not allowed in them.
    assert.match(tool.name, /^[a-z0-9_]+$/);
  }

  const write = byName.get('vein_write');
  assert.equal(write.annotations.readOnlyHint, false);
  assert.equal(write.annotations.destructiveHint, false);
  assert.equal(write.annotations.idempotentHint, true, 'vein.write is undoable');
  assert.deepEqual(write.inputSchema.required, ['path']);

  const read = byName.get('vein_read');
  assert.equal(read.annotations.readOnlyHint, true);
  assert.equal(byName.get('vein_delete').annotations.destructiveHint, true);
  cleanup();
});

test('a tool call answers with readable content and structured data', async () => {
  const { server, root, cleanup } = await makeServer();

  const stats = await call(server, 'tools/call', { name: 'vault_stats', arguments: {} });
  assert.match(stats.result.content[0].text, /veins\s+7/);
  assert.equal(stats.result.structuredContent.veins, 7);
  assert.equal(stats.result.isError, undefined);

  const read = await call(server, 'tools/call', { name: 'vein_read', arguments: { path: 'Home.md' } });
  assert.match(read.result.content[0].text, /^---\ntitle: Macusanite/);

  // Arguments are validated by the catalogue, so a typo never half-writes.
  const badArgs = await call(server, 'tools/call', { name: 'vein_read', arguments: { path: 'Home.md', bogus: 1 } });
  assert.equal(badArgs.result.isError, true);
  assert.match(badArgs.result.content[0].text, /unknown argument/);

  // A tool that fails mid-flight is a result the model can read, not a protocol error.
  const missing = await call(server, 'tools/call', { name: 'vein_read', arguments: { path: 'Nope.md' } });
  assert.equal(missing.result.isError, true);
  assert.match(missing.result.content[0].text, /vein not found/);

  // An unknown tool is a protocol error, per the spec.
  const unknown = await call(server, 'tools/call', { name: 'explode', arguments: {} });
  assert.equal(unknown.error.code, ERRORS.invalidParams);

  // Writing works, and the window's stack sees it.
  const created = await call(server, 'tools/call', {
    name: 'vein_create',
    arguments: { path: 'Chambers/Lab/Agent Note', text: '# Agent Note\n' },
  });
  assert.equal(created.result.structuredContent.created, true);
  assert.ok(fs.existsSync(path.join(root, 'Chambers', 'Lab', 'Agent Note.md')));

  const undone = await call(server, 'tools/call', { name: 'undo', arguments: {} });
  assert.equal(undone.result.structuredContent.applied, true);
  assert.ok(!fs.existsSync(path.join(root, 'Chambers', 'Lab', 'Agent Note.md')));
  cleanup();
});

/* ── lifecycle ─────────────────────────────────────────────────────────── */

test('initialize negotiates a version and reports what this server can do', async () => {
  const { server, cleanup } = await makeServer();

  const echoed = await call(server, 'initialize', { protocolVersion: '2025-06-18' });
  assert.equal(echoed.result.protocolVersion, '2025-06-18', 'a supported revision is echoed back');
  assert.deepEqual(Object.keys(echoed.result.capabilities).sort(), ['prompts', 'resources', 'tools']);
  assert.equal(echoed.result.capabilities.tools.listChanged, false);
  assert.equal(echoed.result.serverInfo.name, 'macusanite');
  assert.ok(echoed.result.serverInfo.version);
  assert.match(echoed.result.instructions, /vault_info/);

  const unsupported = await call(server, 'initialize', { protocolVersion: '2000-01-01' });
  assert.equal(unsupported.result.protocolVersion, LATEST_LEGACY);

  // Notifications get no response at all, including the one after initialize.
  assert.equal(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.deepEqual((await call(server, 'ping')).result, {});
  const unknown = await call(server, 'no/such/method');
  assert.equal(unknown.error.code, ERRORS.methodNotFound);
  cleanup();
});

test('the 2026 revision is answered without an initialize handshake', async () => {
  const { server, cleanup } = await makeServer();
  const context = { protocolVersion: '2026-07-28', era: 'modern' };

  const discover = await call(server, 'server/discover', {}, context);
  assert.deepEqual(discover.result.supportedVersions, SUPPORTED_VERSIONS);
  assert.equal(discover.result._meta['io.modelcontextprotocol/serverInfo'].name, 'macusanite');
  assert.equal(discover.result.resultType, 'complete');

  // Ordinary results are marked complete, and every request declares its version.
  const list = await call(server, 'tools/list', { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } });
  assert.equal(list.result.resultType, 'complete');

  const refused = await call(server, 'tools/list', { _meta: { 'io.modelcontextprotocol/protocolVersion': '1999-01-01' } });
  assert.equal(refused.error.code, ERRORS.unsupportedProtocolVersion);
  assert.deepEqual(refused.error.data.supported, SUPPORTED_VERSIONS);
  assert.equal(refused.error.data.requested, '1999-01-01');
  cleanup();
});

/* ── resources and prompts ─────────────────────────────────────────────── */

test('the manual, the vault and every vein are resources', async () => {
  const { server, cleanup } = await makeServer();

  const listed = await call(server, 'resources/list');
  const uris = listed.result.resources.map((resource) => resource.uri);
  assert.ok(uris.includes('macusanite://manual'));
  assert.ok(uris.includes('macusanite://vault'));
  assert.ok(uris.includes('macusanite://vein/Home.md'));
  assert.equal(listed.result.nextCursor, null, 'seven veins fit on one page');
  assert.deepEqual((await call(server, 'resources/templates/list')).result.resourceTemplates[0].uriTemplate, 'macusanite://vein/{path}');

  const manual = await call(server, 'resources/read', { uri: 'macusanite://manual' });
  assert.equal(manual.result.contents[0].text, buildHelpMarkdown());
  assert.equal(manual.result.contents[0].mimeType, 'text/markdown');

  const vault = await call(server, 'resources/read', { uri: 'macusanite://vault' });
  const summary = JSON.parse(vault.result.contents[0].text);
  assert.equal(summary.name, 'MCP Test Vault');
  assert.equal(summary.stats.veins, 7, 'the summary carries the stats too');

  // A path with a space and a slash has to survive the URI round trip.
  const vein = await call(server, 'resources/read', { uri: 'macusanite://vein/Chambers/Lab/Analytical%20Methods.md' });
  assert.match(vein.result.contents[0].text, /sieve/i);

  const unknown = await call(server, 'resources/read', { uri: 'macusanite://nope' });
  assert.equal(unknown.error.code, ERRORS.invalidParams);
  cleanup();
});

test('resources paginate, so a huge vault does not arrive in one blob', async () => {
  const { server, root, cleanup } = await makeServer();
  for (let i = 0; i < 12; i += 1) {
    fs.writeFileSync(path.join(root, `Bulk ${i}.md`), `# Bulk ${i}\n`, 'utf8');
  }

  const all = await call(server, 'resources/list');
  const veins = all.result.resources.filter((resource) => resource.uri.startsWith('macusanite://vein/'));
  assert.equal(veins.length, 19, 'seven sample veins plus twelve written here');
  assert.equal(all.result.nextCursor, null, 'nineteen veins still fit on one page');

  // And the cursor is honoured when it is handed back.
  const paged = await call(server, 'resources/list', { cursor: '5' });
  const pagedVeins = paged.result.resources.filter((resource) => resource.uri.startsWith('macusanite://vein/'));
  assert.deepEqual(pagedVeins.map((resource) => resource.uri), veins.slice(5).map((resource) => resource.uri));
  cleanup();
});

test('prompts are usable starting points', async () => {
  const { server, cleanup } = await makeServer();
  const listed = (await call(server, 'prompts/list')).result.prompts;
  assert.ok(listed.length >= 4);
  assert.ok(listed.every((prompt) => prompt.description && prompt.arguments));
  assert.deepEqual(listed.find((prompt) => prompt.name === 'summarize-vein').arguments, [
    { name: 'path', description: 'Vault-relative path of the vein.', required: true },
  ]);

  const got = await call(server, 'prompts/get', { name: 'summarize-vein', arguments: { path: 'Home.md' } });
  assert.equal(got.result.messages[0].role, 'user');
  assert.match(got.result.messages[0].content.text, /`Home\.md`/);

  const manual = await call(server, 'prompts/get', { name: 'manual', arguments: { section: 'search' } });
  assert.match(manual.result.messages[0].content.text, /^## Search/);

  const unknown = await call(server, 'prompts/get', { name: 'nope', arguments: {} });
  assert.equal(unknown.error.code, ERRORS.invalidParams);
  cleanup();
});

/* ── HTTP transport ────────────────────────────────────────────────────── */

test('the HTTP transport answers on one endpoint and reports readiness', async () => {
  const { server, cleanup } = await makeServer();
  const controller = new AbortController();
  // Port 0 means "whatever is free": the transport reports what it got.
  let listening = null;
  const ready = new Promise((resolve) => {
    listening = resolve;
  });
  const running = serveHttp(server, {
    host: '127.0.0.1',
    port: 0,
    log: () => {},
    announce: false,
    signal: controller.signal,
    onListening: listening,
  });
  const { url: base, healthUrl } = await ready;
  const health = await (await fetch(healthUrl)).json();
  assert.equal(health.ok, true);
  assert.equal(health.tools, server.tools.length);
  assert.ok(health.vault);

  const init = await post(base, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } });
  assert.equal(init.result.protocolVersion, '2025-11-25');

  const callResult = await post(base, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'tags', arguments: {} },
  });
  assert.match(callResult.result.content[0].text, /#/);

  // A notification is accepted and answered with an empty 202.
  const notification = await fetch(base, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  assert.equal(notification.status, 202);
  assert.equal((await notification.text()).length, 0);

  // Malformed JSON, a wrong path and a GET are all refused the way the spec says.
  const broken = await (await fetch(base, { method: 'POST', body: '{oops' })).json();
  assert.equal(broken.error.code, ERRORS.parse);
  assert.equal((await fetch(`${new URL(base).origin}/nope`)).status, 404);
  const get = await fetch(base);
  assert.equal(get.status, 405);
  assert.equal(get.headers.get('allow'), 'POST');

  controller.abort();
  await running;
  cleanup();
});

async function post(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify(body),
  });
  return response.json();
}

/* ── file intake ───────────────────────────────────────────────────────── */

test('the file intake turns request files into response files', async () => {
  const { server, root, cleanup } = await makeServer();
  const spool = tempDir('spool');

  await fsp.writeFile(path.join(spool, 'one.request.json'), JSON.stringify({
    jsonrpc: '2.0',
    id: 'a',
    method: 'tools/call',
    params: { name: 'vein_read', arguments: { path: 'Home.md' } },
  }));
  await fsp.writeFile(path.join(spool, 'two.request.json'), JSON.stringify([
    { jsonrpc: '2.0', id: 'b', method: 'initialize', params: { protocolVersion: '2025-11-25' } },
    { jsonrpc: '2.0', id: 'c', method: 'tools/call', params: { name: 'vein_create', arguments: { path: 'From Spool.md', text: '# From Spool\n' } } },
  ]));
  await fsp.writeFile(path.join(spool, 'broken.request.json'), '{not json');
  await fsp.writeFile(path.join(spool, 'notes.txt'), 'not a request file');

  await serveIntake(server, { dir: spool, once: true, log: () => {} });

  const one = JSON.parse(await fsp.readFile(path.join(spool, 'one.response.json'), 'utf8'));
  assert.equal(one.id, 'a');
  assert.match(one.result.content[0].text, /title: Macusanite/);

  const two = JSON.parse(await fsp.readFile(path.join(spool, 'two.response.json'), 'utf8'));
  assert.deepEqual(two.map((response) => response.id), ['b', 'c']);
  assert.ok(fs.existsSync(path.join(root, 'From Spool.md')), 'the write landed in the vault');

  const broken = JSON.parse(await fsp.readFile(path.join(spool, 'broken.response.json'), 'utf8'));
  assert.equal(broken.error.code, ERRORS.parse);

  // Requests are moved aside, so nothing is ever processed twice.
  for (const name of ['one', 'two', 'broken']) {
    assert.ok(fs.existsSync(path.join(spool, `${name}.done`)), `${name} should be marked done`);
    assert.ok(!fs.existsSync(path.join(spool, `${name}.request.json`)));
  }
  assert.ok(fs.existsSync(path.join(spool, 'notes.txt')), 'unrelated files are left alone');

  // A second pass has nothing to do and leaves the responses where they are.
  const before = await fsp.readFile(path.join(spool, 'one.response.json'), 'utf8');
  await serveIntake(server, { dir: spool, once: true, log: () => {} });
  assert.equal(await fsp.readFile(path.join(spool, 'one.response.json'), 'utf8'), before);

  fs.rmSync(spool, { recursive: true, force: true });
  cleanup();
});

/* ── the CLI's mcp modes ───────────────────────────────────────────────── */

test('the CLI routes the three mcp modes and documents them', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'cli', 'macusanite.mjs');
  const run = (args, options = {}) => {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', ...options });
    return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };

  const help = run(['mcp', '--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /macusanite mcp stdio/);
  assert.match(help.stdout, /macusanite mcp serve/);
  assert.match(help.stdout, /macusanite mcp intake/);
  assert.match(help.stdout, /127\.0\.0\.1:8765/);

  const bare = run(['mcp']);
  assert.equal(bare.code, 2, 'a mode is required, and saying so is a usage error');

  const badTransport = run(['mcp', 'telepathy']);
  assert.equal(badTransport.code, 1);
  assert.match(badTransport.stderr, /unknown MCP transport: telepathy/);

  const missingDir = run(['mcp', 'intake']);
  assert.equal(missingDir.code, 1);
  assert.match(missingDir.stderr, /needs --dir/);

  // stdio, end to end, exactly as an MCP client would spawn it.
  const stdio = run(['mcp', 'stdio'], {
    input: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } })}\n`,
  });
  assert.equal(stdio.code, 0);
  const lines = stdio.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines[0].result.protocolVersion, '2025-11-25');
  assert.match(stdio.stderr, /stdio transport ready/);
});
