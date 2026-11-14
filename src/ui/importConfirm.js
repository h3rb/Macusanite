/**
 * The Import vault confirmation: what the archive carries, and — before
 * anything is overwritten or deleted — exactly which existing files would
 * change. Replace re-plans against the same local snapshot, so its deletion
 * list is never a guess: nothing is removed until the user checks the box and
 * confirms the import.
 */

import { el, clear, appendAll } from './dom.js';

function fileList(className, paths) {
  if (!paths?.length) return null;
  const list = el('ul', { class: className });
  for (const path of paths) list.append(el('li', { text: path }));
  return list;
}

export function confirmImport({ archive, preview, replacePreview = null, sourceName, canReplace = false }) {
  return new Promise((resolve) => {
    const dialog = el('dialog', { class: 'import-dialog' });
    document.body.append(dialog);
    // A dialog can close twice — the button calls close(), which fires the
    // native `close` event, and Escape does the same — so settle once and
    // never call close() again from the event that close() itself fired.
    let settled = false;
    let replace = false;
    const finish = (confirmed) => {
      if (settled) return;
      settled = true;
      if (dialog.open) dialog.close();
      dialog.remove();
      resolve(confirmed ? { replace } : null);
    };
    dialog.addEventListener('close', () => finish(false));

    const intro = el('p', { class: 'import-intro' });
    const deletionBox = el('div', { class: 'import-deletions' });
    const primary = el('button', {
      type: 'button',
      class: 'btn',
      onclick: () => finish(true),
    });
    const chosen = () => (replace && replacePreview ? replacePreview : preview);
    const refresh = () => {
      const active = chosen();
      const deleting = replace ? active.deletions.length : 0;
      intro.textContent = `${sourceName} — ${archive.manifest.fileCount} files${preview.vaultName ? ` from “${preview.vaultName}”` : ''}. ${active.added.length} new, ${active.conflicts.length} would be overwritten, ${active.unchanged.length} unchanged${replace ? `, ${deleting} would be deleted` : ''}. Undo/redo history travels with the archive.`;

      appendAll(clear(deletionBox), replace
        ? (deleting
            ? el('div', { class: 'import-conflicts' }, [
                el('p', { text: `Deleting these ${deleting} local file${deleting === 1 ? '' : 's'} missing from the archive (except .git):` }),
                fileList('import-file-list', active.deletions),
              ])
            : el('p', { class: 'import-ok', text: 'No local files would be deleted.' }))
        : null);

      const overwriting = active.conflicts.length;
      primary.textContent = overwriting && deleting
        ? `Overwrite ${overwriting}, delete ${deleting}, and import`
        : overwriting
          ? `Overwrite ${overwriting} and import`
          : deleting
            ? `Delete ${deleting} and import`
            : 'Import';
      primary.className = `btn ${overwriting || deleting ? 'btn-warn' : 'btn-primary'}`;
    };

    appendAll(clear(dialog), [
      el('header', { class: 'backup-head' }, [
        el('h2', { class: 'md-dialog-title', text: 'Import vault' }),
        el('div', { class: 'spacer' }),
        el('button', {
          type: 'button',
          class: 'icon-btn',
          text: '✕',
          title: 'Cancel the import',
          onclick: () => finish(false),
        }),
      ]),
      intro,
      preview.conflicts.length
        ? el('div', { class: 'import-conflicts' }, [
            el('p', { text: `Overwriting these ${preview.conflicts.length} existing file${preview.conflicts.length === 1 ? '' : 's'}:` }),
            fileList('import-file-list', preview.conflicts),
          ])
        : el('p', { class: 'import-ok', text: 'No existing files would be overwritten.' }),
      preview.added.length
        ? el('details', { class: 'import-added' }, [
            el('summary', { text: `New files (${preview.added.length})` }),
            fileList('import-file-list', preview.added),
          ])
        : null,
      canReplace
        ? el('label', { class: 'import-replace' }, [
            el('input', {
              type: 'checkbox',
              onchange: (event) => {
                replace = event.target.checked;
                refresh();
              },
            }),
            el('span', { text: 'Replace — delete local files the archive does not carry' }),
          ])
        : null,
      canReplace
        ? el('p', { class: 'import-replace-hint', text: 'When checked, files listed below are removed only after the import writes; .git is never touched.' })
        : null,
      deletionBox,
      el('div', { class: 'settings-actions' }, [
        el('button', {
          type: 'button',
          class: 'btn',
          text: 'Cancel',
          onclick: () => finish(false),
        }),
        primary,
      ]),
    ]);
    refresh();
    dialog.showModal();
  });
}
