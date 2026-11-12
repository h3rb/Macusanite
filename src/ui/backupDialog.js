/**
 * The window's S3 backup dialog.
 *
 * It collects the bucket and either credentials or an SSH host, calls the Rust
 * command that does the upload (`backup_vault_s3`), and shows where the object
 * landed. The connection fields that are not secrets are remembered per
 * installation, because they are the tedious part; the access key, secret and
 * session token are deliberately not written anywhere — a blank secret falls
 * back to the environment or `~/.aws/credentials`, which is where a key belongs,
 * and an SSH upload reads no AWS key on this machine at all.
 */
import { el, clear } from './dom.js';
import { backend } from '../backend.js';

const DRAFT_KEY = 'macusanite.s3-backup.v1';

/** How long after the last save an automatic upload waits for saving to settle. */
const AUTO_DELAY_MS = 5000;

function readDraft() {
  try {
    const parsed = JSON.parse(globalThis.localStorage?.getItem(DRAFT_KEY) ?? 'null');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeDraft(draft) {
  try {
    globalThis.localStorage?.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch {
    /* storage disabled: the dialog still works for this session */
  }
}

function humanBytes(value) {
  const size = Number(value) || 0;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The upload request a stored draft describes, or null when it is not ready.
 *
 * Automatic uploads run from the remembered draft, never from the dialog's
 * inputs: the window may have been closed and reopened since it was filled in.
 * Credentials are passed separately because they are never stored, and an SSH
 * draft has none at all.
 */
export function backupRequestFromDraft(draft, credentials = {}) {
  if (!draft || !String(draft.bucket ?? '').trim()) return null;
  const ssh = draft.transport === 'ssh';
  const host = String(draft.sshHost ?? '').trim();
  if (ssh && !host) return null;
  const portText = String(draft.sshPort ?? '').trim();
  const port = portText ? Number(portText) : null;
  if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) return null;
  return {
    bucket: String(draft.bucket).trim(),
    region: draft.region || null,
    prefix: draft.prefix ?? 'macusanite/',
    endpoint: draft.endpoint || null,
    profile: ssh ? (draft.sshProfile || null) : (draft.profile || null),
    accessKey: ssh ? null : (credentials.accessKey ?? null),
    secretKey: ssh ? null : (credentials.secretKey ?? null),
    sessionToken: ssh ? null : (credentials.sessionToken ?? null),
    ssh: ssh ? { host, keyFile: String(draft.sshKey ?? '').trim() || null, port } : null,
  };
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

  function render() {
    const draft = readDraft();
    const bucket = input('bucket', draft.bucket, { placeholder: 'my-vault-backups' });
    const region = input('region', draft.region, { placeholder: 'us-east-1' });
    const prefix = input('prefix', draft.prefix ?? 'macusanite/', { placeholder: 'macusanite/' });
    const endpoint = input('endpoint', draft.endpoint, { placeholder: 'https://s3.example:9000 (optional)' });
    const profile = input('profile', draft.profile, { placeholder: 'AWS profile (default)' });
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
      el('option', { value: 'direct', text: 'Direct to S3 (AWS keys)', selected: draft.transport !== 'ssh' ? '' : null }),
      el('option', { value: 'ssh', text: 'Through an SSH host', selected: draft.transport === 'ssh' ? '' : null }),
    ]);
    const sshHost = input('sshHost', draft.sshHost, { placeholder: 'user@backup-host' });
    const sshKey = input('sshKey', draft.sshKey, { placeholder: '~/.ssh/backup.pem (optional)' });
    const sshPort = input('sshPort', draft.sshPort, { type: 'number', placeholder: '22 (optional)' });
    const sshProfile = input('sshProfile', draft.sshProfile, { placeholder: 'Remote profile (default)' });
    const autoToggle = el('input', {
      type: 'checkbox',
      name: 'auto',
      checked: draft.auto === true ? '' : null,
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

    /** The non-secret settings, exactly as they would be remembered. */
    const snapshot = () => ({
      bucket: bucket.value.trim(),
      region: region.value.trim(),
      prefix: prefix.value.trim(),
      endpoint: endpoint.value.trim(),
      transport: transport.value,
      profile: profile.value.trim(),
      sshHost: sshHost.value.trim(),
      sshKey: sshKey.value.trim(),
      sshPort: sshPort.value.trim(),
      sshProfile: sshProfile.value.trim(),
      auto: autoToggle.checked,
    });
    const autoNote = el('p', { class: 'md-hint' });
    const autoNoteText = () => {
      autoNote.textContent = autoToggle.checked
        ? `Waits ${AUTO_DELAY_MS / 1000} seconds after saving stops, uses the settings above, and never runs two uploads at once. A typed secret lasts only until the window closes.`
        : 'Tick this to repeat the last upload after every save.';
    };
    transport.addEventListener('change', () => {
      sync();
      writeDraft(snapshot());
    });
    autoToggle.addEventListener('change', () => {
      // Turning this on with a secret already typed means those credentials
      // should be used; a blank form must not wipe credentials an earlier
      // upload kept.
      const typed = {
        accessKey: accessKey.value.trim() || null,
        secretKey: secretKey.value || null,
        sessionToken: sessionToken.value.trim() || null,
      };
      if (autoToggle.checked && (typed.accessKey || typed.secretKey)) sessionCredentials = typed;
      writeDraft(snapshot());
      autoNoteText();
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
        status.className = 'backup-status is-error';
        status.textContent = 'An upload is already running — try again in a moment.';
        return;
      }
      const name = bucket.value.trim();
      if (!name) {
        status.className = 'backup-status is-error';
        status.textContent = 'A bucket is required.';
        bucket.focus();
        return;
      }

      busy = true;
      submit.disabled = true;
      close.disabled = true;
      status.className = 'backup-status';
      const overSsh = transport.value === 'ssh';
      if (overSsh && !sshHost.value.trim()) {
        busy = false;
        submit.disabled = false;
        close.disabled = false;
        status.className = 'backup-status is-error';
        status.textContent = 'An SSH host is required.';
        sshHost.focus();
        return;
      }
      const portText = sshPort.value.trim();
      const port = portText ? Number(portText) : null;
      if (overSsh && portText && (!Number.isInteger(port) || port < 1 || port > 65535)) {
        busy = false;
        submit.disabled = false;
        close.disabled = false;
        status.className = 'backup-status is-error';
        status.textContent = 'The SSH port must be a number between 1 and 65535.';
        sshPort.focus();
        return;
      }
      status.textContent = overSsh
        ? 'Assembling the archive and streaming it over SSH…'
        : 'Assembling the archive and uploading…';

      const request = {
        bucket: name,
        region: region.value.trim() || null,
        prefix: prefix.value.trim(),
        endpoint: endpoint.value.trim() || null,
        profile: overSsh ? (sshProfile.value.trim() || null) : (profile.value.trim() || null),
        accessKey: overSsh ? null : (accessKey.value.trim() || null),
        secretKey: overSsh ? null : (secretKey.value || null),
        sessionToken: overSsh ? null : (sessionToken.value.trim() || null),
        ssh: overSsh
          ? { host: sshHost.value.trim(), keyFile: sshKey.value.trim() || null, port }
          : null,
      };
      uploading = true;
      try {
        const report = await backend.backupS3(request);
        writeDraft(snapshot());
        autoPausedUntil = 0;
        warned = false;
        sessionCredentials = {
          accessKey: accessKey.value.trim() || null,
          secretKey: secretKey.value || null,
          sessionToken: sessionToken.value.trim() || null,
        };
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
        status.className = 'backup-status is-error';
        status.textContent = error?.message ?? String(error);
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

  /** The upload a save triggers, when the dialog was told to repeat it. */
  async function runAutoBackup() {
    if (!backend.isDesktop) return;
    const draft = readDraft();
    if (draft.auto !== true) return;
    const request = backupRequestFromDraft(draft, sessionCredentials ?? {});
    if (!request) return;
    if (uploading) {
      queued = true;
      return;
    }
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
    open() {
      render();
      dialog.showModal();
      dialog.querySelector('input[name="bucket"]')?.focus();
    },

    /** Called after a successful save; a no-op unless automatic upload is on. */
    noteSaved() {
      if (!backend.isDesktop) return;
      const draft = readDraft();
      if (draft.auto !== true) return;
      if (Date.now() < autoPausedUntil) return;
      if (!backupRequestFromDraft(draft, sessionCredentials ?? {})) return;
      clearTimeout(autoTimer);
      autoTimer = setTimeout(() => {
        autoTimer = null;
        runAutoBackup();
      }, AUTO_DELAY_MS);
    },
  };
}
