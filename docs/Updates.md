# Updates

Macusanite updates itself from signed GitHub releases. The desktop app checks
the release's static `latest.json` for a newer version, verifies the installer
against the public key embedded in the app, and only then offers to download,
install and restart.

## How it works

- **Endpoint.** `src-tauri/tauri.conf.json` points the updater plugin at
  `https://github.com/h3rb/Macusanite/releases/latest/download/latest.json`.
  `createUpdaterArtifacts` is on, so `tauri build` emits a `.sig` next to each
  updater artifact (NSIS setup exe on Windows, `.app.tar.gz` on macOS,
  AppImage on Linux).
- **Where the installed app lives.** On Windows the only bundle target is
  NSIS with `installMode: "currentUser"`, so the app installs per user into
  `%LOCALAPPDATA%\Macusanite` (AppData) — never Program Files, never with
  admin rights. An update is the same NSIS installer run by the updater in
  `passive` mode against that same folder: `macusanite.exe` is replaced in
  place, the same way the portable `macusanite.exe` is replaced, and the app
  restarts into the new version. There is no MSI and no per-machine install
  to keep in sync.
- **Check.** A few seconds after a vault opens — unless automatic checks are
  off — the app asks the updater for a newer version. Settings → Updates →
  **Check for updates** checks on demand at any time, even when automatic
  checks are off.
- **Prompt.** An available update opens a dialog with the new version and its
  release notes. Nothing installs itself: **Download & restart** starts the
  download (with progress), installs the verified package, and restarts into
  the new version. On Windows the installer exits the app; on macOS/Linux the
  app relaunches itself.
- **The off switch.** Settings → Updates → **Check for updates automatically**
  (persisted per vault as `updates.autoCheck` in `.macusanite/settings.json`,
  default on). Turning it off cancels any check still waiting to run;
  turning it back on checks within a second. A plain browser has no updater
  and reports that instead of pretending.

## Signing keys

The public key is in `tauri.conf.json` under `plugins.updater.pubkey` — it is
safe to commit. The private key is **never** in the repo: it lives at
`~/.tauri/macusanite.key` on the build machine. If it is lost, already-
installed copies will refuse new updates, so keep a backup somewhere safe.

Generate a fresh pair (CI mode, no password) with:

```sh
npm run tauri signer generate -- --ci -p "" -w ~/.tauri/macusanite.key
```

Then put the new `~/.tauri/macusanite.key.pub` contents into
`plugins.updater.pubkey` in `tauri.conf.json`.

## Building a signed release

```sh
export TAURI_SIGNING_PRIVATE_KEY="$HOME/.tauri/macusanite.key"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
npm run tauri:build
```

The key may be the file path or its contents; `.env` files do not work —
these must be real environment variables. `scripts/collect-release.mjs`
(ran automatically after the build) copies the installers and their `.sig`
files into `release/` and writes `release/latest.json` from the signatures.
Set `MACUSANITE_UPDATE_NOTES` for the release notes shown in the dialog and
`MACUSANITE_UPDATE_BASE_URL` if the artifacts are hosted somewhere other than
the GitHub release.

An unsigned build still works as a normal install; it just writes no
manifest and its copies never offer an update.

## Publishing

1. Bump the version in `package.json`, `src-tauri/Cargo.toml` and
   `src-tauri/tauri.conf.json`.
2. Build signed (above) and create the GitHub release for that tag.
3. Upload `release/latest.json` plus every installer/AppImage/`.app.tar.gz`
   (and their `.sig` files) as release assets.

Installed copies then fetch `latest.json` from the latest release, see the
newer version, and offer the signed update. A manifest with a missing URL or
signature for any platform it lists is rejected as a whole, so always publish
the generated `latest.json` rather than editing it by hand.
