/**
 * The search pane: the sidebar's second tab.
 *
 * It is only rendering — the query, the ranking and the decision about what a
 * click means all live in [src/lib/search.js] and the controller. Rows show why
 * they matched (title, section, tag, body) and a snippet with the terms already
 * marked, so a result can be judged without opening it.
 */
import { el, clear, delegate, escapeHtml } from './dom.js';
import { findMatches } from '../lib/search.js';

/** Escape the text and wrap the matched ranges in `<mark>`. */
function marked(text, ranges) {
  let html = '';
  let at = 0;
  for (const [start, end] of ranges) {
    html += escapeHtml(text.slice(at, start));
    html += `<mark class="search-hit">${escapeHtml(text.slice(start, end))}</mark>`;
    at = end;
  }
  return html + escapeHtml(text.slice(at));
}

export function createSearchPanel({ app, root }) {
  const input = el('input', {
    class: 'search-input',
    type: 'search',
    placeholder: 'Search every vein…',
    spellcheck: 'false',
    autocomplete: 'off',
    'aria-label': 'Search every vein',
    oninput: (event) => app.runSearch(event.target.value),
  });

  const prevHit = el('button', { class: 'icon-btn btn-mini', type: 'button', title: 'Previous hit (Shift+F3)', text: '‹', onclick: () => app.searchHit(-1) });
  const nextHit = el('button', { class: 'icon-btn btn-mini', type: 'button', title: 'Next hit (F3)', text: '›', onclick: () => app.searchHit(1) });
  const summary = el('div', { class: 'search-summary' });
  const results = el('div', { class: 'search-results', role: 'listbox', 'aria-label': 'Search results' });

  root.append(
    el('div', { class: 'search-head' }, [input]),
    el('div', { class: 'search-status' }, [summary, el('div', { class: 'spacer' }), prevHit, nextHit]),
    results,
  );

  delegate(results, 'click', '[data-result]', (event, node) => {
    event.preventDefault();
    app.openSearchResult(node.dataset.result);
  });

  // Arrow keys work whether the focus is in the box or on a result row.
  root.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      app.moveSearchSelection(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Enter' && event.target !== input) {
      event.preventDefault();
      const active = app.state.search.results[app.state.search.activeIndex];
      if (active) app.openSearchResult(active.path);
    }
    // Escape is the controller's: one step out of the search at a time.
  });

  function render() {
    const search = app.state.search;
    const showing = search.results.length;
    const hitText = !search.terms.length
      ? ''
      : search.hits
        ? `${search.hitIndex + 1} of ${search.hits} hit${search.hits === 1 ? '' : 's'} on this page`
        : 'no hits on this page';

    clear(summary);
    if (!search.terms.length) {
      // The vault size is always known; the corpus is only built on first use.
      const veins = app.state.veins.length;
      summary.append(el('span', {
        class: 'search-stat',
        text: veins ? `${veins} vein${veins === 1 ? '' : 's'} to search` : 'no vault loaded',
      }));
    } else {
      summary.append(
        el('span', {
          class: 'search-stat',
          text: search.total
            ? `${search.total} vein${search.total === 1 ? '' : 's'}${search.total > showing ? ` · showing ${showing}` : ''}`
            : 'no matches',
        }),
        hitText ? el('span', { class: 'search-stat search-hitstat', text: hitText }) : null,
      );
    }
    // A lazily opened vault answers from cached metadata at once and reads the
    // body text behind the results, so the count can still be growing.
    if (search.reading) {
      summary.append(el('span', {
        class: 'search-stat search-reading',
        text: `reading ${search.reading.done}/${search.reading.total}…`,
      }));
    }
    prevHit.disabled = !search.hits;
    nextHit.disabled = !search.hits;

    clear(results);
    if (!search.terms.length) {
      results.append(el('p', { class: 'search-empty' }, [
        el('span', { text: 'Search titles, sections, tags and body text. ' }),
        el('span', { class: 'search-tip', text: 'Quote a run — "sieve series" — to require the exact phrase.' }),
      ]));
      return;
    }
    if (!showing) {
      results.append(el('p', { class: 'search-empty', text: `Nothing in this vault matches “${search.query.trim()}”.` }));
      return;
    }

    const activeResult = app.state.current?.path;
    results.append(...search.results.map((result, index) => row(result, index, activeResult)));
    results.querySelector('.search-result.active')?.scrollIntoView({ block: 'nearest' });
  }

  function row(result, index, activeResult) {
    const terms = app.state.search.terms;
    const chips = [];
    if (result.fields.title) chips.push(el('span', { class: 'hit-chip hit-title', text: 'title' }));
    for (const heading of result.headingMatches.slice(0, 2)) {
      chips.push(el('span', { class: 'hit-chip hit-heading', text: `§ ${heading.text}` }));
    }
    if (result.fields.tag) chips.push(el('span', { class: 'hit-chip hit-tag', text: 'tag' }));
    if (result.bodyHits) {
      chips.push(el('span', { class: 'hit-chip hit-body', text: `${result.bodyHits} in text` }));
    }

    return el('button', {
      class: `search-result ${index === app.state.search.activeIndex ? 'active' : ''} ${result.path === activeResult ? 'current' : ''}`,
      type: 'button',
      role: 'option',
      'aria-selected': index === app.state.search.activeIndex ? 'true' : 'false',
      'data-result': result.path,
      title: result.path,
    }, [
      el('span', { class: 'result-title', html: marked(result.title, findMatches(result.title, terms)) }),
      el('span', { class: 'result-path', text: result.path }),
      chips.length ? el('span', { class: 'result-chips' }, chips) : null,
      result.snippet
        ? el('span', { class: 'result-snippet', html: marked(result.snippet.text, result.snippet.ranges) })
        : null,
    ]);
  }

  return {
    render,
    /**
     * Focus the query box: select an existing query so it can be replaced, or
     * put the caret at the end of an empty one.
     */
    focus(select = false) {
      input.focus();
      if (select && input.value) input.select();
      else input.setSelectionRange?.(input.value.length, input.value.length);
    },
    /** Called by the controller when the query comes from somewhere else. */
    setQuery(query) {
      if (input.value !== query) input.value = query;
    },
    get query() {
      return input.value;
    },
  };
}
