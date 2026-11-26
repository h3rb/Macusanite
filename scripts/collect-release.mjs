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
 * The manifest describes every platform whose signed artifacts are in
 * `release/`, not just the platform this build made: the folder is shared, so
 * a Windows build in a folder that already holds the Linux AppImage writes one
 * manifest naming both. Building the other platform on another host and
 * copying its installer and `.sig` across is therefore all it takes:
 *
 *   npm run release:manifest        # rewrite release/latest.json, no build
 *
 * which is `node scripts/collect-release.mjs --manifest-only`. Artifacts of a
 * different version are ignored, so a leftover older AppImage never wins.
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

export const MANIFEST_NAME = 'latest.json';
export const DEFAULT_BASE_URL = 'https://github.com/h3rb/Macusanite/releases/latest/download/';

/* ── artefacts → platforms ─────────────────────────────────────────────
 * Only the artifacts the updater itself installs get a platform entry: the
 * NSIS setup exe, the macOS `.app.tar.gz` and the Linux AppImage. The deb is
 * published for people who prefer it, but Tauri cannot update from one.
 */

export function platformForArtifact(name) {
  const lower = String(name ?? '').toLowerCase();
  const arch = lower.includes('aarch64') || lower.includes('arm64') ? 'aarch64' : 'x86_64';
  if (lower.endsWith('-setup.exe') || lower.endsWith('.msi')) return `windows-${arch}`;
  if (lower.endsWith('.app.tar.gz')) return `darwin-${arch}`;
  if (lower.endsWith('.appimage')) return `linux-${arch}`;
  return null;
}

function parseVersion(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(text ?? '').trim());
  return match ? [+match[1], +match[2], +match[3], match[4] ?? ''] : null;
}

/** The version encoded in an installer's name (`Macusanite_0.2.0_x64-setup.exe`). */
export function artifactVersion(name) {
  const match = /_(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)_/.exec(String(name ?? ''));
  return match ? parseVersion(match[1]) : null;
}

/** Prefer the first listed kind when a platform has more than one artifact. */
export const PLATFORM_PREFERENCE = [/setup\.exe$/i, /\.app\.tar\.gz$/i, /\.appimage$/i, /\.msi$/i];

/**
 * Pick one signed artifact per platform from a flat list of `{ name,
 * signature }`. Artifacts without a signature are not updater artifacts, and
 * artifacts of another version are stale leftovers — the update would be
 * rejected for its signature anyway.
 */
export function selectPlatformArtifacts({ version, artifacts = [] } = {}) {
  const wanted = parseVersion(version);
  const candidates = {};
  const skipped = [];
  for (const artifact of artifacts) {
    const name = String(artifact?.name ?? '').trim();
    const signature = String(artifact?.signature ?? '').trim();
    if (!name || !signature) continue;
    const platform = platformForArtifact(name);
    if (!platform) continue;
    const found = artifactVersion(name);
    if (found && wanted && found.join('.') !== wanted.join('.')) {
      skipped.push(name);
      continue;
    }
    const rank = PLATFORM_PREFERENCE.findIndex((re) => re.test(name));
    if (!candidates[platform] || rank < candidates[platform].rank) {
      candidates[platform] = { name, signature, rank };
    }
  }
  return { candidates, skipped };
}

/**
 * Build the `latest.json` for every platform in `artifacts` — the single
 * builder behind both a Windows and a Linux build, so two hosts end up with
 * one manifest instead of two halves to merge by hand.
 */
export function buildReleaseManifest({ version, notes = '', pubDate = null, baseUrl = DEFAULT_BASE_URL, artifacts = [] } = {}) {
  const { candidates, skipped } = selectPlatformArtifacts({ version, artifacts });
  const platforms = Object.keys(candidates).sort();
  if (!platforms.length) return { manifest: null, platforms, skipped };
  const base = String(baseUrl).replace(/\/$/, '');
  const manifest = buildUpdateManifest({
    version,
    notes,
    pubDate,
    platforms: Object.fromEntries(platforms.map((platform) => [platform, {
      url: `${base}/${candidates[platform].name}`,
      signature: candidates[platform].signature,
    }])),
  });
  return { manifest, platforms, skipped };
}

/**
 * The `latest.json` already in `dir`, when it describes `version`. Re-running
 * from the second host, or re-running the manifest step, must not throw away
 * the notes and date the release was first published with.
 */
