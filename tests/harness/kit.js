/**
 * The plumbing the canvas checks under `tests/harness/` share.
 *
 * Every check drives the real panel with synthetic input and reads the result
 * back from the DOM, so they all need the same few things: a pointer event
 * shaped like a browser's, a poll that waits for a repaint instead of a fixed
 * delay, the card rects the reader would see, and a fixture written into the
 * harness's virtual vault. Those live here once; each check script supplies
 * only what it asserts.
 *
 * Nothing here is imported by the application: `?wb-smoke=…` loads a script in
 * development, and a production build drops the import with it.
 */

/* ------------------------------------------------------ the virtual vault -- */

/** Where the harness keeps the whole virtual vault in localStorage. */
export const VAULT_STORAGE_KEY = 'macusanite.virtual-vault.v1';

/**
 * `'seed'` on the first visit, `'run'` after the reload a seed asks for: a
 * fixture written into the vault is read fresh only when the page starts again.
 */
export function harnessPhase(search = globalThis.location?.search ?? '') {
  return new URLSearchParams(search).get('phase') === 'run' ? 'run' : 'seed';
}

/** Reload into the run phase, so the vault a seed just wrote is read fresh. */
export function reloadForRunPhase() {
  const next = new URL(globalThis.location.href);
  next.searchParams.set('phase', 'run');
  globalThis.location.replace(next.href);
}

/**
 * Write one fixture — or a list of them — into the harness vault: each one's
 * markdown as a vein, and its canvas record beside it. Returns an error
 * message for a vault that is not there, or null once they are written.
 */
export function seedHarnessVault(fixtures) {
  const raw = globalThis.localStorage?.getItem(VAULT_STORAGE_KEY);
  if (!raw) return 'the harness vault is not in localStorage';
  const store = JSON.parse(raw);
  if (!store?.files) return 'the harness vault has no files';
  const state = JSON.parse(store.files['.macusanite/state.json'] ?? '{}');
  state.world = state.world && typeof state.world === 'object' ? state.world : {};
  for (const fixture of [].concat(fixtures)) {
    store.files[fixture.path] = fixture.body;
    state.world[fixture.path] = fixture.record;
  }
  store.files['.macusanite/state.json'] = JSON.stringify(state, null, 2);
  globalThis.localStorage.setItem(VAULT_STORAGE_KEY, JSON.stringify(store));
  return null;
}

/* ---------------------------------------------------------- waiting/polling -- */

export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The next painted frame, for a measurement or a zoom the panel applies there. */
export const nextFrame = () => new Promise((resolve) => {
  requestAnimationFrame(() => requestAnimationFrame(resolve));
});

/** Poll until `predicate` answers something truthy, or the time runs out. */
export async function waitFor(predicate, timeout = 2000) {
  const until = performance.now() + timeout;
  for (;;) {
    const answer = predicate();
    if (answer) return answer;
    if (performance.now() >= until) return null;
    await wait(25);
  }
}

/* --------------------------------------------------------------- asserting -- */

export function fail(message) {
  throw new Error(message);
}

export function sameSet(a, b) {
  const left = [...a].sort();
  const right = [...b].sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Run one check and keep its result: a pass with a detail line, a skip with its
 * reason, or a failure with the message it threw.
 */
export async function record(results, name, run) {
  try {
    const detail = await run();
    if (detail?.skip) results.push({ name, status: 'skip', detail: detail.skip });
    else results.push({ name, status: 'pass', detail: detail?.detail ?? '' });
  } catch (error) {
    results.push({ name, status: 'fail', detail: error?.message ?? String(error) });
  }
}

/**
 * Announce a finished run on `globalThis[key]`, as a console table, and in the
 * page title — the three places a harness run is read from.
 */
export function reportSmoke(label, key, results) {
  const failures = results.filter((result) => result.status === 'fail');
  const passes = results.filter((result) => result.status === 'pass');
  const summary = {
    ok: failures.length === 0 && passes.length > 0,
    passed: passes.length,
    failed: failures.length,
    skipped: results.filter((result) => result.status === 'skip').length,
    results,
  };
  globalThis[key] = summary;
  if (globalThis.console?.table) console.table(results);
  document.title = `${summary.ok ? '✓' : '✗'} ${label} — ${summary.passed}/${results.length} passed`;
  return summary;
}

/* ------------------------------------------------------- synthetic pointer -- */

/** One pointer event of the kind a mouse would send, at a client point. */
export function fire(target, type, x, y, buttons, extra = {}) {
  target.dispatchEvent(new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    composed: true,
    button: 0,
    buttons,
    clientX: x,
    clientY: y,
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true,
    ...extra,
  }));
}

