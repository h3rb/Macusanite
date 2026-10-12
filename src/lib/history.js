/**
 * Navigation history for the back/forward arrows and the "recent navigation"
 * breadcrumb trail.
 *
 * File-level undo/redo is a different thing entirely: those stacks live in the
 * vault (`.macusanite/history.json`) and are applied by the Rust side, because
 * undo has to rewrite files, not just scroll the viewer back.
 */

export class NavHistory {
  /**
   * @param {{limit?: number}} [options]
   */
  constructor(options = {}) {
    this.limit = options.limit ?? 200;
    /** @type {Array<{path: string, section: string, title?: string, ts?: number, via?: string}>} */
    this.entries = [];
    this.index = -1;
  }

  get current() {
    return this.entries[this.index] ?? null;
  }

  get canBack() {
    return this.index > 0;
  }

  get canForward() {
    return this.index >= 0 && this.index < this.entries.length - 1;
  }

  /**
   * Record a visit. Re-visiting the current page with the same section is a
   * no-op so the arrows never appear to "stick".
   */
  push(entry, options = {}) {
    if (!entry?.path) return this.current;
    const next = {
      path: entry.path,
      section: entry.section ?? '',
      title: entry.title ?? null,
      via: entry.via ?? null,
      ts: entry.ts ?? Date.now(),
    };
    const current = this.current;
    if (current && !options.force && current.path === next.path && current.section === next.section) {
      return current;
    }
    // A new visit invalidates the forward branch.
    this.entries = this.entries.slice(0, this.index + 1);
    this.entries.push(next);
    if (this.entries.length > this.limit) {
      this.entries = this.entries.slice(this.entries.length - this.limit);
    }
    this.index = this.entries.length - 1;
    return next;
  }

  back() {
    if (!this.canBack) return null;
    this.index -= 1;
    return this.current;
  }

  forward() {
    if (!this.canForward) return null;
    this.index += 1;
    return this.current;
  }

  /**
   * Previously visited pages, newest first, deduplicated by path and excluding
   * the page you are on: chips in the nav bar should never repeat.
   */
  recent(count = 8) {
    const out = [];
    const seen = new Set();
    if (this.current?.path) seen.add(this.current.path);
    for (let i = this.index; i >= 0 && out.length < count; i -= 1) {
      const entry = this.entries[i];
      if (!entry || seen.has(entry.path)) continue;
      seen.add(entry.path);
      out.push(entry);
    }
    return out;
  }

  /**
   * Breadcrumb trail for the nav bar: the pages that led here, oldest first,
   * so "recent navigation" reads like a trail rather than a stack.
   */
  trail(count = 6) {
    return this.recent(count).reverse();
  }

  /**
   * Wiki breadcrumbs: how the reader arrived at the current note, derived from
   * the `via` field of each step (`via` is the page the link was clicked from).
   */
  wikiTrail(count = 8) {
    const out = [];
    let cursor = this.current;
    let guard = 0;
    while (cursor && guard < count) {
      out.push(cursor);
      if (!cursor.via) break;
      cursor = this.entries.find((e) => e.path === cursor.via) ?? { path: cursor.via, section: '' };
      guard += 1;
    }
    return out.reverse();
  }

  clear() {
    this.entries = [];
    this.index = -1;
  }

  toJSON() {
    return { entries: this.entries, index: this.index, limit: this.limit };
  }

  static fromJSON(json) {
    const nav = new NavHistory({ limit: json?.limit ?? 200 });
    nav.entries = Array.isArray(json?.entries) ? json.entries : [];
    nav.index = Number.isInteger(json?.index) ? Math.min(json.index, nav.entries.length - 1) : nav.entries.length - 1;
    return nav;
  }
}

/**
 * Colour assignment keys. Keeping them in one place stops the renderer, the
 * picker and the graph from drifting apart.
 */
export const colorKeys = {
  page: (path) => `page:${path}`,
  link: (from, to) => `link:${from}->${to}`,
  section: (path, anchor) => `section:${path}#${anchor}`,
  concept: (name) => `concept:${name}`,
};

/** Which key wins when resolving a colour: exact -> section -> page -> default. */
export function resolveColorKey(assignments, key, fallbacks = [], defaultColor = '#ffffff') {
  const candidates = [key, ...fallbacks];
  for (const candidate of candidates) {
    const found = assignments?.[candidate];
    if (found) return found;
  }
  return defaultColor;
}

/**
 * Ordered fallbacks for each kind of colour target.
 * A section colour inherits its page colour; a link inherits its source page.
 */
export function colorFallbacks(kind, parts) {
  switch (kind) {
    case 'section':
      return [colorKeys.page(parts.path)];
    case 'link':
      return [colorKeys.page(parts.from)];
    case 'concept':
      return [];
    default:
      return [];
  }
}
