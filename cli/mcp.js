#!/usr/bin/env node
/**
 * The Macusanite MCP server.
 *
 * One protocol implementation, three transports:
 *
 * ```
 * macusanite mcp stdio   --vault <folder>                 # newline-delimited JSON-RPC
 * macusanite mcp serve   --vault <folder> [--port 8765]   # headless HTTP, loopback by default
 * macusanite mcp intake  --dir <spool> [--watch]          # a directory of request files
 * ```
 *
 * ## What it speaks
 *
 * Two protocol eras, because clients are split across them:
 *
 *   * the **legacy** `initialize` handshake (revisions through `2025-11-25`), which
 *     is what Claude Desktop, VS Code and Cursor send today. Negotiation follows
 *     the spec: if the client's requested revision is one this server implements
 *     it is echoed back, otherwise the server answers with its own latest and the
 *     client decides whether it can go on.
 *   * the **modern** `2026-07-28` protocol, which has no `initialize`: every
 *     request carries its revision in `_meta["io.modelcontextprotocol/protocolVersion"]`
 *     (and, over HTTP, in `MCP-Protocol-Version`), `server/discover` reports what
 *     is supported, and a request for a revision this server does not implement is
 *     refused with `-32022` plus the list of versions that would work.
 *
 * ## What it exposes
 *
 *   * **tools** — every command in [src/lib/catalogue.js](../src/lib/catalogue.js)
 *     that is not marked `mcp: false`, with the JSON Schema the catalogue
 *     declares, so the two cannot drift;
 *   * **resources** — the manual (`macusanite://manual`), a vault summary
 *     (`macusanite://vault`) and every vein, paginated;
 *   * **prompts** — a few starting points for an agent that has just been pointed
 *     at a vault.
 *
 * Results carry a readable text block (the same rendering the CLI prints) and,
 * when the result is an object, `structuredContent` with the raw data.
 *
 * Everything here is plain Node with no dependencies, and `createServer` is
 * exported so the tests can drive the protocol without a socket.
 */
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { createVaultApi, ApiError } from '../src/lib/api.js';
import {
  mcpCommands,
  commandForTool,
  toolName,
  inputSchema,
  annotations,
} from '../src/lib/catalogue.js';
import { commandSummary, buildHelpMarkdown, helpSections } from '../src/lib/helpDoc.js';
import { openVault } from './vaultFs.js';
import { formatResult } from './format.js';

const SERVER_NAME = 'macusanite';
const SERVER_TITLE = 'Macusanite vault';
const DEFAULT_PORT = 8765;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_ENDPOINT = '/mcp';
const PAGE_SIZE = 200;

/** Revisions this server implements, newest first. */
export const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const MODERN_VERSIONS = ['2026-07-28'];
export const SUPPORTED_VERSIONS = [...MODERN_VERSIONS, ...LEGACY_VERSIONS];
export const LATEST_LEGACY = LEGACY_VERSIONS[0];

/** JSON-RPC error codes, including the MCP-specific ones. */
export const ERRORS = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  unsupportedProtocolVersion: -32022,
};

const jsonRpcError = (id, code, message, data = undefined) => ({
  jsonrpc: '2.0',
  id: id ?? null,
  error: data === undefined ? { code, message } : { code, message, data },
});

const jsonRpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });

const INSTRUCTIONS = [
  'Macusanite reads a vault: a folder of markdown "veins" in "chambers", with wiki [[links]], tags and a concept graph.',
  '',
  'Start with `vault_info` or `vault_stats` to orient, and `vault_tree` to see the shape.',
  'Read the manual with the `docs` tool (or the `macusanite://manual` resource) before assuming how something works.',
  '`vein_read` returns a vein as written; `vein_info` returns its headings, links and tags without the prose.',
  'Writing tools are undoable: `undo` reverses the last recorded change, and the window\'s Ctrl+Z shares the same stack.',
  '`ghosts` lists wiki links that point at veins which do not exist yet — usually the most useful thing to fix first.',
  'Pass `--vault` (or call `vault_open`) to work in a vault; without one only `docs` and the vault-management tools work.',
].join('\n');

/* ─────────────────────────────────────────────────────── the server ───── */

