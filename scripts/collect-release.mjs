#!/usr/bin/env node
/**
 * Collect the release artefacts into `release/` at the top of the repository.
 *
 * Cargo writes into `src-tauri/target/release`, and that stays where it is —
 * it is the build cache, and clearing it only makes the next build slower. The
 * finished files are copied out of it into a flat `release/` folder that is easy
 * to find and hand to someone:
 *
 *   release/macusanite.exe                    the portable binary (Windows)
 *   release/macusanite                        the portable binary (Linux)
 *   release/Macusanite_0.1.0_x64-setup.exe    the NSIS installer
 *   release/Macusanite_0.1.0_amd64.AppImage   Linux bundles, flat, as built
 *   release/Macusanite.app                    macOS, kept as a bundle
 *
 * It runs automatically as `posttauri:build`; `node scripts/collect-release.mjs`
 * also does it on its own, after a bare `cargo build --release --features
 * custom-protocol`.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const from = join(root, 'src-tauri', 'target', 'release');
const to = join(root, 'release');

if (!existsSync(from)) {
  console.error(`nothing to collect: ${relative(root, from)} does not exist — run \`npm run tauri:build\` first`);
  process.exit(1);
}

// `release/` is generated output, so it is emptied first: an installer from an
// earlier build must never sit next to the new binary looking current.
rmSync(to, { recursive: true, force: true });
mkdirSync(to, { recursive: true });

const copied = [];

function take(source, name) {
  const target = join(to, name);
  cpSync(source, target, { recursive: true });
  copied.push(target);
}

// The portable binary is named after the Cargo package.
for (const name of ['macusanite.exe', 'macusanite']) {
  const candidate = join(from, name);
  if (existsSync(candidate) && statSync(candidate).isFile()) take(candidate, name);
}

// Installers and application bundles, one level under bundle/<kind>/.
const bundles = join(from, 'bundle');
if (existsSync(bundles)) {
  for (const group of readdirSync(bundles, { withFileTypes: true })) {
    if (!group.isDirectory()) continue;
    const groupDir = join(bundles, group.name);
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      take(join(groupDir, entry.name), entry.name);
    }
  }
}

if (!copied.length) {
  console.error('the build left no binary or bundle behind — did `tauri build` finish?');
  process.exit(1);
}

function bytes(path) {
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) total += bytes(join(path, entry.name));
  return total;
}

const megabytes = (size) => `${(size / 1024 / 1024).toFixed(1)} MB`;
for (const path of copied) console.log(`${relative(root, path).replace(/\\/g, '/')}  ${megabytes(bytes(path))}`);
console.log(`\n${copied.length} artefact${copied.length === 1 ? '' : 's'} in release/`);
