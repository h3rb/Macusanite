#!/usr/bin/env node
/**
 * The Macusanite CLI — every vault operation the window can do, from a shell.
 *
 * ```
 * macusanite [--vault <folder>] [--json] <command> [arguments] [options]
 * macusanite help [command]                 # the reference
 * macusanite docs [section] [--out FILE]    # the whole manual
 * macusanite mcp stdio|serve|intake         # the MCP server (see cli/mcp.js)
 * ```
 *
 * Two ideas keep this file small:
 *
 *   * **the catalogue is the CLI.** [src/lib/catalogue.js](../src/lib/catalogue.js)
 *     declares every command, its arguments and what it does; this file turns
 *     those declarations into subcommands, `--help` pages and an argument
 *     parser. There is no second list of commands to keep in step.
 *   * **the API is the logic.** [src/lib/api.js](../src/lib/api.js) implements
 *     the commands against a vault store. The CLI's whole job is arguments in,
 *     text out — it never touches a vault file itself.
 *
 * Exit codes: `0` success, `1` the command failed, `2` the command line was
 * wrong (unknown command, bad option, missing argument). `vault doctor` exits
 * `1` when a check fails, which is what makes it usable in a pipeline.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  COMMANDS,
  commandNames,
  commandsByGroup,
  positionalParams,
  prepareArgs,
  LIST_TYPES,
} from '../src/lib/catalogue.js';
import { commandPage } from '../src/lib/helpDoc.js';
import { createVaultApi } from '../src/lib/api.js';
import { openVault } from './vaultFs.js';
import { formatResult } from './format.js';

const PROGRAM = 'macusanite';
const VERSION = '0.1.0';

/** Usage errors are the user's typo, not a failure of the command. */
class UsageError extends Error {}

/** `vein.write` is written `macusanite vein write` on the command line. */
const CLI_PATH = new Map(commandNames().map((name) => [name.split('.').join(' '), name]));
const PATH_OF = new Map(commandNames().map((name) => [name, name.split('.').join(' ')]));

/* ─────────────────────────────────────────────────────────── arguments ── */

/**
 * Split argv into global options and everything else.
 *
 * Globals are accepted anywhere — `macusanite search foo --json` and
 * `macusanite --json search foo` mean the same thing — because that is what a
 * person types. A `--` stops option scanning, so a vein called `--json` is still
 * reachable.
 */
function parseGlobals(argv) {
  const globals = {
    vault: process.env.MACUSANITE_VAULT ?? null,
    json: false,
    quiet: false,
    color: process.stdout.isTTY === true,
    help: false,
    version: false,
  };
  const rest = [];
  let literal = false;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (literal) {
      rest.push(token);
      continue;
    }
    if (token === '--') {
      literal = true;
      continue;
    }
    const [flag, inline] = token.startsWith('--') && token.includes('=')
      ? [token.slice(0, token.indexOf('=')), token.slice(token.indexOf('=') + 1)]
      : [token, null];
    if (flag === '--vault' || flag === '-C') {
      const value = inline ?? argv[++i];
      if (!value) throw new UsageError('--vault needs a folder');
      globals.vault = value;
    } else if (flag === '--json') globals.json = true;
    else if (flag === '--quiet' || flag === '-q') globals.quiet = true;
    else if (flag === '--help' || flag === '-h') globals.help = true;
    else if (flag === '--version' || flag === '-V') globals.version = true;
    else if (flag === '--color' || flag === '--colour') globals.color = true;
    else if (flag === '--no-color' || flag === '--no-colour') globals.color = false;
    else rest.push(token);
  }
  return { globals, rest };
}

/** Every leading run of tokens that could begin a command path. */
const CLI_PREFIXES = new Set();
for (const cliPath of CLI_PATH.keys()) {
  const parts = cliPath.split(' ');
  for (let i = 1; i <= parts.length; i += 1) CLI_PREFIXES.add(parts.slice(0, i).join(' '));
}

/**
 * The first tokens that name a command, longest match first.
 *
 * `vault settings set` has to win over `vault settings`, which is why the walk
 * keeps consuming — it stops only when the tokens so far can no longer begin any
 * command path.
 */