/**
 * A protocol handler over the Macusanite API.
 *
 * @param {object} input
 * @param {object} input.api a session from [src/lib/api.js](../src/lib/api.js)
 * @param {string} [input.version] reported in `serverInfo`
 * @param {(level: string, message: string) => void} [input.log]
 */
export function createServer({ api, version = '0.1.0', log = () => {} }) {
  const started = Date.now();
  const tools = mcpCommands().map((entry) => ({
    name: toolName(entry.name),
    title: `macusanite ${entry.name.split('.').join(' ')}`,
    description: `${commandSummary(entry.name)}\n\nFull documentation: the \`docs\` tool, section "${manualSectionFor(entry.name)}".`,
    inputSchema: inputSchema(entry.name),
    annotations: annotations(entry.name),
  }));
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));

  const capabilities = {
    tools: { listChanged: false },
    resources: { subscribe: false, listChanged: false },
    prompts: { listChanged: false },
  };
  const serverInfo = { name: SERVER_NAME, title: SERVER_TITLE, version };

  const uriFor = (veinPath) => `macusanite://vein/${veinPath.split('/').map(encodeURIComponent).join('/')}`;
  const pathOfUri = (uri) => String(uri).replace(/^macusanite:\/\/vein\//, '').split('/').map(decodeURIComponent).join('/');

  /* ── tools ─────────────────────────────────────────────────────────── */

  function toolList({ cursor = null } = {}) {
    const offset = cursor ? Number(cursor) || 0 : 0;
    return { tools: tools.slice(offset, offset + PAGE_SIZE), nextCursor: null };
  }

  async function callTool({ name, arguments: rawArgs }) {
    const command = commandForTool(name);
    if (!command || !toolsByName.has(name)) {
      throw new ApiError(`unknown tool: ${name}`, { code: 'unknown-tool', status: ERRORS.invalidParams });
    }
    const result = await api.dispatch(command, rawArgs ?? {});
    const text = formatResult(command, result, { color: false });
    const content = [{ type: 'text', text: text === '' || text === undefined ? JSON.stringify(result, null, 2) : String(text) }];
    const structured = result !== null && typeof result === 'object' && !Array.isArray(result) ? result : undefined;
    return structured === undefined ? { content } : { content, structuredContent: structured };
  }

  /* ── resources ─────────────────────────────────────────────────────── */

  async function listResources({ cursor = null } = {}) {
    const offset = cursor ? Number(cursor) || 0 : 0;
    const resources = [
      {
        uri: 'macusanite://manual',
        name: 'Macusanite manual',
        title: 'Macusanite manual — every feature, the CLI and the API',
        mimeType: 'text/markdown',
      },
    ];
    const store = api.store;
    if (store) {
      resources.push({
        uri: 'macusanite://vault',
        name: 'Vault summary',
        title: 'Identity and stats of the open vault',
        mimeType: 'application/json',
      });
      const veins = (await store.veins()).sort();
      const slice = veins.slice(offset, offset + PAGE_SIZE);
      for (const veinPath of slice) {
        resources.push({
          uri: uriFor(veinPath),
          name: veinPath,
          title: veinPath,
          mimeType: 'text/markdown',
        });
      }
      const next = offset + PAGE_SIZE < veins.length ? String(offset + PAGE_SIZE) : null;
      return { resources, nextCursor: next };
    }
    return { resources, nextCursor: null };
  }

  async function readResource({ uri }) {
    const store = api.store;
    if (uri === 'macusanite://manual') {
      return { contents: [{ uri, mimeType: 'text/markdown', text: buildHelpMarkdown() }] };
    }
    if (uri === 'macusanite://vault') {
      if (!store) throw new ApiError('no vault is open', { code: 'no-vault', status: ERRORS.invalidParams });
      const info = await store.info();
      const stats = await store.stats();
      return {
        contents: [{
          uri,
          mimeType: 'application/json',
          text: JSON.stringify({ ...info, stats }, null, 2),
        }],
      };
    }
    if (String(uri).startsWith('macusanite://vein/')) {
      if (!store) throw new ApiError('no vault is open', { code: 'no-vault', status: ERRORS.invalidParams });
      const rel = pathOfUri(uri);
      const resolved = await api.dispatch('vein.resolve', { target: rel }).catch(() => null);
      const target = resolved?.ok ? resolved.path : rel;
      const text = await store.readVein(target);
      return { contents: [{ uri: uriFor(target), mimeType: 'text/markdown', text }] };
    }
    throw new ApiError(`unknown resource: ${uri}`, { code: 'not-found', status: ERRORS.invalidParams });
  }

  const templateList = () => ({
    resourceTemplates: [{
      uriTemplate: 'macusanite://vein/{path}',
      name: 'A vein',
      title: 'Any vein in the open vault, as markdown',
      mimeType: 'text/markdown',
    }],
  });

  /* ── prompts ───────────────────────────────────────────────────────── */

  const PROMPTS = [
    {
      name: 'orient',
      title: 'Orient in this vault',
      description: 'Work out what this vault contains before changing anything.',
      arguments: [],
      text: () => [
        'You are working in a Macusanite vault.',
        'Call `vault_info` and `vault_stats` for identity and scale, `vault_tree` for the shape, `tags` for themes, `ghosts` for links that point nowhere, and `docs` (section "what-macusanite-is") if you need the rules of the format.',
        'Then summarise: what the vault is about, how it is organised, and the three most useful next actions.',
      ].join('\n'),
    },
    {
      name: 'repair-ghosts',
      title: 'Repair ghost links',
      description: 'Turn links that point at nothing into veins, or point them somewhere real.',
      arguments: [],
      text: () => [
        'Call `ghosts` to list wiki links whose target does not exist.',
        'For each one, decide from the linking context whether the target should exist (create it with `vein_create` and a real body) or is a typo of a vein that does exist (`vein_resolve` tells you the candidates).',
        'Create each vein in the chamber that already links to it, then re-run `vault_doctor` and report what is left.',
      ].join('\n'),
    },
    {
      name: 'summarize-vein',
      title: 'Summarise a vein',
      description: 'Read one vein and report what it says, without editing it.',
      arguments: [{ name: 'path', description: 'Vault-relative path of the vein.', required: true }],
      text: ([arg]) => [
        `Read the vein \`${arg}\` with \`vein_info\` for its structure and \`vein_read\` for its text.`,
        'Report its purpose, its sections in order, the veins it links to, and anything that looks unfinished. Do not edit it.',
      ].join('\n'),
    },
    {
      name: 'manual',
      title: 'Read the manual',
      description: 'The full Macusanite manual, or one section of it.',
      arguments: [{ name: 'section', description: `One of: ${helpSections().map((entry) => entry.slug).join(', ')}.`, required: false }],
      text: ([section]) => buildHelpMarkdown({ section: section || null }) ?? `No such section. Available: ${helpSections().map((entry) => entry.slug).join(', ')}`,
    },
  ];

  const promptList = () => ({
    prompts: PROMPTS.map(({ name, title, description, arguments: args }) => ({
      name,
      title,
      description,
      arguments: args.map((arg) => ({ name: arg.name, description: arg.description, required: arg.required ?? false })),
    })),
  });

  function getPrompt({ name, arguments: raw = {} }) {
    const prompt = PROMPTS.find((entry) => entry.name === name);
    if (!prompt) throw new ApiError(`unknown prompt: ${name}`, { code: 'not-found', status: ERRORS.invalidParams });
    const values = prompt.arguments.map((arg) => raw[arg.name] ?? '');
    const text = prompt.text(values);
    return {
      description: prompt.description,
      messages: [{ role: 'user', content: { type: 'text', text } }],
    };
  }

  /* ── the request path ──────────────────────────────────────────────── */

  /**
   * Handle one JSON-RPC message.
   *
   * @param {object} message
   * @param {{era?: 'legacy'|'modern', protocolVersion?: string|null}} [context]
   * @returns {object|null} the response, or null for a notification
   */
  async function handle(message, context = {}) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      return jsonRpcError(null, ERRORS.invalidRequest, 'a single JSON-RPC object is expected');
    }
    const { id = null, method, params = {} } = message;
    const isNotification = id === undefined || id === null;
    const requested = context.protocolVersion
      ?? params?._meta?.['io.modelcontextprotocol/protocolVersion']
      ?? null;
    const era = context.era ?? (requested && MODERN_VERSIONS.includes(requested) ? 'modern' : 'legacy');
    const modern = era === 'modern';

    if (requested && !SUPPORTED_VERSIONS.includes(requested)) {
      return jsonRpcError(id, ERRORS.unsupportedProtocolVersion, `unsupported protocol version: ${requested}`, {
        supported: SUPPORTED_VERSIONS,
        requested,
      });
    }

    const done = (result) => {
      if (isNotification) return null;
      // Ordinary results in the 2026 revision are marked complete.
      return jsonRpcResult(id, modern ? { resultType: 'complete', ...result } : result);
    };

    try {
      switch (method) {
        case 'initialize': {
          const asked = params.protocolVersion ?? null;
          const protocolVersion = LEGACY_VERSIONS.includes(asked) ? asked : LATEST_LEGACY;
          return jsonRpcResult(id, {
            protocolVersion,
            capabilities,
            serverInfo,
            instructions: INSTRUCTIONS,
          });
        }

        // The 2026 revision has no handshake: this is how a client learns what
        // the server implements, per request and without a session.
        case 'server/discover':
          return jsonRpcResult(id, {
            resultType: 'complete',
            supportedVersions: SUPPORTED_VERSIONS,
            capabilities,
            instructions: INSTRUCTIONS,
            _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
          });

        case 'notifications/initialized':
        case 'notifications/cancelled':
        case 'notifications/roots/list_changed':
          return null;

        case 'ping':
          return done({});

        case 'tools/list':
          return done(toolList(params));

        case 'tools/call': {
          if (!params.name) throw new ApiError('tools/call needs a name', { code: 'bad-args', status: ERRORS.invalidParams });
          try {
            return done(await callTool(params));
          } catch (error) {
            if (error instanceof ApiError && error.code === 'unknown-tool') throw error;
            // A tool that failed mid-flight answers with content and isError,
            // not a JSON-RPC error: the caller is the model, and it can react.
            const text = `${commandForTool(params.name) ?? params.name} failed: ${error.message}`;
            log('warn', text);
            return done({ content: [{ type: 'text', text }], isError: true });
          }
        }

        case 'resources/list':
          return done(await listResources(params));

        case 'resources/templates/list':
          return done(templateList());

        case 'resources/read': {
          if (!params.uri) throw new ApiError('resources/read needs a uri', { code: 'bad-args', status: ERRORS.invalidParams });
          return done(await readResource(params));
        }

        case 'prompts/list':
          return done(promptList());

        case 'prompts/get':
          return done(getPrompt(params));

        default:
          return jsonRpcError(id, ERRORS.methodNotFound, `method not found: ${method}`);
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === ERRORS.invalidParams) {
        return jsonRpcError(id, ERRORS.invalidParams, error.message);
      }
      log('error', `${method} failed: ${error.message}`);
      return jsonRpcError(id, ERRORS.internal, error.message ?? String(error));
    }
  }

  return {
    handle,
    tools,
    prompts: promptList().prompts,
    capabilities,
    serverInfo,
    instructions: INSTRUCTIONS,
    api,
    stats: () => ({ started, tools: tools.length, uptimeMs: Date.now() - started }),
  };
}

