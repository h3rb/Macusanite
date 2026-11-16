/**
 * The Edit view's formatting toolbar.
 *
 * Every tool is a text transform from `lib/markdownEdit.js` applied to the
 * textarea's current selection; the dialogs only collect options and hand the
 * resulting snippet back to the same insertion path. Nothing here writes the
 * vault — `apply` is the viewer's own "put this text in the editor" callback,
 * so the draft, autosave, preview and locked-section rules all still apply.
 */
import { el, clear } from './dom.js';
import {
  wrapInline, toggleLinePrefix, setHeading, insertCodeBlock, insertRule,
  insertTable, insertMermaid, insertInline, linkSnippet, isWebLink,
  MERMAID_KINDS, MERMAID_DIRECTIONS,
} from '../lib/markdownEdit.js';

const MERMAID_LABELS = {
  flowchart: 'Flowchart',
  sequence: 'Sequence diagram',
  class: 'Class diagram',
  state: 'State diagram',
  er: 'Entity relationship',
  gantt: 'Gantt chart',
  pie: 'Pie chart',
  journey: 'User journey',
  mindmap: 'Mind map',
};

export function createFormatBar({ textarea, apply, blocked, warnBlocked, linkTargets }) {
  const selection = () => ({
    start: textarea.selectionStart ?? 0,
    end: textarea.selectionEnd ?? textarea.selectionStart ?? 0,
  });

  /** Apply one transform to the current selection, refusing locked sections. */
  function run(transform) {
    const { start, end } = selection();
    if (blocked?.(start, end)) {
      warnBlocked?.();
      return;
    }
    const result = transform(textarea.value, start, end);
    if (result && result.text !== textarea.value) apply(result.text, result.start, result.end);
  }

  function tool(text, title, onclick, extraClass = '') {
    return el('button', {
      class: `fmt-btn ${extraClass}`.trim(),
      type: 'button',
      title,
      'aria-label': title.replace(/\s*\(.*\)$/, ''),
      text,
      onclick,
    });
  }

  const separator = () => el('span', { class: 'fmt-sep', 'aria-hidden': 'true' });

  /* ── dialogs ─────────────────────────────────────────────────────────── */

  /**
   * A modal with a form. `onSubmit(fail)` returns true when it is done; `fail`
   * keeps the dialog open and shows a message under the fields.
   */
  function openModal(title, fields, submitLabel, onSubmit) {
    for (const stale of document.querySelectorAll('dialog.md-dialog')) stale.remove();
    const dialog = el('dialog', { class: 'md-dialog composition-dialog' });
    const error = el('p', { class: 'md-dialog-error hidden' });
    const form = el('form', { method: 'dialog', class: 'md-dialog-form' });
    const close = () => {
      if (dialog.open) dialog.close();
      dialog.remove();
    };
    const fail = (message) => {
      error.textContent = message;
      error.classList.remove('hidden');
    };
    form.append(
      el('h2', { class: 'md-dialog-title', text: title }),
      ...fields,
      error,
      el('div', { class: 'md-dialog-actions' }, [
        el('button', { class: 'btn', type: 'button', text: 'Cancel', title: 'Close without inserting anything', onclick: close }),
        el('button', { class: 'btn btn-primary', type: 'submit', icon: 'check', text: submitLabel, title: submitLabel }),
      ]),
    );
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      error.classList.add('hidden');
      if (!onSubmit(fail)) return;
      close();
      textarea.focus();
    });
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      close();
    });
    dialog.append(form);
    document.body.append(dialog);
    dialog.showModal();
    return dialog;
  }

  function field(labelText, control, hint = '') {
    return el('label', { class: 'md-field' }, [
      el('span', { text: labelText }),
      control,
      hint ? el('span', { class: 'md-hint', text: hint }) : null,
    ]);
  }

  /* ── link ────────────────────────────────────────────────────────────── */

  function openLinkDialog() {
    const { start, end } = selection();
    if (blocked?.(start, end)) {
      warnBlocked?.();
      return;
    }
    const selectedText = textarea.value.slice(start, end).replace(/\s+/g, ' ').trim();
    const targets = linkTargets?.() ?? [];

    const textInput = el('input', {
      class: 'md-input',
      value: selectedText,
      placeholder: 'Link text (optional)',
      autocomplete: 'off',
      spellcheck: 'false',
    });
    const targetInput = el('input', {
      class: 'md-input',
      placeholder: 'A vein, a path, or https://…',
      autocomplete: 'off',
      spellcheck: 'false',
    });
    const format = el('select', { class: 'md-input' }, [
      el('option', { value: 'wiki', text: 'Wiki link — [[Vein]]' }),
      el('option', { value: 'markdown', text: 'Markdown link — [text](target)' }),
    ]);
    const list = el('div', { class: 'combo-list hidden', role: 'listbox' });
    const combo = el('div', { class: 'combo' }, [targetInput, list]);
    let options = [];
    let active = -1;
    let formatTouched = false;

    const hideList = () => {
      clear(list);
      list.classList.add('hidden');
      options = [];
      active = -1;
    };

    function paintActive() {
      [...list.children].forEach((node, index) => {
        node.classList.toggle('is-active', index === active);
        node.setAttribute('aria-selected', index === active ? 'true' : 'false');
      });
    }

    const choose = (entry) => {
      targetInput.value = entry.target;
      if (!textInput.value.trim()) textInput.value = entry.title;
      hideList();
      textInput.focus();
      textInput.select();
    };

    function renderList() {
      const query = targetInput.value.trim().toLowerCase();
      const matches = targets
        .filter((entry) => !query
          || entry.target.toLowerCase().includes(query)
          || entry.title.toLowerCase().includes(query))
        .slice(0, 8);
      clear(list);
      options = matches;
      active = matches.length ? 0 : -1;
      for (const [index, entry] of matches.entries()) {
        list.append(el('button', {
          class: `combo-option ${index === active ? 'is-active' : ''}`,
          type: 'button',
          role: 'option',
          'aria-selected': index === active ? 'true' : 'false',
          title: entry.path ? `${entry.title} — ${entry.path}` : entry.title,
          onmousedown: (event) => event.preventDefault(),
          onclick: () => choose(entry),
        }, [
          el('span', { class: 'combo-title', text: entry.title }),
          el('span', { class: 'combo-detail', text: entry.path }),
        ]));
      }
      list.classList.toggle('hidden', !matches.length);
    }

    targetInput.addEventListener('focus', renderList);
    targetInput.addEventListener('input', () => {
      if (!formatTouched && isWebLink(targetInput.value)) format.value = 'markdown';
      renderList();
    });
    targetInput.addEventListener('blur', () => setTimeout(hideList, 150));
    targetInput.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (list.classList.contains('hidden')) {
          renderList();
          return;
        }
        if (!options.length) return;
        active = (active + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
        paintActive();
        return;
      }
      if (event.key === 'Enter' && !list.classList.contains('hidden') && options[active]) {
        event.preventDefault();
        choose(options[active]);
        return;
      }
      if (event.key === 'Escape' && !list.classList.contains('hidden')) {
        event.preventDefault();
        event.stopPropagation();
        hideList();
      }
    });
    format.addEventListener('change', () => { formatTouched = true; });

    const dialog = openModal('Insert link', [
      field('Text', textInput),
      field('Link to', combo, 'Type freely, or pick a vein from the list. A full URL is inserted as a Markdown link.'),
      field('Format', format),
    ], 'Insert link', (fail) => {
      const raw = targetInput.value.trim();
      if (!raw) {
        fail('Type a link target — a vein name, a path, or a URL.');
        targetInput.focus();
        return false;
      }
      const mode = format.value === 'wiki' && isWebLink(raw) ? 'markdown' : format.value;
      const name = textInput.value.trim();
      let href = raw;
      if (mode === 'markdown' && !isWebLink(raw) && !/\.(md|markdown|mdx)$/i.test(raw)) href = `${raw}.md`;
      const snippet = linkSnippet({ target: mode === 'markdown' ? href : raw, label: name, format: mode });
      // Where the label sits inside the snippet, so it stays selected for a rename.
      const labelAt = !name ? -1 : mode === 'markdown' ? 1 : snippet.includes('|') ? snippet.indexOf('|') + 1 : -1;
      const placed = insertInline(
        textarea.value,
        start,
        end,
        snippet,
        labelAt >= 0 ? { start: labelAt, end: labelAt + name.length } : {},
      );
      apply(placed.text, placed.start, placed.end);
      return true;
    });
    targetInput.focus();
    return dialog;
  }

  /* ── table ───────────────────────────────────────────────────────────── */

  function openTableDialog() {
    const columns = el('input', { class: 'md-input', type: 'number', min: '1', max: '10', step: '1', value: '3' });
    const rows = el('input', { class: 'md-input', type: 'number', min: '0', max: '20', step: '1', value: '2' });
    const align = el('select', { class: 'md-input' }, [
      el('option', { value: 'left', text: 'Left' }),
      el('option', { value: 'center', text: 'Centre' }),
      el('option', { value: 'right', text: 'Right' }),
    ]);
    const header = el('input', { class: 'md-checkbox', type: 'checkbox' });
    header.checked = true;

    const dialog = openModal('Insert table', [
      el('div', { class: 'md-dialog-row' }, [
        field('Columns', columns),
        field('Body rows', rows),
        field('Alignment', align),
      ]),
      el('label', { class: 'md-check-field' }, [
        header,
        el('span', { text: 'Header row' }),
      ]),
      el('p', { class: 'md-hint', text: 'Markdown tables always have a header row; without a header its cells are left blank.' }),
    ], 'Insert table', (fail) => {
      const cols = Number(columns.value);
      const body = Number(rows.value);
      if (!Number.isInteger(cols) || cols < 1 || cols > 10) {
        fail('Columns must be a whole number between 1 and 10.');
        columns.focus();
        return false;
      }
      if (!Number.isInteger(body) || body < 0 || body > 20) {
        fail('Body rows must be a whole number between 0 and 20.');
        rows.focus();
        return false;
      }
      run((text, from, to) => insertTable(text, from, to, {
        columns: cols,
        rows: body,
        header: header.checked,
        align: align.value,
      }));
      return true;
    });
    columns.focus();
    columns.select();
    return dialog;
  }

  /* ── mermaid ─────────────────────────────────────────────────────────── */

  function openMermaidDialog() {
    const kind = el('select', { class: 'md-input' }, MERMAID_KINDS.map((value) => el('option', {
      value,
      text: MERMAID_LABELS[value] ?? value,
    })));
    const direction = el('select', { class: 'md-input' }, MERMAID_DIRECTIONS.map((value) => el('option', {
      value,
      text: value,
    })));
    const syncDirection = () => {
      direction.disabled = kind.value !== 'flowchart';
    };
    kind.addEventListener('change', syncDirection);
    syncDirection();

    const dialog = openModal('Insert Mermaid diagram', [
      field('Diagram', kind),
      field('Direction', direction, 'Only flowcharts have a direction.'),
      el('p', { class: 'md-hint', text: 'Inserts a fenced mermaid block with a starter diagram you can edit.' }),
    ], 'Insert diagram', () => {
      run((text, from, to) => insertMermaid(text, from, to, {
        kind: kind.value,
        direction: direction.value,
      }));
      return true;
    });
    kind.focus();
    return dialog;
  }

  /* ── the bar ─────────────────────────────────────────────────────────── */

  const element = el('div', { class: 'editor-format-bar', role: 'toolbar', 'aria-label': 'Markdown formatting' }, [
    tool('B', 'Bold (Ctrl+B)', () => run((t, s, e) => wrapInline(t, s, e, '**', 'bold text')), 'fmt-bold'),
    tool('I', 'Italic (Ctrl+I)', () => run((t, s, e) => wrapInline(t, s, e, '*', 'italic text')), 'fmt-italic'),
    tool('S', 'Strikethrough', () => run((t, s, e) => wrapInline(t, s, e, '~~', 'struck text')), 'fmt-strike'),
    tool('`code`', 'Inline code', () => run((t, s, e) => wrapInline(t, s, e, '`', 'code')), 'fmt-mono'),
    separator(),
    tool('H1', 'Heading 1', () => run((t, s, e) => setHeading(t, s, e, 1))),
    tool('H2', 'Heading 2', () => run((t, s, e) => setHeading(t, s, e, 2))),
    tool('H3', 'Heading 3', () => run((t, s, e) => setHeading(t, s, e, 3))),
    separator(),
    tool('❝', 'Quote', () => run((t, s, e) => toggleLinePrefix(t, s, e, 'quote'))),
    tool('• List', 'Bullet list', () => run((t, s, e) => toggleLinePrefix(t, s, e, 'bullet'))),
    tool('1. List', 'Numbered list', () => run((t, s, e) => toggleLinePrefix(t, s, e, 'ordered'))),
    tool('☑', 'Task list', () => run((t, s, e) => toggleLinePrefix(t, s, e, 'task'))),
    separator(),
    tool('{ }', 'Code block', () => run(insertCodeBlock), 'fmt-mono'),
    tool('―', 'Horizontal rule', () => run(insertRule)),
    separator(),
    tool('Link', 'Insert link (Ctrl+Shift+K)', openLinkDialog, 'fmt-text'),
    tool('Table', 'Insert table', openTableDialog, 'fmt-text'),
    tool('Mermaid', 'Insert Mermaid diagram', openMermaidDialog, 'fmt-text'),
  ]);

  // The shortcuts an editor is expected to have, on top of the buttons.
  textarea.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === 'b') {
      event.preventDefault();
      run((t, s, e) => wrapInline(t, s, e, '**', 'bold text'));
    } else if (key === 'i') {
      event.preventDefault();
      run((t, s, e) => wrapInline(t, s, e, '*', 'italic text'));
    } else if (key === 'k' && event.shiftKey) {
      // Ctrl+Shift+K, not Ctrl+K: plain Ctrl+K stays the app-wide jump palette.
      event.preventDefault();
      event.stopPropagation();
      openLinkDialog();
    }
  });

  return { element };
}
