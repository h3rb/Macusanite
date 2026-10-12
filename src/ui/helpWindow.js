/**
 * The help window — the whole manual, in its own window, with a search box.
 *
 * It is deliberately the *same document* the CLI prints and the MCP server
 * serves ([src/lib/helpDoc.js](../lib/helpDoc.js)): the manual has one source and
 * three renders, so the window can never document something the code does not do.
 *
 * The window is a reader, not an editor, and it needs nothing from the vault:
 * it works with no vault open, which is exactly when someone reads the manual.
 *
 * Search behaviour, matching the rest of the app:
 *
 *   * every term has to appear (two words match anywhere and in any order);
 *   * `"a quoted phrase"` requires the phrase;
 *   * sections that match stay, sections that do not are hidden;
 *   * `Enter` / `↓` and `Shift+Enter` / `↑` step through the hits, which are
 *     marked in the page, and the status line says where you are.
 */
import { el, clear } from './dom.js';
import { renderMarkdown } from './markdown.js';
import { tokenize, findMatches } from '../lib/search.js';
import { splitManual, planSearch } from '../lib/helpSearch.js';
import { buildHelpMarkdown, DOC_TITLE } from '../lib/helpDoc.js';

/** Markdown context: the manual links to nothing, so every wiki link is a ghost. */
const CONTEXT = {
  currentPath: 'Help.md',
  resolveLink: (link) => ({ ok: false, path: link?.target ?? '', candidates: [] }),
  colorFor: () => 'var(--accent, #7aa2f7)',
};

/**
 * @param {object} input
 * @param {HTMLElement} input.root  an empty element to build the window into
 * @param {string} [input.markdown] the manual; defaults to the generated one
 */
