/**
 * Self-update plumbing for the Tauri shell.
 *
 * The updater itself lives in Rust (`tauri-plugin-updater`, configured in
 * `src-tauri/tauri.conf.json`): it fetches a static `latest.json` from the
 * GitHub release, verifies the artifact against the embedded public key, and
 * only then hands it to the JS side. This module is the JS half — the
 * check/download/install/restart flow, progress accounting, and the
 * `latest.json` builder used by `scripts/collect-release.mjs` — plus the
 * `updates.autoCheck` setting gate, so all of it can be tested without Tauri.
 *
 * In a plain browser there is no updater to talk to: `checkForUpdates`
 * resolves to `{ status: 'unavailable' }` and the UI says so instead of
 * pretending to have checked.
 */

/** Whether automatic update checks are on. Defaults to on; `false` opts out. */
export function isAutoCheckEnabled(settings) {
  return settings?.updates?.autoCheck !== false;
}

/**
 * Shape an announced update for the dialog: everything it shows, nothing it
 * should not. `date`/`body` are optional on the wire.
 */
export function summarizeUpdate(update) {
  if (!update) return null;
  return {
    version: String(update.version ?? ''),
    currentVersion: String(update.currentVersion ?? ''),
    date: update.date ?? null,
    notes: typeof update.body === 'string' && update.body.trim() ? update.body : '',
  };
}

/**
 * Tot up download progress from updater `DownloadEvent`s. Returns a fresh
 * snapshot each call so a dialog can render it straight away:
 * `{ downloaded, total, percent }` where `percent` is `null` until the total
 * is known.
 */
export function createProgressTracker() {
  let downloaded = 0;
  let total = null;
  const snapshot = () => ({
    downloaded,
    total,
    percent: total && total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : null,
  });
  return {
    onEvent(event) {
      if (!event) return snapshot();
      if (event.event === 'Started') {
        total = Number(event.data?.contentLength) || null;
        downloaded = 0;
      } else if (event.event === 'Progress') {
        downloaded += Number(event.data?.chunkLength) || 0;
      } else if (event.event === 'Finished') {
        if (total) downloaded = total;
      }
      return snapshot();
    },
    snapshot,
  };
}

import { isDesktop } from '../backend.js';

/**
 * Check for updates on the desktop. The updater plugin itself is imported
 * dynamically, so the browser build (and the test suite) never loads it:
 * a plain browser simply reports that updates are unavailable.
 *
 * @param {{ timeout?: number }} [options]
 * @returns {Promise<{ status: 'available', update: object } | { status: 'none' } | { status: 'unavailable', reason: string }>}
 */
export async function checkForUpdates(options = {}) {
  if (!isDesktop) return { status: 'unavailable', reason: 'Updates are only available in the desktop app.' };
  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    const update = await check({ timeout: options.timeout ?? 30_000 });
    if (!update) return { status: 'none' };
    return { status: 'available', update };
  } catch (error) {
    return { status: 'unavailable', reason: error?.message ?? String(error) };
  }
}

/**
 * Download and install an announced update, reporting progress, then restart
 * into the new version. On Windows the installer exits the app itself
 * (`install` never returns); on macOS/Linux we relaunch explicitly.
 */
export async function downloadInstallAndRestart(update, onProgress) {
  const tracker = createProgressTracker();
  await update.downloadAndInstall((event) => {
    onProgress?.(tracker.onEvent(event));
  });
  onProgress?.(tracker.snapshot());
  // Windows: already exited by the installer. macOS/Linux: relaunch.
  try {
    const { relaunch } = await import('@tauri-apps/plugin-process');
    await relaunch();
  } catch {
    /* the process plugin is unavailable — the new version starts next launch */
  }
}

/* ------------------------------------------------------------------ */
/* Static release manifest (latest.json)                               */
/* ------------------------------------------------------------------ */

/** Platform keys the static manifest accepts, in `OS-ARCH` form. */
export const UPDATE_PLATFORMS = ['windows-x86_64', 'windows-aarch64', 'darwin-x86_64', 'darwin-aarch64', 'linux-x86_64', 'linux-aarch64'];

/**
 * Build the static `latest.json` a GitHub release carries and the updater
 * fetches. Every platform entry needs both a URL and the *contents* of its
 * `.sig` file — Tauri validates the whole manifest before the version
 * check, so a half-written entry would break updates for every platform.
 *
 * @param {{ version: string, notes?: string, pubDate?: string, platforms: Record<string, { url: string, signature: string }> }} input
 */
export function buildUpdateManifest({ version, notes = '', pubDate = null, platforms = {} } = {}) {
  const cleanVersion = String(version ?? '').trim().replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(cleanVersion)) {
    throw new Error(`update manifest needs a semver version, got: ${version}`);
  }
  const cleanPlatforms = {};
  for (const [platform, entry] of Object.entries(platforms)) {
    if (!UPDATE_PLATFORMS.includes(platform)) {
      throw new Error(`unknown update platform: ${platform} (expected one of ${UPDATE_PLATFORMS.join(', ')})`);
    }
    const url = String(entry?.url ?? '').trim();
    const signature = String(entry?.signature ?? '').trim();
    if (!url) throw new Error(`update manifest platform ${platform} is missing a url`);
    if (!signature) throw new Error(`update manifest platform ${platform} is missing a signature`);
    cleanPlatforms[platform] = { signature, url };
  }
  if (!Object.keys(cleanPlatforms).length) {
    throw new Error('update manifest needs at least one platform with a url and signature');
  }
  const manifest = { version: cleanVersion, notes: String(notes ?? '') };
  if (pubDate) manifest.pub_date = pubDate;
  manifest.platforms = cleanPlatforms;
  return manifest;
}
