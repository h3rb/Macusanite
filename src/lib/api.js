/**
 * The Macusanite API: one dispatcher, every vault operation.
 *
 * `createVaultApi({ store, openVault })` returns an object whose `dispatch(name,
 * args)` runs any command in [src/lib/catalogue.js](catalogue.js) — the same
 * commands the CLI exposes as subcommands and the MCP server exposes as tools.
 * Arguments are validated and coerced against the catalogue, so a command can
 * only be called the way it is documented.
 *
 * Everything here is runtime-agnostic: it talks to a *vault store*
 * ([src/lib/vaultStore.js](vaultStore.js)), which is given to it. The CLI passes
 * a store over `node:fs`; nothing in this file knows what a filesystem is.
 *
 * ## Sessions
 *
 * `vault.open` and `vault.create` swap the store the session is using, which is
 * what lets one MCP server (or one CLI process with `--vault`) work across
 * vaults. Every other command needs an open vault and says so plainly when there
 * is none.
 */
import { prepareArgs, applyAssignments, commandNames, COMMANDS } from './catalogue.js';
import { buildHelpMarkdown, commandPage, helpSections, DEFAULT_DOC_SECTIONS } from './helpDoc.js';
import { assertBucket } from './backup.js';
import {
  AUTO_BACKUP_FILE,
  AUTO_BACKUP_PATH,
  autoBackupArgs,
  emptyAutoBackup,
  parseAutoBackup,
  triggersAutoBackup,
} from './autoBackup.js';

