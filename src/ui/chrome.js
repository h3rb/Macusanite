/**
 * Window chrome: the top bar (burger menu + vault identity + wiki breadcrumbs),
 * the navigation bar (back/forward, file location, recent trail, undo/redo) and
 * the Ctrl+K quick-jump palette.
 */
import { el, clear, qs, delegate, htmlNode, appendAll } from './dom.js';
import { titleFromPath } from '../lib/path.js';
import { colorSwatch } from './markdown.js';

export function createChrome({ app, root }) {
  const menuBtn = qs('#menu-btn', root);
  const menu = qs('#menu', root);
  const badge = qs('.vault-badge', root);
  const vaultName = qs('#vault-name', root);
  const vaultDesc = qs('#vault-desc', root);
  const crumbs = qs('#wiki-crumbs', root);
  const backBtn = qs('#back-btn', root);
  const fwdBtn = qs('#fwd-btn', root);
  const fileLocation = qs('#file-location', root);
  const navTrail = qs('#nav-trail', root);
  const undoBtn = qs('#undo-btn', root);
  const redoBtn = qs('#redo-btn', root);
  const jumpBtn = qs('#jump-btn', root);
  const jumpOverlay = qs('#jump-overlay', root);
  const settingsBtn = qs('#settings-btn', root);
  const graphBtn = qs('#graph-btn', root);
  const helpBtn = qs('#help-btn', root);

  let jumpActive = 0;
  let jumpMatches = [];

  /* ------------------------------------------------------------ burger -- */

  function menuItem(label, action, options = {}) {
    return el('button', {
      class: `menu-item ${options.class ?? ''}`,
      type: 'button',
      role: 'menuitem',
      text: label,
      disabled: options.disabled ?? false,
      onclick: (event) => {
        event.stopPropagation();
        if (options.disabled) return;
        if (!options.keepOpen) closeMenu();
        action();
      },
    });
  }

  function renderMenu() {
    const canUndo = app.state.undoStack.length > 0;
    const canRedo = app.state.redoStack.length > 0;
    clear(menu).append(
      el('div', { class: 'menu-group-label', text: 'New' }),
      menuItem('New Vault…', () => app.createVaultInteractive()),
      menuItem('New Chamber…', () => app.newChamber()),
      menuItem('New Vein…', () => app.newVein()),
      el('div', { class: 'menu-sep' }),
      menuItem('Load Vault…', () => app.chooseAndOpenVault()),
      menuItem('Save', () => app.saveCurrent(), { class: 'menu-primary' }),
      el('div', { class: 'menu-sep' }),
      menuItem(`Undo${canUndo ? ` — ${app.state.undoStack[0].label}` : ''}`, () => app.undo(), { disabled: !canUndo }),
      menuItem(`Redo${canRedo ? ` — ${app.state.redoStack[0].label}` : ''}`, () => app.redo(), { disabled: !canRedo }),
      el('div', { class: 'menu-sep' }),
      menuItem('Search the vault…  (Ctrl+F)', () => app.openSearch()),
      menuItem('Settings…', () => app.openSettings()),
      menuItem('Help and manual  (F1)', () => app.openHelpWindow(), { class: 'menu-primary' }),
      menuItem('Vault Wiki.md (syntax guide, in this window)', () => app.openSyntaxGuide()),
      el('div', { class: 'menu-sep' }),
      menuItem('Exit', () => app.quit()),
    );
  }

  function openMenu() {
    renderMenu();
    menu.classList.remove('hidden');
    menuBtn.setAttribute('aria-expanded', 'true');
    app.state.ui.menuOpen = true;
  }

  function closeMenu() {
    menu.classList.add('hidden');
    menuBtn.setAttribute('aria-expanded', 'false');
    app.state.ui.menuOpen = false;
  }

  menuBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    if (menu.classList.contains('hidden')) openMenu();
    else closeMenu();
  });

  document.addEventListener('click', (event) => {
    if (!menu.classList.contains('hidden') && !menu.contains(event.target) && event.target !== menuBtn) closeMenu();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeMenu();
      closeJump();
    }
  });

  /* ---------------------------------------------------------- identity -- */

  function renderIdentity() {
    const vault = app.state.vault;
    vaultName.textContent = vault ? vault.name : 'No vault loaded';
    vaultDesc.textContent = vault?.description ?? '';
    vaultDesc.title = vault?.path ?? '';
    // The badge turns green while the vault is followed on disk: that is the
    // difference between "saved by me" and "changed by something else, live".
    const live = Boolean(vault) && app.state.ui.watching;
    badge.classList.toggle('is-live', live);
    badge.title = live
      ? 'Following this vault: edits made outside Macusanite appear as they happen'
      : 'Vault badge';
  }

  /* ------------------------------------------------------- breadcrumbs -- */

  function renderCrumbs() {
    const trail = app.state.nav.wikiTrail(6);
    clear(crumbs);
    if (!trail.length) return;
    trail.forEach((entry, i) => {
      if (i > 0) crumbs.append(el('span', { class: 'crumb-sep', text: '›' }));
      crumbs.append(el('button', {
        class: `crumb ${entry.path === app.state.current?.path ? 'current' : ''}`,
        type: 'button',
        text: entry.title ?? titleFromPath(entry.path),
        title: entry.path,
        onclick: () => app.openPath(entry.path, { section: entry.section }),
      }));
    });
  }

  /* -------------------------------------------------------------- navbar */

  function renderNavbar() {
    const nav = app.state.nav;
    const doc = app.state.current;
    backBtn.disabled = !nav.canBack;
    fwdBtn.disabled = !nav.canForward;

    clear(fileLocation);
    if (doc) {
      const color = app.colorFor('page', { path: doc.path });
      appendAll(fileLocation, [
        htmlNode(colorSwatch('page', { path: doc.path }, color, 'Page colour')),
        el('span', { class: 'location-path', text: doc.path, title: doc.path }),
        doc.meta?.title ? el('span', { class: 'location-title', text: doc.meta.title }) : null,
        app.state.dirty ? el('span', { class: 'dirty-dot', title: 'Unsaved changes', text: '●' }) : null,
      ]);
    } else {
      fileLocation.append(el('span', { class: 'location-empty', text: 'No vein open' }));
    }

    clear(navTrail);
    const recent = nav.trail(5).filter((entry) => entry.path !== doc?.path);
    for (const entry of recent.slice().reverse()) {
      navTrail.append(el('button', {
        class: 'trail-chip',
        type: 'button',
        text: titleFromPath(entry.path),
        title: entry.path,
        onclick: () => app.openPath(entry.path, { section: entry.section }),
      }));
    }

    const canUndo = app.state.undoStack.length > 0;
    const canRedo = app.state.redoStack.length > 0;
    undoBtn.disabled = !canUndo;
    redoBtn.disabled = !canRedo;
    undoBtn.title = canUndo ? `Undo ${app.state.undoStack[0].label}` : 'Nothing to undo';
    redoBtn.title = canRedo ? `Redo ${app.state.redoStack[0].label}` : 'Nothing to redo';
    undoBtn.textContent = `↶ ${canUndo ? app.state.undoStack.length : ''}`.trim();
    redoBtn.textContent = `↷ ${canRedo ? app.state.redoStack.length : ''}`.trim();
  }

  backBtn.addEventListener('click', () => app.navigateBack());
  fwdBtn.addEventListener('click', () => app.navigateForward());
  undoBtn.addEventListener('click', () => app.undo());
  redoBtn.addEventListener('click', () => app.redo());
  settingsBtn.addEventListener('click', () => app.openSettings());
  graphBtn.addEventListener('click', () => app.toggleGraph());
  helpBtn.addEventListener('click', () => app.openHelpWindow());

  /* ---------------------------------------------------------- jump box -- */

  function openJump() {
    if (!app.state.veins.length) return;
    jumpOverlay.classList.remove('hidden');
    clear(jumpOverlay);
    const input = el('input', { class: 'jump-input', placeholder: 'Jump to a vein…', spellcheck: 'false' });
    const list = el('div', { class: 'jump-list' });

    const refresh = () => {
      const query = input.value.trim().toLowerCase();
      jumpMatches = app.state.veins
        .map((path) => ({ path, score: score(path, query) }))
        .filter((entry) => entry.score > -Infinity)
        .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
        .slice(0, 40);
      jumpActive = 0;
      clear(list).append(...jumpMatches.map((entry, i) => el('button', {
        class: `jump-item ${i === jumpActive ? 'active' : ''}`,
        type: 'button',
        onclick: () => choose(entry.path),
      }, [
        el('span', { class: 'jump-title', text: titleFromPath(entry.path) }),
        el('span', { class: 'jump-path', text: entry.path }),
      ])));
    };

    const choose = (path) => {
      closeJump();
      app.openPath(path);
    };

    input.addEventListener('input', refresh);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        jumpActive = Math.min(jumpActive + 1, jumpMatches.length - 1);
        refresh();
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        jumpActive = Math.max(jumpActive - 1, 0);
        refresh();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        if (jumpMatches[jumpActive]) choose(jumpMatches[jumpActive].path);
      }
    });

    jumpOverlay.append(el('div', { class: 'jump-panel' }, [input, list]));
    jumpOverlay.addEventListener('click', (event) => {
      if (event.target === jumpOverlay) closeJump();
    });
    refresh();
    input.focus();
  }

  function closeJump() {
    jumpOverlay.classList.add('hidden');
    clear(jumpOverlay);
  }

  jumpBtn.addEventListener('click', openJump);

  function score(path, query) {
    if (!query) return 0;
    const haystack = path.toLowerCase();
    const title = titleFromPath(path).toLowerCase();
    if (title === query) return 1000;
    if (title.startsWith(query)) return 600 - path.length;
    if (title.includes(query)) return 400 - path.length;
    if (haystack.includes(query)) return 200 - path.length;
    // subsequence match, so "fm" finds "Fieldwork/Macusanite"
    let i = 0;
    let hits = 0;
    for (const ch of haystack) {
      if (ch === query[i]) {
        hits += 1;
        i += 1;
        if (i === query.length) return 100 - path.length + hits;
      }
    }
    return -Infinity;
  }

  /* -------------------------------------------------------------- misc -- */

  delegate(crumbs, 'click', '.crumb', () => closeMenu());

  return {
    render() {
      renderMenu();
      renderIdentity();
      renderCrumbs();
      renderNavbar();
    },
    renderIdentity,
    renderCrumbs,
    renderNavbar,
    openMenu,
    closeMenu,
    openJump,
    closeJump,
  };
}
