# Building Macusanite from scratch

Everything needed to go from a bare machine to a running desktop app and a
release artefact, on **Windows**, **macOS** and **Linux**.

The short version, once the platform prerequisites below are in place:

```bash
git clone <this repository> macusanite && cd macusanite
npm run setup                 # per-user Node LTS + Rust, no administrator rights
npm install
npm run tauri:dev             # run the desktop app
npm run tauri:build           # produce the release artefact
```

`npm run setup` installs **Node.js and Rust only**. It deliberately does not
touch system packages — on Windows that is the MSVC build tools and the WebView2
runtime, and on Linux it is the WebKitGTK development packages. Those are the
platform sections below, and they are the part that actually varies.

---

## 1. What is being built

| Piece | Technology | Needs |
| --- | --- | --- |
| The window | Rust + [Tauri 2](https://tauri.app), using the operating system's own webview | Rust toolchain, platform build tools, webview runtime |
| The interface | Plain ES modules, bundled by Vite 8 ([marked](https://marked.js.org), [mermaid](https://mermaid.js.org)) | Node.js |
| The CLI and the MCP server | Plain Node, no dependencies | Node.js — **no Rust, no webview, no build** |

So the whole headless half of Macusanite (documented in
[docs/Help.md](docs/Help.md)) runs with nothing but Node:

```bash
node cli/macusanite.mjs --help
node cli/macusanite.mjs vault create ./notes --sample
node cli/macusanite.mjs --vault ./notes mcp serve --port 8765
```

Versions this repository pins, and where they live:

| Version | Where it is declared |
| --- | --- |
| Node.js ≥ 20.19 (22.12+ recommended; the setup script installs 22 LTS) | Vite 8's requirement; `scripts/setup-toolchain.sh` defaults |
| Rust stable (this crate declares `rust-version = "1.77"`) | [src-tauri/Cargo.toml](src-tauri/Cargo.toml) |
| Tauri 2, `tauri-plugin-dialog`, `tauri-plugin-opener`, `notify` | [src-tauri/Cargo.toml](src-tauri/Cargo.toml) |
| `@tauri-apps/cli` ^2.12, `vite` ^8.3, `marked` ^18, `mermaid` ^12 | [package.json](package.json) |
| Bundle targets, icons, window defaults, macOS minimum 10.15 | [src-tauri/tauri.conf.json](src-tauri/tauri.conf.json) |

---

## 2. The one-command path (all platforms)

```bash
npm run setup        # == bash scripts/setup-toolchain.sh
```

It installs, per user, with no registry changes and no `sudo`:

* **Node.js LTS** (v22 line) into `~/.tools/node` — on macOS/Linux it uses your
  system Node when one is already on `PATH`;
* **Rust + cargo** via rustup into `~/.cargo` and `~/.rustup` (stable toolchain;
  on Windows the `x86_64-pc-windows-msvc` target).

Re-running is safe: every step is skipped when it is already present, and
downloads are cached in `~/.tools/.cache`.

The script does not edit your shell profile, so add the toolchain to `PATH` for
the session (the script prints this too):

```bash
# Git Bash / macOS / Linux
export PATH="$HOME/.tools/node/bin:$HOME/.cargo/bin:$PATH"

# PowerShell (Windows)
$env:PATH = "$HOME\.tools\node;$HOME\.cargo\bin;$env:PATH"
```

Confirm before going further:

```bash
node -v      # v20.19+ (v22.x expected)
npm -v
cargo -V
rustc -V
```

**Windows users need Git for Windows**, because `npm run setup` is a bash script.
Everything else is ordinary Node/Rust tooling.

If you prefer to install the toolchain yourself — `winget`, Homebrew, your
distribution's packages, or <https://rustup.rs> — skip this section and just make
sure the checks above pass. `npm run setup` is a convenience, not a requirement.

---

## 3. Windows

### Prerequisites

| Requirement | Why | How |
| --- | --- | --- |
| Windows 10 (1803+) or Windows 11, x64 | supported platform | — |
| **Visual Studio 2022 Build Tools**, workload **Desktop development with C++** | Rust's MSVC toolchain needs `link.exe`, and Tauri links a native binary | <https://visualstudio.microsoft.com/visual-cpp-build-tools/> — select *Desktop development with C++* (MSVC v143 build tools + a Windows SDK) |
| **WebView2 runtime** | the app's window *is* WebView2 | preinstalled on Windows 11 and Windows 10 1803+; otherwise install the [Evergreen runtime](https://developer.microsoft.com/microsoft-edge/webview2/) |
| Node.js ≥ 20.19 | Vite 8 | `npm run setup`, or `winget install OpenJS.NodeJS.LTS` |
| Rust stable (MSVC) | the shell | `npm run setup`, or the [rustup-init.exe](https://rustup.rs) installer |
| Git for Windows | `bash` for `npm run setup` and the sample scripts | `winget install Git.Git` |

Path to the compiler, if `cargo build` cannot find `link.exe`: run the commands
from a **Developer Command Prompt for VS 2022**, or install the Build Tools with
the *C++ build tools* workload and reopen your shell.

### Build

```powershell
cd macusanite
npm run setup
npm install
npm run tauri:dev      # dev window, hot reload against the Vite dev server
npm run tauri:build    # release
```

Artefacts:

| File | What it is |
| --- | --- |
| `src-tauri\target\release\Macusanite.exe` | the portable binary (~5 MB) — copy it anywhere, WebView2 is the only runtime it needs |
| `src-tauri\target\release\bundle\nsis\Macusanite_0.1.0_x64-setup.exe` | the installer (~2.6 MB; NSIS is fetched by Tauri's bundler on first use) |

`src-tauri\tauri.conf.json` sets `bundle.targets: ["nsis"]`, so `tauri:build` on
Windows produces exactly that installer. To also produce an MSI you would need
WiX and a `--bundles msi` run; this project does not.

### Notes

* **Long paths.** Deep `node_modules` plus Rust's target directory can exceed the
  legacy 260-character limit. Enable long paths once (elevated PowerShell):

  ```powershell
  New-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" `
    -Name LongPathsEnabled -Value 1 -PropertyType DWORD -Force
  ```

* **Defender.** Excluding `node_modules`, `src-tauri\target` and `~\.cargo` from
  real-time scanning is the difference between a two-minute and a ten-minute
  release build.
* **Windows on ARM.** The app builds natively for `aarch64-pc-windows-msvc` (add
  that rustup target and the *MSVC v143 ARM64 build tools* component), but the
  NSIS installer itself stays x86 and runs under emulation.
* **A blank window right after a forced kill** is WebView2 residue, not a build
  problem: close the app gracefully (or `taskkill /IM Macusanite.exe`), and the
  next launch is clean.

---

## 4. macOS

### Prerequisites

| Requirement | Why | How |
| --- | --- | --- |
| macOS with **Xcode Command Line Tools** | `clang`, the SDK, the linker | `xcode-select --install` |
| Node.js ≥ 20.19 | Vite 8 | `npm run setup`, or `brew install node` |
| Rust stable | the shell | `npm run setup`, or `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |

No extra system libraries: macOS ships the webview (WKWebView).

### Build

```bash
cd macusanite
npm run setup
npm install
npm run tauri:dev
npm run tauri:build -- --bundles app,dmg
```

Artefacts (defaults for `.app` and `.dmg`):

| Path | What it is |
| --- | --- |
| `src-tauri/target/release/bundle/macos/Macusanite.app` | the application bundle |
| `src-tauri/target/release/bundle/dmg/Macusanite_*.dmg` | the disk image |

**Pass `--bundles` explicitly on macOS.** The repository's
`bundle.targets` is `["nsis"]`, which is the Windows installer format; without
the flag the bundler has nothing it can produce on this platform. `app,dmg` is
the natural pair.

### Notes

* **Architecture.** A plain build targets the host (`aarch64-apple-darwin` on
  Apple Silicon, `x86_64-apple-darwin` on Intel). For one binary that runs
  everywhere:

  ```bash
  rustup target add aarch64-apple-darwin x86_64-apple-darwin
  npm run tauri:build -- --target universal-apple-darwin --bundles app,dmg
  ```

* **Gatekeeper.** A locally built, unsigned `.app` is quarantined when it is
  copied from another machine; `xattr -dr com.apple.quarantine Macusanite.app`
  clears that. Signing and notarisation need an Apple Developer certificate and
  are out of scope here.
* **Minimum system version.** `bundle.macOS.minimumSystemVersion` is `10.15` in
  [src-tauri/tauri.conf.json](src-tauri/tauri.conf.json). Raise it if you build
  with newer SDK features; lowering it is not a promise the webview APIs you use
  are available.
* **Apple Silicon + Rosetta** is only relevant if you run an Intel toolchain;
  the native arm64 path needs no Rosetta.

---

## 5. Linux

Unlike the other two platforms, Linux needs **system development packages**
before any Rust can link. These are the packages that provide WebKitGTK 4.1 — the
webview engine Tauri 2 uses.

### Debian / Ubuntu (and derivatives)

```bash
sudo apt update
sudo apt install -y libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

### Fedora / RHEL-family

```bash
sudo dnf check-update
sudo dnf install -y webkit2gtk4.1-devel openssl-devel curl wget file \
  libappindicator-gtk3-devel librsvg2-devel
sudo dnf group install -y "C Development Tools and Libraries"
```

### Arch / Manjaro

```bash
sudo pacman -Syu
sudo pacman -S --needed webkit2gtk-4.1 base-devel curl wget file \
  openssl appmenu-gtk-module libappindicator-gtk3 librsvg xdotool
```

Node.js ≥ 20.19 and Rust stable are the same everywhere:

```bash
npm run setup        # or: your distribution's node + https://rustup.rs
```

### Build

```bash
cd macusanite
npm run setup
npm install
npm run tauri:dev
npm run tauri:build -- --bundles deb,appimage
```

Artefacts:

| Path | What it is |
| --- | --- |
| `src-tauri/target/release/macusanite` | the plain binary (named after the Cargo package) |
| `src-tauri/target/release/bundle/deb/*.deb` | Debian package (pulls `libwebkit2gtk-4.1-0` and `libgtk-3-0` at install time) |
| `src-tauri/target/release/bundle/appimage/*.AppImage` | self-contained AppImage |

As on macOS, pass `--bundles` explicitly: the repository's `bundle.targets` is
the Windows `nsis` one.

### Notes

* **Build on old, run on new.** glibc compatibility is inherited from the build
  machine, so build releases on the oldest distribution you intend to support
  that still ships WebKitGTK 4.1 — Ubuntu 22.04 and Debian 12 are the usual
  baselines.
* **AppImage at runtime** needs FUSE. It is present almost everywhere;
  `sudo apt install libfuse2` fixes Ubuntu 22.04, and Ubuntu 24.04 names the
  package `libfuse2t64`. `chmod +x macusanite_0.1.0_amd64.AppImage` before running
  it, and extract with `--appimage-extract` if FUSE is unavailable.
* **Headless build hosts** (CI containers, servers) cannot run the app without an
  X/Wayland display; add `xvfb-run` if you want to smoke-test the window. The
  tests do not need a display at all.
* **Wayland** is supported by WebKitGTK 4.1; if a window misbehaves under
  Wayland, `WEBKIT_DISABLE_COMPOSITING_MODE=1` or `GDK_BACKEND=x11` are the usual
  escape hatches.

---

## 6. Every build command

| Command | What it does | Needs |
| --- | --- | --- |
| `npm run setup` | per-user Node LTS + Rust | bash (Git Bash on Windows) |
| `npm install` | frontend dependencies (Vite, marked, mermaid, the Tauri CLI) | Node |
| `npm run dev` | the interface in a browser against an in-memory sample vault — no Rust, no Tauri | Node |
| `npm run harness` | the same, on a fixed port (1421) | Node |
| `npm run build` | bundle the interface into `dist/` (`index.html` and `help.html`) | Node |
| `npm run tauri:dev` | the real desktop window, hot reload | everything |
| `npm run tauri:build` | release binary + installer (runs `npm run build` first) | everything |
| `npm test` | 170 JavaScript tests (`node --test`, no browser needed) | Node |
| `npm run test -- tests/node/mcp.test.js` | one suite | Node |
| `cargo test --manifest-path src-tauri/Cargo.toml` | 30 Rust tests (paths, scanning, writes, undo/redo, watcher) | Rust |
| `npm run docs` | regenerate [docs/Help.md](docs/Help.md) from the catalogue | Node |
| `npm run docs:check` | fail if the manual is out of date (used by the tests) | Node |
| `npm run vault:sample` | write the bundled sample vault to `reference-vault/` | Node |
| `npm run icons` | regenerate every platform icon from a PNG built with `node:zlib` — offline, no image tools | Node + Tauri CLI |
| `npm run cli -- --help` | the CLI (same as `node cli/macusanite.mjs`) | Node |
| `npm run mcp` | the MCP server on `http://127.0.0.1:8765/mcp` | Node |

Cargo can be driven directly too: `--manifest-path src-tauri/Cargo.toml` makes the
usual `cargo build`, `cargo check` and `cargo clippy` work from the repository
root. `cargo check` is much faster than a release build when you are only
verifying that the Rust half compiles.

---

## 7. Verifying the install

A build that produced files is not the same as a working installation. This is
the checklist, in order, cheapest first:

```bash
# 1. the logic (no display, no Rust, ~3 s)
npm test                                   # expect: 170 pass, 0 fail
npm run docs:check                         # expect: docs in sync

# 2. the Rust half
cargo test --manifest-path src-tauri/Cargo.toml    # expect: 30 pass

# 3. the interface bundle (both pages must be emitted)
npm run build && ls dist/index.html dist/help.html

# 4. a real vault, through the real CLI
npm run vault:sample
node cli/macusanite.mjs --vault reference-vault vault stats
node cli/macusanite.mjs --vault reference-vault search fluid

# 5. the headless MCP server, as an agent would use it
node cli/macusanite.mjs --vault reference-vault mcp serve --port 8765
curl -s http://127.0.0.1:8765/health       # expect: {"ok":true,...}
```

Then the desktop app itself:

```bash
npm run tauri:dev
```

and check, in the window: the vault opens with its name in the top bar, `Ctrl+K`
jumps to a vein, `Ctrl+F` finds text, `F1` (or the **?** button, or
**☰ → Help and manual**) opens the manual in its **own window**, and typing in
that window's search box filters the sections.

With the window still open and that vault loaded, edit `.macusanite/settings.json`
by hand — flip `"theme"` and save:

```bash
# GNU sed / BSD sed differ on -i, so write through a temporary file
sed 's/"theme": "dark"/"theme": "light"/' \
  reference-vault/.macusanite/settings.json > /tmp/s.json && mv /tmp/s.json \
  reference-vault/.macusanite/settings.json
```

The window must change theme without a reload, and
`reference-vault/.macusanite/logs/session-*.log` must gain
`applied from disk (edited outside the viewer): .macusanite/settings.json`. A
hand-edit to `colors.json` behaves the same way; a *save you make in the window*
must never produce that line.

For a release build, run the produced artefact — the portable binary or
`Macusanite.app` — once before shipping it, and open a vault from your own disk
rather than the bundled sample.

---

## 8. Cross-compiling

Don't. Tauri links against the platform's webview and system libraries, so the
realistic answer is to build on each target operating system (a Windows VM, a Mac
or a CI runner per platform). The exceptions worth knowing:

* **Windows ARM64** from an x64 Windows host, with the ARM64 MSVC component and
  `rustup target add aarch64-pc-windows-msvc`.
* **macOS universal** (`--target universal-apple-darwin`) built on macOS, as above.
* A `.deb` or AppImage can be built inside a container of the *oldest* supported
  Ubuntu, which is how you keep glibc compatibility without keeping an old
  machine.

---

## 9. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `link.exe not found` / `LINK : fatal error` | MSVC build tools missing, or not on `PATH` | install *Desktop development with C++*, and run from a Developer Command Prompt |
| The window opens blank, with no error | WebView2 runtime missing (Windows) | install the Evergreen runtime; on Windows 11 it is already there |
| `error: unrecognized command-line option ...` from `cc` on macOS | Xcode Command Line Tools missing or outdated | `xcode-select --install`, then `xcode-select -p` to confirm |
| `pkg-config could not find webkit2gtk-4.1` / build script errors mentioning gtk | Linux system packages missing | install the packages in [section 5](#5-linux) for your distribution |
| `Cannot find package 'vite'` or Vite complains about Node | Node too old (Vite 8 needs 20.19+/22.12+) | `npm run setup`, or upgrade Node, then delete `node_modules` and reinstall |
| `tauri:build` errors that no bundle target applies (macOS/Linux) | `bundle.targets` is `["nsis"]` in this repo | pass `--bundles app,dmg` or `--bundles deb,appimage` |
| The AppImage will not start | FUSE missing, or not executable | `chmod +x`, install `libfuse2`/`libfuse2t64`, or run with `--appimage-extract` |
| Blank window straight after a hard `taskkill` (Windows) | WebView2 profile residue from the force-kill | close gracefully; the next launch is clean |
| `docs:check` fails after editing the manual | `docs/Help.md` is generated, not hand-written | `npm run docs` and commit the result |
| `npm install` fails behind a proxy | npm cannot reach the registry | set `npm_config_proxy` / `npm_config_https_proxy`, or use a registry mirror |

---

## 10. Offline and no-administrator installs

* `npm run setup` needs no administrator rights on any platform: Node goes into
  `~/.tools/node` and Rust into `~/.cargo` / `~/.rustup`.
* After the first `npm install`, the frontend build works offline. `npm run icons`
  needs nothing but `node:zlib`.
* An offline Windows installer is a WebView2 configuration choice rather than a
  build-system one: Tauri's NSIS bundle downloads the WebView2 bootstrapper by
  default, and `bundle.windows.webviewInstallMode` can embed it instead
  (`embedBootstrapper`, or `offlineInstaller` at the cost of ~127 MB).
* A release build needs no network at all once the Rust dependency tree and npm
  packages are cached — except the first `tauri:build`, which fetches NSIS on
  Windows.
