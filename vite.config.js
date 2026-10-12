import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// Tauri drives this config: `beforeDevCommand` starts `vite`, `devUrl` points at
// the fixed port below, and `frontendDist` consumes ./dist.
//
// Two pages, because the app has two windows: `index.html` is the viewer and
// `help.html` is the manual, which opens as its own OS window (see
// `open_help_window` in src-tauri/src/lib.rs).
export default defineConfig({
  clearScreen: false,
  server: {
    host: '127.0.0.1',
    port: 1420,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**', '**/logs/**'] },
  },
  build: {
    // WebView2 / WKWebView / WebKitGTK all ship a modern evergreen engine.
    target: 'chrome110',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 2048,
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL('./index.html', import.meta.url)),
        help: fileURLToPath(new URL('./help.html', import.meta.url)),
      },
    },
  },
});
