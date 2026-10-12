/** Tiny DOM helpers. No framework, no build magic. */

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export const qs = (selector, root = document) => root.querySelector(selector);
export const qsa = (selector, root = document) => [...root.querySelectorAll(selector)];

/**
 * Turn an HTML string (built by the renderers) into a real element, so it can be
 * appended to the DOM instead of showing up as literal markup text.
 */
export function htmlNode(html) {
  const template = document.createElement('template');
  template.innerHTML = String(html ?? '').trim();
  return template.content.firstElementChild;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function on(target, type, handler, options) {
  target.addEventListener(type, handler, options);
  return () => target.removeEventListener(type, handler, options);
}

/** Event delegation: returns an unsubscribe function. */
export function delegate(root, type, selector, handler) {
  return on(root, type, (event) => {
    const match = event.target instanceof Element ? event.target.closest(selector) : null;
    if (match && root.contains(match)) handler(event, match);
  });
}

/**
 * `Element.append(null)` would insert the literal text "null", and conditional
 * children are everywhere in this UI — so filter first.
 */
export function appendAll(parent, children) {
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Truncate to `max` characters, appending an ellipsis when shortened. */
export function truncate(value, max = 48) {
  const text = String(value ?? '');
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** Prompt-free inline "modal" used for new vein/chamber names and confirmations. */
export function askText({ title, label = 'Name', value = '', hint = '', confirmLabel = 'Create' }) {
  return new Promise((resolve) => {
    // Only one prompt at a time, and it leaves the DOM when it closes: leftover
    // dialogs make `querySelector('dialog.md-dialog')` ambiguous.
    for (const stale of document.querySelectorAll('dialog.md-dialog')) stale.remove();

    const dialog = el('dialog', { class: 'md-dialog' });
    const input = el('input', { class: 'md-input', value, spellcheck: 'false', autocomplete: 'off' });
    const form = el('form', { method: 'dialog', class: 'md-dialog-form' }, [
      el('h2', { class: 'md-dialog-title', text: title }),
      el('label', { class: 'md-field' }, [el('span', { text: label }), input]),
      hint ? el('p', { class: 'md-hint', text: hint }) : null,
      el('div', { class: 'md-dialog-actions' }, [
        el('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: () => finish(null) }),
        el('button', { type: 'submit', class: 'btn btn-primary', text: confirmLabel }),
      ]),
    ]);
    dialog.append(form);

    function finish(answer) {
      if (dialog.open) dialog.close();
      dialog.remove();
      resolve(answer);
    }

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      finish(input.value.trim() || null);
    });
    dialog.addEventListener('cancel', () => finish(null));
    document.body.append(dialog);
    dialog.showModal();
    input.focus();
    input.select();
  });
}

/**
 * Inline status line at the bottom of the window.
 *
 * A toast is normally an announcement. An `action` — `{ label, onClick }` — makes
 * it an offer instead: a button the reader can press, kept on screen longer,
 * because an offer that disappears before it is read is not an offer.
 */
export function createToaster(host) {
  const FADE = 320;
  return {
    show(message, kind = 'info', timeout = 4200, action = null) {
      const node = el('div', { class: `toast toast-${kind}` }, [
        el('span', { class: 'toast-message', text: message }),
      ]);
      let dismissed = false;
      const dismiss = () => {
        if (dismissed) return;
        dismissed = true;
        clearTimeout(timer);
        node.classList.add('toast-out');
        setTimeout(() => node.remove(), FADE);
      };
      const timer = setTimeout(dismiss, action ? Math.max(timeout, 15_000) : timeout);
      if (action) {
        node.append(el('button', {
          type: 'button',
          class: 'toast-action',
          text: action.label,
          onclick: (event) => {
            event.preventDefault();
            event.stopPropagation();
            dismiss();
            action.onClick?.();
          },
        }));
      }
      host.append(node);
      return node;
    },
  };
}
