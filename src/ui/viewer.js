/**
 * The centre pane: the rendered vein.
 *
 * Handles wiki-link clicks (including ghosts that offer to be created), colour
 * swatch clicks, in-place editing with autosave, the worldbuilding canvas and the
 * backlink list.
 */
import { el, clear, qs, htmlNode } from './dom.js';
import { renderMarkdown, renderMermaidIn, colorSwatch } from './markdown.js';
import { parseFrontmatter } from '../lib/frontmatter.js';
import { createWorldbuildPanel } from './worldbuildPanel.js';
import { findMatches } from '../lib/search.js';

/** Never highlight inside these: our own marks, diagrams, swatches and chrome. */
const SKIP_HITS = 'svg, mark, script, style, .color-swatch, .mermaid-caption';

export function createViewer({ app, root }) {
  let currentRender = null;
  let scrollPositions = new Map();
  // Search terms the reader is looking for, and the marks they produced.
  let hitTerms = [];
  let hitNodes = [];
  let hitIndex = 0;

  const head = el('div', { class: 'viewer-head' });
  const body = el('article', { class: 'markdown-body', id: 'document-body' });
  const foot = el('div', { class: 'viewer-foot' });
  // The editor's two faces: the source alone ("Code Editing"), or the source
  // with its rendered document beside it ("Visual Editing") — source on the
  // left, preview on the right. The Visual/Code switch in the toolbar is the
  // preview toggle: Code Editing hides the preview entirely. The textarea is
  // the only editing surface either way — the preview is the reader's
  // rendering of the current draft, so the draft, autosave and undo work
  // exactly as before.
  const preview = el('article', {
    class: 'markdown-body visual-preview hidden',
    'aria-label': 'Rendered preview',
    tabindex: '0',
  });
  // Preview links and swatches must not navigate or pop pickers mid-edit:
  // the preview is for looking at, not for following.
  preview.addEventListener('click', (event) => {
    const interactive = event.target.closest('a, button, input, select, textarea, [data-color-target]');
    if (interactive) {
      event.preventDefault();
      event.stopPropagation();
    }
  }, true);
  const visualBtn = el('button', {
    class: 'btn btn-ghost editor-mode-btn', type: 'button', text: 'Visual Editing',
    title: 'Edit with the rendered document beside the source',
    onclick: () => switchEditorMode('visual'),
  });
  const codeBtn = el('button', {
    class: 'btn btn-ghost editor-mode-btn', type: 'button', text: 'Code Editing',
    title: 'Edit the markdown source directly',
    onclick: () => switchEditorMode('code'),
  });
  const editorSplit = el('div', { class: 'editor-split' }, [
    el('textarea', {
      class: 'editor-textarea',
      spellcheck: 'false',
      oninput: (event) => {
        app.setDraft(event.target.value);
        scheduleVisualPreview();
      },
      onkeydown: (event) => {
        if (event.key === 'Tab') {
          event.preventDefault();
          const ta = event.target;
          const start = ta.selectionStart;
          ta.setRangeText('  ', start, ta.selectionEnd, 'end');
          app.setDraft(ta.value);
        }
      },
    }),
    preview,
  ]);
  const editor = el('div', { class: 'editor-pane hidden' }, [
    el('div', { class: 'editor-toolbar' }, [
      el('div', { class: 'editor-mode-switch', role: 'group', 'aria-label': 'Editor mode' }, [visualBtn, codeBtn]),
      el('span', { class: 'editor-hint', text: 'Markdown source — Ctrl+S saves, Esc returns to the rendered view' }),
      el('div', { class: 'spacer' }),
      el('button', { class: 'btn btn-ghost', type: 'button', text: 'Revert', onclick: () => app.revertDraft() }),
      el('button', { class: 'btn btn-primary', type: 'button', text: 'Save', onclick: () => app.saveCurrent() }),
    ]),
    editorSplit,
  ]);

  const world = el('div', { class: 'world-view hidden' });
  root.append(head, body, world, editor, foot);

  const worldPanel = createWorldbuildPanel({ app, root: world });
  const textarea = qs('.editor-textarea', editor);
  const emptyState = el('div', { class: 'empty-state' }, [
    el('h1', { text: 'Macusanite' }),
    el('p', { class: 'lede', text: 'Open a vault to begin — chambers on the left, veins in the middle, concepts on the right.' }),
    el('div', { class: 'empty-actions' }, [
      el('button', { class: 'btn btn-primary', type: 'button', text: 'Open vault…', onclick: () => app.chooseAndOpenVault() }),
      el('button', { class: 'btn', type: 'button', text: 'Create vault…', onclick: () => app.createVaultInteractive() }),
    ]),
  ]);

  function renderEmpty() {
    clear(head);
    clear(body).append(emptyState);
    clear(foot);
    clearHits();
    editor.classList.add('hidden');
    world.classList.add('hidden');
    worldPanel.render(null);
    body.classList.remove('hidden');
  }

  /**
   * The worldbuilding switch, in the document's upper-right corner.
   *
   * It is a checkbox rather than a button so the reader can see at a glance
   * which of the two views of the vein they are in.
   */
  function worldSwitch(mode) {
    const input = el('input', {
      type: 'checkbox',
      class: 'mode-switch-input',
      'aria-label': 'Worldbuilding mode',
      onchange: () => app.toggleWorldbuilding(),
    });
    input.checked = mode === 'world';
    return el('label', {
      class: `mode-switch ${mode === 'world' ? 'is-on' : ''}`,
      title: 'Worldbuilding: arrange this vein as notes instead of lines',
    }, [
      el('span', { class: 'mode-switch-label', text: 'Worldbuilding' }),
      el('span', { class: 'mode-switch-track' }, [input, el('span', { class: 'mode-switch-knob' })]),
    ]);
  }

  /* --------------------------------------------------------- search hits -- */

  /**
   * Wrap every occurrence of the current terms in the rendered page, so a hit
   * found by search is visible where the reader is. Ranges come from the same
   * pure matcher the results pane uses.
   */
  function applyHits({ keepIndex = false } = {}) {
    const previous = hitIndex;
    clearHits();
    if (!hitTerms.length) return 0;

    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || parent.closest(SKIP_HITS)) return NodeFilter.FILTER_REJECT;
        return findMatches(node.nodeValue, hitTerms).length ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });

    const targets = [];
    while (walker.nextNode()) targets.push(walker.currentNode);

    for (const node of targets) {
      const text = node.nodeValue;
      const fragment = document.createDocumentFragment();
      let at = 0;
      for (const [start, end] of findMatches(text, hitTerms)) {
        if (start > at) fragment.append(text.slice(at, start));
        const mark = el('mark', { class: 'search-hit', text: text.slice(start, end) });
        hitNodes.push(mark);
        fragment.append(mark);
        at = end;
      }
      if (at < text.length) fragment.append(text.slice(at));
      node.replaceWith(fragment);
    }

    hitIndex = keepIndex && hitNodes.length ? Math.min(previous, hitNodes.length - 1) : 0;
    markCurrent();
    return hitNodes.length;
  }

  /** Put the page back the way marked made it: text again, no stray elements. */
  function clearHits() {
    for (const mark of hitNodes) {
      const parent = mark.parentNode;
      mark.replaceWith(document.createTextNode(mark.textContent));
      parent?.normalize();
    }
    hitNodes = [];
    hitIndex = 0;
  }

  function markCurrent() {
    hitNodes.forEach((mark, i) => mark.classList.toggle('is-current', i === hitIndex));
  }

  /** Move between hits, wrapping around, and bring the current one into view. */
  function goToHit(delta = 0) {
    if (!hitNodes.length) return { index: 0, count: 0 };
    hitIndex = (hitIndex + delta + hitNodes.length) % hitNodes.length;
    markCurrent();
    hitNodes[hitIndex].scrollIntoView({ block: 'center', behavior: 'auto' });
    return { index: hitIndex, count: hitNodes.length };
  }

  /* -------------------------------------------------------- editor mode -- */

  /** Which editor the markdown pane opens in — visual by default. */
  function editorMode() {
    return app.state.settings.editor?.livePreview === false ? 'code' : 'visual';
  }

  /** Show the preview or the source alone, and say which is active. */
  function applyEditorMode() {
    const visual = editorMode() === 'visual';
    preview.classList.toggle('hidden', !visual);
    visualBtn.classList.toggle('is-active', visual);
    codeBtn.classList.toggle('is-active', !visual);
    visualBtn.setAttribute('aria-pressed', String(visual));
    codeBtn.setAttribute('aria-pressed', String(!visual));
    if (visual) renderVisualPreview();
  }

  async function switchEditorMode(mode) {
    await app.setEditorMode(mode);
    applyEditorMode();
  }

  /** Render the current draft the way the reader would (front matter aside). */
  function renderVisualPreview() {
    if (editorMode() !== 'visual' || editor.classList.contains('hidden')) return;
    const doc = app.state.current;
    if (!doc || doc.readOnly) return;
    const { body } = parseFrontmatter(app.state.draft ?? '');
    const rendered = renderMarkdown(body, {
      currentPath: doc.path,
      resolveLink: (link) => app.resolveLink(link, doc.path),
      colorFor: (kind, parts) => app.colorFor(kind, parts),
    });
    clear(preview).innerHTML = rendered.html;
    renderMermaidIn(preview, rendered.mermaid, app.mermaid);
  }

  let visualTimer = 0;
  function scheduleVisualPreview() {
    clearTimeout(visualTimer);
    visualTimer = setTimeout(renderVisualPreview, 150);
  }

  /**
   * @param {object} doc { path, text, frontmatter, meta, headings }
   */
  async function render(doc) {
    if (!doc) {
      renderEmpty();
      return;
    }

    const mode = app.state.ui.mode;
    const readOnly = Boolean(doc.readOnly);
    const inWorld = mode === 'world' && !readOnly;
    editor.classList.toggle('hidden', mode !== 'edit' || readOnly);
    body.classList.toggle('hidden', (mode === 'edit' && !readOnly) || inWorld);
    world.classList.toggle('hidden', !inWorld);
    applyEditorMode();
    clear(head);
    clear(foot);

    const pageColor = app.colorFor('page', { path: doc.path });
    const backlinks = app.backlinksFor(doc.path);
    // Front matter is metadata: it configures the page, it does not print on it.
    const bodyText = doc.body ?? doc.text;
    const words = bodyText.trim() ? bodyText.trim().split(/\s+/).length : 0;

    head.append(
      el('div', { class: 'viewer-title-row' }, [
        htmlNode(colorSwatch('page', { path: doc.path }, pageColor, 'Page colour')),
        el('h1', { class: 'viewer-title', text: doc.meta.title ?? doc.path.split('/').pop() }),
        readOnly ? el('span', { class: 'tag-chip', text: 'shipped guide' }) : null,
        !readOnly && app.isWorldMarked?.(doc.path)
          ? el('span', { class: 'tag-chip tag-chip-world', text: 'Worldbuilding', title: 'This vein opens as a worldbuilding graph' })
          : null,
        el('div', { class: 'spacer' }),
        el('span', { class: 'viewer-path', text: doc.path, title: doc.path }),
        readOnly ? null : worldSwitch(mode),
      ]),
      el('div', { class: 'viewer-tools' }, [
        readOnly ? null : el('button', {
          class: `btn btn-ghost ${mode === 'edit' ? 'is-active' : ''}`,
          type: 'button',
          text: mode === 'edit' ? 'Preview' : 'Edit',
          onclick: () => app.setMode(mode === 'edit' ? 'read' : 'edit'),
        }),
        readOnly ? null : el('button', { class: 'btn btn-ghost', type: 'button', text: 'Save', onclick: () => app.saveCurrent() }),
        el('div', { class: 'spacer' }),
        el('span', { class: 'viewer-stat', text: `${words} words` }),
        el('span', { class: 'viewer-stat', text: `${(doc.headings ?? []).length} sections` }),
        el('span', { class: 'viewer-stat', text: `${backlinks.length} backlinks` }),
        doc.meta.tags?.length
          ? el('span', { class: 'viewer-tags' }, doc.meta.tags.map((tag) => el('span', { class: 'tag-chip', text: `#${tag}` })))
          : null,
      ]),
    );

    const rendered = renderMarkdown(bodyText, {
      currentPath: doc.path,
      resolveLink: (link) => app.resolveLink(link, doc.path),
      colorFor: (kind, parts) => app.colorFor(kind, parts),
    });
    currentRender = rendered;
    clear(body).innerHTML = rendered.html;

    foot.append(
      backlinks.length
        ? el('section', { class: 'backlinks' }, [
          el('h3', { class: 'backlinks-title', text: 'Linked from' }),
          el('ul', { class: 'backlink-list' }, backlinks.map((link) => el('li', {}, [
            el('a', {
              class: 'backlink',
              href: '#',
              'data-backlink': link.path,
              text: link.title,
              title: `Open ${link.path}`,
              onclick: (event) => {
                event.preventDefault();
                app.openPath(link.path, { via: doc.path });
              },
            }),
            link.context ? el('span', { class: 'backlink-context', text: link.context }) : null,
          ]))),
        ])
        : el('p', { class: 'backlinks-empty', text: 'No other vein links here yet — add a [[link]] and the graph will pick it up.' }),
    );

    textarea.value = doc.text;
    if (mode === 'edit') textarea.focus();
    if (inWorld) worldPanel.render(doc);
    await renderMermaidIn(body, rendered.mermaid, app.mermaid);
    body.classList.add('rendered');
    // A re-render (colour change, save, external edit) keeps the reader's hits.
    if (hitTerms.length) applyHits({ keepIndex: true });
  }

  /** Called by the app after an edit is saved/reverted. */
  function syncEditor(text) {
    if (textarea.value !== text) textarea.value = text;
    scheduleVisualPreview();
  }

  /** Scroll a section anchor into view after a wiki-link navigation. */
  function scrollToAnchor(anchor) {
    if (!anchor) {
      root.scrollTop = 0;
      return;
    }
    const selector = `[id="${String(anchor).replace(/"/g, '\\"')}"]`;
    const target = body.querySelector(selector) ?? document.getElementById(anchor);
    if (!target) {
      app.toast(`No section "${anchor}" in this vein`, 'warn');
      return;
    }

    const jump = () => target.scrollIntoView({ block: 'start', behavior: 'auto' });
    jump();
    // Mermaid diagrams and webfonts settle a frame later and shift the layout,
    // which would otherwise leave the anchor just below the viewport.
    requestAnimationFrame(() => {
      jump();
      requestAnimationFrame(jump);
    });
    target.classList.add('anchor-flash');
    setTimeout(() => target.classList.remove('anchor-flash'), 1400);
  }

  /** Remember where the reader was, so Back can return them there. */
  function rememberScroll(path) {
    if (!path) return;
    scrollPositions.set(path, root.scrollTop);
  }

  return {
    render,
    renderEmpty,
    syncEditor,
    scrollToAnchor,
    rememberScroll,
    /** Set the terms to highlight; returns how many hits landed on the page. */
    setTerms(next) {
      hitTerms = Array.isArray(next) ? next : [];
      return applyHits();
    },
    clearHits,
    goToHit,
    get hitCount() {
      return hitNodes.length;
    },
    get hitIndex() {
      return hitIndex;
    },
    get searchTerms() {
      return hitTerms;
    },
    get body() {
      return body;
    },
    get editor() {
      return editor;
    },
    get world() {
      return world;
    },
    clearScrollMemory() {
      scrollPositions = new Map();
    },
  };
}
