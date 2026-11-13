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
 *   release/latest.json                       the signed updater manifest
 *
 * When the build was signed (`TAURI_SIGNING_PRIVATE_KEY` set, see
 * docs/Updates.md), every installer also has a `.sig` beside it and this
 * script writes `release/latest.json` from those signatures — the static
 * file the updater fetches from the GitHub release. Publish that file and
 * the installers as release assets and already-installed copies will offer
 * the update. An unsigned build still collects, but writes no manifest.
 *
 * It runs automatically as `posttauri:build`; `node scripts/collect-release.mjs`
 * also does it on its own, after a bare `cargo build --release --features
 * custom-protocol`.
 *
 * Only this build's own artefacts are touched: the folder is never emptied, so
 * artefacts built on another platform — a Linux deb copied in from WSL, say —
 * survive a Windows build, and vice versa.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildUpdateManifest } from '../src/lib/updater.js';

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

/* ── signed update manifest ────────────────────────────────────────────
 * Tauri writes a `.sig` next to each updater artifact when the private key
 * is in the environment. The manifest needs the signature *contents*, a URL
 * per platform, and the version — see `buildUpdateManifest`.
 */
function platformFor(name) {
  const lower = name.toLowerCase();
  const arch = lower.includes('aarch64') || lower.includes('arm64') ? 'aarch64' : 'x86_64';
  if (lower.endsWith('-setup.exe') || lower.endsWith('.msi')) return `windows-${arch}`;
  if (lower.endsWith('.app.tar.gz')) return `darwin-${arch}`;
  if (lower.endsWith('.appimage')) return `linux-${arch}`;
  return null;
}

// Prefer the NSIS installer over the MSI when a Windows build made both.
const PLATFORM_PREFERENCE = [/setup\.exe$/i, /\.app\.tar\.gz$/i, /\.appimage$/i, /\.msi$/i];
const candidates = {};
for (const name of copied) {
  const platform = platformFor(name);
  if (!platform) continue;
  const sigPath = join(to, `${name}.sig`);
  if (!existsSync(sigPath)) continue;
  const rank = PLATFORM_PREFERENCE.findIndex((re) => re.test(name));
  if (!candidates[platform] || rank < candidates[platform].rank) {
    candidates[platform] = { name, rank, signature: readFileSync(sigPath, 'utf8').trim() };
  }
}

const signedPlatforms = Object.keys(candidates);
if (signedPlatforms.length) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const base = process.env.MACUSANITE_UPDATE_BASE_URL ?? 'https://github.com/h3rb/Macusanite/releases/latest/download/';
  const manifest = buildUpdateManifest({
    version: pkg.version,
    notes: process.env.MACUSANITE_UPDATE_NOTES ?? `Macusanite ${pkg.version}`,
    pubDate: new Date().toISOString(),
    platforms: Object.fromEntries(signedPlatforms.map((platform) => [
      platform,
      { url: `${base.replace(/\/$/, '')}/${candidates[platform].name}`, signature: candidates[platform].signature },
    ])),
  });
  writeFileSync(join(to, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`release/latest.json  ${signedPlatforms.join(', ')}`);
} else {
  console.log('\nno signed updater artefacts — set TAURI_SIGNING_PRIVATE_KEY and rebuild to generate release/latest.json (see docs/Updates.md)');
}