/** A press and release in place, with the click a browser would add. */
export function clickAt(target, x, y, extra = {}) {
  fire(target, 'pointerdown', x, y, 1, extra);
  fire(window, 'pointerup', x, y, 0, extra);
  target.dispatchEvent(new MouseEvent('click', {
    bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, ...extra,
  }));
}

/* ------------------------------------------------------ cards and their rects -- */

export function centreOf(rect) {
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

/** A rect with a real size sitting wholly inside another, by a margin. */
export function inside(outer, rect, margin = 0) {
  return rect.width > 1 && rect.height > 1
    && rect.left >= outer.left + margin && rect.right <= outer.right - margin
    && rect.top >= outer.top + margin && rect.bottom <= outer.bottom - margin;
}

export function overlaps(outer, rect) {
  return rect.width > 1 && rect.height > 1
    && rect.right > outer.left && rect.left < outer.right
    && rect.bottom > outer.top && rect.top < outer.bottom;
}

/** Whether a screen rectangle would be picked by a marquee box. */
export function intersects(rect, box) {
  return rect.right > box.left && rect.left < box.right && rect.bottom > box.top && rect.top < box.bottom;
}

/** The card for an anchor, in the page or inside `root`. */
export function cardFor(anchor, root = document) {
  return [...root.querySelectorAll('.wb-card')]
    .find((card) => card.dataset.anchor === anchor) ?? null;
}

/**
 * Every note card on the canvas, in the order the panel holds them.
 *
 * The intro card ("Before the first heading") is a `.wb-card` too, but it is
 * not a note: it has no anchor and no note index. Letting it into the
 * comparison makes `Number(undefined)` return NaN, so the sort has no total
 * order and silently keeps whatever order the DOM happens to be in — which
 * changes as cards are raised or re-mounted, and reads as "the cards came back
 * in a different order" while the canvas is in fact correct. Note cards alone
 * are compared here, by index, and a duplicate index is reported rather than
 * quietly permuting the result.
 */
export function cardAnchors() {
  const notes = [...document.querySelectorAll('.wb-card')]
    .filter((card) => card.dataset.anchor && card.dataset.note !== undefined && card.dataset.note !== '')
    .map((card) => ({ anchor: card.dataset.anchor, note: Number(card.dataset.note) }));
  const seen = new Map();
  for (const { anchor, note } of notes) {
    if (!Number.isFinite(note)) fail(`the card for ${anchor} carries no note index`);
    const twin = seen.get(note);
    if (twin) fail(`the cards for ${twin} and ${anchor} share note index ${note}`);
    seen.set(note, anchor);
  }
  return notes.sort((left, right) => left.note - right.note).map(({ anchor }) => anchor);
}

export function selectedAnchors() {
  return [...document.querySelectorAll('.wb-card.is-selected')].map((card) => card.dataset.anchor);
}

/**
 * Press the canvas's own Fit button until every card named is wholly inside
 * the stage, so all of them are built and none is clipped.
 */
export async function fitAllCards(stage, anchors) {
  const button = [...document.querySelectorAll('button')]
    .find((candidate) => (candidate.title ?? '').startsWith('Zoom to fit every card'));
  if (!button) fail('the canvas has no Fit button');
  button.click();
  const fitted = await waitFor(() => {
    const bounds = stage.getBoundingClientRect();
    const cards = anchors.map((anchor) => cardFor(anchor));
    if (cards.some((card) => !card)) return null;
    const allInside = cards.map((card) => card.getBoundingClientRect()).every((rect) => (
      rect.width > 2 && rect.height > 2
      && rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1
      && rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1
    ));
    return allInside ? true : null;
  }, 3000);
  if (!fitted) fail('the fixture cards could not all be brought into the stage');
}

/** A point on the stage where the background, not a card or control, takes the press. */
export function blankPoint(stage) {
  const s = stage.getBoundingClientRect();
  const blocked = '.wb-card, .wb-group-tab, .wb-group-summary, .wb-annotation, .wb-menu, '
    + '.wb-navigator, .wb-inspector, button, input, select, textarea, '
    + '.wb-edge-label, [data-edge-key], .wb-zoom-hud, .wb-overlap-hud';
  for (let gy = 0.06; gy <= 0.94; gy += 0.055) {
    for (let gx = 0.03; gx <= 0.97; gx += 0.05) {
      const x = s.left + s.width * gx;
      const y = s.top + s.height * gy;
      const hit = document.elementFromPoint(x, y);
      if (!hit || !stage.contains(hit)) continue;
      if (hit.closest(blocked)) continue;
      return { x, y };
    }
  }
  return null;
}

/** Drag the background by a screen-space delta; returns whether it started. */
export async function panBy(stage, dx, dy) {
  const from = blankPoint(stage);
  if (!from) return false;
  fire(stage, 'pointerdown', from.x, from.y, 1);
  fire(window, 'pointermove', from.x + dx / 2, from.y + dy / 2, 1);
  fire(window, 'pointermove', from.x + dx, from.y + dy, 1);
  fire(window, 'pointerup', from.x + dx, from.y + dy, 0);
  await wait(30);
  return true;
}

/** Pan just far enough for an element's centre to be clickable on stage. */
export async function bringCentreIntoView(stage, element, margin = 12) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const s = stage.getBoundingClientRect();
    const r = element.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) return false;
    const point = centreOf(r);
    const dx = point.x < s.left + margin ? (s.left + margin) - point.x
      : point.x > s.right - margin ? (s.right - margin) - point.x : 0;
    const dy = point.y < s.top + margin ? (s.top + margin) - point.y
      : point.y > s.bottom - margin ? (s.bottom - margin) - point.y : 0;
    if (!dx && !dy) return true;
    if (!(await panBy(stage, dx, dy))) return false;
  }
  const s = stage.getBoundingClientRect();
  const point = centreOf(element.getBoundingClientRect());
  return point.x >= s.left && point.x <= s.right && point.y >= s.top && point.y <= s.bottom;
}

