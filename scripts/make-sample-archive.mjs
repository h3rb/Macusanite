#!/usr/bin/env node
/**
 * Exports the bundled sample vault as one portable `.tar.gz` —
 * `reference-vault.tar.gz`, beside the `reference-vault/` folder it mirrors.
 *
 * The content lives in `src/lib/fixtures.js`, the same fixture the browser
 * fallback, `scripts/make-reference-vault.mjs` and the tests use, so this
 * script only materialises the archive the way `vault.export` would: every
 * vault file plus `macusanite-archive.json`, through `createVaultArchive`.
 * One file the fixture does not carry is supplied — `.macusanite/history.json`,
 * the empty undo/redo stacks `ensureMeta` writes when the sample is opened —
 * because an archive without history is refused on import.
 *
 * The export is stamped with the fixture's own date and zeroed mtimes, so
 * regenerating from unchanged fixtures gives the same archive.
 *
 *   node scripts/make-sample-archive.mjs
 *
 * Try it end to end: open (or create) any vault, then
 *   macusanite vault import reference-vault.tar.gz --overwrite
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sampleVaultFiles, SAMPLE_VAULT_NAME } from '../src/lib/fixtures.js';
import { createVaultArchive, parseVaultArchive } from '../src/lib/vaultArchive.js';

const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(here, '..', 'reference-vault.tar.gz');
const files = Object.entries(sampleVaultFiles())
  .map(([path, data]) => ({ path, data, mtime: 0 }))
  .sort((a, b) => a.path.localeCompare(b.path));
if (!files.some((file) => file.path === '.macusanite/history.json')) {
  files.push({
    path: '.macusanite/history.json',
    data: `${JSON.stringify({ version: 1, undo: [], redo: [] }, null, 2)}\n`,
    mtime: 0,
  });
}

const bytes = await createVaultArchive(files, {
  vaultName: SAMPLE_VAULT_NAME,
  exportedAt: '2026-10-11T00:00:00.000Z',
});
// Round-trip before writing: the committed file must parse and validate.
const parsed = await parseVaultArchive(bytes);
if (parsed.files.length !== files.length) {
  throw new Error(`archive self-check failed: ${parsed.files.length} of ${files.length} files`);
}
writeFileSync(target, bytes);
console.log(`sample archive ready: ${bytes.length} bytes, ${files.length} files -> ${target}`);
console.log('import it with: macusanite vault import reference-vault.tar.gz --overwrite');
