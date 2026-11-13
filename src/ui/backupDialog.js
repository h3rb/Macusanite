/**
 * The window's S3 backup dialog.
 *
 * The settings — where an upload goes, over which transport, and whether it
 * repeats after each save — are the vault's own `.macusanite/backup.json`: the
 * file `macusanite vault autobackup` writes and the CLI and MCP server read. The
 * dialog is therefore an editor for that setting rather than a second one kept
 * per installation, so a vault armed here is armed everywhere and one armed from
 * a shell is armed here.
 *
 * The file holds only non-secret fields. The access key, secret and session
 * token typed here live in memory for this window's lifetime; a blank secret
 * falls back to the environment or `~/.aws/credentials`, which is where a key
 * belongs, and an SSH upload reads no AWS key on this machine at all.
 */
import { el, clear } from './dom.js';
import { backend } from '../backend.js';
import {
  AUTO_BACKUP_FILE,
  AUTO_BACKUP_PATH,
  backupRequestFromConfig,
  emptyAutoBackup,
  parseAutoBackup,
} from '../lib/autoBackup.js';

/** How long after the last save an automatic upload waits for saving to settle. */
const AUTO_DELAY_MS = 5000;

function humanBytes(value) {
  const size = Number(value) || 0;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function createBackupDialog({ app }) {
  const dialog = el('dialog', { class: 'backup-dialog' });
  document.body.append(dialog);
  let busy = false;
  // Typed credentials live only for as long as this window does.
  let sessionCredentials = null;
  let autoTimer = null;
  let uploading = false;
  let queued = false;
  let warned = false;
  // After a failed automatic upload, saves stop retrying for a while: the
  // failure is almost always configuration, and a retry per pause would fill
  // the log without ever succeeding.
  let autoPausedUntil = 0;

  /** The vault's backup setting, or null when it has none (or is unreadable). */
  async function readConfig() {
    try {
      return parseAutoBackup(await backend.readMeta(AUTO_BACKUP_FILE));
    } catch {
      // A malformed file is reported by `vault autobackup`; the dialog starts
      // from empty and the next save replaces it.
      return null;
    }
  }

  /** Store the setting in the vault, where every Macusanite front end sees it. */
  async function writeConfig(config) {
    await backend.writeMeta(AUTO_BACKUP_FILE, `${JSON.stringify(config, null, 2)}\n`, null, false);
  }

  function field(label, control, hint) {
    return el('label', { class: 'settings-field' }, [
      el('span', { class: 'settings-label', text: label }),
      control,
      hint ? el('span', { class: 'settings-hint', text: hint }) : null,
    ]);
  }

  function input(name, value, { type = 'text', placeholder = '', autocomplete = 'off' } = {}) {
    return el('input', {
      class: 'md-input',
      name,
      type,
      value: value ?? '',
      placeholder,
      autocomplete,
      spellcheck: 'false',
    });
  }

  function render(config) {
    const bucket = input('bucket', config.bucket, { placeholder: 'my-vault-backups' });
    const region = input('region', config.region, { placeholder: 'us-east-1' });
    const prefix = input('prefix', config.prefix || 'macusanite/', { placeholder: 'macusanite/' });
    const endpoint = input('endpoint', config.endpoint, { placeholder: 'https://s3.example:9000 (optional)' });
    const profile = input('profile', config.profile, { placeholder: 'AWS profile (default)' });
    const accessKey = input('accessKey', '', { placeholder: 'AWS access key id (or leave blank)' });
    const secretKey = input('secretKey', '', {
      type: 'password',
      placeholder: 'Secret access key (or leave blank)',
      autocomplete: 'new-password',
    });
    const sessionToken = input('sessionToken', '', {
      type: 'password',
      placeholder: 'Session token (optional)',
      autocomplete: 'new-password',
    });

    const transport = el('select', { class: 'md-input', name: 'transport' }, [
      el('option', { value: 'direct', text: 'Direct to S3 (AWS keys)', selected: config.sshHost ? null : '' }),
      el('option', { value: 'ssh', text: 'Through an SSH host', selected: config.sshHost ? '' : null }),
    ]);
    const sshHost = input('sshHost', config.sshHost, { placeholder: 'user@backup-host' });
    const sshKey = input('sshKey', config.sshKey, { placeholder: '~/.ssh/backup.pem (optional)' });
    const sshPort = input('sshPort', config.sshPort, { type: 'number', placeholder: '22 (optional)' });
    const sshProfile = input('sshProfile', config.profile, { placeholder: 'Remote profile (default)' });
    const autoToggle = el('input', {
      type: 'checkbox',
      name: 'auto',
      checked: config.enabled ? '' : null,
    });

    const status = el('p', { class: 'backup-status', role: 'status' });
    const submit = el('button', { type: 'submit', class: 'btn btn-primary', text: 'Back up' });
    const close = el('button', { type: 'button', class: 'btn', text: 'Close', onclick: () => dialog.close() });

    const hint = el('p', { class: 'md-hint' });
    const directBlock = el('div', { class: 'backup-credentials' }, [
      field('Profile', profile, 'A named profile in ~/.aws/credentials and config.'),
      field('Access key id', accessKey),
      field('Secret access key', secretKey),
      field('Session token', sessionToken, 'Only for temporary credentials.'),
      el('p', { class: 'md-hint', text: 'Leave the credentials blank to use AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, or ~/.aws/credentials. Nothing typed here is saved.' }),
    ]);
    const keyRow = el('div', { class: 'backup-key-row' }, [sshKey]);
    if (backend.isDesktop) {
      keyRow.append(el('button', {
        type: 'button',
        class: 'btn',
        text: 'Choose…',
        onclick: async () => {
          try {
            const picked = await backend.pickFile();
            if (picked) sshKey.value = picked;
          } catch (error) {
            status.className = 'backup-status is-error';
            status.textContent = error?.message ?? String(error);
          }
        },
      }));
    }
    const sshBlock = el('div', { class: 'backup-credentials' }, [
      field('SSH host', sshHost, 'A user@host the machine can reach, or an ~/.ssh/config alias.'),
      field('Private key', keyRow, 'A PEM or OpenSSH key file; blank uses the SSH client’s own key.'),
      field('Port', sshPort, 'Blank uses the SSH client’s configuration.'),
      field('Remote profile', sshProfile, 'The profile on that host, not on this machine.'),
      el('p', { class: 'md-hint', text: 'The archive is streamed over SSH and uploaded there by the host’s own aws CLI. No AWS key is read on this machine.' }),
    ]);

    const sync = () => {
      const ssh = transport.value === 'ssh';
      directBlock.hidden = ssh;
      sshBlock.hidden = !ssh;
      submit.textContent = ssh ? 'Back up over SSH' : 'Back up';
      hint.textContent = ssh
        ? 'One timestamped .tar.gz, uploaded by the remote host. It needs the AWS CLI and its own credentials; nothing in the vault is changed.'
        : 'One timestamped .tar.gz of the whole vault — veins, chambers and .macusanite. Nothing in the vault is changed.';
    };

    /**
     * The setting the form describes, or the reason it cannot be saved yet.
     * Disarming is always allowed, so it does not require a destination.
     */
    const formConfig = ({ requireDestination = true } = {}) => {
      const ssh = transport.value === 'ssh';
      const name = bucket.value.trim();
      const host = sshHost.value.trim();
      const portText = String(sshPort.value ?? '').trim();
      const port = portText ? Number(portText) : null;
      if (requireDestination) {
        if (!name) return { error: 'A bucket is required.', focus: bucket };
        if (ssh && !host) return { error: 'An SSH host is required.', focus: sshHost };
        if (ssh && portText && (!Number.isInteger(port) || port < 1 || port > 65535)) {
          return { error: 'The SSH port must be a number between 1 and 65535.', focus: sshPort };
        }
      }
      return {
        config: {
          enabled: autoToggle.checked,
          bucket: name,
          region: region.value.trim(),
          prefix: prefix.value.trim(),
          endpoint: endpoint.value.trim(),
          profile: ssh ? sshProfile.value.trim() : profile.value.trim(),
          sshHost: ssh ? host : '',
          sshKey: ssh ? sshKey.value.trim() : '',
          sshPort: ssh ? port : null,
        },
      };
    };

    const showError = (error, focus = null) => {
      status.className = 'backup-status is-error';
      status.textContent = error;
      focus?.focus();
    };

    const typedCredentials = () => ({
      accessKey: accessKey.value.trim() || null,
      secretKey: secretKey.value || null,
      sessionToken: sessionToken.value.trim() || null,
    });

    const autoNote = el('p', { class: 'md-hint' });
    const autoNoteText = () => {
      autoNote.textContent = autoToggle.checked
        ? `Saved in this vault’s ${AUTO_BACKUP_PATH}. Waits ${AUTO_DELAY_MS / 1000} seconds after saving stops, uses these settings, and never runs two uploads at once — the CLI and MCP server honour the same setting. A typed secret lasts only until the window closes.`
        : 'Turn this on to upload after every save. The setting belongs to the vault, so the CLI and MCP server honour it too.';
    };
    transport.addEventListener('change', sync);
    autoToggle.addEventListener('change', async () => {
      autoNoteText();
      // Turning this on with a secret already typed means those credentials
      // should be used; a blank form must not wipe credentials an earlier
      // upload kept.
      const typed = typedCredentials();
      if (autoToggle.checked && (typed.accessKey || typed.secretKey)) sessionCredentials = typed;
      const described = formConfig({ requireDestination: autoToggle.checked });
      if (described.error) {
        autoToggle.checked = !autoToggle.checked;
        autoNoteText();
        showError(described.error, described.focus);
        return;
      }
      try {
        await writeConfig(described.config);
        status.className = 'backup-status is-ok';
        status.textContent = described.config.enabled
          ? 'Automatic uploads are on for this vault — the CLI and MCP server use the same setting.'
          : 'Automatic uploads are off for this vault.';
      } catch (error) {
        autoToggle.checked = !autoToggle.checked;
        autoNoteText();
        showError(`Could not save the setting: ${error?.message ?? error}`);
      }
    });
    autoNoteText();

    const form = el('form', { method: 'dialog', class: 'md-dialog-form' }, [
      el('header', { class: 'backup-head' }, [
        el('h2', { class: 'md-dialog-title', text: 'Back up to S3' }),
        el('div', { class: 'spacer' }),
        el('button', {
          type: 'button',
          class: 'icon-btn',
          text: '✕',
          title: 'Close',
          onclick: () => dialog.close(),
        }),
      ]),
      hint,
      field('Bucket', bucket),
      el('div', { class: 'backup-grid' }, [
        field('Region', region),
        field('Prefix', prefix, 'Keeps vaults apart in a shared bucket.'),
      ]),
      field('Endpoint', endpoint, 'For an S3-compatible service; AWS itself needs no endpoint.'),
      field('Transport', transport),
      directBlock,
      sshBlock,
      el('label', { class: 'backup-auto' }, [
        autoToggle,
        el('span', { text: 'Upload automatically after each save' }),
      ]),
      autoNote,
      status,
      el('div', { class: 'md-dialog-actions' }, [close, submit]),
    ]);
    sync();

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (busy) return;
      if (uploading) {
        showError('An upload is already running — try again in a moment.');
        return;
      }
      const described = formConfig();
      if (described.error) {
        showError(described.error, described.focus);
        return;
      }
      const settings = described.config;
      const request = backupRequestFromConfig(settings, typedCredentials());
      const overSsh = transport.value === 'ssh';

      busy = true;
      submit.disabled = true;
      close.disabled = true;
      status.className = 'backup-status';
      status.textContent = overSsh
        ? 'Assembling the archive and streaming it over SSH…'
        : 'Assembling the archive and uploading…';

      uploading = true;
      try {
        const report = await backend.backupS3(request);
        // The backup succeeded, so its settings belong in the vault even if
        // writing them does not: a failed write is logged, not reported as a
        // failed backup.
        try {
          await writeConfig(settings);
        } catch (error) {
          await backend.log('warn', `could not save ${AUTO_BACKUP_PATH}: ${error?.message ?? error}`);
        }
        autoPausedUntil = 0;
        warned = false;
        sessionCredentials = typedCredentials();
        secretKey.value = '';
        sessionToken.value = '';
        status.className = 'backup-status is-ok';
        const via = report.sshHost ? ` via ${report.sshHost}` : '';
        clear(status).append(
          el('strong', { text: `Backed up ${report.files} file${report.files === 1 ? '' : 's'} (${humanBytes(report.bytes)})${via}` }),
          el('span', { class: 'backup-key', text: report.url }),
        );
        app.toast(`Backed up to ${report.url}${via}`, 'ok', 6000);
        await backend.log('info', `backed up to ${report.url}${via} (${report.files} files, ${report.bytes} bytes)`);
      } catch (error) {
        showError(error?.message ?? String(error));
      } finally {
        busy = false;
        finishUpload();
        submit.disabled = false;
        close.disabled = false;
      }
    });

    clear(dialog).append(form);
  }

  /** Shared by both paths: one upload at a time, and a queued save runs after. */
  function finishUpload() {
    uploading = false;
    if (!queued) return;
    queued = false;
    clearTimeout(autoTimer);
    autoTimer = setTimeout(() => {
      autoTimer = null;
      runAutoBackup();
    }, AUTO_DELAY_MS);
  }

  /** The upload a save triggers, when the vault's setting asks for one. */
  async function runAutoBackup() {
    if (!backend.isDesktop) return;
    if (uploading) {
      queued = true;
      return;
    }
    // Read the setting when the upload runs, so arming or disarming it — from
    // this dialog or a shell — takes effect for the very next save.
    const config = await readConfig();
    if (!config?.enabled) return;
    const request = backupRequestFromConfig(config, sessionCredentials ?? {});
    if (!request) return;
    uploading = true;
    try {
      const report = await backend.backupS3(request);
      warned = false;
      const via = report.sshHost ? ` via ${report.sshHost}` : '';
      await backend.log('info', `automatic backup to ${report.url}${via} (${report.files} files, ${report.bytes} bytes)`);
    } catch (error) {
      // Saves happen far more often than a failure is worth a toast: warn once,
      // log it, and let the backoff below keep retries out of the log.
      if (!warned) {
        warned = true;
        app.toast(`Automatic backup failed: ${error?.message ?? error}`, 'error', 7000);
      }
      autoPausedUntil = Date.now() + 5 * 60 * 1000;
      await backend.log('error', `automatic backup failed: ${error?.message ?? error}`);
    } finally {
      finishUpload();
    }
  }

  return {
    async open() {
      if (dialog.open) return;
      const config = (await readConfig()) ?? emptyAutoBackup();
      if (dialog.open) return; // a second click while the setting was loading
      render(config);
      dialog.showModal();
      dialog.querySelector('input[name="bucket"]')?.focus();
    },

    /** Called after a successful save; a no-op unless the vault is armed. */
    async noteSaved() {
      if (!backend.isDesktop || Date.now() < autoPausedUntil) return;
      const config = await readConfig();
      if (!config?.enabled) return;
      if (!backupRequestFromConfig(config, sessionCredentials ?? {})) return;
      clearTimeout(autoTimer);
      autoTimer = setTimeout(() => {
        autoTimer = null;
        runAutoBackup();
      }, AUTO_DELAY_MS);
    },
  };
}