/**
 * Pan just far enough for an element to sit wholly inside the stage.
 *
 * A pan rebuilds part of the canvas, and some of that part is replaced rather
 * than moved — group tabs are removed and drawn again on every build. Such a
 * caller passes `relook`, which finds its element again after each pan; the
 * loop then measures the element that is on screen now, not the one it panned.
 */
export async function bringIntoView(stage, element, margin = 10, relook = null) {
  let target = element;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const s = stage.getBoundingClientRect();
    const r = target.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) return false;
    if (inside(s, r, margin)) return true;
    const dx = r.left < s.left + margin ? (s.left + margin) - r.left
      : r.right > s.right - margin ? (s.right - margin) - r.right : 0;
    const dy = r.top < s.top + margin ? (s.top + margin) - r.top
      : r.bottom > s.bottom - margin ? (s.bottom - margin) - r.bottom : 0;
    if (!dx && !dy) return false;
    if (!(await panBy(stage, dx, dy))) return false;
    if (relook) target = relook() ?? target;
  }
  const s = stage.getBoundingClientRect();
  return inside(s, target.getBoundingClientRect(), 0);
}

/* ------------------------------------------------------------ wheel zooming -- */

/** The canvas's applied zoom, as the panel writes it. */
export function scaleOf(canvas) {
  return Number.parseFloat(canvas.style.getPropertyValue('--wb-zoom'));
}

/**
 * Wait until the canvas shows the zoom the last wheel asked for. The panel
 * applies a wheel on the next frame, so on a heavy canvas a fixed wait would
 * read the previous scale and send another full step on top of it — several
 * steps compounding into one runaway zoom past the limits.
 */
export async function settleZoom(canvas, from, timeout = 1500) {
  const until = performance.now() + timeout;
  while (performance.now() < until) {
    const now = scaleOf(canvas);
    if (Number.isFinite(now) && now !== from) return now;
    await wait(10);
  }
  return scaleOf(canvas);
}

/** Wheel the canvas to a scale, keeping one screen point still. */
export async function zoomTo(stage, canvas, target, anchor, tolerance = 1e-4) {
  const point = anchor ?? blankPoint(stage) ?? centreOf(stage.getBoundingClientRect());
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const current = scaleOf(canvas);
    if (!Number.isFinite(current)) return current;
    if (Math.abs(current - target) <= tolerance) return current;
    // One event is one step, so ask only for a ratio a single step can land:
    // a vast delta clamps at ZOOM_MIN or ZOOM_MAX instead of arriving.
    const ratio = Math.min(4, Math.max(0.25, target / current));
    stage.dispatchEvent(new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaMode: 0,
      deltaY: -Math.log(ratio) / 0.002,
      clientX: point.x,
      clientY: point.y,
    }));
    if ((await settleZoom(canvas, current)) === current) break;
  }
  return scaleOf(canvas);
}
