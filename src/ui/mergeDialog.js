/**
 * The question asked when a vein changed in the viewer and on disk at once.
 *
 * It follows the shape of `askText` in `dom.js` — a `<dialog>`, no framework — and
 * answers with a choice rather than a boolean, because there are three sensible
 * things to do and one of them ("keep what I typed") is what the viewer did
 * before this dialog existed.
 *
 * The preview is the point of the dialog: every line is shown in the order the
 * merged text will have it, with the lines that came from disk, the lines you
 * typed and the conflicts between them marked. The conflict markers are shown
 * literally, because they are literally what will be in the editor — the reader
 * resolves them there.
 */
import { el } from './dom.js';
import { describeMerge, MERGE_LABELS } from '../lib/merge.js';

/**
 * @param {object} input
 * @param {string} input.name  the vein's file name, for the title
 * @param {ReturnType<typeof import('../lib/merge.js').mergeVein>} input.merge
 * @returns {Promise<'merge'|'disk'|'keep'>} `keep` also answers a dismissed dialog
 */
export function askMerge({ name, merge }) {
  return new Promise((resolve) => {
    for (const stale of document.querySelectorAll('dialog.merge-dialog')) stale.remove();

    const dialog = el('dialog', { class: 'merge-dialog' });
    const closable = () => {
      if (dialog.open) dialog.close();
      dialog.remove();
      resolve('keep');
    };
    const finish = (choice) => {
      if (dialog.open) dialog.close();
      dialog.remove();
      resolve(choice);
    };

    const intro = merge.unchanged
      ? 'The disk already says what your draft says — nothing to merge.'
      : merge.supported
        ? 'You have unsaved text in this vein and another program saved it too. Here is what a line-by-line merge would make of the two.'
        : 'You have unsaved text in this vein and another program saved it too. There is no earlier version to compare against, so only you can decide.';

    dialog.append(el('div', { class: 'merge-body' }, [
      el('header', { class: 'merge-head' }, [
        el('h2', { class: 'md-dialog-title', text: `“${name}” changed on disk` }),
        el('div', { class: 'spacer' }),
        el('button', { type: 'button', class: 'icon-btn', text: '✕', title: 'Keep my draft', onclick: closable }),
      ]),
      el('p', { class: 'md-hint', text: intro }),
      el('div', { class: 'merge-summary' }, [
        el('span', { class: `merge-chip ${merge.conflicts ? 'is-conflict' : 'is-clean'}`, text: describeMerge(merge) }),
      ]),
      merge.supported ? preview(merge) : null,
      el('div', { class: 'merge-legend' }, [
        el('span', { class: 'merge-key merge-key-theirs' }, ['from disk']),
        el('span', { class: 'merge-key merge-key-mine' }, ['yours']),
        merge.conflicts ? el('span', { class: 'merge-key merge-key-conflict' }, ['conflict']) : null,
      ]),
      merge.conflicts
        ? el('p', { class: 'md-hint', text: 'The marked regions are in the text you will edit. Resolve them — autosave stays out of the way until you do — and the vein is saved with Ctrl+S.' })
        : null,
      el('div', { class: 'md-dialog-actions' }, [
        el('button', { type: 'button', class: 'btn', text: 'Keep my draft', onclick: () => finish('keep') }),
        el('button', { type: 'button', class: 'btn', text: 'Use the disk version', onclick: () => finish('disk') }),
        merge.unchanged || !merge.supported
          ? null
          : el('button', {
            type: 'button',
            class: 'btn btn-primary',
            text: merge.conflicts ? `Merge, marking ${merge.conflicts === 1 ? 'the conflict' : `${merge.conflicts} conflicts`}` : 'Merge into my draft',
            onclick: () => finish('merge'),
          }),
      ]),
    ]));

    dialog.addEventListener('cancel', closable);
    document.body.append(dialog);
    dialog.showModal();
    dialog.querySelector('.btn-primary')?.focus();
  });
}

/** The merged text, line by line: one block per run of lines with the same origin. */
function preview(merge) {
  const box = el('div', { class: 'merge-preview' });
  for (const part of merge.parts) {
    if (part.kind === 'conflict') box.append(conflictBlock(part.lines));
    else box.append(el('pre', { class: `merge-lines merge-lines-${part.kind}`, text: part.lines.join('\n') }));
  }
  return box;
}

/**
 * A conflicting region: the two versions with the marker lines the editor will
 * carry, shown flat so the preview is exactly what the reader is about to get.
 */
function conflictBlock(lines) {
  const middle = lines.indexOf('=======');
  const mine = lines.slice(1, middle);
  const theirs = lines.slice(middle + 1, Math.max(middle + 1, lines.length - 1));
  const block = el('div', { class: 'merge-conflict' });
  block.append(el('div', { class: 'merge-marker', text: `<<<<<<< ${MERGE_LABELS.mine}` }));
  block.append(el('pre', { class: 'merge-lines merge-lines-mine', text: mine.join('\n') }));
  block.append(el('div', { class: 'merge-marker', text: '=======' }));
  block.append(el('pre', { class: 'merge-lines merge-lines-theirs', text: theirs.join('\n') }));
  block.append(el('div', { class: 'merge-marker', text: `>>>>>>> ${MERGE_LABELS.theirs}` }));
  return block;
}