/** Which manual section documents a command — used in tool descriptions. */
function manualSectionFor(command) {
  if (command === 'docs' || command === 'help') return 'agents';
  if (command.startsWith('vault')) return 'vault-on-disk';
  return 'agents';
}

/* ──────────────────────────────────────────────────────── transports ──── */

/** Build the API session an MCP run works through. */
async function openSession({ vault = null } = {}) {
  const writeFile = async (target, contents) => {
    const absolute = path.resolve(process.cwd(), target);
    await fsp.mkdir(path.dirname(absolute), { recursive: true });
    await fsp.writeFile(absolute, contents, 'utf8');
    return { path: absolute, bytes: Buffer.byteLength(contents) };
  };
  const api = createVaultApi({ openVault, writeFile });
  if (vault) {
    const store = await openVault(vault, { create: false });
    api.attach(store, store.root);
  }
  return api;
}

const logger = ({ quiet = false } = {}) => (level, message) => {
  if (quiet && level === 'debug') return;
  process.stderr.write(`mcp ${level}: ${message}\n`);
};

/** Newline-delimited JSON-RPC on stdin/stdout — what a local MCP client spawns. */
async function serveStdio(server, { log }) {
  log('info', 'stdio transport ready (one JSON-RPC message per line)');
  const state = { protocolVersion: null };
  let buffer = '';
  // One queue, not a pool: a client that pipelines gets its responses in the
  // order it sent them, and two tools can never interleave their writes.
  let queue = Promise.resolve();

  const respond = (response) => {
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  };

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const text = line.trim();
      if (!text) continue;
      // A client that frames with Content-Length is tolerated: headers are
      // skipped and the JSON body on its own line is handled as usual.
      if (/^content-length:/i.test(text) || /^content-type:/i.test(text)) continue;
      let message;
      try {
        message = JSON.parse(text);
      } catch (error) {
        respond(jsonRpcError(null, ERRORS.parse, `parse error: ${error.message}`));
        continue;
      }
      if (message?.method === 'initialize') state.protocolVersion = message.params?.protocolVersion ?? null;
      queue = queue
        .then(() => server.handle(message, { protocolVersion: state.protocolVersion }))
        .then(respond)
        .catch((error) => respond(jsonRpcError(null, ERRORS.internal, error.message)));
    }
  });

  // `end` is the normal close of a piped stdin; `close` covers a client that
  // hangs up mid-line. Whichever arrives first, the queue is drained before the
  // process is allowed to finish, so no response is lost.
  await new Promise((resolve) => {
    process.stdin.once('end', resolve);
    process.stdin.once('close', resolve);
  });
  await queue;
  log('info', 'stdin closed — stopping');
}