export function createHelpWindow({ root, markdown = buildHelpMarkdown() }) {
  const { intro, sections } = splitManual(markdown);
  const sectionNodes = new Map();
  /** Section slugs in the order they are on screen. */
  let visible = sections.map((section) => section.slug);
  let hitNodes = [];
  let hitIndex = -1;

  const searchInput = el('input', {
    class: 'help-search-input',
    type: 'search',
    id: 'help-search',
    placeholder: 'Search the manual…  (every word has to appear; "quote a phrase")',
    spellcheck: 'false',
    autocomplete: 'off',
  });
  const status = el('span', { class: 'help-status', role: 'status' });
  const prevBtn = el('button', { class: 'help-step', type: 'button', title: 'Previous hit (Shift+Enter)', text: '↑', onclick: () => step(-1) });
  const nextBtn = el('button', { class: 'help-step', type: 'button', title: 'Next hit (Enter)', text: '↓', onclick: () => step(1) });
  const nav = el('nav', { class: 'help-nav', 'aria-label': 'Manual sections' });
  const content = el('main', { class: 'help-content' });

  /* ── the document ──────────────────────────────────────────────────── */

  const article = el('article', { class: 'markdown-body help-article' });
  article.innerHTML = renderMarkdown(intro, CONTEXT).html;

  for (const section of sections) {
    const node = el('section', { class: 'help-section', id: `help-section-${section.slug}` });
    node.dataset.slug = section.slug;
    // The section is rendered whole, `## Title` included: the heading keeps the
    // id the renderer gives it, so `[Undo and redo](#undo-and-redo)` links inside
    // the manual land where they should.
    node.innerHTML = renderMarkdown(`## ${section.title}\n${section.body}`, CONTEXT).html;
    sectionNodes.set(section.slug, node);
    article.append(node);
  }
  content.append(article);

  const shell = el('div', { class: 'help-shell' }, [
    el('header', { class: 'help-bar' }, [
      el('span', { class: 'help-brand' }, [
        el('span', { class: 'vault-badge', 'aria-hidden': 'true', text: '◈' }),
        el('span', { class: 'help-title', text: DOC_TITLE }),
      ]),
      el('div', { class: 'help-search' }, [searchInput, prevBtn, nextBtn]),
      status,
    ]),
    el('div', { class: 'help-body' }, [nav, content]),
  ]);
  clear(root).append(shell);

  /* ── search ────────────────────────────────────────────────────────── */

  /** Wrap every hit in the visible sections, collecting the marks in order. */
  function markHits(terms) {
    for (const section of visible) {
      const host = sectionNodes.get(section);
      if (!host) continue;
      const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => {
          if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
          const parent = node.parentElement;
          if (!parent || parent.closest('mark, script, style')) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      const texts = [];
      while (walker.nextNode()) texts.push(walker.currentNode);
      for (const textNode of texts) {
        const ranges = findMatches(textNode.nodeValue, terms);
        if (!ranges.length) continue;
        const fragment = document.createDocumentFragment();
        let cursor = 0;
        for (const [start, end] of ranges) {
          if (start > cursor) fragment.append(document.createTextNode(textNode.nodeValue.slice(cursor, start)));
          // `search-hit` is the app's own hit style, so the manual and a document
          // mark what you searched for in exactly the same way.
          const mark = el('mark', { class: 'search-hit help-hit', text: textNode.nodeValue.slice(start, end) });
          fragment.append(mark);
          hitNodes.push(mark);
          cursor = end;
        }
        if (cursor < textNode.nodeValue.length) fragment.append(document.createTextNode(textNode.nodeValue.slice(cursor)));
        textNode.parentNode.replaceChild(fragment, textNode);
      }
    }
  }

  /** Undo the marks from the previous search: unwrap them back into text. */
  function clearHits() {
    for (const mark of article.querySelectorAll('mark.help-hit')) {
      const parent = mark.parentNode;
      if (!parent) continue;
      parent.replaceChild(document.createTextNode(mark.textContent ?? ''), mark);
      parent.normalize();
    }
    hitNodes = [];
    hitIndex = -1;
  }

  function renderNav(plan) {
    const query = plan.query;
    clear(nav);
    if (!query) {
      for (const section of sections) nav.append(navButton(section.title, section.slug));
      return;
    }
    if (!plan.sections.length) {
      nav.append(el('p', { class: 'help-nav-empty', text: `Nothing in the manual mentions “${query}”.` }));
      return;
    }
    for (const match of plan.sections) {
      nav.append(navButton(match.title, match.slug, `${match.hits} ×`));
    }
  }

  function navButton(title, slug, badge = null) {
    return el('button', {
      class: 'help-nav-item',
      type: 'button',
      dataset: { slug },
      onclick: () => focusSection(slug),
    }, [
      el('span', { class: 'help-nav-text', text: title }),
      badge ? el('span', { class: 'help-nav-badge', text: badge }) : null,
    ]);
  }

  function focusSection(slug) {
    const node = sectionNodes.get(slug);
    if (!node) return;
    node.scrollIntoView({ block: 'start', behavior: 'smooth' });
    setActive(slug);
  }

  function setActive(slug) {
    for (const item of nav.querySelectorAll('.help-nav-item')) {
      item.classList.toggle('is-active', item.dataset.slug === slug);
    }
  }

  function setStatus(plan) {
    if (!plan.query) {
      status.textContent = `${sections.length} sections`;
      return;
    }
    // The planner counts the markdown, but what the reader can step through is
    // what was marked in the rendered page — so the two never disagree.
    const total = hitNodes.length || plan.total;
    if (!total) {
      status.textContent = `no matches for “${plan.query}”`;
      return;
    }
    const shown = plan.sections.length;
    const where = hitIndex >= 0 ? ` · hit ${hitIndex + 1}/${total}` : '';
    status.textContent = `${total} match${total === 1 ? '' : 'es'} in ${shown} section${shown === 1 ? '' : 's'}${where}`;
  }

  /** Re-run the search: hide what does not match, mark and count what does. */
  function apply(query = searchInput.value) {
    const plan = planSearch(sections, query);
    clearHits();
    visible = plan.sections.map((section) => section.slug);
    const visibleSet = new Set(visible);
    for (const [slug, node] of sectionNodes) node.hidden = !visibleSet.has(slug);
    if (plan.query) {
      markHits(tokenize(plan.query));
      // Jump to the first hit so a search is never a scroll hunt.
      if (hitNodes.length) {
        hitIndex = 0;
        highlightCurrent();
      }
    }
    renderNav(plan);
    setStatus(plan);
    const active = plan.sections[0]?.slug;
    if (active) setActive(active);
    return plan;
  }

  function highlightCurrent() {
    hitNodes.forEach((mark, index) => mark.classList.toggle('is-current', index === hitIndex));
    const mark = hitNodes[hitIndex];
    if (mark) mark.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  function step(delta) {
    if (!hitNodes.length) return;
    hitIndex = (hitIndex + delta + hitNodes.length) % hitNodes.length;
    highlightCurrent();
    setStatus(planSearch(sections, searchInput.value));
  }

  searchInput.addEventListener('input', () => apply());
  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      step(event.shiftKey ? -1 : 1);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      searchInput.value = '';
      apply('');
    }
  });

  // Ctrl+F (or `/`) reaches the search box from anywhere in the window. Enter
  // and Escape belong to the input itself (see above) — handling them here as
  // well would step twice per keypress.
  document.addEventListener('keydown', (event) => {
    const typing = document.activeElement === searchInput;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      searchInput.focus();
      searchInput.select();
    } else if (!typing && event.key === '/') {
      event.preventDefault();
      searchInput.focus();
    } else if (event.key === 'F3' && !typing) {
      event.preventDefault();
      step(event.shiftKey ? -1 : 1);
    }
  });

  // Scroll spy: the nav highlights the section you are actually reading.
  let ticking = false;
  content.addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      const top = content.getBoundingClientRect().top;
      let best = null;
      for (const slug of visible) {
        const node = sectionNodes.get(slug);
        if (!node) continue;
        const offset = node.getBoundingClientRect().top - top;
        if (offset <= 24) best = slug;
      }
      if (best) setActive(best);
    });
  });

  // Clicking a `#anchor` inside the manual scrolls without leaving the window.
  article.addEventListener('click', (event) => {
    const link = event.target instanceof Element ? event.target.closest('a[href^="#"]') : null;
    if (!link) return;
    const target = article.querySelector(link.getAttribute('href'));
    if (!target) return;
    event.preventDefault();
    target.scrollIntoView({ block: 'start', behavior: 'smooth' });
  });

  apply('');
  return {
    sections,
    shell,
    search: apply,
    step,
    focusSection,
    /** What the search box currently has. */
    query: () => searchInput.value,
  };
}
