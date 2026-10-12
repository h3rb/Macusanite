/**
 * The colour picker popover.
 *
 * Opened by any swatch in the app: recent colours, the common palette, a searchable
 * X11 selector, a `#hex` field and red/green/blue sliders — all four inputs stay
 * in sync with each other.
 */
import { el, clear, qs } from './dom.js';
import {
  PALETTE, X11_COLORS, normalizeColor, hexToRgb, rgbToHex, contrastColor, nearestX11Name,
} from '../lib/colors.js';
import { describeTarget } from '../lib/colorStore.js';

const toHex = (value) => normalizeColor(value) ?? '#ffffff';

export function createColorPicker({ app, root }) {
  const popover = el('div', { class: 'color-popover hidden', role: 'dialog', 'aria-label': 'Colour picker' });
  root.append(popover);

  let current = { color: '#ffffff', target: null, anchor: null, preview: null };
  let swatches = () => {};
  let hexInput = null;
  let sliders = null;
  let previewBox = null;
  let x11Select = null;

  function open(target, anchorEl, options = {}) {
    current.target = target;
    current.anchor = anchorEl;
    const existing = target.kind === 'default'
      ? app.state.settings.defaultPageColor
      : app.assignedColorFor(target);
    current.color = existing ?? app.colorFor(target.kind, target);
    current.inherited = existing === null;
    current.onPreview = options.onPreview ?? null;

    renderPopover();
    position(anchorEl);
    popover.classList.remove('hidden');
    popover.dataset.open = 'true';
  }

  function close() {
    popover.classList.add('hidden');
    delete popover.dataset.open;
    current.anchor?.classList.remove('is-picking');
  }

  function isOpen() {
    return !popover.classList.contains('hidden');
  }

  function position(anchorEl) {
    if (!anchorEl) return;
    const rect = anchorEl.getBoundingClientRect();
    const width = 320;
    const height = popover.offsetHeight || 420;
    let left = rect.left + window.scrollX;
    let top = rect.bottom + 8 + window.scrollY;
    if (left + width > window.innerWidth - 12) left = Math.max(12, window.innerWidth - width - 12);
    if (rect.bottom + height > window.innerHeight && rect.top > height) top = rect.top - height - 8 + window.scrollY;
    popover.style.left = `${left}px`;
    popover.style.top = `${Math.max(8, top)}px`;
  }

  function setColor(value, { commit = false, silent = false } = {}) {
    const hex = toHex(value);
    current.color = hex;
    syncInputs();
    if (!silent) applyPreview(hex);
    if (commit) commitColor(hex);
  }

  function applyPreview(hex) {
    if (current.anchor) {
      current.anchor.style.setProperty('--swatch', hex);
      current.anchor.dataset.preview = hex;
    }
    current.onPreview?.(hex);
  }

  function commitColor(hex) {
    if (current.target?.kind === 'default') {
      app.setDefaultColor(current.target.slot, hex);
    } else if (current.target) {
      app.applyColor(current.target, hex);
    }
    app.rememberRecentColor(hex);
    close();
  }

  function renderPopover() {
    const description = current.target?.kind === 'default'
      ? { title: `Default ${current.target.slot} colour`, subtitle: 'applies to every target that has no colour of its own' }
      : describeTarget(current.target.kind, current.target);
    const recent = app.state.settings.recentColors;
    const palette = app.state.settings.palette?.length ? app.state.settings.palette : PALETTE;
    const x11Names = Object.keys(X11_COLORS);

    previewBox = el('div', { class: 'picker-preview', style: `--preview:${current.color}` }, [
      el('span', { class: 'picker-preview-label', text: current.color.toUpperCase() }),
      el('span', { class: 'picker-preview-name', text: nearestX11Name(current.color) ?? '' }),
    ]);

    hexInput = el('input', {
      class: 'picker-hex',
      value: current.color,
      spellcheck: 'false',
      'aria-label': 'Hex colour',
      oninput: (event) => {
        const normalized = normalizeColor(event.target.value);
        if (normalized) setColor(normalized, { silent: true });
      },
      onchange: (event) => setColor(event.target.value),
    });

    x11Select = el('select', { class: 'picker-x11', 'aria-label': 'X11 colour' }, [
      el('option', { value: '', text: 'X11 colours…' }),
      ...x11Names.map((name) => el('option', { value: X11_COLORS[name], text: `${name} ${X11_COLORS[name]}` })),
    ]);
    x11Select.addEventListener('change', (event) => {
      if (event.target.value) setColor(event.target.value, { commit: true });
    });

    const rgb = hexToRgb(current.color);
    sliders = {};
    const sliderRow = (channel, value) => {
      const input = el('input', {
        type: 'range',
        min: '0',
        max: '255',
        value: String(value),
        class: `picker-slider picker-slider-${channel}`,
        'aria-label': `${channel} channel`,
        oninput: () => {
          const next = rgbToHex(
            Number(sliders.r.value),
            Number(sliders.g.value),
            Number(sliders.b.value),
          );
          setColor(next, { silent: true });
        },
        onchange: () => {
          const next = rgbToHex(Number(sliders.r.value), Number(sliders.g.value), Number(sliders.b.value));
          commitColor(next);
        },
      });
      sliders[channel] = input;
      return el('label', { class: `picker-slider-row picker-slider-row-${channel}` }, [
        el('span', { class: 'picker-slider-label', text: channel.toUpperCase() }),
        input,
        el('input', {
          class: 'picker-channel-number',
          type: 'number',
          min: '0',
          max: '255',
          value: String(value),
          'aria-label': `${channel} value`,
          oninput: (event) => {
            const v = Math.max(0, Math.min(255, Number(event.target.value)));
            sliders[channel].value = String(v);
            setColor(rgbToHex(Number(sliders.r.value), Number(sliders.g.value), Number(sliders.b.value)), { silent: true });
          },
        }),
      ]);
    };

    swatches = (label, colors, onPick) => el('div', { class: 'picker-section' }, [
      el('span', { class: 'picker-section-label', text: label }),
      el('div', { class: 'picker-grid' }, colors.map((color) => el('button', {
        class: `picker-cell ${color === current.color ? 'selected' : ''}`,
        type: 'button',
        title: color,
        style: `--cell:${color}`,
        onclick: () => {
          setColor(color, { silent: true });
          onPick(color);
        },
      }))),
    ]);

    clear(popover).append(
      el('header', { class: 'picker-head' }, [
        el('div', {}, [
          el('strong', { class: 'picker-title', text: description.title }),
          el('span', { class: 'picker-subtitle', text: description.subtitle }),
        ]),
        el('button', { class: 'icon-btn', type: 'button', text: '✕', title: 'Close', onclick: close }),
      ]),

      previewBox,

      recent.length
        ? swatches('Recent', recent, (color) => commitColor(color))
        : null,
      swatches('Palette', palette, (color) => commitColor(color)),
      swatches('X11', Object.values(X11_COLORS).slice(0, 48), (color) => commitColor(color)),

      el('div', { class: 'picker-section' }, [
        el('span', { class: 'picker-section-label', text: 'Exact value' }),
        el('div', { class: 'picker-row' }, [hexInput, x11Select]),
      ]),

      el('div', { class: 'picker-section' }, [
        el('span', { class: 'picker-section-label', text: 'Channels' }),
        sliderRow('r', rgb.r),
        sliderRow('g', rgb.g),
        sliderRow('b', rgb.b),
      ]),

      el('footer', { class: 'picker-actions' }, [
        el('button', {
          class: 'btn btn-ghost',
          type: 'button',
          text: current.target?.kind === 'default' ? 'Reset to white' : 'Use default',
          onclick: () => {
            if (current.target?.kind === 'default') commitColor('#ffffff');
            else {
              app.clearColor(current.target);
              close();
            }
          },
        }),
        el('div', { class: 'spacer' }),
        el('button', { class: 'btn', type: 'button', text: 'Cancel', onclick: close }),
        el('button', { class: 'btn btn-primary', type: 'button', text: 'Apply', onclick: () => commitColor(current.color) }),
      ]),
    );

    syncInputs();
  }

  /** Push `current.color` into every input without re-rendering. */
  function syncInputs() {
    const hex = current.color;
    const rgb = hexToRgb(hex);
    if (hexInput && hexInput.value.toLowerCase() !== hex.toLowerCase()) hexInput.value = hex;
    if (sliders) {
      for (const channel of ['r', 'g', 'b']) {
        const input = sliders[channel];
        if (!input) continue;
        if (input.value !== String(rgb[channel])) input.value = String(rgb[channel]);
        const number = input.parentElement?.querySelector('.picker-channel-number');
        if (number && number.value !== String(rgb[channel])) number.value = String(rgb[channel]);
      }
    }
    if (previewBox) {
      previewBox.style.setProperty('--preview', hex);
      qs('.picker-preview-label', previewBox).textContent = hex.toUpperCase();
      qs('.picker-preview-name', previewBox).textContent = nearestX11Name(hex) ?? '';
      previewBox.style.color = contrastColor(hex);
    }
  }

  document.addEventListener('click', (event) => {
    if (!isOpen()) return;
    if (popover.contains(event.target)) return;
    if (event.target.closest?.('.color-swatch')) return;
    close();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && isOpen()) close();
  });

  return { open, close, isOpen, setColor };
}