/** An error a caller can show a user or an agent as-is. */
export class ApiError extends Error {
  constructor(message, { code = 'error', status = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

/** Paths are accepted with or without the markdown extension. */
const withExtension = (path) => (/\.(md|markdown|mdx)$/i.test(path) ? path : `${path}.md`);

/**
 * @param {object} input
 * @param {object|null} [input.store] the vault store to start on
 * @param {string|null} [input.root] where that store's vault lives
 * @param {(path: string, options: object) => Promise<object>} [input.openVault]
 *   how to open another folder; required only for `vault.open`/`vault.create`
 * @param {(path: string) => Promise<string>} [input.readFile] text reader, for files named by an argument
 * @param {(options: object) => Promise<object>} [input.backupS3]
 *   uploads a vault; the CLI passes the Node implementation, and a runtime that
 *   has no network or filesystem leaves it out
 * @param {number} [input.autoBackupQuietMs] how long an automatic upload is held
 *   back so a burst of writes becomes one archive; `0` uploads before `dispatch`
 *   resolves, which is what a one-shot CLI command wants
 */
export function createVaultApi({
  store = null,
  root = null,
  openVault = null,
  writeFile = null,
  readFile = null,
  backupS3 = null,
  autoBackupQuietMs = 0,
} = {}) {
  let session = store;
  let vaultRoot = root ?? store?.root ?? null;

  // With a quiet window (the MCP server), a pending upload belongs to the vault
  // last written to; it runs on its own when the writes stop, or on flush.
  let autoBackupTimer = null;
  let autoBackupVault = null;
  let autoBackupRunning = Promise.resolve();

  const inVault = () => {
    if (!session) {
      throw new ApiError('no vault is open — open one first (`vault open <folder>`, or `--vault <folder>`)', {
        code: 'no-vault',
      });
    }
    return session;
  };

  /** The real path of a vein, whether or not `.md` was spelled out. */
  async function veinPath(rel, { mustExist = true } = {}) {
    const vault = inVault();
    const candidates = /\.(md|markdown|mdx)$/i.test(rel) ? [rel] : [`${rel}.md`, rel];
    for (const candidate of candidates) {
      try {
        await vault.statVein(candidate);
        return candidate;
      } catch {
        /* try the next spelling */
      }
    }
    if (mustExist) throw new ApiError(`vein not found: ${rel}`, { code: 'not-found' });
    return withExtension(rel);
  }

  async function adopt(target, options = {}) {
    if (!openVault) {
      throw new ApiError('this session cannot open other folders (no vault provider is available)', {
        code: 'unsupported',
      });
    }
    session = await openVault(target, options);
    vaultRoot = session.root ?? target;
    return session;
  }

  /* ── vault ───────────────────────────────────────────────────────────── */

  const handlers = {
    async 'vault.open'(args) {
      await adopt(args.path, { create: args.create === true, name: args.name ?? null, description: args.description ?? null });
      const info = await session.info();
      const stats = await session.stats();
      return { ...info, veins: stats.veins, chambers: stats.chambers };
    },

    async 'vault.create'(args) {
      const seeded = [];
      // Seeding first means the sample's own identity is what gets written.
      if (args.sample) {
        const { seedSampleVault } = await import('../../cli/vaultFs.js');
        const fresh = await adopt(args.path, { create: true, ensure: false });
        seeded.push(...await seedSampleVault(fresh));
        await fresh.ensureMeta({
          name: args.name ?? 'Macusanite Sample Vault',
          description: args.description ?? 'Field and laboratory notes for the Macusani glass project.',
        });
      } else {
        await adopt(args.path, { create: true, name: args.name ?? null, description: args.description ?? '' });
      }
      const info = await session.info();
      const stats = await session.stats();
      return { ...info, veins: stats.veins, chambers: stats.chambers, seeded };
    },

    async 'vault.info'() {
      const vault = inVault();
      const info = await vault.info();
      const colors = await vault.readColors();
      return {
        ...info,
        colors,
        colorCount: Object.values(colors).reduce((sum, bucket) => sum + Object.keys(bucket ?? {}).length, 0),
      };
    },

    async 'vault.update'(args) {
      const vault = inVault();
      const patch = {};
      if (args.name !== undefined) patch.name = args.name;
      if (args.description !== undefined) patch.description = args.description;
      return vault.updateVaultMeta(patch, { record: args['no-undo'] !== true });
    },

    async 'vault.stats'() {
      return inVault().stats();
    },

    async 'vault.tree'() {
      return inVault().tree();
    },

    async 'vault.veins'(args) {
      const vault = inVault();
      let veins = await vault.veins();
      if (args.under) veins = veins.filter((path) => path.startsWith(`${String(args.under).replace(/\/$/, '')}/`));
      if (args.query) {
        const needle = String(args.query).toLowerCase();
        veins = veins.filter((path) => path.toLowerCase().includes(needle));
      }
      return veins;
    },

    async 'vault.chambers'() {
      return inVault().chambers();
    },

    async 'vault.settings'() {
      return inVault().readSettings();
    },

    async 'vault.settings.set'(args) {
      const vault = inVault();
      let patch = {};
      if (args.patch && typeof args.patch === 'object') patch = args.patch;
      if (args.set?.length) patch = applyAssignments(patch, args.set);
      if (!Object.keys(patch).length) throw new ApiError('nothing to set — pass --set key=value or --patch {...}', { code: 'bad-args' });
      return vault.updateSettings(patch, { record: args['no-undo'] !== true });
    },

    async 'vault.backup'(args) {
      return uploadVault(args);
    },

    async 'vault.autobackup'(args) {
      const vault = inVault();
      const current = await autoBackupConfig(vault);
      if (args.on && args.off) throw new ApiError('pass --on or --off, not both', { code: 'bad-args' });

      // Only what the caller named is changed, so `--off` keeps the destination
      // and a later `--on` needs no arguments.
      const patch = {};
      for (const [key, value] of Object.entries({
        bucket: args.bucket,
        region: args.region,
        prefix: args.prefix,
        endpoint: args.endpoint,
        profile: args.profile,
        sshHost: args['ssh-host'],
        sshKey: args['ssh-key'],
      })) {
        if (value !== undefined) patch[key] = String(value).trim();
      }
      if (args['ssh-port'] !== undefined) patch.sshPort = args['ssh-port'];
      if (args.on !== undefined) patch.enabled = true;
      if (args.off !== undefined) patch.enabled = false;

      const next = { ...(current ?? emptyAutoBackup()), ...patch };
      if (next.sshPort !== null && (!Number.isInteger(next.sshPort) || next.sshPort < 1 || next.sshPort > 65535)) {
        throw new ApiError(`not a usable SSH port: ${next.sshPort}`, { code: 'bad-args' });
      }
      if (next.enabled) {
        try {
          next.bucket = assertBucket(next.bucket);
        } catch (error) {
          throw new ApiError(error.message, { code: 'bad-args' });
        }
      }

      const touched = Object.keys(patch).length > 0;
      // `record: false` — where backups go is not an edit to undo.
      if (touched) await vault.writeMeta(AUTO_BACKUP_FILE, `${JSON.stringify(next, null, 2)}\n`, { record: false });
      return { path: AUTO_BACKUP_PATH, ...next };
    },

    async 'vault.state'() {
      return inVault().readState();
    },

    async 'vault.state.set'(args) {
      const vault = inVault();
      const state = typeof args.state === 'object' && args.state !== null ? args.state : {};
      await vault.writeState(state);
      return { path: '.macusanite/state.json', state };
    },

    async 'vault.log'(args) {
      const vault = inVault();
      await vault.appendLog(args.level, args.message);
      return { level: args.level, message: args.message };
    },

    async 'vault.logs'(args) {
      return inVault().logs({ limit: args.limit, day: args.day ?? null });
    },

    async 'vault.index'() {
      return inVault().indexCacheStatus();
    },

    async 'vault.index.rebuild'() {
      const vault = inVault();
      await vault.dropIndexCache();
      const { index } = await vault.buildIndex({ refresh: true });
      return {
        index: index.map((doc) => ({
          path: doc.path,
          title: doc.title,
          headings: doc.headings.length,
          links: doc.links.length,
          tags: doc.tags,
        })),
      };
    },

    async 'vault.index.drop'() {
      return inVault().dropIndexCache();
    },

    async 'vault.doctor'() {
      const vault = inVault();
      const checks = [];
      const push = (name, ok, detail) => checks.push({ name, ok, detail });

      const metaFiles = ['.macusanite/vault.json', '.macusanite/settings.json', '.macusanite/colors.json', '.macusanite/history.json'];
      const files = new Set((await vault.listFiles()).map((file) => file.path));
      const missing = metaFiles.filter((file) => !files.has(file));
      push('meta files', missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : 'vault.json, settings.json, colors.json, history.json present');

      const cache = await vault.indexCacheStatus();
      push('index cache', cache.stale === 0, cache.present
        ? `${cache.fresh}/${cache.veins} entries fresh (${cache.bytes} bytes)`
        : 'no cache yet (the next open writes one)');

      const ghosts = await vault.ghosts();
      push('wiki links', ghosts.length === 0, ghosts.length === 0
        ? 'every link resolves'
        : `${ghosts.length} link${ghosts.length === 1 ? '' : 's'} point at nothing: ${ghosts.slice(0, 5).map((g) => `${g.from} -> ${g.target}`).join('; ')}`);

      const stats = await vault.stats();
      push('orphans', stats.orphans === 0, stats.orphans === 0
        ? 'every vein is linked'
        : `${stats.orphans} vein${stats.orphans === 1 ? '' : 's'} have no links in or out`);

      const empty = [];
      for (const path of await vault.veins()) {
        const text = await vault.readVein(path).catch(() => null);
        if (text !== null && text.trim() === '') empty.push(path);
      }
      push('empty veins', empty.length === 0, empty.length ? `${empty.length} empty: ${empty.slice(0, 5).join(', ')}` : 'no empty veins');

      return { ok: checks.every((check) => check.ok), checks, ghosts: ghosts.length, orphans: stats.orphans };
    },

    /* ── documents ───────────────────────────────────────────────────── */

    async 'vein.read'(args) {
      const vault = inVault();
      const path = await veinPath(args.path);
      const text = await vault.readVein(path);
      if (!args['with-meta']) return { path, text };
      const doc = await vault.document(path);
      const { text: _text, body, ...meta } = doc;
      return { ...meta, body, path, text };
    },

    async 'vein.info'(args) {
      const vault = inVault();
      const path = await veinPath(args.path);
      const doc = await vault.document(path);
      const { text, ...rest } = doc;
      return { ...rest, bytes: text.length };
    },

    async 'vein.write'(args) {
      const vault = inVault();
      const path = await veinPath(args.path, { mustExist: false });
      await vault.writeVein(path, args.text, { label: args.label ?? null, record: args['no-undo'] !== true });
      return { path, bytes: String(args.text ?? '').length };
    },

    async 'vein.create'(args) {
      const vault = inVault();
      const target = args.chamber ? `${String(args.chamber).replace(/\/$/, '')}/${args.path}` : args.path;
      const created = await vault.createVein(target, args.text ?? null);
      return created;
    },

    async 'vein.append'(args) {
      const vault = inVault();
      const path = await veinPath(args.path);
      await vault.appendVein(path, args.text, { label: args.label ?? null });
      return { path, bytes: (await vault.readVein(path)).length };
    },

    async 'vein.section'(args) {
      const vault = inVault();
      const path = await veinPath(args.path, { mustExist: false });
      return vault.upsertSection(path, args.heading, args.text ?? '', { level: args.level });
    },

    async 'vein.rename'(args) {
      const vault = inVault();
      const from = await veinPath(args.from);
      return vault.renameVein(from, args.to);
    },

    async 'vein.delete'(args) {
      const vault = inVault();
      const path = await veinPath(args.path);
      return vault.deleteVein(path, { record: args['no-undo'] !== true });
    },

    async 'vein.links'(args) {
      const vault = inVault();
      return vault.links(await veinPath(args.path));
    },

    async 'vein.headings'(args) {
      const vault = inVault();
      const doc = await vault.document(await veinPath(args.path));
      return doc.headings;
    },

    async 'vein.backlinks'(args) {
      const vault = inVault();
      return vault.backlinks(await veinPath(args.path));
    },

    async 'vein.resolve'(args) {
      const vault = inVault();
      let from = args.from ?? null;
      if (from) from = await veinPath(from);
      const resolved = await vault.resolveLink(args.target, from);
      return {
        ok: resolved.ok === true,
        path: resolved.path ?? null,
        anchor: resolved.anchor ?? '',
        candidates: resolved.candidates ?? [],
        ghost: resolved.ok !== true,
        suggestedPath: resolved.suggestedPath ?? null,
      };
    },

    /* ── chambers ────────────────────────────────────────────────────── */

    async 'chamber.create'(args) {
      return inVault().createChamber(args.path);
    },

    /* ── search and graph ────────────────────────────────────────────── */

    async search(args) {
      return inVault().search(args.query, { limit: args.limit, refresh: args.refresh === true });
    },

    async tags() {
      return inVault().tags();
    },

    async ghosts() {
      return inVault().ghosts();
    },

    async graph(args) {
      const vault = inVault();
      let focus = args.focus ?? null;
      if (focus) focus = await veinPath(focus);
      return vault.graph({ focus, depth: args.depth ?? null });
    },

    /* ── colours ─────────────────────────────────────────────────────── */

    async 'color.set'(args) {
      return inVault().setColor(args.kind, colorTarget(args), args.color, { record: args['no-undo'] !== true });
    },

    async 'color.clear'(args) {
      return inVault().clearColor(args.kind, colorTarget(args));
    },

    async 'color.reset'() {
      await inVault().resetColors();
      return { pages: {}, sections: {}, links: {}, concepts: {} };
    },

    async 'color.resolve'(args) {
      return { kind: args.kind, color: await inVault().resolveColor(args.kind, colorTarget(args)) };
    },

    /* ── history ─────────────────────────────────────────────────────── */

    async history() {
      return inVault().historyState();
    },

    async undo() {
      return inVault().undo();
    },

    async redo() {
      return inVault().redo();
    },

    /* ── help ────────────────────────────────────────────────────────── */

    async help(args) {
      if (args.command) {
        const name = COMMANDS[args.command] ? args.command : null;
        if (!name) throw new ApiError(`unknown command: ${args.command}`, { code: 'bad-args' });
        return { command: name, markdown: commandPage(name) };
      }
      return { commands: commandNames(), markdown: buildHelpMarkdown({ commandsOnly: true }) };
    },

    async docs(args) {
      if (args.sections) return { sections: helpSections() };
      const markdown = buildHelpMarkdown({ section: args.section ?? null });
      if (args.section && markdown === null) {
        throw new ApiError(`no such section: ${args.section} (try --sections)`, { code: 'bad-args' });
      }
      if (args.out) {
        if (!writeFile) {
          throw new ApiError('this session cannot write files, so --out is unavailable', { code: 'unsupported' });
        }
        // The manual has one source (src/lib/helpDoc.js) and this is how
        // `npm run docs` materialises it as docs/Help.md.
        const written = await writeFile(args.out, markdown);
        return { out: args.out, bytes: written?.bytes ?? markdown.length, section: args.section ?? null, markdown };
      }
      return { section: args.section ?? null, sections: DEFAULT_DOC_SECTIONS, markdown };
    },
  };

  /** The per-vault automatic backup setting, or null when the vault has none. */
  async function autoBackupConfig(vault) {
    try {
      return parseAutoBackup(await vault.readMeta(AUTO_BACKUP_FILE));
    } catch (error) {
      throw new ApiError(error.message, { code: 'bad-args' });
    }
  }

  /**
   * One upload, from `vault.backup` or from an automatic run.
   *
   * @param {object} args `vault.backup` arguments
   * @param {object} [vault] the store to upload; the session's by default
   */
  async function uploadVault(args, vault = inVault()) {
    if (!backupS3) {
      throw new ApiError('this session cannot upload to S3 (no backup provider is available)', {
        code: 'unsupported',
      });
    }
    // The secret may live in a file so that it does not appear in a process
    // list or a shell history. Only the first line is used, because that file
    // is often written by hand or copied from a credentials file.
    // An SSH backup needs no local secret at all: the remote host has its own
    // credentials, so a `--secret-key-file` alongside `--ssh-host` is ignored
    // rather than read.
    const overSsh = Boolean(args['ssh-host']);
    let secretKey = args['secret-key'] ?? null;
    if (!secretKey && args['secret-key-file'] && !overSsh) {
      if (!readFile) {
        throw new ApiError('this session cannot read files, so --secret-key-file is unavailable', { code: 'unsupported' });
      }
      let text;
      try {
        text = await readFile(args['secret-key-file']);
      } catch (error) {
        throw new ApiError(`could not read ${args['secret-key-file']}: ${error.message}`, { code: 'bad-args' });
      }
      secretKey = String(text ?? '').trim().split(/\r?\n/)[0].trim() || null;
      if (!secretKey) {
        throw new ApiError(`secret key file is empty: ${args['secret-key-file']}`, { code: 'bad-args' });
      }
    }

    const info = await vault.info();
    try {
      return await backupS3({
        root: vaultRoot,
        vaultName: info.name,
        bucket: args.bucket,
        region: args.region ?? null,
        prefix: args.prefix ?? null,
        endpoint: args.endpoint ?? null,
        accessKey: args['access-key'] ?? null,
        secretKey,
        sessionToken: args['session-token'] ?? null,
        profile: args.profile ?? null,
        sshHost: args['ssh-host'] ?? null,
        sshKey: args['ssh-key'] ?? null,
        sshPort: args['ssh-port'] ?? null,
        dryRun: args['dry-run'] === true,
      });
    } catch (error) {
      throw new ApiError(error?.message ?? String(error), { code: 'backup-failed' });
    }
  }

  /**
   * One upload for an armed vault, or null when it is not armed.
   *
   * A failure comes back as a report rather than throwing: the write that
   * triggered it has already landed. It is logged, since a held-back upload has
   * no caller to show it to.
   */
  async function runAutoBackup(vault) {
    try {
      const config = await autoBackupConfig(vault);
      if (!config?.enabled) return null;
      const { transport, bucket, key, url, files, bytes } = await uploadVault(autoBackupArgs(config), vault);
      return { ok: true, transport, bucket, key, url, files, bytes };
    } catch (error) {
      const report = { ok: false, error: error?.message ?? String(error) };
      await vault.appendLog('warn', `automatic backup failed: ${report.error}`).catch(() => {});
      return report;
    }
  }

  /** Upload the writes the quiet window has collected, and log where it went. */
  async function runPendingAutoBackup() {
    const vault = autoBackupVault;
    const report = await runAutoBackup(vault);
    // Unlike an inline upload there is no tool result waiting, so the session
    // log is where a coalesced upload is recorded (failures log themselves).
    if (report?.ok) {
      await vault.appendLog('info', `automatic backup to ${report.url}`).catch(() => {});
    }
  }

  /** Hold this write's upload back until the writes stop, or until flush. */
  function scheduleAutoBackup(vault) {
    clearTimeout(autoBackupTimer);
    autoBackupVault = vault;
    autoBackupTimer = setTimeout(() => {
      autoBackupTimer = null;
      autoBackupRunning = autoBackupRunning.then(runPendingAutoBackup);
    }, autoBackupQuietMs);
  }

  /** Run a held-back upload now and wait for it — what the MCP server does as it stops. */
  async function flushAutoBackup() {
    if (autoBackupTimer) {
      clearTimeout(autoBackupTimer);
      autoBackupTimer = null;
      autoBackupRunning = autoBackupRunning.then(runPendingAutoBackup);
    }
    await autoBackupRunning;
  }

  /**
   * Upload after a write when the vault is armed.
   *
   * With a quiet window the upload is left for later, so the result says nothing
   * about it; otherwise it runs before `dispatch` resolves and the report is
   * attached as `autoBackup`.
   */
  async function autoBackupAfterWrite(name, result) {
    if (!backupS3 || !triggersAutoBackup(name)) return result;
    if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
    const vault = inVault();
    if (autoBackupQuietMs > 0) {
      scheduleAutoBackup(vault);
      return result;
    }
    const report = await runAutoBackup(vault);
    return report ? { ...result, autoBackup: report } : result;
  }

  /** The colour target a `color.*` command was given. */
  function colorTarget(args) {
    switch (args.kind) {
      case 'page':
        if (!args.path) throw new ApiError('--path is required for a page colour', { code: 'bad-args' });
        return { path: args.path };
      case 'section':
        if (!args.path) throw new ApiError('--path is required for a section colour', { code: 'bad-args' });
        return { path: args.path, anchor: args.anchor ?? '' };
      case 'link':
        if (!args.from) throw new ApiError('--from is required for a link colour', { code: 'bad-args' });
        return { from: args.from, to: args.to ?? '', section: args.section ?? '' };
      case 'concept':
        if (!args.name) throw new ApiError('--name is required for a concept colour', { code: 'bad-args' });
        return { name: args.name };
      default:
        throw new ApiError(`unknown colour kind: ${args.kind}`, { code: 'bad-args' });
    }
  }

  /**
   * Run a command.
   * @param {string} name command from the catalogue, e.g. `vein.write`
   * @param {object} [rawArgs] parameters as strings or JSON values
   */
  async function dispatch(name, rawArgs = {}) {
    const handler = handlers[name];
    if (!handler) throw new ApiError(`unknown command: ${name}`, { code: 'unknown-command' });
    const prepared = prepareArgs(name, rawArgs);
    if (!prepared.ok) throw new ApiError(prepared.error, { code: 'bad-args' });
    const result = await handler({ ...prepared.args });
    // A vault that is armed backs itself up after every write, from the CLI and
    // from the MCP server alike.
    return autoBackupAfterWrite(name, result);
  }

  return {
    dispatch,
    /** Run any automatic upload the quiet window is holding, and wait for it. */
    flushAutoBackup,
    commands: handlers,
    /** The store the session is on, or null. */
    get store() {
      return session;
    },
    get root() {
      return vaultRoot;
    },
    /** Attach an already-open store (the CLI's `--vault`). */
    attach(next, path = null) {
      session = next;
      vaultRoot = path ?? next?.root ?? null;
      return session;
    },
    requiresVault: (name) => COMMANDS[name]?.group !== 'Help' && name !== 'vault.open' && name !== 'vault.create',
  };
}