export function readPreviousManifest(dir, version) {
  const existing = join(dir, MANIFEST_NAME);
  if (!existsSync(existing)) return null;
  try {
    const parsed = JSON.parse(readFileSync(existing, 'utf8'));
    return String(parsed?.version ?? '').trim() === String(version ?? '').trim().replace(/^v/, '') ? parsed : null;
  } catch {
    // A half-written manifest is simply replaced.
    return null;
  }
}

/** Every artifact in `dir` that has a `.sig` beside it, signature included. */
export function readSignedArtifacts(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.sig'))
    .map((sig) => {
      const name = sig.slice(0, -'.sig'.length);
      if (!existsSync(join(dir, name))) return null;
      return { name, signature: readFileSync(join(dir, sig), 'utf8') };
    })
    .filter(Boolean);
}

/* ── the command itself ────────────────────────────────────────────────── */

function bytes(path) {
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) total += bytes(join(path, entry.name));
  return total;
}

const megabytes = (size) => `${(size / 1024 / 1024).toFixed(1)} MB`;

function collect() {
  if (!existsSync(from)) {
    console.error(`nothing to collect: ${relative(root, from)} does not exist — run \`npm run tauri:build\` first`);
    return 1;
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
    return 1;
  }

  // A bundle kind this build produced replaces its older selves: a version bump
  // would otherwise leave the previous version's installer sitting beside the
  // new binary looking current. Other kinds are not this build's business, so
  // the other host's artifacts stay put.
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

  // A stale installer left in the bundle dir by an earlier build must not win
  // selection: its URL would be paired with the new build's signature, and the
  // updater would reject the artifact. Keep only the newest setup exe per arch.
  function compareVersion(a, b) {
    if (!a || !b) return 0;
    for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] - b[i];
    return String(a[3]).localeCompare(String(b[3]));
  }
  for (const name of [...copied]) {
    if (!/-setup\.exe$/i.test(name)) continue;
    const version = artifactVersion(name);
    const newer = copied.find(
      (other) => other !== name && /-setup\.exe$/i.test(other)
        && (other.toLowerCase().includes('aarch64') === name.toLowerCase().includes('aarch64'))
        && compareVersion(artifactVersion(other), version) > 0,
    );
    if (newer) {
      rmSync(join(to, name), { recursive: true, force: true });
      rmSync(join(to, `${name}.sig`), { force: true });
      copied.splice(copied.indexOf(name), 1);
      const bundle = bundles.find((entry) => entry.names.includes(name));
      if (bundle) bundle.names.splice(bundle.names.indexOf(name), 1);
    }
  }

  for (const name of copied) console.log(`release/${name}  ${megabytes(bytes(join(to, name)))}`);
  console.log(`\n${copied.length} artefact${copied.length === 1 ? '' : 's'} in release/`);
  return 0;
}

function writeManifest({ manifestOnly }) {
  if (!existsSync(to)) {
    console.error(`nothing to describe: ${relative(root, to)} does not exist — run \`npm run tauri:build\` first`);
    return 1;
  }

  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const version = String(pkg.version ?? '').trim();
  const artifacts = readSignedArtifacts(to);
  const previous = readPreviousManifest(to, version);

  const { manifest, platforms, skipped } = buildReleaseManifest({
    version,
    notes: process.env.MACUSANITE_UPDATE_NOTES ?? previous?.notes ?? `Macusanite ${version}`,
    pubDate: previous?.pub_date ?? new Date().toISOString(),
    baseUrl: process.env.MACUSANITE_UPDATE_BASE_URL ?? DEFAULT_BASE_URL,
    artifacts,
  });

  for (const name of skipped) console.log(`ignoring ${name} — not version ${version}`);

  if (!manifest) {
    const hint = 'no signed updater artefacts — set TAURI_SIGNING_PRIVATE_KEY and rebuild to generate release/latest.json (see docs/Updates.md)';
    if (manifestOnly) console.error(hint);
    else console.log(`\n${hint}`);
    return manifestOnly ? 1 : 0;
  }

  writeFileSync(join(to, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`release/${MANIFEST_NAME}  ${platforms.join(', ')}`);
  return 0;
}

function main(argv) {
  const manifestOnly = argv.includes('--manifest-only');
  if (manifestOnly) return writeManifest({ manifestOnly });
  const collected = collect();
  return collected === 0 ? writeManifest({ manifestOnly }) : collected;
}

const invokedDirectly = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (invokedDirectly) process.exit(main(process.argv.slice(2)));
