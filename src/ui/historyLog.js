/**
 * The history log: every recorded change in the vault, as a list a person can
 * read — newest first, with the current state marked, and every row a jump
 * target. Clicking a row undoes or redoes all the way to it in one move.
 *
 * The undo/redo buttons and the burger menu show only the top of each stack;
 * this dialog is the stack itself. The entries come from `.macusanite/history.json`
 * (see vaultStore's historyState), so CLI edits and window edits share it.
 */
import { el, clear } from './dom.js';

export function createHistoryLog({ app }) {
  const dialog = el('dialog', { class: 'history-dialog' });
  document.body.append(dialog);
  let fileOnly = false;
  let busy = false;

  function formatTime(ts) {
    if (!Number.isFinite(ts)) return '';
    return new Date(ts).toLocaleString();
  }

  function row(entry, kind, glyph, steps) {
    return el('button', {
      class: 'history-row',
      type: 'button',
      disabled: busy ? '' : null,
      title: `${kind === 'undo' ? 'Undo' : 'Redo'} ${steps} step${steps === 1 ? '' : 's'}: ${entry.label}`,
      onclick: async () => {
        busy = true;
        render();
        try {
          if (kind === 'undo') await app.undoSteps(steps);
          else await app.redoSteps(steps);
        } finally {
          busy = false;
          render();
        }
      },
    }, [
      el('span', { class: 'history-glyph', text: glyph }),
      el('span', { class: 'history-main' }, [
        el('span', { class: 'history-label', text: entry.label }),
        el('span', { class: 'history-path', text: entry.path }),
      ]),
      el('span', { class: 'history-time', text: formatTime(entry.ts) }),
    ]);
  }

  function render() {
    const current = app.state.current?.path ?? null;
    const visible = (entry) => !fileOnly || entry.path === current;
    const undo = app.state.undoStack.filter(visible);
    const redo = app.state.redoStack.filter(visible);

    const body = [];
    if (redo.length) {
      body.push(el('h3', { class: 'history-section', text: 'Redo' }));
      redo.forEach((entry, i) => body.push(row(entry, 'redo', '↷', i + 1)));
    }
    body.push(el('div', { class: 'history-now', text: '⦿ now' }));
    if (undo.length) {
      body.push(el('h3', { class: 'history-section', text: 'Undo' }));
      undo.forEach((entry, i) => body.push(row(entry, 'undo', '↶', i + 1)));
    }
    if (!redo.length && !undo.length) {
      body.push(el('p', {
        class: 'history-empty',
        text: fileOnly
          ? 'Nothing recorded for this file yet.'
          : 'Nothing recorded yet — edits, new veins, colour and settings changes will appear here.',
      }));
    }

    clear(dialog).append(
      el('form', { method: 'dialog', class: 'history-body' }, [
        el('header', { class: 'history-head' }, [
          el('h2', { text: 'History log' }),
          el('div', { class: 'spacer' }),
          el('label', { class: 'history-filter' }, [
            el('input', {
              class: 'md-checkbox', type: 'checkbox', checked: fileOnly ? '' : null,
              disabled: current ? null : '',
              onchange: (event) => { fileOnly = event.target.checked; render(); },
            }),
            el('span', { text: current ? `This file only (${current})` : 'This file only' }),
          ]),
          el('button', { class: 'icon-btn', type: 'button', text: '✕', onclick: () => dialog.close() }),
        ]),
        el('p', {
          class: 'history-note',
          text: 'Every recorded change, newest first. Pick any row to jump straight to it — the steps in between are undone or redone in one move.',
        }),
        el('div', { class: 'history-list', role: 'list' }, body),
        el('footer', { class: 'history-foot' }, [
          el('span', {
            class: 'history-counts',
            text: `${app.state.undoStack.length} to undo · ${app.state.redoStack.length} to redo`,
          }),
          el('div', { class: 'spacer' }),
          el('button', { class: 'btn btn-primary', type: 'button', text: 'Close', onclick: () => dialog.close() }),
        ]),
      ]),
    );
  }

  return {
    open() {
      if (!app.state.vault) {
        app.toast('Open a vault first', 'warn');
        return;
      }
      render();
      dialog.showModal();
    },
    /** Redraw in place while open: the stacks move under the dialog whenever
     * a step is taken elsewhere (Ctrl+Z, the buttons, the CLI). */
    refresh() {
      if (dialog.open) render();
    },
    close() {
      dialog.close();
    },
    get element() {
      return dialog;
    },
  };
}
