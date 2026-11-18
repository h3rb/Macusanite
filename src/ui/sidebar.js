/**
 * Left pane: the vault tree, and the tab that switches to search.
 *
 * Chambers fold open, veins open in the centre pane. A filter box narrows the
 * tree without losing the folder structure around matches. Which of the two
 * panes is visible is the controller's business (`app.setPane`); this module
 * only builds the tree and reflects the active tab.
 */
import { el, clear, delegate, on, qs } from './dom.js';
import { createDock } from './dock.js';
import { filterTree, countVeins, VEIN, CHAMBER } from '../lib/tree.js';
import { basename, dirname, join, titleFromPath } from '../lib/path.js';

export function createSidebar({ app, root }) {
  const head = qs('#sidebar-head', root) ?? root;
  const host = qs('#tree-pane', root) ?? root;
  const filterInput = el('input', {
    class: 'sidebar-filter',
    type: 'search',
    placeholder: 'Filter chambers and veins…',
    spellcheck: 'false',
    oninput: (event) => {
      app.state.ui.filter = event.target.value;
      render();
    },
  });

  const treeHost = el('div', { class: 'tree', role: 'tree' });
  const footer = el('div', { class: 'sidebar-footer' });

  const tabTree = el('button', {
    class: 'pane-tab',
    type: 'button',
    role: 'tab',
    icon: 'chamber',
    text: 'Chambers',
    title: 'Browse chambers and veins (Ctrl+B)',
    onclick: () => app.setPane('tree'),
  });
  const tabSearch = el('button', {
    class: 'pane-tab',
    type: 'button',
    role: 'tab',
    icon: 'search',
    text: 'Search',
    title: 'Search the whole vault (Ctrl+F)',
    onclick: () => app.openSearch(),
  });

  head.append(
    el('div', { class: 'pane-tabs', role: 'tablist' }, [tabTree, tabSearch]),
    el('div', { class: 'spacer' }),
    el('button', { class: 'icon-btn ui-icon-only', type: 'button', title: 'New chamber', icon: 'folder-plus', iconLabel: 'New chamber', onclick: () => app.newChamber() }),
    el('button', { class: 'icon-btn ui-icon-only', type: 'button', title: 'New vein', icon: 'file-plus', iconLabel: 'New vein', onclick: () => app.newVein() }),
    el('button', {
      class: 'icon-btn ui-icon-only',
      type: 'button',
      title: 'Fold the vault sidebar — the centre pane takes its width',
      icon: 'hide',
      iconLabel: 'Hide',
      onclick: () => app.toggleSidebar(false),
    }),
  );

  host.append(filterInput, treeHost, footer);

  // The pane folds to a tab on its inner edge: the dock wraps what the sidebar
  // already built, so folding is one state rather than a second set of nodes.
  const dock = createDock({
    root,
    labels: [{ id: 'vault', label: 'Vault', title: 'Expand the vault sidebar' }],
    edge: 'left',
    variant: 'column',
    railSide: 'end',
    onChoose: () => app.toggleSidebar(!sidebarShown()),
  });

  delegate(treeHost, 'click', '[data-toggle]', (event, node) => {
    event.stopPropagation();
    app.toggleExpanded(node.dataset.toggle);
  });

  delegate(treeHost, 'click', '[data-vein]', (event, node) => {
    event.preventDefault();
    app.openPath(node.dataset.vein);
  });

  delegate(treeHost, 'click', '[data-chamber]', (event, node) => {
    event.preventDefault();
    app.toggleExpanded(node.dataset.chamber);
  });

  delegate(treeHost, 'contextmenu', '[data-vein], [data-chamber]', (event, node) => {
    event.preventDefault();
    event.stopPropagation();
    const kind = node.dataset.vein ? 'vein' : 'chamber';
    app.showTreeMenu(kind, node.dataset.vein ?? node.dataset.chamber, event);
  });

  /* ── drag and drop ──────────────────────────────────────────────────────
   * A vein or chamber dragged onto a chamber row moves inside it; its own
   * kind's row moves it back to the vault root. The chamber is the destination
   * either way, because the tree has no manual order to drop between — files
   * sort by name once they land.
   */

  let dragged = null;
  let dropRow = null;

  function markDrop(row, allowed) {
    if (dropRow && dropRow !== row) dropRow.classList.remove('drop-target', 'drop-invalid');
    dropRow = row;
    if (!row) return;
    row.classList.toggle('drop-target', allowed);
    row.classList.toggle('drop-invalid', !allowed);
  }

  function endDrag() {
    dragged?.row.classList.remove('dragging');
    markDrop(null, true);
    dragged = null;
  }

  /** Which chamber a drop at `target` would move into ('' is the vault root). */
  function zoneFor(target) {
    const node = target instanceof Element ? target : target?.parentElement ?? null;
    if (!node || !treeHost.contains(node)) return { row: null, chamber: '' };
    const row = node.closest('[data-vein], [data-chamber]');
    if (row) return { row, chamber: row.dataset.chamber ?? dirname(row.dataset.vein ?? '') };
    // The gap between a chamber's children belongs to that chamber.
    const box = node.closest('[data-drop]');
    if (box) return { row: box.querySelector('.tree-row.chamber'), chamber: box.dataset.drop };
    return { row: null, chamber: '' };
  }

  on(treeHost, 'dragstart', (event) => {
    const row = event.target.closest?.('[data-vein], [data-chamber]');
    if (!row) return;
    dragged = {
      kind: row.dataset.vein ? 'vein' : 'chamber',
      path: row.dataset.vein ?? row.dataset.chamber,
      row,
    };
    row.classList.add('dragging');
    event.dataTransfer?.setData('application/x-macusanite-tree', JSON.stringify({ kind: dragged.kind, path: dragged.path }));
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', dragged.path);
    }
  });

  on(treeHost, 'dragover', (event) => {
    if (!dragged) return;
    event.preventDefault();
    const zone = zoneFor(event.target);
    const allowed = app.canMoveTreeItem(dragged.kind, dragged.path, zone.chamber);
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    markDrop(zone.row, allowed);
  });

  on(treeHost, 'dragleave', (event) => {
    if (!dragged) return;
    if (!treeHost.contains(event.relatedTarget)) markDrop(null, true);
  });

  on(treeHost, 'drop', (event) => {
    if (!dragged) return;
    event.preventDefault();
    const zone = zoneFor(event.target);
    const { kind, path } = dragged;
    const allowed = app.canMoveTreeItem(kind, path, zone.chamber);
    const noop = zone.chamber === path || join(zone.chamber, basename(path)) === path;
    endDrag();
    if (noop) return;
    if (!allowed) {
      if (kind === 'chamber') app.toast('A chamber cannot be moved inside itself', 'warn');
      return;
    }
    app.moveTreeItem(kind, path, zone.chamber);
  });

  on(treeHost, 'dragend', () => endDrag());

  function render() {
    const ui = app.state.ui;
    const searching = ui.pane === 'search';
    tabTree.classList.toggle('is-active', !searching);
    tabSearch.classList.toggle('is-active', searching);
    tabTree.setAttribute('aria-selected', searching ? 'false' : 'true');
    tabSearch.setAttribute('aria-selected', searching ? 'true' : 'false');
    const tree = filterTree(app.state.tree, ui.filter);
    const activePath = app.state.current?.path ?? null;
    clear(treeHost).append(...tree.map((node) => renderNode(node, 0, ui.expanded, activePath, ui.filter)));

    const total = countVeins(app.state.tree);
    // A lazily opened vault reports its own progress: the tree and the list are
    // complete from the first walk, the index fills in behind them.
    const indexing = app.state.indexing ?? { status: 'ready', indexed: 0, total: 0 };
    // While the pass is running, what is moving is the number of veins being
    // read — the entries themselves are already there, as stubs.
    const indexLabel = indexing.status === 'indexing'
      ? `indexing ${indexing.read ?? 0}/${indexing.pending ?? 0}`
      : `${indexing.total} indexed`;
    clear(footer).append(
      el('span', { class: 'sidebar-stat', text: `${total} vein${total === 1 ? '' : 's'}` }),
      el('span', { class: 'sidebar-stat', text: indexLabel }),
      el('div', { class: 'spacer' }),
      el('button', { class: 'btn btn-ghost btn-mini', type: 'button', text: 'Reload', title: 'Re-read this vault from disk and rebuild the index', onclick: () => app.reloadVault(true) }),
    );
  }

  function renderNode(node, depth, expanded, activePath, filter) {
    const isChamber = node.kind === CHAMBER;
    const open = isChamber && (expanded[node.path] ?? depth === 0);
    const forcedOpen = Boolean(filter);
    const isOpen = isChamber && (open || forcedOpen);
    const active = !isChamber && node.path === activePath;

    const twisty = isChamber
      ? el('span', {
        class: `twisty ${isOpen ? 'open' : ''}`,
        text: node.children?.length ? (isOpen ? '▾' : '▸') : '·',
        'data-toggle': node.path,
        role: 'button',
        tabindex: '0',
      })
      : el('span', { class: 'twisty vein-mark', text: '•' });

    const row = el(
      isChamber ? 'button' : 'a',
      {
        class: `tree-row ${isChamber ? 'chamber' : 'vein'} ${active ? 'active' : ''}`,
        style: `--depth:${depth}`,
        draggable: 'true',
        type: isChamber ? 'button' : null,
        href: isChamber ? null : '#',
        icon: isChamber ? 'chamber' : false,
        title: node.path,
        ...(isChamber ? { 'data-chamber': node.path } : { 'data-vein': node.path }),
      },
      [
        twisty,
        el('span', { class: 'tree-label', text: isChamber ? node.name : titleFromPath(node.name) }),
        isChamber
          ? el('span', { class: 'tree-count', text: String(countVeins(node.children ?? [])) })
          : el('span', { class: 'tree-ext', text: '.md' }),
      ],
    );

    if (!isChamber) return row;
    const children = isOpen
      ? el('div', { class: 'tree-children' }, (node.children ?? []).map((child) => renderNode(child, depth + 1, expanded, activePath, filter)))
      : null;
    return el('div', { class: `tree-node ${isOpen ? 'open' : ''}`, 'data-drop': node.path }, [row, children]);
  }

  function sidebarShown() {
    return app.state.settings.layout.showSidebar !== false;
  }

  /** Reflect the fold setting: the tab alone when folded, the tree when not. */
  function sync() {
    dock.show(sidebarShown() ? 'vault' : null);
  }

  return { render, sync };
}
