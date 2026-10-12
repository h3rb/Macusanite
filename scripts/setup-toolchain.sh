#!/usr/bin/env bash
# Macusanite build-toolchain bootstrap (per-user, no administrator rights).
#
# Installs:
#   * Node.js LTS  -> $HOME/.tools/node            (portable zip, no registry changes)
#   * Rust + cargo -> $HOME/.cargo, $HOME/.rustup  (rustup, MSVC toolchain)
#
# Re-running is safe: each step is skipped when already present, and downloads
# are cached in $HOME/.tools/.cache.
#
# Usage:  bash scripts/setup-toolchain.sh
set -euo pipefail

TOOLS_DIR="${TOOLS_DIR:-$HOME/.tools}"
CACHE_DIR="$TOOLS_DIR/.cache"
NODE_MAJOR="${NODE_MAJOR:-22}"
NODE_MIN_MAJOR="${NODE_MIN_MAJOR:-20}"

log() { printf '[toolchain] %s\n' "$*"; }

detect_platform() {
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*) echo windows ;;
    Darwin) echo macos ;;
    Linux) echo linux ;;
    *) echo unknown ;;
  esac
}

PLATFORM="$(detect_platform)"
log "platform: $PLATFORM"

# GNU tar (MSYS/mingw) cannot read zip archives; unzip and Windows' bundled
# bsdtar both can. Probe for a working extractor instead of assuming one.
extract_zip() {
  local archive="$1" dest="$2"
  mkdir -p "$dest"
  if command -v unzip >/dev/null 2>&1; then
    unzip -q -o "$archive" -d "$dest"
    return 0
  fi
  for tar_bin in /c/Windows/System32/tar.exe tar; do
    if command -v "$tar_bin" >/dev/null 2>&1 || [ -x "$tar_bin" ]; then
      if "$tar_bin" -xf "$archive" -C "$dest" 2>/dev/null; then return 0; fi
    fi
  done
  log "no zip extractor found (need unzip or bsdtar)"
  return 1
}

# Download once, reuse afterwards.
fetch() {
  local url="$1" out="$2"
  mkdir -p "$CACHE_DIR"
  if [ -s "$out" ]; then
    log "using cached $(basename "$out")"
    return 0
  fi
  log "downloading $(basename "$out")"
  curl -fL --retry 3 --retry-delay 2 -o "$out.part" "$url"
  mv "$out.part" "$out"
}

# ---------------------------------------------------------------- Node.js ----
install_node() {
  if [ -x "$TOOLS_DIR/node/bin/node" ] || [ -x "$TOOLS_DIR/node/node.exe" ]; then
    log "node already present: $("$TOOLS_DIR/node/bin/node" -v 2>/dev/null || "$TOOLS_DIR/node/node.exe" -v)"
    return 0
  fi

  mkdir -p "$TOOLS_DIR"

  if [ "$PLATFORM" = macos ] || [ "$PLATFORM" = linux ]; then
    if command -v node >/dev/null 2>&1; then
      log "using system node $(node -v)"
      return 0
    fi
  fi

  local sums file
  sums="$(curl -fsSL "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/SHASUMS256.txt")"

  case "$PLATFORM" in
    windows)
      file="$(printf '%s\n' "$sums" | grep -o "node-v[0-9.]*-win-x64\.zip" | head -1)"
      [ -n "$file" ] || { log "could not resolve Node LTS zip name"; return 1; }
      fetch "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/$file" "$CACHE_DIR/$file"
      rm -rf "$TOOLS_DIR/node" "$CACHE_DIR/x"
      extract_zip "$CACHE_DIR/$file" "$CACHE_DIR/x"
      mv "$CACHE_DIR/x/node-v"* "$TOOLS_DIR/node"
      ;;
    macos|linux)
      local target
      target="$([ "$PLATFORM" = macos ] && echo darwin || echo linux)"
      file="$(printf '%s\n' "$sums" | grep -o "node-v[0-9.]*-$target-x64\.tar\.gz" | head -1)"
      [ -n "$file" ] || { log "could not resolve Node LTS tarball name"; return 1; }
      fetch "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/$file" "$CACHE_DIR/$file"
      rm -rf "$TOOLS_DIR/node" "$CACHE_DIR/x"
      mkdir -p "$CACHE_DIR/x"
      tar -xzf "$CACHE_DIR/$file" -C "$CACHE_DIR/x"
      mv "$CACHE_DIR/x/node-v"* "$TOOLS_DIR/node"
      ;;
    *) log "unsupported platform"; return 1 ;;
  esac

  local bin
  bin="$TOOLS_DIR/node/bin/node"
  [ -x "$bin" ] || bin="$TOOLS_DIR/node/node.exe"
  local have
  have="$("$bin" -v 2>/dev/null | sed 's/^v\([0-9]*\).*/\1/')"
  [ -n "$have" ] && [ "$have" -ge "$NODE_MIN_MAJOR" ] || { log "node install looks wrong (found $have)"; return 1; }
  log "installed node $("$bin" -v) -> $TOOLS_DIR/node"
}

# ------------------------------------------------------------ Rust / cargo ---
install_rust() {
  if [ -x "$HOME/.cargo/bin/cargo" ] || [ -x "$HOME/.cargo/bin/cargo.exe" ]; then
    log "cargo already present: $("$HOME/.cargo/bin/cargo" --version 2>/dev/null || "$HOME/.cargo/bin/cargo.exe" --version)"
    return 0
  fi

  case "$PLATFORM" in
    windows)
      fetch "https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe" \
        "$CACHE_DIR/rustup-init.exe"
      "$CACHE_DIR/rustup-init.exe" -y --no-modify-path \
        --profile default --default-toolchain stable \
        -t x86_64-pc-windows-msvc
      ;;
    macos|linux)
      fetch "https://sh.rustup.rs" "$CACHE_DIR/rustup-init.sh"
      sh "$CACHE_DIR/rustup-init.sh" -y --no-modify-path \
        --profile default --default-toolchain stable
      ;;
    *) log "unsupported platform"; return 1 ;;
  esac

  log "installed $("$HOME/.cargo/bin/cargo" --version 2>/dev/null || "$HOME/.cargo/bin/cargo.exe" --version)"
}

install_node
install_rust

cat <<EOF

[toolchain] done.

Add the toolchain to your shell for interactive use:

  export PATH="$TOOLS_DIR/node/bin:\$HOME/.cargo/bin:\$PATH"

Build the desktop app:

  npm install
  npm run build
  npm run tauri:build
EOF
