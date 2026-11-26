# Updates

Macusanite updates itself from signed GitHub releases. When the desktop application checks for an update, it reads the release's static `latest.json`, verifies the installer against the public key embedded in the application, and only then offers to download, install, and restart.

## How it works

- **Endpoint.** `src-tauri/tauri.conf.json` points the updater plugin at `https://github.com/h3rb/Macusanite/releases/latest/download/latest.json`. Because `createUpdaterArtifacts` is enabled, `tauri build` writes a `.sig` file next to each updater artifact: the NSIS setup executable on Windows, the `.app.tar.gz` archive on macOS, and the AppImage on Linux.
- **Install location.** On Windows the only bundle target is NSIS with `installMode: "currentUser"`, which installs the application per user into `%LOCALAPPDATA%\Macusanite` rather than into Program Files and never requires administrator rights. An update runs the same NSIS installer in `passive` mode against that folder, so `macusanite.exe` is replaced in place and the application restarts into the new version. The project ships neither an MSI package nor a per-machine installation that would need separate synchronization.
- **Check.** A few seconds after a vault opens, and unless automatic checks are disabled, the application asks the updater whether a newer version exists. The Settings → Updates → **Check for updates** command performs the same check on demand, even when automatic checks are disabled.
- **Prompt.** When an update is available, a dialog shows the new version and its release notes. The application does not install anything without confirmation; choosing **Download & restart** starts the download with progress, installs the verified package, and restarts into the new version. On Windows the installer closes the application, while on macOS and Linux the application relaunches itself.
- **Automatic checks.** Settings → Updates → **Check for updates automatically** stores the choice per vault as `updates.autoCheck` in `.macusanite/settings.json`, and the setting defaults to on. Disabling it cancels any check that is still waiting to run, while enabling it schedules a check within one second. A browser session has no updater, so it reports that limitation instead of offering an update.

## Signing keys

The public key is stored in `tauri.conf.json` under `plugins.updater.pubkey`, and it is safe to commit. The private key must never be committed; it lives at `~/.tauri/macusanite.key` on the build machine. If that key is lost, already-installed copies will reject future updates, so keep a secure backup.

Generate a fresh key pair in CI mode, without a password, by running:

```sh
npm run tauri signer generate -- --ci -p "" -w ~/.tauri/macusanite.key
```

Then copy the contents of `~/.tauri/macusanite.key.pub` into `plugins.updater.pubkey` in `tauri.conf.json`.

## Building a signed release

```sh
export TAURI_SIGNING_PRIVATE_KEY="$HOME/.tauri/macusanite.key"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
npm run tauri:build
```

The key variable may contain either the file path or the key contents, and `.env` files are not read because these values must be real environment variables. `scripts/collect-release.mjs`, which runs automatically after the build, copies the installers and their `.sig` files into `release/` and writes `release/latest.json` from the signatures. Set `MACUSANITE_UPDATE_NOTES` to provide the release notes shown in the dialog, and set `MACUSANITE_UPDATE_BASE_URL` when the artifacts are hosted somewhere other than the GitHub release.

An unsigned build still works as a normal installation, but it writes no update manifest, so installed copies never offer an update.

## Combining platforms

`release/latest.json` describes every platform whose signed artifacts are in `release/`, not only the platform that ran the build. After the second host has built, copy its installer and `.sig` into `release/` and rewrite the manifest without building again:

```sh
npm run release:manifest
```

That step — `node scripts/collect-release.mjs --manifest-only` — scans `release/` for installers with a `.sig` beside them, keeps the newest artifact per platform, and writes one manifest naming all of them, so the Windows installer and the Linux AppImage end up in the same file with neither signature copied by hand. Artifacts of an earlier version, and bundles the updater cannot install (the deb), are ignored. The notes and `pub_date` already in the manifest are kept, so the second host does not restate the release.

## Publishing

1. Bump the version in `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`.
2. Build a signed release as described above, and create the GitHub release for that tag.
3. Upload `release/latest.json`, every installer, AppImage, and `.app.tar.gz`, and all corresponding `.sig` files as release assets.

Installed copies then fetch `latest.json` from the latest release, compare its version with their own, and offer the signed update when a newer version is available. If the manifest omits a URL or signature for any platform it lists, the updater rejects the entire manifest, so publish the generated `latest.json` rather than editing it by hand.