/**
 * The HTTP transport: one POST endpoint, plus GET /health for readiness.
 *
 * `announce: false` keeps it silent (tests bind an ephemeral port), and `signal`
 * stops it — the same thing Ctrl+C does.
 */
async function serveHttp(server, {
  host = DEFAULT_HOST,
  port = DEFAULT_PORT,
  endpoint = DEFAULT_ENDPOINT,
  log,
  quiet,
  announce = true,
  signal = null,
  onListening = null,
}) {
  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const sendJson = (status, payload) => {
      const body = JSON.stringify(payload, null, 2);
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store',
      });
      res.end(body);
    };

    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/healthz')) {
      const stats = server.stats();
      sendJson(200, {
        ok: true,
        server: server.serverInfo,
        vault: server.api.root ?? null,
        tools: stats.tools,
        uptimeMs: stats.uptimeMs,
        endpoint,
      });
      return;
    }

    if (url.pathname !== endpoint) {
      sendJson(404, { error: `not found — the MCP endpoint is ${endpoint}` });
      return;
    }

    if (req.method === 'GET') {
      // The legacy transport allows GET to refuse an SSE stream explicitly.
      res.writeHead(405, { allow: 'POST', 'content-type': 'text/plain; charset=utf-8' });
      res.end(`This MCP endpoint streams nothing: POST JSON-RPC to ${endpoint}.\n`);
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' });
      res.end();
      return;
    }

    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let message;
      try {
        message = raw.trim() ? JSON.parse(raw) : null;
      } catch (error) {
        sendJson(200, jsonRpcError(null, ERRORS.parse, `parse error: ${error.message}`));
        return;
      }
      if (message === null) {
        sendJson(200, jsonRpcError(null, ERRORS.invalidRequest, 'empty body'));
        return;
      }
      const protocolVersion = req.headers['mcp-protocol-version'] ?? null;
      try {
        if (Array.isArray(message)) {
          const responses = [];
          for (const one of message) responses.push(await server.handle(one, { protocolVersion }));
          const kept = responses.filter(Boolean);
          if (!kept.length) {
            res.writeHead(202).end();
            return;
          }
          sendJson(200, kept);
          return;
        }
        const response = await server.handle(message, { protocolVersion });
        if (!response) {
          res.writeHead(202, { 'content-length': '0' }).end();
          return;
        }
        sendJson(200, response);
      } catch (error) {
        log('error', error.message);
        sendJson(500, jsonRpcError(null, ERRORS.internal, error.message));
      }
    });
  });

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, resolve);
  });

  const address = httpServer.address();
  const boundPort = typeof address === 'object' && address ? address.port : port;
  const shown = host === '0.0.0.0' ? '127.0.0.1' : host;
  // A caller that bound port 0 needs to learn the real port.
  if (onListening) {
    onListening({
      host: shown,
      port: boundPort,
      url: `http://${shown}:${boundPort}${endpoint}`,
      healthUrl: `http://${shown}:${boundPort}/health`,
    });
  }
  if (announce) {
    process.stderr.write([
      `mcp: listening on http://${shown}:${boundPort}${endpoint}`,
      `mcp: health at http://${shown}:${boundPort}/health`,
      `mcp: ${server.tools.length} tools · protocol ${SUPPORTED_VERSIONS.join(', ')}`,
      host === '0.0.0.0' ? 'mcp: exposed on every interface — there is no authentication on this port' : null,
    ].filter(Boolean).join('\n') + '\n');
    if (!quiet) log('info', `vault: ${server.api.root ?? 'none open (use the vault_open tool)'}`);
    // readiness proof for a caller that cannot read stderr
    process.stdout.write(`${JSON.stringify({ listening: `http://${shown}:${boundPort}${endpoint}`, tools: server.tools.length })}\n`);
  }

  await new Promise((resolve) => {
    let done = false;
    const stop = () => {
      if (done) return;
      done = true;
      // Stop accepting, then hang up on anything still connected — otherwise a
      // keep-alive client can hold Ctrl+C (and a test) open indefinitely.
      httpServer.close(() => resolve());
      httpServer.closeAllConnections?.();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    if (signal) {
      if (signal.aborted) stop();
      else signal.addEventListener('abort', stop, { once: true });
    }
  });
  log('info', 'stopped');
}

/**
 * The file-uptake transport: write a request, read a response.
 *
 * A request is `<name>.request.json` in the spool directory — one JSON-RPC
 * message, or an array of them. The reply is written to `<name>.response.json`
 * and the request is renamed `<name>.done`, so a caller can poll for the
 * response, and nothing is ever processed twice.
 */
async function serveIntake(server, { dir, once = false, interval = 400, log }) {
  const spool = path.resolve(dir);
  await fsp.mkdir(spool, { recursive: true });
  log('info', `intake watching ${spool} (${once ? 'one pass' : `every ${interval} ms`})`);

  const pendingRequests = async () => {
    const entries = await fsp.readdir(spool, { withFileTypes: true }).catch(() => []);
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.request.json'))
      .map((entry) => entry.name)
      .sort();
  };

  const processOne = async (name) => {
    const requestPath = path.join(spool, name);
    const base = name.slice(0, -'.request.json'.length);
    const responsePath = path.join(spool, `${base}.response.json`);
    let raw;
    try {
      raw = await fsp.readFile(requestPath, 'utf8');
    } catch {
      return; // it vanished between the listing and the read
    }
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch (error) {
      await fsp.writeFile(responsePath, `${JSON.stringify(jsonRpcError(null, ERRORS.parse, `parse error: ${error.message}`), null, 2)}\n`, 'utf8');
      await fsp.rename(requestPath, path.join(spool, `${base}.done`));
      log('warn', `${name}: parse error`);
      return;
    }
    const messages = Array.isArray(payload) ? payload : [payload];
    const responses = [];
    for (const message of messages) {
      try {
        const response = await server.handle(message, {});
        if (response) responses.push(response);
      } catch (error) {
        responses.push(jsonRpcError(message?.id ?? null, ERRORS.internal, error.message));
      }
    }
    const body = Array.isArray(payload) ? responses : (responses[0] ?? { jsonrpc: '2.0', id: null, result: {} });
    await fsp.writeFile(responsePath, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
    await fsp.rename(requestPath, path.join(spool, `${base}.done`));
    const failed = Array.isArray(body) ? body.some((one) => one.error) : Boolean(body.error);
    log(failed ? 'warn' : 'info', `${name} → ${path.basename(responsePath)}${failed ? ' (error)' : ''}`);
  };

  const pass = async () => {
    let count = 0;
    for (const name of await pendingRequests()) {
      await processOne(name);
      count += 1;
    }
    return count;
  };

  if (once) {
    const count = await pass();
    log('info', `processed ${count} request${count === 1 ? '' : 's'}`);
    return;
  }

  let stopping = false;
  const stop = () => { stopping = true; };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  while (!stopping) {
    await pass();
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  log('info', 'stopped');
}

/* ───────────────────────────────────────────────────────── the mode ───── */

const MODE_HELP = `usage:
  macusanite mcp stdio  [--vault <folder>]
  macusanite mcp serve  [--vault <folder>] [--port ${DEFAULT_PORT}] [--host ${DEFAULT_HOST}] [--endpoint ${DEFAULT_ENDPOINT}]
  macusanite mcp intake --dir <spool> [--once] [--interval 400] [--vault <folder>]

transports:
  stdio    one JSON-RPC message per line on stdin, one per line on stdout
  serve    headless HTTP on a single endpoint (default http://${DEFAULT_HOST}:${DEFAULT_PORT}${DEFAULT_ENDPOINT})
  intake   a directory of request files: <name>.request.json in, <name>.response.json out

protocol: ${SUPPORTED_VERSIONS.join(', ')}
  legacy initialize handshake through ${LATEST_LEGACY}; server/discover for the 2026 revision.
  The HTTP endpoint is unauthenticated: it binds ${DEFAULT_HOST} unless --host says otherwise.`;

/** Parse the tokens after `mcp`. */
function parseModeArgs(tokens) {
  const args = { mode: null, vault: null, host: DEFAULT_HOST, port: DEFAULT_PORT, endpoint: DEFAULT_ENDPOINT, dir: null, once: false, interval: 400, quiet: false, help: false };
  const list = [...tokens];
  for (let i = 0; i < list.length; i += 1) {
    const token = list[i];
    const [flag, inline] = token.startsWith('--') && token.includes('=')
      ? [token.slice(0, token.indexOf('=')), token.slice(token.indexOf('=') + 1)]
      : [token, null];
    const value = () => { const found = inline ?? list[++i]; if (found === undefined) throw new Error(`${flag} needs a value`); return found; };
    if (!token.startsWith('-')) {
      if (!args.mode) args.mode = token;
      else throw new Error(`unexpected argument: ${token}`);
      continue;
    }
    if (flag === '--vault' || flag === '-C') args.vault = value();
    else if (flag === '--host') args.host = value();
    else if (flag === '--port' || flag === '-p') args.port = Number(value());
    else if (flag === '--endpoint') args.endpoint = value();
    else if (flag === '--dir' || flag === '--spool') args.dir = value();
    else if (flag === '--once') args.once = true;
    else if (flag === '--watch') args.once = false;
    else if (flag === '--interval') args.interval = Number(value());
    else if (flag === '--quiet' || flag === '-q') args.quiet = true;
    else if (flag === '--help' || flag === '-h') args.help = true;
    else throw new Error(`unknown option: ${token}`);
  }
  return args;
}

/**
 * `macusanite mcp …` — run one transport until it stops.
 * @param {string[]} argv tokens after `mcp`
 * @param {{vault?: string|null, version?: string}} [options]
 */
export async function runMcp(argv, { vault = null, version = '0.1.0', help = false } = {}) {
  const args = parseModeArgs(argv);
  // `macusanite --help mcp` and `macusanite mcp --help` are the same request.
  const wantsHelp = args.help || help;
  if (wantsHelp || !args.mode) {
    process.stdout.write(`${MODE_HELP}\n`);
    // A mode is required: without one this is a usage error, not a no-op.
    if (!args.mode && !wantsHelp) process.exitCode = 2;
    return;
  }
  const mode = args.mode === 'http' ? 'serve' : args.mode;
  if (!['stdio', 'serve', 'intake'].includes(mode)) {
    throw new Error(`unknown MCP transport: ${args.mode}\n\n${MODE_HELP}`);
  }

  const api = await openSession({ vault: args.vault ?? vault });
  const log = logger({ quiet: args.quiet });
  const server = createServer({ api, version, log });
  log('info', `${server.tools.length} tools · vault ${api.root ?? 'none open'}`);

  if (mode === 'stdio') return serveStdio(server, { log });
  if (mode === 'serve') {
    if (!Number.isFinite(args.port) || args.port < 0) throw new Error(`--port must be a number, got ${args.port}`);
    return serveHttp(server, { host: args.host, port: args.port, endpoint: args.endpoint, log, quiet: args.quiet });
  }
  if (!args.dir) throw new Error('mcp intake needs --dir <spool>\n\n' + MODE_HELP);
  return serveIntake(server, { dir: args.dir, once: args.once, interval: args.interval, log });
}

export { serveStdio, serveHttp, serveIntake, openSession, MODE_HELP, INSTRUCTIONS };
