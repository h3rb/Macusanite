# Building Macusanite from scratch

This guide covers everything required to go from a bare machine to a running desktop application and a release artefact on **Windows**, **macOS** and **Linux**.

Once the platform prerequisites described below are in place, the short version is:

```bash
git clone <this repository> macusanite && cd macusanite
npm run setup                 # per-user Node LTS + Rust, no administrator rights
npm install
npm run tauri:dev             # run the desktop app
npm run tauri:build           # produce the release artefact
```

`npm run setup` installs **Node.js and Rust only**, because it deliberately leaves system packages to the platform-specific instructions. On Windows those packages are the MSVC build tools and the WebView2 runtime, and on Linux they are the WebKitGTK development packages. The platform sections below cover those dependencies, and they are the parts that differ between operating systems.

---

## 1. What is being built

| Piece | Technology | Needs |
| --- | --- | --- |
| The window | Rust + [Tauri 2](https://tauri.app), using the operating system's own webview | Rust toolchain, platform build tools, webview runtime |
| The interface | Plain ES modules, bundled by Vite 8 ([marked](https://marked.js.org), [mermaid](https://mermaid.js.org)) | Node.js |
| The CLI and the MCP server | Plain Node, no dependencies | Node.js — **no Rust, no webview, no build** |

The entire headless half of Macusanite, which is documented in [docs/Help.md](docs/Help.md), therefore runs with Node alone:

```bash
node cli/macusanite.mjs --help
node cli/macusanite.mjs vault create ./notes --sample
node cli/macusanite.mjs --vault ./notes mcp serve --port 8765
```

The repository pins the following versions, which are declared in the files listed beside them:

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

The script installs the toolchain per user without changing the registry and without requiring `sudo`:

* **Node.js LTS** (v22 line) into `~/.tools/node` — on macOS/Linux it uses your system Node when one is already on `PATH`;
* **Rust and cargo** through rustup into `~/.cargo` and `~/.rustup` (stable toolchain; on Windows the `x86_64-pc-windows-msvc` target).

Re-running the script is safe, because every step is skipped when it is already present and downloads are cached in `~/.tools/.cache`.

The script does not modify the shell profile, so the toolchain must be added to `PATH` for the current session; the script also prints the relevant command:

```bash
# Git Bash / macOS / Linux
export PATH="$HOME/.tools/node/bin:$HOME/.cargo/bin:$PATH"

# PowerShell (Windows)
$env:PATH = "$HOME\.tools\node;$HOME\.cargo\bin;$env:PATH"
```

Confirm the installation before continuing:

```bash
node -v      # v20.19+ (v22.x expected)
npm -v
cargo -V
rustc -V
```

**Windows users need Git for Windows**, because `npm run setup` is a bash script; all other tooling is ordinary Node and Rust software.

If you prefer to install the toolchain yourself with `winget`, Homebrew, your distribution's packages or <https://rustup.rs>, you can skip this section and simply ensure that the checks above pass. `npm run setup` is a convenience rather than a requirement.

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

If `cargo build` cannot find `link.exe`, run the commands from a **Developer Command Prompt for VS 2022**, or install the Build Tools with the *C++ build tools* workload and reopen the shell.

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
| `release\macusanite.exe` | the portable binary (~5.6 MB, named after the Cargo package) — copy it anywhere, WebView2 is the only runtime it needs |
| `release\Macusanite_0.1.0_x64-setup.exe` | the installer (~2.6 MB; NSIS is fetched by Tauri's bundler on first use) |

`tauri:build` collects both files into `release/` at the top of the repository, while the same files also remain under `src-tauri\target\release\`, which is Cargo's build cache. The collector never empties `release/`. It overwrites only the files produced by the current build and removes older bundles of its own kind, so artefacts built on another platform remain in place.

`src-tauri\tauri.conf.json` sets `bundle.targets: ["nsis"]`, so `tauri:build` on Windows produces exactly that installer. Producing an MSI as well would require WiX and a separate `--bundles msi` run, which this project does not use.

### Notes

* **Long paths.** Deep `node_modules` directories combined with Rust's target directory can exceed the legacy 260-character limit. Enable long paths once in an elevated PowerShell session:

  ```powershell
  New-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" `
    -Name LongPathsEnabled -Value 1 -PropertyType DWORD -Force
  ```

* **Defender.** Excluding `node_modules`, `src-tauri\target` and `~\.cargo` from real-time scanning can reduce a release build from roughly ten minutes to roughly two.
* **Windows on ARM.** The application builds natively for `aarch64-pc-windows-msvc`, provided that the rustup target and the *MSVC v143 ARM64 build tools* component are installed, but the NSIS installer itself remains x86 and runs under emulation.
* **A blank window immediately after a forced kill** is WebView2 residue rather than a build problem. Close the application gracefully, or run `taskkill /IM Macusanite.exe`, and the next launch will be clean.

---

## 4. macOS

### Prerequisites

| Requirement | Why | How |
| --- | --- | --- |
| macOS with **Xcode Command Line Tools** | `clang`, the SDK, the linker | `xcode-select --install` |
| Node.js ≥ 20.19 | Vite 8 | `npm run setup`, or `brew install node` |
| Rust stable | the shell | `npm run setup`, or `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |

No additional system libraries are required, because macOS provides the WKWebView webview.

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
| `release/Macusanite.app` | the application bundle |
| `release/Macusanite_*.dmg` | the disk image |

**Pass `--bundles` explicitly on macOS.** The repository's `bundle.targets` is `["nsis"]`, which is the Windows installer format, so without the flag the bundler has nothing it can produce on this platform. `app,dmg` is the natural pair.

### Notes

* **Architecture.** A plain build targets the host, which is `aarch64-apple-darwin` on Apple Silicon and `x86_64-apple-darwin` on Intel. To produce one binary that runs on both:

  ```bash
  rustup target add aarch64-apple-darwin x86_64-apple-darwin
  npm run tauri:build -- --target universal-apple-darwin --bundles app,dmg
  ```

* **Gatekeeper.** A locally built, unsigned `.app` is quarantined when it is copied from another machine, and `xattr -dr com.apple.quarantine Macusanite.app` clears that attribute. Signing and notarisation require an Apple Developer certificate and are outside the scope of this guide.
* **Minimum system version.** `bundle.macOS.minimumSystemVersion` is `10.15` in [src-tauri/tauri.conf.json](src-tauri/tauri.conf.json). Raise it when building with newer SDK features, because lowering it does not guarantee that the webview APIs in use are available.
* **Apple Silicon and Rosetta** are relevant only when an Intel toolchain is used; the native arm64 path does not require Rosetta.

---

## 5. Linux

Unlike the other two platforms, Linux requires **system development packages** before Rust can link. These packages provide WebKitGTK 4.1, which is the webview engine used by Tauri 2.

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

Node.js ≥ 20.19 and Rust stable are installed in the same way on every distribution:

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
| `release/macusanite` | the plain binary (named after the Cargo package) |
| `release/*.deb` | Debian package (pulls `libwebkit2gtk-4.1-0` and `libgtk-3-0` at install time) |
| `release/*.AppImage` | self-contained AppImage |

As on macOS, pass `--bundles` explicitly, because the repository's `bundle.targets` is the Windows `nsis` target.

When the Linux build runs somewhere other than the checkout, such as a WSL copy, copy the artefacts out by hand after building. This is safe because a build never clears `release/`, as explained above:

```bash
cp src-tauri/target/release/macusanite \
  src-tauri/target/release/bundle/deb/*.deb \
  src-tauri/target/release/bundle/appimage/*.AppImage release/
```

### WSL

WSL is a normal Linux build host, subject to two common problems:

* **Node.** Ubuntu 24.04's `nodejs` package provides Node 18, which Vite 8 does not support. Install Node 22 with `nvm`, NodeSource or the official tarball, place it first on `PATH`, and confirm the version with `node -v` before running `npm run setup` or `npm install`, because the setup script uses whichever `node` it finds first.
* **Where the tree lives.** Keep the Linux checkout and its `node_modules` in the Linux filesystem, such as `~/macusanite`, rather than under `/mnt/c`. Windows and Linux install different native binaries for esbuild and Rollup, so running `npm install` from both sides overwrites the other side's dependencies. Copy the working tree with `rsync -a --exclude node_modules --exclude dist --exclude src-tauri/target <checkout>/ ~/macusanite/`, then build and test in `~/macusanite`.

The shell requires no display for `npm test`, `npm run build` or `cargo test`, while `npm run tauri:dev` and a release build require an X or Wayland session, or `xvfb-run`.

### Notes

* **Build on old, run on new.** glibc compatibility is inherited from the build machine, so releases should be built on the oldest distribution that you intend to support and that still ships WebKitGTK 4.1. Ubuntu 22.04 and Debian 12 are the usual baselines.
* **AppImage at runtime** requires FUSE, which is available almost everywhere. On Ubuntu 22.04, `sudo apt install libfuse2` provides it, while Ubuntu 24.04 names the package `libfuse2t64`. Run `chmod +x macusanite_0.1.0_amd64.AppImage` before launching the file, and use `--appimage-extract` when FUSE is unavailable.
* **Headless build hosts**, including CI containers and servers, cannot run the application without an X or Wayland display. Add `xvfb-run` when you want to smoke-test the window, because the tests themselves require no display.
* **Wayland** is supported by WebKitGTK 4.1. If a window behaves incorrectly under Wayland, `WEBKIT_DISABLE_COMPOSITING_MODE=1` and `GDK_BACKEND=x11` are the usual workarounds.

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
| `npm run tauri:build` | release binary + installer, collected into `release/` (runs `npm run build` first) | everything |
| `npm test` | 462 JavaScript tests (`node --test`, no browser needed) | Node |
| `npm run test -- tests/node/mcp.test.js` | one suite | Node |
| `cargo test --manifest-path src-tauri/Cargo.toml` | 44 Rust tests (paths, scanning, writes, undo/redo, watcher) | Rust |
| `npm run docs` | regenerate [docs/Help.md](docs/Help.md) from the catalogue | Node |
| `npm run docs:check` | fail if the manual is out of date (used by the tests) | Node |
| `npm run vault:sample` | write the bundled sample vault to `reference-vault/` | Node |
| `npm run vault:sample-archive` | write the sample vault as `reference-vault.tar.gz` | Node |
| `npm run icons` | regenerate every platform icon from a PNG built with `node:zlib` — offline, no image tools | Node + Tauri CLI |
| `npm run cli -- --help` | the CLI (same as `node cli/macusanite.mjs`) | Node |
| `npm run mcp` | the MCP server on `http://127.0.0.1:8765/mcp` | Node |

Cargo can also be invoked directly. Passing `--manifest-path src-tauri/Cargo.toml` allows the usual `cargo build`, `cargo check` and `cargo clippy` commands to run from the repository root, and `cargo check` is much faster than a release build when the goal is only to verify that the Rust half compiles.

Three browser checks run against the harness beside the Node suite. `?wb-smoke=zoom` drives the zoom contract and its hit targets at 100%, 60%, 20% and 12.5%; `?wb-smoke=lens` drives the relationship lens — selecting through a link port dims unrelated cards and wires, emphasises the card's own bonds, fills the inspector, jumps and re-focuses from a row, and raises the kind chips at 20% and 12.5%; `?wb-perf=200|500|1000` measures the canvas performance budget — canvas DOM nodes at detail and icon zoom, wire paths at icon zoom, the first frame and the pan frame time — for a synthetic vein of that size, seeding it on the first load and reporting on the second. All three write their result to the console, to `window.wbZoomSmoke` / `window.wbLensSmoke` / `window.wbPerf`, and to the page title, and all three are development-only.

### Building the portable binary without Node

`npm run tauri:build` runs `npm run build` first, so the full pipeline requires Node for the interface. The window itself requires only the Rust side and an already-built `dist/` directory:

```bash
npm run build                                     # once, where Node exists
cargo build --release --features custom-protocol  # portable binary, no Node
```

This produces the same artefact as the full build, at `src-tauri/target/release/macusanite.exe` on Windows or `src-tauri/target/release/macusanite` on Linux, and it skips only installer bundling. The `custom-protocol` feature embeds `dist/` into the binary; without that feature, the window loads `devUrl` and requires the Vite dev server.

A bare `cargo build` does not run npm lifecycle scripts, so when this path is used, copy the result out by hand:

```bash
node scripts/collect-release.mjs   # -> release/macusanite(.exe)
```

---

## 7. Verifying the install

A build that produced files is not necessarily a working installation. The following checklist proceeds in order from the cheapest check to the most complete:

```bash
# 1. the logic (no display, no Rust, ~3 s)
npm test                                   # expect: 462 pass, 0 fail
npm run docs:check                         # expect: docs in sync

# 2. the Rust half
cargo test --manifest-path src-tauri/Cargo.toml    # expect: 44 pass

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

Then run the desktop application:

```bash
npm run tauri:dev
```

Check that the vault opens with its name in the top bar, that `Ctrl+K` jumps to a vein, that `Ctrl+F` finds text, that `F1`, the **?** button or **☰ → Help and manual** opens the manual in its **own window**, and that typing in that window's search box filters the sections.

With the window still open and the vault loaded, edit `.macusanite/settings.json` by hand and flip `"theme"`:

```bash
# GNU sed / BSD sed differ on -i, so write through a temporary file
sed 's/"theme": "dark"/"theme": "light"/' \
  reference-vault/.macusanite/settings.json > /tmp/s.json && mv /tmp/s.json \
  reference-vault/.macusanite/settings.json
```

The window must change theme without a reload, and `reference-vault/.macusanite/logs/session-*.log` must gain the line `applied from disk (edited outside the viewer): .macusanite/settings.json`. A hand-edit to `colors.json` behaves the same way, while a save made in the window must never produce that line.

For a release build, run the produced artefact, whether it is the portable binary or `Macusanite.app`, once before shipping it, and open a vault from local disk rather than the bundled sample.

---

## 8. Cross-compiling

Cross-compiling is not practical for this project, because Tauri links against the platform's webview and system libraries. The realistic approach is to build on each target operating system, using a Windows VM, a Mac or a CI runner per platform. The following exceptions are worth knowing:

* **Windows ARM64** can be built from an x64 Windows host when the ARM64 MSVC component is installed and `rustup target add aarch64-pc-windows-msvc` has been run.
* **macOS universal** builds with `--target universal-apple-darwin` on macOS, as described above.
* A `.deb` or AppImage can be built inside a container of the oldest supported Ubuntu release, which preserves glibc compatibility without requiring an old machine.

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
| The Help window (`F1`) opens blank and will not close | a sync Tauri command builds it, so `build()` blocks the event loop that has to navigate it — the page stays `about:blank` | mark the command `#[tauri::command(async)]`, which runs it off the main thread |
| `docs:check` fails after editing the manual | `docs/Help.md` is generated, not hand-written | `npm run docs` and commit the result |
| `npm install` fails behind a proxy | npm cannot reach the registry | set `npm_config_proxy` / `npm_config_https_proxy`, or use a registry mirror |

---

## 10. Offline and no-administrator installs

* `npm run setup` requires no administrator rights on any platform, because Node is installed into `~/.tools/node` and Rust into `~/.cargo` and `~/.rustup`.
* After the first `npm install`, the frontend build works offline, and `npm run icons` requires only `node:zlib`.
* An offline Windows installer is a WebView2 configuration choice rather than a build-system choice. Tauri's NSIS bundle downloads the WebView2 bootstrapper by default, while `bundle.windows.webviewInstallMode` can embed the bootstrapper instead or use `offlineInstaller`, which adds roughly 127 MB.
* A release build requires no network access once the Rust dependency tree and npm packages are cached, with the exception of the first `tauri:build`, which fetches NSIS on Windows.
