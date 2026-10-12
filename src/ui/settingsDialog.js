/**
 * Settings dialog: vault identity (name/description), the three default colours,
 * viewer behaviour, graph options and a summary of what lives in .macusanite.
 */
import { el, clear } from './dom.js';
import { normalizeColor, X11_COLORS, PALETTE, nearestX11Name } from '../lib/colors.js';
import { colorStats } from '../lib/colorStore.js';
import { META } from '../backend.js';

export function createSettingsDialog({ app }) {
  const dialog = el('dialog', { class: 'settings-dialog' });
  document.body.append(dialog);

  function field(label, control, hint) {
    return el('label', { class: 'settings-field' }, [
      el('span', { class: 'settings-label', text: label }),
      control,
      hint ? el('span', { class: 'settings-hint', text: hint }) : null,
    ]);
  }

  function numberInput(value, { min, max, step = 1, onchange }) {
    return el('input', {
      class: 'md-input',
      type: 'number',
      value: String(value),
      min: String(min),
      max: String(max),
      step: String(step),
      onchange: (event) => onchange(Number(event.target.value)),
    });
  }

  function checkbox(checked, onchange) {
    return el('input', { class: 'md-checkbox', type: 'checkbox', checked: checked ? '' : null, onchange: (event) => onchange(event.target.checked) });
  }

  function colorField(label, slot, hint) {
    const current = app.state.settings[slot];
    const input = el('input', {
      class: 'md-input color-input',
      value: current,
      spellcheck: 'false',
      onchange: (event) => {
        const hex = normalizeColor(event.target.value);
        if (!hex) {
          event.target.value = app.state.settings[slot];
          app.toast(`"${event.target.value}" is not a colour`, 'warn');
          return;
        }
        app.setDefaultColor(slot, hex, { silent: true });
        event.target.value = hex;
      },
    });
    const picker = el('select', { class: 'md-input' }, [
      el('option', { value: '', text: 'X11…' }),
      ...Object.keys(X11_COLORS).map((name) => el('option', { value: X11_COLORS[name], text: name })),
    ]);
    picker.addEventListener('change', (event) => {
      if (!event.target.value) return;
      app.setDefaultColor(slot, event.target.value, { silent: true });
      input.value = normalizeColor(event.target.value);
      event.target.value = '';
    });
    const quick = el('div', { class: 'settings-swatches' }, PALETTE.slice(0, 12).map((color) => el('button', {
      class: 'picker-cell',
      type: 'button',
      style: `--cell:${color}`,
      title: `${color} ${nearestX11Name(color) ?? ''}`,
      onclick: () => {
        app.setDefaultColor(slot, color, { silent: true });
        input.value = color;
      },
    })));
    return field(label, el('div', { class: 'settings-row' }, [input, picker, quick]), hint);
  }

  function render() {
    const settings = app.state.settings;
    const vault = app.state.vault;
    const stats = colorStats(app.state.colors);

    clear(dialog).append(
      el('form', { method: 'dialog', class: 'settings-body' }, [
        el('header', { class: 'settings-head' }, [
          el('h2', { text: 'Settings' }),
          el('div', { class: 'spacer' }),
          el('button', { class: 'icon-btn', type: 'button', text: '✕', onclick: () => dialog.close() }),
        ]),

        el('section', { class: 'settings-section' }, [
          el('h3', { text: 'Vault' }),
          field('Name', el('input', {
            class: 'md-input',
            value: vault?.name ?? '',
            onchange: (event) => app.updateVaultMeta({ name: event.target.value }),
          })),
          field('Description', el('textarea', {
            class: 'md-input md-textarea',
            rows: '2',
            onchange: (event) => app.updateVaultMeta({ description: event.target.value }),
          }, [vault?.description ?? ''])),
          el('p', { class: 'settings-note' }, [
            el('strong', { text: 'Vault root: ' }),
            el('code', { text: vault?.path ?? '—' }),
          ]),
          el('p', { class: 'settings-note' }, [
            el('strong', { text: `.macusanite/ ` }),
            el('span', { text: `${META.vault}, ${META.settings}, ${META.colors}, ${META.history}, logs/ — ` }),
            el('span', { text: `${stats.total} colour assignment${stats.total === 1 ? '' : 's'} stored` }),
          ]),
        ]),

        el('section', { class: 'settings-section' }, [
          el('h3', { text: 'Default colours' }),
          el('p', { class: 'settings-hint', text: 'Every page, link and section starts here (white out of the box) and inherits until you pick something.' }),
          colorField('Page colour', 'defaultPageColor'),
          colorField('Link colour', 'defaultLinkColor', 'Links fade from their own colour into the colour of their target.'),
          colorField('Section colour', 'defaultSectionColor'),
        ]),

        el('section', { class: 'settings-section' }, [
          el('h3', { text: 'Reading' }),
          el('div', { class: 'settings-grid' }, [
            field('Font size', numberInput(settings.fontSize, { min: 11, max: 28, onchange: (v) => app.updateSettings({ fontSize: v }) })),
            field('Line width', numberInput(settings.lineWidth, { min: 40, max: 160, onchange: (v) => app.updateSettings({ lineWidth: v }) })),
            field('Theme', el('select', { class: 'md-input', onchange: (event) => app.updateSettings({ theme: event.target.value }) }, [
              el('option', { value: 'dark', text: 'Dark', selected: settings.theme === 'dark' ? '' : null }),
              el('option', { value: 'light', text: 'Light', selected: settings.theme === 'light' ? '' : null }),
            ])),
            field('Autosave', checkbox(settings.autosave, (v) => app.updateSettings({ autosave: v })), 'Save the open vein shortly after you stop typing.'),
          ]),
        ]),

        el('section', { class: 'settings-section' }, [
          el('h3', { text: 'Concept graph' }),
          el('div', { class: 'settings-grid' }, [
            field('Depth', numberInput(settings.graph.depth, { min: 1, max: 4, onchange: (v) => app.setGraphOption('depth', v) })),
            field('Layout iterations', numberInput(settings.graph.iterations, { min: 40, max: 1200, step: 20, onchange: (v) => app.setGraphOption('iterations', v) })),
            field('Node radius', numberInput(settings.graph.nodeRadius, { min: 3, max: 20, step: 0.5, onchange: (v) => app.setGraphOption('nodeRadius', v) })),
            field('Fade steps', numberInput(settings.linkFadeSteps, { min: 2, max: 12, onchange: (v) => app.updateSettings({ linkFadeSteps: v }) }), 'Gradient stops used along link edges.'),
            field('Sections', checkbox(settings.graph.showSections, (v) => app.setGraphOption('showSections', v))),
            field('Tags', checkbox(settings.graph.showTags, (v) => app.setGraphOption('showTags', v))),
            field('Unwritten pages', checkbox(settings.graph.showUnresolved, (v) => app.setGraphOption('showUnresolved', v))),
            field('Vault context', checkbox(settings.graph.showContext, (v) => app.setGraphOption('showContext', v))),
          ]),
        ]),

        el('footer', { class: 'settings-actions' }, [
          el('button', { class: 'btn btn-ghost', type: 'button', text: 'Open .macusanite folder', onclick: () => app.revealMetaFolder() }),
          el('div', { class: 'spacer' }),
          el('button', { class: 'btn', type: 'button', text: 'Reset colours', onclick: () => app.resetAllColors() }),
          el('button', { class: 'btn btn-primary', type: 'button', text: 'Done', onclick: () => dialog.close() }),
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
    /**
     * Redraw in place: the state behind these fields can change while the dialog
     * is on screen, because `settings.json` is watched and a hand-edit to it is
     * applied to the running window. A closed dialog has nothing to redraw — it
     * renders again on the next `open()`.
     */
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
