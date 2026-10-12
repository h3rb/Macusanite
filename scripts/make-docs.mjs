#!/usr/bin/env node
/**
 * Materialise the Macusanite manual as `docs/Help.md`.
 *
 * The manual is generated, never written by hand: the features come from
 * `src/lib/helpDoc.js` and the command reference from `src/lib/catalogue.js`, so
 * this script only asks the API for the document and writes down what it says.
 * That is also why the file is safe to read on GitHub — and why editing it is
 * pointless, because the next run overwrites it.
 *
 *   node scripts/make-docs.mjs              # writes docs/Help.md
 *   node scripts/make-docs.mjs --check      # fails if docs/Help.md is out of date
 *   node scripts/make-docs.mjs --out FILE
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVaultApi } from '../src/lib/api.js';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const check = argv.includes('--check');
const outIndex = argv.findIndex((arg) => arg === '--out');
const target = resolve(here, '..', outIndex === -1 ? 'docs/Help.md' : argv[outIndex + 1]);

// No vault: the manual is about the program, not about one vault.
const api = createVaultApi({});
const { markdown } = await api.dispatch('docs', {});

if (check) {
  const current = existsSync(target) ? readFileSync(target, 'utf8') : null;
  if (current === markdown) {
    console.log(`docs in sync: ${target}`);
    process.exit(0);
  }
  console.error(`docs are out of date: ${target}\nrun \`npm run docs\` and commit the result.`);
  process.exit(1);
}

mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, markdown, 'utf8');

const commands = (markdown.match(/^### `[^`]+`$/gm) ?? []).length;
const lines = markdown.split('\n').length;
console.log(`wrote ${target}`);
console.log(`${lines} lines · ${commands} commands · ${(markdown.length / 1024).toFixed(1)} KB`);
console.log('the same document is in the window (Help, or F1), `macusanite docs` and the MCP `docs` tool');
