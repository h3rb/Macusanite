/**
 * Splitting and searching the manual, without a DOM.
 *
 * The help window renders the manual one section at a time, and its search box
 * has to answer two questions: which sections contain what was typed, and how
 * many times it appears there. Both are string work, so they live here — the
 * window only draws the answer, and the tests do not need a browser.
 *
 * Highlighting is deliberately *not* here: matches are marked up in the rendered
 * HTML by walking its text nodes (see [src/ui/helpWindow.js](../ui/helpWindow.js)),
 * because doing it on the markdown source would corrupt the markup it is part of.
 */
import { helpSections } from './helpDoc.js';
import { tokenize } from './search.js';

const slugify = (text) => String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * Break the manual into its sections.
 *
 * Returns `{ intro, sections }`: everything before the first `## ` heading
 * (title, blurb, generation note) and then one entry per section, in document
 * order. The generated `## Contents` list is dropped, since the window builds its
 * own navigation from the same headings.
 *
 * @param {string} markdown
 * @returns {{intro: string, sections: Array<{slug: string, title: string, body: string}>}}
 */
export function splitManual(markdown) {
  const text = String(markdown ?? '');
  const known = new Map(helpSections().map((entry) => [entry.title.toLowerCase(), entry.slug]));
  const parts = text.split(/\n(?=## )/);
  const intro = parts[0] ?? '';
  const sections = [];
  for (const part of parts.slice(1)) {
    const match = /^##\s+(.+?)\s*\n/.exec(part);
    if (!match) continue;
    const title = match[1].trim();
    if (title.toLowerCase() === 'contents') continue;
    sections.push({
      slug: known.get(title.toLowerCase()) ?? slugify(title),
      title,
      body: part.slice(match[0].length),
    });
  }
  return { intro, sections };
}

/** Every occurrence of `needle` in `haystack`, case-insensitively (both lowercased). */
function occurrences(haystack, needle) {
  if (!needle) return [];
  const lower = haystack.toLowerCase();
  const search = needle.toLowerCase();
  const found = [];
  let at = lower.indexOf(search);
  while (at !== -1) {
    found.push(at);
    at = lower.indexOf(search, at + search.length);
  }
  return found;
}

/** A short line around the first hit in a section, for the results list. */
function previewAround(text, at, length) {
  const flat = text.replace(/\s+/g, ' ');
  // The offsets are in the raw text; approximate the window in the flattened one.
  const approx = Math.max(0, Math.min(Math.max(0, flat.length - 1), at - Math.round(text.slice(0, at).split(/\s+/).length)));
  const start = Math.max(0, approx - 40);
  const end = Math.min(flat.length, approx + length + 60);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end).trim()}${end < flat.length ? '…' : ''}`;
}

/**
 * Which sections match a query, and how often.
 *
 * The query is read by the *same* tokenizer the vault search uses
 * ([src/lib/search.js](search.js)) and the same one the window highlights with, so
 * what the manual shows and what it marks can never disagree:
 *
 *   * every term has to appear somewhere in the section — two words match in any
 *     order and in any position;
 *   * `"a quoted phrase"` is one term and has to appear whole;
 *   * the section's heading counts as part of it, so searching "colours" finds
 *     the Colours section even if the word never appears in its prose.
 *
 * An empty query matches everything with no hits, which is what the window needs
 * to render the unfiltered manual.
 *
 * @param {Array<{slug: string, title: string, body: string}>} sections
 * @param {string} query
 * @returns {{query: string, terms: Array<{text: string, lower: string, phrase: boolean}>,
 *   total: number, sections: Array<{slug: string, title: string, hits: number, preview: string}>}}
 */
export function planSearch(sections, query) {
  const needle = String(query ?? '').trim();
  const terms = tokenize(needle);
  const matches = [];
  let total = 0;

  for (const section of sections) {
    if (!terms.length) {
      matches.push({ slug: section.slug, title: section.title, hits: 0, preview: '' });
      continue;
    }
    const haystack = `${section.title}\n${section.body}`;
    const counts = terms.map((term) => occurrences(haystack, term.lower).length);
    if (counts.some((count) => count === 0)) continue; // every term has to appear
    const hits = counts.reduce((sum, count) => sum + count, 0);
    total += hits;

    // Preview the earliest hit of any term, so the row shows what matched first.
    const places = terms.map((term) => {
      const at = occurrences(haystack, term.lower)[0] ?? 0;
      return { at, length: term.text.length };
    }).sort((a, b) => a.at - b.at);
    matches.push({
      slug: section.slug,
      title: section.title,
      hits,
      preview: previewAround(haystack, places[0].at, places[0].length),
    });
  }
  return { query: needle, terms, total, sections: matches };
}
