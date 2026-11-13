/**
 * Automatic backups: a per-vault setting that makes a vault upload itself after
 * writes. The CLI and MCP server act on it directly; the window's backup dialog
 * reads and writes the same file and repeats the upload after its own saves.
 *
 * The setting lives in `.macusanite/backup.json`, inside the vault it protects,
 * so it travels with the folder: copy or clone a vault and the machine that
 * opens it backs it up the same way. It is bookkeeping, not content. The
 * window's **Back up to S3…** dialog reads and writes the same file, so a vault
 * armed in one place is armed for its saves, the CLI and the MCP server alike.
 *
 * It never holds a credential. A direct upload reads `AWS_ACCESS_KEY_ID` /
 * `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` or `~/.aws/credentials` (with
 * `profile`), and an SSH upload uses the remote host's own identity, so the file
 * is safe to read, diff and commit next to the notes.
 */
import { isMutating } from './catalogue.js';

/** The setting's file inside `.macusanite`, and its vault-relative path. */
export const AUTO_BACKUP_FILE = 'backup.json';
export const AUTO_BACKUP_PATH = `.macusanite/${AUTO_BACKUP_FILE}`;

/**
 * Writes that are not worth an upload.
 *
 * These commands do write, but they change the viewer's own bookkeeping or the
 * configuration rather than the notes: uploading the whole vault again after a
 * log line or an index rebuild would be noise, and `vault backup` uploading
 * after itself would never stop. `vault open`/`vault create` are here because
 * merely opening a folder — which ensures `.macusanite` exists — is not an edit.
 */
const NO_AUTO_BACKUP = new Set([
  'vault.open',
  'vault.create',
  'vault.autobackup',
  'vault.backup',
  'vault.state.set',
  'vault.log',
  'vault.index.rebuild',
  'vault.index.drop',
]);

/**
 * Does this command's write want an automatic upload afterwards?
 *
 * Everything the catalogue calls a mutation counts — vein edits, new chambers,
 * colours, settings, vault details, undo and redo — except the bookkeeping in
 * `NO_AUTO_BACKUP`.
 */
export function triggersAutoBackup(command) {
  return isMutating(command) && !NO_AUTO_BACKUP.has(command);
}

/** The setting with nothing configured yet. */
export function emptyAutoBackup() {
  return {
    enabled: false,
    bucket: '',
    region: '',
    prefix: '',
    endpoint: '',
    profile: '',
    sshHost: '',
    sshKey: '',
    sshPort: null,
  };
}

/**
 * Read `.macusanite/backup.json`.
 *
 * Unknown keys are dropped — which is what keeps a hand-edited file from
 * smuggling an access key into a backup — and `null` means the vault has no
 * setting. Malformed JSON is an error, because silently ignoring it would make
 * `vault autobackup` report settings it is not actually using.
 *
 * @param {string|null} text the file's contents, or null when it is absent
 * @returns {ReturnType<typeof emptyAutoBackup>|null}
 */
export function parseAutoBackup(text) {
  if (text === null || text === undefined) return null;
  let stored;
  try {
    stored = JSON.parse(String(text));
  } catch (error) {
    throw new Error(`${AUTO_BACKUP_PATH} is not valid JSON: ${error.message}`);
  }
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
    throw new Error(`${AUTO_BACKUP_PATH} should hold a JSON object`);
  }
  const config = emptyAutoBackup();
  config.enabled = stored.enabled === true;
  for (const key of ['bucket', 'region', 'prefix', 'endpoint', 'profile', 'sshHost', 'sshKey']) {
    config[key] = typeof stored[key] === 'string' ? stored[key].trim() : '';
  }
  const port = Number(stored.sshPort);
  config.sshPort = Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
  return config;
}

/**
 * The setting as the upload request the desktop window sends to Rust.
 *
 * Credentials are passed separately because the file never holds one: a typed
 * key lives in the window's memory, and a missing one falls back to the AWS
 * environment or `~/.aws/credentials`. An SSH destination uses the remote
 * host's own identity, so it has no local credential at all.
 *
 * @returns {object|null} the request, or null when the setting cannot upload yet
 */
export function backupRequestFromConfig(config, credentials = {}) {
  if (!config) return null;
  const bucket = String(config.bucket ?? '').trim();
  if (!bucket) return null;
  const host = String(config.sshHost ?? '').trim();
  const ssh = host !== '';
  return {
    bucket,
    region: config.region || null,
    prefix: config.prefix || 'macusanite/',
    endpoint: config.endpoint || null,
    profile: config.profile || null,
    accessKey: ssh ? null : (credentials.accessKey ?? null),
    secretKey: ssh ? null : (credentials.secretKey ?? null),
    sessionToken: ssh ? null : (credentials.sessionToken ?? null),
    ssh: ssh ? { host, keyFile: config.sshKey || null, port: config.sshPort ?? null } : null,
  };
}

/** The setting as the arguments `vault.backup` takes. */
export function autoBackupArgs(config) {
  return {
    bucket: config.bucket,
    region: config.region || null,
    prefix: config.prefix || null,
    endpoint: config.endpoint || null,
    profile: config.profile || null,
    'ssh-host': config.sshHost || null,
    'ssh-key': config.sshKey || null,
    'ssh-port': config.sshPort ?? null,
  };
}
