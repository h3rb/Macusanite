/**
 * "Update available" dialog: what is new, download progress, and the
 * install-and-restart step. One dialog at a time; installing disables the
 * dismiss buttons because the installer (Windows) or the relaunch
 * (macOS/Linux) is about to take the process away.
 */
import { el, clear } from './dom.js';

export function createUpdateDialog({ app }) {
  const dialog = el('dialog', { class: 'settings-dialog update-dialog' });
  document.body.append(dialog);
  let installing = false;

  function show(summary, onInstall) {
    installing = false;
    const progressLabel = el('p', { class: 'settings-note update-progress-label', text: '' });
    const bar = el('progress', { class: 'update-progress', max: '100', value: '0' });
    bar.hidden = true;
    progressLabel.hidden = true;
    const installBtn = el('button', {
      class: 'btn btn-primary',
      type: 'button',
      text: 'Download & restart',
      onclick: async () => {
        installing = true;
        installBtn.disabled = true;
        laterBtn.disabled = true;
        bar.hidden = false;
        progressLabel.hidden = false;
        progressLabel.textContent = 'Downloading…';
        try {
          await app.installUpdate(summary, (progress) => {
            const pct = progress?.percent;
            bar.value = String(pct ?? 0);
            progressLabel.textContent = pct === null
              ? `Downloading… ${formatBytes(progress?.downloaded ?? 0)}`
              : `Downloading… ${pct}% (${formatBytes(progress?.downloaded ?? 0)}${progress?.total ? ` of ${formatBytes(progress.total)}` : ''})`;
          });
          progressLabel.textContent = 'Installed — restarting…';
          bar.value = '100';
        } catch (error) {
          installing = false;
          installBtn.disabled = false;
          laterBtn.disabled = false;
          progressLabel.textContent = `Could not install the update: ${error.message}`;
          await app.log?.('error', `update install failed: ${error.message}`);
        }
      },
    });
    const laterBtn = el('button', {
      class: 'btn',
      type: 'button',
      text: 'Later',
      onclick: () => { if (!installing) dialog.close(); },
    });

    clear(dialog).append(
      el('form', { method: 'dialog', class: 'settings-body' }, [
        el('header', { class: 'settings-head' }, [
          el('h2', { text: `Update available: ${summary.version}` }),
        ]),
        el('section', { class: 'settings-section' }, [
          summary.currentVersion
            ? el('p', { class: 'settings-note', text: `Macusanite ${summary.currentVersion} → ${summary.version}${summary.date ? ` · ${summary.date}` : ''}` })
            : null,
          summary.notes ? el('pre', { class: 'update-notes', text: summary.notes }) : el('p', { class: 'settings-note', text: 'A newer version of Macusanite is ready. The update is signed — it only installs if its signature verifies.' }),
          progressLabel,
          bar,
        ]),
        el('footer', { class: 'settings-actions' }, [
          el('p', { class: 'settings-hint', text: 'The app restarts into the new version when the install finishes.' }),
          el('div', { class: 'spacer' }),
          laterBtn,
          installBtn,
        ]),
      ]),
    );
    dialog.oncancel = (event) => { if (installing) event.preventDefault(); };
    if (!dialog.open) dialog.showModal();
  }

  return {
    show,
    get element() { return dialog; },
  };
}

function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log10(n) / 3));
  return `${(n / 10 ** (i * 3)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