function resolveCommand(tokens) {
  let command = null;
  let consumed = 0;
  let walked = '';
  for (let i = 0; i < tokens.length; i += 1) {
    const next = walked ? `${walked} ${tokens[i]}` : tokens[i];
    if (!CLI_PREFIXES.has(next)) break;
    walked = next;
    if (CLI_PATH.has(next)) {
      command = CLI_PATH.get(next);
      consumed = i + 1;
    }
  }
  return { command, consumed };
}

/**
 * Turn command-line tokens into arguments for one command.
 *
 * Positional parameters are filled in the order the catalogue declares them —
 * that order is part of the documented interface, so it is not repeated here —
 * and `--name value`, `--name=value` and repeated `--list` flags are understood
 * from the declared types alone.
 */
function parseCommandArgs(command, tokens) {
  const entry = COMMANDS[command];
  const params = entry.params ?? [];
  const byName = new Map(params.map((param) => [param.name, param]));
  const positional = positionalParams(command);
  const raw = {};
  const values = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === '--') {
      values.push(...tokens.slice(i + 1));
      break;
    }
    if (token.startsWith('-') && token !== '-') {
      const body = token.replace(/^-+/, '');
      const eq = body.indexOf('=');
      const name = eq === -1 ? body : body.slice(0, eq);
      let value = eq === -1 ? undefined : body.slice(eq + 1);
      const param = byName.get(name);
      if (!param) throw new UsageError(`unknown option: ${token}\nrun \`${PROGRAM} ${PATH_OF.get(command)} --help\``);
      if (value === undefined) {
        if (param.type === 'boolean') value = 'true';
        else {
          value = tokens[++i];
          if (value === undefined) throw new UsageError(`--${name} needs a value`);
        }
      }
      if (LIST_TYPES.has(param.type)) raw[name] = [...(raw[name] ?? []), value];
      else if (raw[name] !== undefined) throw new UsageError(`--${name} was given twice`);
      else raw[name] = value;
    } else {
      values.push(token);
    }
  }

  positional.forEach((param, index) => {
    if (values[index] === undefined) return;
    if (raw[param.name] !== undefined) throw new UsageError(`${param.name} was given twice`);
    raw[param.name] = values[index];
  });
  if (values.length > positional.length) {
    throw new UsageError(`unexpected argument: ${values[positional.length]}\nrun \`${PROGRAM} ${PATH_OF.get(command)} --help\``);
  }

  const prepared = prepareArgs(command, raw);
  if (!prepared.ok) throw new UsageError(prepared.error);
  return prepared.args;
}

/** `-` means "read it from stdin", which is how an agent sends a document. */
function applyStdin(command, args) {
  const entry = COMMANDS[command];
  const out = { ...args };
  for (const param of entry.params ?? []) {
    if (param.type === 'string' && out[param.name] === '-') out[param.name] = readStdin();
  }
  return out;
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/** One-line usage, derived from the catalogue rather than written out. */
function usageLine(command) {
  const positional = positionalParams(command)
    .map((param) => (param.required ? `<${param.name}>` : `[${param.name}]`))
    .join(' ');
  const options = (COMMANDS[command].params ?? []).filter((param) => !param.positional);
  return `${PROGRAM} ${PATH_OF.get(command)}${positional ? ` ${positional}` : ''}${options.length ? ' [options]' : ''}`;
}

/* ────────────────────────────────────────────────────────── output ────── */

function write(text) {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exitCode = code;
}

function printVersion() {
  write(`${PROGRAM} ${VERSION}`);
}

/** The reference: every command by group, or one command's full page. */
function printHelp(command = null) {
  if (command) {
    const name = CLI_PATH.get(command.split(/\s+/).join(' ')) ?? (COMMANDS[command] ? command : null);
    if (!name) throw new UsageError(`unknown command: ${command}`);
    write(commandPage(name));
    return;
  }
  const lines = [
    `${PROGRAM} ${VERSION} — the Macusanite vault API, CLI and MCP server`,
    '',
    'usage:',
    `  ${PROGRAM} [--vault <folder>] [--json] <command> [arguments] [options]`,
    `  ${PROGRAM} help [command]`,
    `  ${PROGRAM} docs [section] [--out FILE]`,
    `  ${PROGRAM} mcp stdio|serve|intake [options]`,
    '',
    'global options:',
    '  --vault, -C <folder>   the vault to work on (or MACUSANITE_VAULT)',
    '  --json                 print the raw result as JSON',
    '  --quiet, -q            suppress commentary, keep the result',
    '  --no-color             plain text (colour is only used on a terminal)',
    '  --help, -h             this page, or one command\'s page',
    '  --version, -V          the version',
    '',
  ];
  for (const [group, entries] of commandsByGroup()) {
    if (!entries.length) continue;
    lines.push(`${group}`);
    const width = Math.max(...entries.map((entry) => PATH_OF.get(entry.name).length));
    for (const entry of entries) {
      lines.push(`  ${PATH_OF.get(entry.name).padEnd(width)}  ${entry.summary}`);
    }
    lines.push('');
  }
  lines.push(
    'MCP server (an AI agent can do everything here through it):',
    `  ${PROGRAM} mcp stdio   [--vault <folder>]                JSON-RPC on stdin/stdout`,
    `  ${PROGRAM} mcp serve   [--vault <folder>] [--port 8765]  headless HTTP on one endpoint`,
    `  ${PROGRAM} mcp intake  --dir <spool> [--watch]           request and response files`,
    '',
    `Run \`${PROGRAM} mcp --help\` for the server, \`${PROGRAM} help <command>\` for one command's`, 
    `arguments and examples, or \`${PROGRAM} docs\` for the whole manual.`,
  );
  write(lines.join('\n'));
}

/* ────────────────────────────────────────────────────────── the run ───── */

/** Build the API session, opening `--vault` first when one was given. */
async function createSession(globals) {
  const writeFile = async (target, contents) => {
    const absolute = path.resolve(process.cwd(), target);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, contents, 'utf8');
    return { path: absolute, bytes: Buffer.byteLength(contents) };
  };
  const api = createVaultApi({ openVault, writeFile });
  if (globals.vault) {
    const store = await openVault(globals.vault, { create: false });
    api.attach(store, store.root);
  }
  return api;
}

