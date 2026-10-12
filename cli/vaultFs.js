/**
 * A vault filesystem over `node:fs` — the CLI's counterpart to the Tauri core.
 *
 * The vault store ([src/lib/vaultStore.js]) only ever talks to an adapter with
 * six methods; this is the one that touches a real disk. Everything is
 * synchronous underneath (the interface is async) so a command sees a
 * consistent vault: no two writes interleave, and a stat taken after a write
 * always reflects it.
 *
 * Two deliberate restrictions:
 *
 *   * every path is resolved inside the vault root and refused if it escapes —
 *     the same rule as `vault.rs::resolve_in_vault`;
 *   * symlinks are ignored when walking, so a link cannot pull the vault's tree
 *     out of the vault.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createVaultStore, safePath } from '../src/lib/vaultStore.js';
import { sampleVaultFiles } from '../src/lib/fixtures.js';

/** Absolute path for a vault-relative one, refusing anything that escapes. */
export function resolveInVault(root, rel) {
  const clean = safePath(rel);
  const absolute = path.resolve(root, ...clean.split('/'));
  const base = path.resolve(root);
  if (absolute !== base && !absolute.startsWith(base + path.sep)) {
    throw new Error(`path escapes the vault: ${rel}`);
  }
  return absolute;
}

const statOf = (root, absolute) => {
  const info = fs.statSync(absolute);
  return {
    path: path.relative(root, absolute).split(path.sep).join('/'),
    mtime: Math.floor(info.mtimeMs),
    size: info.size,
  };
};

/**
 * @param {string} root absolute path of the vault folder
 * @returns the six-method adapter `createVaultStore` expects
 */
export function createNodeVaultFs(root) {
  const base = path.resolve(root);
  const list = (dir = base, out = []) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) list(absolute, out);
      else if (entry.isFile()) {
        try {
          out.push(statOf(base, absolute));
        } catch {
          /* the file vanished between readdir and stat */
        }
      }
    }
    return out;
  };

  return {
    root: base,
    async list() {
      return list();
    },
    async read(rel) {
      const absolute = resolveInVault(base, rel);
      try {
        return fs.readFileSync(absolute, 'utf8');
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'EISDIR') return null;
        throw error;
      }
    },
    async write(rel, text) {
      const absolute = resolveInVault(base, rel);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, String(text ?? ''), 'utf8');
    },
    async append(rel, text) {
      const absolute = resolveInVault(base, rel);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.appendFileSync(absolute, String(text ?? ''), 'utf8');
    },
    async remove(rel) {
      const absolute = resolveInVault(base, rel);
      try {
        const info = fs.statSync(absolute);
        if (info.isDirectory()) fs.rmSync(absolute, { recursive: true, force: true });
        else fs.unlinkSync(absolute);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    },
    async stat(rel) {
      const absolute = resolveInVault(base, rel);
      try {
        return statOf(base, absolute);
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
    },
    async mkdir(rel) {
      fs.mkdirSync(resolveInVault(base, rel), { recursive: true });
    },
  };
}

/** Is this path an existing folder? */
export function isVaultFolder(candidate) {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Open (or create) a vault folder and hand back the store for it.
 *
 * @param {string} root
 * @param {{create?: boolean, name?: string, description?: string, ensure?: boolean}} [options]
 *   `ensure: false` hands back the store without creating `.macusanite` — what
 *   seeding a new vault wants, so the sample's own identity is the one written
 */
export async function openVault(root, options = {}) {
  const base = path.resolve(root);
  if (!isVaultFolder(base)) {
    if (!options.create) throw new Error(`not a folder: ${base}`);
    fs.mkdirSync(base, { recursive: true });
  }
  const store = createVaultStore({ fs: createNodeVaultFs(base), root: base });
  if (options.ensure !== false) {
    await store.ensureMeta({ name: options.name ?? null, description: options.description ?? null });
  }
  return store;
}

/**
 * Write the bundled sample vault into `root` (the CLI's `vault create --sample`).
 * The content comes from `src/lib/fixtures.js`, so the CLI, the browser fallback
 * and `npm run vault:sample` all produce the same vault.
 */
export async function seedSampleVault(store, { overwrite = false } = {}) {
  const files = sampleVaultFiles();
  const present = new Set((await store.listFiles()).map((file) => file.path));
  const written = [];
  for (const [rel, contents] of Object.entries(files)) {
    if (present.has(rel) && !overwrite) continue;
    // No undo entries: seeding is not an edit the reader made.
    if (rel.startsWith('.macusanite/')) await store.writeMeta(rel.slice('.macusanite/'.length), contents, { record: false });
    else await store.createVein(rel, contents, { record: false });
    written.push(rel);
  }
  store.invalidate();
  return written;
}
