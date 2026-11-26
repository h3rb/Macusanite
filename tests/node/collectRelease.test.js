import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_BASE_URL,
  PLATFORM_PREFERENCE,
  artifactVersion,
  buildReleaseManifest,
  platformForArtifact,
  readPreviousManifest,
  readSignedArtifacts,
} from '../../scripts/collect-release.mjs';

// `release/` is shared by every build host, so the manifest step sees installers
// from both and must describe all of them at once — the merge that used to be
// done by hand after two builds.
function withReleaseDir(files) {
  const dir = mkdtempSync(join(tmpdir(), 'macusanite-release-'));
  for (const [name, contents] of Object.entries(files)) writeFileSync(join(dir, name), contents);
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('collect-release names every platform whose signed artifact is in release/', () => {
  const { dir, done } = withReleaseDir({
    'Macusanite_0.1.16_x64-setup.exe': 'windows installer',
    'Macusanite_0.1.16_x64-setup.exe.sig': 'sig-windows\n',
    'Macusanite_0.1.16_amd64.AppImage': 'linux appimage',
    'Macusanite_0.1.16_amd64.AppImage.sig': 'sig-linux\n',
  });
  try {
    // The Windows build wrote the manifest; the Linux files were copied in from
    // the other host afterwards, and the step then ran on its own.
    const { manifest, platforms, skipped } = buildReleaseManifest({
      version: '0.1.16',
      notes: 'Release 0.1.16',
      pubDate: '2026-11-24T00:00:00.000Z',
      artifacts: readSignedArtifacts(dir),
    });
    assert.deepEqual(platforms, ['linux-x86_64', 'windows-x86_64']);
    assert.deepEqual(skipped, []);
    assert.equal(manifest.version, '0.1.16');
    assert.deepEqual(manifest.platforms['windows-x86_64'], {
      signature: 'sig-windows',
      url: `${DEFAULT_BASE_URL}Macusanite_0.1.16_x64-setup.exe`,
    });
    assert.deepEqual(manifest.platforms['linux-x86_64'], {
      signature: 'sig-linux',
      url: `${DEFAULT_BASE_URL}Macusanite_0.1.16_amd64.AppImage`,
    });
  } finally {
    done();
  }
});

test('a second host adds its platform without dropping the first one or its notes', () => {
  const { dir, done } = withReleaseDir({
    'Macusanite_0.1.16_x64-setup.exe': 'windows installer',
    'Macusanite_0.1.16_x64-setup.exe.sig': 'sig-windows',
  });
  try {
    const first = buildReleaseManifest({
      version: '0.1.16',
      notes: 'Release 0.1.16',
      pubDate: '2026-11-24T00:00:00.000Z',
      artifacts: readSignedArtifacts(dir),
    }).manifest;
    writeFileSync(join(dir, 'latest.json'), JSON.stringify(first, null, 2));

    writeFileSync(join(dir, 'Macusanite_0.1.16_amd64.AppImage'), 'linux appimage');
    writeFileSync(join(dir, 'Macusanite_0.1.16_amd64.AppImage.sig'), 'sig-linux');

    // The manifest step reuses the published notes and date, and picks up the
    // platform the second host brought with it.
    const previous = readPreviousManifest(dir, '0.1.16');
    assert.equal(previous.notes, 'Release 0.1.16');
    const merged = buildReleaseManifest({
      version: '0.1.16',
      notes: previous.notes,
      pubDate: previous.pub_date,
      artifacts: readSignedArtifacts(dir),
    }).manifest;
    assert.deepEqual(Object.keys(merged.platforms), ['linux-x86_64', 'windows-x86_64']);
    assert.equal(merged.notes, 'Release 0.1.16');
    assert.equal(merged.pub_date, '2026-11-24T00:00:00.000Z');
    assert.equal(merged.platforms['windows-x86_64'].signature, 'sig-windows');
  } finally {
    done();
  }
});

test('an older artifact in release/ never reaches the manifest', () => {
  const { dir, done } = withReleaseDir({
    'Macusanite_0.1.15_amd64.AppImage': 'old appimage',
    'Macusanite_0.1.15_amd64.AppImage.sig': 'sig-old',
    'Macusanite_0.1.16_amd64.AppImage': 'new appimage',
    'Macusanite_0.1.16_amd64.AppImage.sig': 'sig-new',
  });
  try {
    const { manifest, platforms, skipped } = buildReleaseManifest({
      version: '0.1.16',
      artifacts: readSignedArtifacts(dir),
    });
    assert.deepEqual(platforms, ['linux-x86_64']);
    assert.deepEqual(skipped, ['Macusanite_0.1.15_amd64.AppImage']);
    assert.equal(manifest.platforms['linux-x86_64'].signature, 'sig-new');
    assert.match(manifest.platforms['linux-x86_64'].url, /Macusanite_0\.1\.16_amd64\.AppImage$/);
  } finally {
    done();
  }
});

test('the NSIS installer wins over an MSI for the same Windows platform', () => {
  const artifacts = [
    { name: 'Macusanite_0.1.16_x64_en-US.msi', signature: 'sig-msi' },
    { name: 'Macusanite_0.1.16_x64-setup.exe', signature: 'sig-nsis' },
  ];
  assert.ok(PLATFORM_PREFERENCE[0].test('Macusanite_0.1.16_x64-setup.exe'));
  const { manifest } = buildReleaseManifest({ version: '0.1.16', artifacts });
  assert.equal(manifest.platforms['windows-x86_64'].signature, 'sig-nsis');
});

test('only installers the updater can install get a platform', () => {
  assert.equal(platformForArtifact('Macusanite_0.1.16_amd64.deb'), null);
  assert.equal(platformForArtifact('Macusanite_0.1.16_amd64.AppImage'), 'linux-x86_64');
  assert.equal(platformForArtifact('Macusanite_0.1.16_aarch64.app.tar.gz'), 'darwin-aarch64');
  assert.equal(platformForArtifact('Macusanite_0.1.16_x64-setup.exe'), 'windows-x86_64');

  const { manifest, platforms } = buildReleaseManifest({
    version: '0.1.16',
    artifacts: [
      { name: 'Macusanite_0.1.16_amd64.deb', signature: 'sig-deb' },
      { name: 'Macusanite_0.1.16_amd64.AppImage', signature: '' },
    ],
  });
  // A deb alone, or an artifact without its signature, is not an update.
  assert.equal(manifest, null);
  assert.deepEqual(platforms, []);
});

test('installer names carry the version the manifest is checked against', () => {
  assert.deepEqual(artifactVersion('Macusanite_0.1.16_x64-setup.exe'), [0, 1, 16, '']);
  assert.deepEqual(artifactVersion('Macusanite_0.2.0-beta.1_amd64.AppImage'), [0, 2, 0, 'beta.1']);
  assert.equal(artifactVersion('Macusanite.app.tar.gz'), null);
});

test('readSignedArtifacts ignores signatures whose artifact is gone', () => {
  const { dir, done } = withReleaseDir({
    'Macusanite_0.1.16_amd64.AppImage': 'linux appimage',
    'Macusanite_0.1.16_amd64.AppImage.sig': 'sig-linux',
    'Macusanite_0.1.15_x64-setup.exe.sig': 'sig-orphan',
    'release-notes-0.1.16.md': 'notes',
  });
  try {
    assert.deepEqual(readSignedArtifacts(dir), [
      { name: 'Macusanite_0.1.16_amd64.AppImage', signature: 'sig-linux' },
    ]);
  } finally {
    done();
  }
});
