#!/usr/bin/env node
/**
 * Writes the bundled sample vault to `reference-vault/` so the desktop build has
 * somewhere to point the "Load Vault…" dialog.
 *
 * The content lives in `src/lib/fixtures.js` — the same fixture the browser
 * fallback and the tests use — so this script only materialises it.
 *
 *   node scripts/make-reference-vault.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sampleVaultFiles } from '../src/lib/fixtures.js';

const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(here, '..', 'reference-vault');
const files = sampleVaultFiles();

let written = 0;
for (const [rel, contents] of Object.entries(files)) {
  const destination = resolve(target, rel);
  if (!destination.startsWith(target)) throw new Error(`refusing to write outside the vault: ${rel}`);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, contents, 'utf8');
  written += 1;
}

console.log(`reference-vault ready: ${written} files in ${target}`);
console.log('open it with: npm run tauri:dev  →  ☰ → Load Vault…');
