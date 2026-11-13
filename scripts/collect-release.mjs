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
 *
 * Only this build's own artefacts are touched: the folder is never emptied, so
 * artefacts built on another platform — a Linux deb copied in from WSL, say —
 * survive a Windows build, and vice versa.
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

mkdirSync(to, { recursive: true });

const copied = [];

function take(source, name) {
  cpSync(source, join(to, name), { recursive: true });
  copied.push(name);
}

// The portable binary is named after the Cargo package.
for (const name of ['macusanite.exe', 'macusanite']) {
  const candidate = join(from, name);
  if (existsSync(candidate) && statSync(candidate).isFile()) take(candidate, name);
}

// Installers and application bundles, one level under bundle/<kind>/.
const bundles = [];
const bundleDirs = join(from, 'bundle');
if (existsSync(bundleDirs)) {
  for (const group of readdirSync(bundleDirs, { withFileTypes: true })) {
    if (!group.isDirectory()) continue;
    const names = readdirSync(join(bundleDirs, group.name)).map((name) => {
      take(join(bundleDirs, group.name, name), name);
      return name;
    });
    if (names.length) bundles.push({ kind: group.name, names });
  }
}

if (!copied.length) {
  console.error('the build left no binary or bundle behind — did `tauri build` finish?');
  process.exit(1);
}

// A bundle kind this build produced replaces its older selves: a version bump
// would otherwise leave the previous version's installer sitting beside the
// new binary looking current. Other kinds are not this build's business.
const STALE_PATTERNS = {
  nsis: /^Macusanite_.*-setup\.exe$/,
  deb: /\.deb$/,
  appimage: /\.AppImage$/,
  // Tauri puts both macOS bundles in bundle/macos/: the .app directory and
  // the .dmg that wraps it.
  macos: /^Macusanite\.app$|\.dmg$/,
};
for (const { kind, names } of bundles) {
  const pattern = STALE_PATTERNS[kind];
  if (!pattern) continue;
  for (const entry of readdirSync(to)) {
    if (!names.includes(entry) && pattern.test(entry)) {
      rmSync(join(to, entry), { recursive: true, force: true });
    }
  }
}

function bytes(path) {
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) total += bytes(join(path, entry.name));
  return total;
}

const megabytes = (size) => `${(size / 1024 / 1024).toFixed(1)} MB`;
for (const name of copied) console.log(`release/${name}  ${megabytes(bytes(join(to, name)))}`);
console.log(`\n${copied.length} artefact${copied.length === 1 ? '' : 's'} in release/`);
