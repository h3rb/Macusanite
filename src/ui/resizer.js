/**
 * Draggable splitters for the sidebar and graph panels.
 *
 * Widths are written into `settings.layout`, so a vault remembers how you left
 * the workspace.
 */
import { qs } from './dom.js';

export function createResizer({ app, handle, target, side, key, cssVar, min = 160, max = 900 }) {
  let startX = 0;
  let startWidth = 0;
  let active = false;

  // The panel widths are grid columns driven by custom properties on :root, so
  // the splitter has to write there (setting it on the panel itself would do
  // nothing at all).
  const apply = (width) => {
    const clamped = Math.max(min, Math.min(max, Math.round(width)));
    document.documentElement.style.setProperty(cssVar, `${clamped}px`);
    app.state.settings.layout[key] = clamped;
    return clamped;
  };

  const onMove = (event) => {
    if (!active) return;
    const delta = event.clientX - startX;
    apply(side === 'left' ? startWidth + delta : startWidth - delta);
    app.scheduleGraphRefresh();
  };

  const onUp = () => {
    if (!active) return;
    active = false;
    handle.classList.remove('dragging');
    document.body.classList.remove('resizing');
    app.persistSettings({ record: false });
  };

  handle.addEventListener('pointerdown', (event) => {
    active = true;
    startX = event.clientX;
    startWidth = target.getBoundingClientRect().width;
    handle.classList.add('dragging');
    document.body.classList.add('resizing');
    handle.setPointerCapture?.(event.pointerId);
  });

  handle.addEventListener('pointermove', onMove);
  handle.addEventListener('pointerup', onUp);
  handle.addEventListener('pointercancel', onUp);

  // Pointer capture keeps events on the handle, but a stray release outside the
  // window would otherwise leave the splitter stuck.
  window.addEventListener('mouseup', onUp);

  return {
    apply(settings = app.state.settings) {
      const width = settings.layout[key] ?? 260;
      document.documentElement.style.setProperty(cssVar, `${width}px`);
    },
    get element() {
      return handle;
    },
  };
}

/** Wire both splitters in one call; returns an `apply()` for the whole layout. */
export function createResizers({ app, root }) {
  const sidebar = createResizer({
    app,
    handle: qs('#sidebar-resizer', root),
    target: qs('#sidebar', root),
    side: 'left',
    key: 'sidebarWidth',
    cssVar: '--sidebar-width',
    min: 180,
    max: 620,
  });
  const graph = createResizer({
    app,
    handle: qs('#graph-resizer', root),
    target: qs('#graph-panel', root),
    side: 'right',
    key: 'graphWidth',
    cssVar: '--graph-width',
    min: 220,
    max: 860,
  });

  return {
    apply() {
      sidebar.apply();
      graph.apply();
    },
  };
}