async function main(argv) {
  const { globals, rest } = parseGlobals(argv);

  if (globals.version && !rest.length) {
    printVersion();
    return;
  }

  // `mcp` is a mode, not a vault command: it owns the process until it stops.
  if (rest[0] === 'mcp') {
    const { runMcp } = await import('./mcp.js');
    await runMcp(rest.slice(1), {
      vault: globals.vault,
      json: globals.json,
      version: VERSION,
      help: globals.help,
    });
    return;
  }

  const { command, consumed } = resolveCommand(rest);
  const tokens = rest.slice(consumed);

  if (!command) {
    if (rest.length) throw new UsageError(`unknown command: ${rest.slice(0, 3).join(' ')}\nrun \`${PROGRAM} help\``);
    printHelp();
    return;
  }

  if (globals.help || tokens.includes('--help') || tokens.includes('-h')) {
    // The page itself already names the MCP tool, so this adds only the usage line.
    write([`usage: ${usageLine(command)}`, '', commandPage(command)].join('\n'));
    return;
  }

  // The command line is understood before a vault is required, so a typo is
  // reported as a typo rather than as a missing vault.
  const args = applyStdin(command, parseCommandArgs(command, tokens));

  const api = await createSession(globals);
  if (!api.store && api.requiresVault(command)) {
    throw new UsageError(`no vault is open — pass --vault <folder> (or set MACUSANITE_VAULT)\nrun \`${PROGRAM} ${PATH_OF.get(command)} --help\``);
  }

  const result = await api.dispatch(command, args);

  if (globals.json) {
    write(JSON.stringify(result, null, 2));
  } else if (command === 'docs' && args.out) {
    // The document went to a file: say so instead of printing it as well.
    write(`wrote ${result.bytes} bytes to ${result.out}`);
  } else {
    const text = formatResult(command, result, { color: globals.color && !globals.quiet });
    if (text !== '' && text !== undefined) write(text);
  }

  // `vault doctor` reports through its exit code so a script can branch on it.
  if (command === 'vault.doctor' && result.ok === false) process.exitCode = 1;
}

/** Everything the CLI can do, exported so tests can drive it in-process. */
export {
  main,
  parseGlobals,
  parseCommandArgs,
  resolveCommand,
  usageLine,
  printHelp,
  CLI_PATH,
  PATH_OF,
};

// `node cli/macusanite.mjs` runs; `import` from a test does not.
const self = fileURLToPath(import.meta.url);
const invokedDirectly = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === path.resolve(self);
if (invokedDirectly) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      fail(`error: ${error.message}`, 2);
    } else {
      fail(`error: ${error.message ?? error}`);
    }
  }
}
