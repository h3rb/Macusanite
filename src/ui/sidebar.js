/**
 * Left pane: the vault tree, and the tab that switches to search.
 *
 * Chambers fold open, veins open in the centre pane. A filter box narrows the
 * tree without losing the folder structure around matches. Which of the two
 * panes is visible is the controller's business (`app.setPane`); this module
 * only builds the tree and reflects the active tab.
 */
import { el, clear, delegate, qs } from './dom.js';
import { filterTree, countVeins, VEIN, CHAMBER } from '../lib/tree.js';
import { titleFromPath } from '../lib/path.js';

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
    text: 'Chambers',
    onclick: () => app.setPane('tree'),
  });
  const tabSearch = el('button', {
    class: 'pane-tab',
    type: 'button',
    role: 'tab',
    text: 'Search',
    title: 'Search the whole vault (Ctrl+F)',
    onclick: () => app.openSearch(),
  });

  head.append(
    el('div', { class: 'pane-tabs', role: 'tablist' }, [tabTree, tabSearch]),
    el('div', { class: 'spacer' }),
    el('button', { class: 'icon-btn', type: 'button', title: 'New chamber', text: '＋🗂', onclick: () => app.newChamber() }),
    el('button', { class: 'icon-btn', type: 'button', title: 'New vein', text: '＋📄', onclick: () => app.newVein() }),
  );

  host.append(filterInput, treeHost, footer);

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
    if (node.dataset.vein) app.showVeinMenu(node.dataset.vein);
    else app.newVein(node.dataset.chamber);
  });

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
      el('button', { class: 'btn btn-ghost btn-mini', type: 'button', text: 'Reload', onclick: () => app.reloadVault(true) }),
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
        type: isChamber ? 'button' : null,
        href: isChamber ? null : '#',
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
    return el('div', { class: `tree-node ${isOpen ? 'open' : ''}` }, [row, children]);
  }

  return { render };
}
