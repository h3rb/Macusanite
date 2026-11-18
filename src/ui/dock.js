/**
 * One dock primitive: a rail of vertical tabs on a pane's edge, and the slot
 * that holds the panel of whichever tab is open, one at a time.
 *
 * Three panes had grown their own version of this. The vault sidebar and the
 * concept graph fold their whole grid column to a single tab, and the canvas
 * keeps a rail of two tabs — Navigator and Inspector — over its right edge.
 * The tab's shape, its rotated label, the hover and focus states, the pressed
 * state, the arrow-key walk and the "which panel is showing" bookkeeping were
 * written once per pane; they live here now.
 *
 * The host keeps the decisions — its setting, its selection, where the pane
 * sits and how wide it is — and calls `show()`. The dock keeps the rail, the
 * slot and the state, and reports a press through `onChoose` so the host can
 * change what it owns (a setting, a selected panel) and call `show()` again.
 *
 * Variants:
 *   - `column`: the pane is a grid column that gives up its width when folded
 *     (the sidebar and the graph), so the rail is the whole of the pane and the
 *     slot is simply not displayed.
 *   - `overlay`: the pane floats over the canvas and the rail must stay on the
 *     edge (the canvas dock), so the host sizes the pane and clips the slot.
 */
import { el } from './dom.js';

let dockSeq = 0;

export function createDock({
  root,
  labels,
  panels = [],
  railSide = 'end',
  variant = 'column',
  edge = 'right',
  railLabel,
  onChoose,
  onShow,
}) {
  // With no panels given, the pane's own children become the single panel: the
  // column folds only ever hide what the host already built.
  const panelEls = panels.length
    ? panels
    : [el('div', {}, [...root.children])];
  const tabs = labels.map((label, index) => ({ ...label, panel: panelEls[index] ?? null, button: null }));
  let active = null;

  const rail = el('div', {
    class: 'dock-rail',
    role: 'toolbar',
    'aria-orientation': 'vertical',
    'aria-label': railLabel ?? (tabs.length > 1 ? 'Panels' : tabs[0]?.label ?? 'Panel'),
  });
  const slot = el('div', { class: 'dock-slot' });

  for (const tab of tabs) {
    if (!tab.panel) continue;
    if (!tab.panel.id) tab.panel.id = `dock-panel-${(dockSeq += 1)}`;
    tab.panel.classList.add('dock-panel');
    slot.append(tab.panel);
    tab.button = el('button', {
      class: 'dock-tab',
      type: 'button',
      'aria-pressed': 'false',
      'aria-controls': tab.panel.id,
      title: tab.title ?? tab.label,
      onclick: () => onChoose?.(tab.id, active === tab.id),
    }, [
      // A single tab is the pane's whole fold, so it says which way the pane
      // opens; a rail of two is a choice, and the pressed state says which.
      ...(tabs.length === 1
        ? [el('span', { class: 'dock-tab-arrow', text: edge === 'left' ? '›' : '‹', 'aria-hidden': 'true' })]
        : []),
      el('span', { class: 'dock-tab-label', text: tab.label }),
    ]);
    rail.append(tab.button);
  }

  // A toolbar's arrow keys walk its tabs, wherever they sit in the rail.
  rail.addEventListener('keydown', (event) => {
    const buttons = tabs.map((tab) => tab.button).filter(Boolean);
    if (buttons.length < 2) return;
    const at = buttons.indexOf(document.activeElement);
    if (at < 0) return;
    const last = buttons.length - 1;
    let next = null;
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = buttons[(at + 1) % buttons.length];
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = buttons[(at - 1 + buttons.length) % buttons.length];
    else if (event.key === 'Home') next = buttons[0];
    else if (event.key === 'End') next = buttons[last];
    if (!next) return;
    event.preventDefault();
    next.focus({ preventScroll: true });
  });

  const dockEl = el('div', {
    class: `dock dock--${variant} dock--rail-${railSide}`,
  }, railSide === 'start' ? [rail, slot] : [slot, rail]);
  root.append(dockEl);

  /**
   * Show one tab's panel, or nothing. Both the host and the dock carry the
   * open state: the host's own CSS sizes and clips the pane, and the dock's
   * rules hide the slot the column variants give up.
   */
  function show(id = null) {
    const open = id && tabs.some((tab) => tab.id === id && tab.button) ? id : null;
    active = open;
    for (const tab of tabs) {
      if (!tab.button) continue;
      tab.button.setAttribute('aria-pressed', String(tab.id === open));
    }
    for (const node of [root, dockEl]) {
      node.classList.toggle('is-open', Boolean(open));
      if (open) node.dataset.panel = open;
      else delete node.dataset.panel;
    }
    onShow?.(open);
  }

  return {
    /** The dock's own element, for hosts that need to measure or move it. */
    el: dockEl,
    /** The box the panels live in: a host may move one out and back. */
    slot,
    show,
    /** The tab button for a panel, so a host can hand focus back to it. */
    tab: (id) => tabs.find((tab) => tab.id === id)?.button ?? null,
    active: () => active,
  };
}
