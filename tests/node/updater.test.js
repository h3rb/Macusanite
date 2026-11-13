import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isAutoCheckEnabled,
  summarizeUpdate,
  createProgressTracker,
  buildUpdateManifest,
} from '../../src/lib/updater.js';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/lib/settings.js';

test('automatic update checks default to on and can be turned off', () => {
  assert.equal(isAutoCheckEnabled(DEFAULT_SETTINGS), true);
  assert.equal(isAutoCheckEnabled({}), true);
  assert.equal(isAutoCheckEnabled({ updates: { autoCheck: false } }), false);
  assert.equal(isAutoCheckEnabled({ updates: { autoCheck: true } }), true);
});

test('the autoCheck setting survives a settings round trip', () => {
  const off = mergeSettings(DEFAULT_SETTINGS, { updates: { autoCheck: false } });
  assert.equal(off.updates.autoCheck, false);
  const junk = mergeSettings(DEFAULT_SETTINGS, { updates: { autoCheck: 'yes' } });
  // Anything that is not literally `false` means on.
  assert.equal(junk.updates.autoCheck, true);
});

test('summarizeUpdate shapes what the dialog shows', () => {
  assert.equal(summarizeUpdate(null), null);
  assert.deepEqual(
    summarizeUpdate({ version: '0.2.0', currentVersion: '0.1.0', date: '2026-11-13T00:00:00Z', body: '  Notes  ' }),
    { version: '0.2.0', currentVersion: '0.1.0', date: '2026-11-13T00:00:00Z', notes: '  Notes  ' },
  );
  assert.equal(summarizeUpdate({ version: '0.2.0' }).notes, '');
});

test('the progress tracker totals chunks into a percent', () => {
  const tracker = createProgressTracker();
  assert.deepEqual(tracker.snapshot(), { downloaded: 0, total: null, percent: null });
  tracker.onEvent({ event: 'Started', data: { contentLength: 200 } });
  tracker.onEvent({ event: 'Progress', data: { chunkLength: 50 } });
  assert.deepEqual(tracker.snapshot(), { downloaded: 50, total: 200, percent: 25 });
  tracker.onEvent({ event: 'Progress', data: { chunkLength: 200 } });
  // Never reports more than the whole file.
  assert.equal(tracker.snapshot().percent, 100);
  tracker.onEvent({ event: 'Finished' });
  assert.equal(tracker.snapshot().downloaded, 200);
});

test('the progress tracker works without a known total', () => {
  const tracker = createProgressTracker();
  tracker.onEvent({ event: 'Progress', data: { chunkLength: 10 } });
  tracker.onEvent({ event: 'Progress', data: { chunkLength: 5 } });
  assert.deepEqual(tracker.snapshot(), { downloaded: 15, total: null, percent: null });
});

test('buildUpdateManifest writes the static latest.json shape', () => {
  const manifest = buildUpdateManifest({
    version: 'v0.2.0',
    notes: 'Release notes',
    pubDate: '2026-11-13T00:00:00.000Z',
    platforms: {
      'windows-x86_64': { url: 'https://example.test/setup.exe', signature: 'sig-windows' },
      'darwin-aarch64': { url: 'https://example.test/app.tar.gz', signature: 'sig-mac' },
    },
  });
  assert.equal(manifest.version, '0.2.0');
  assert.equal(manifest.notes, 'Release notes');
  assert.equal(manifest.pub_date, '2026-11-13T00:00:00.000Z');
  assert.deepEqual(manifest.platforms['windows-x86_64'], { signature: 'sig-windows', url: 'https://example.test/setup.exe' });
});

test('buildUpdateManifest refuses an incomplete manifest', () => {
  assert.throws(() => buildUpdateManifest({ version: 'not-semver', platforms: { 'windows-x86_64': { url: 'u', signature: 's' } } }), /semver/);
  assert.throws(() => buildUpdateManifest({ version: '0.2.0', platforms: {} }), /at least one platform/);
  assert.throws(() => buildUpdateManifest({ version: '0.2.0', platforms: { 'windows-x86_64': { url: 'u' } } }), /signature/);
  assert.throws(() => buildUpdateManifest({ version: '0.2.0', platforms: { 'windows-x86_64': { signature: 's' } } }), /url/);
  assert.throws(() => buildUpdateManifest({ version: '0.2.0', platforms: { 'amiga-68k': { url: 'u', signature: 's' } } }), /unknown update platform/);
});
