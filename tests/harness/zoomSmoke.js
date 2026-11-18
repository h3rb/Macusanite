/**
 * Harness smoke test for the canvas zoom contract and its hit targets.
 *
 * Unit tests can prove what `zoomMode` returns; they cannot prove that the
 * stage carries those classes, that the badge agrees with them, or that the
 * link ring, the group port and the card's own centre still receive the
 * pointer when the canvas is transformed. Those are the defects the manual
 * zoom checks kept finding, so this drives the real panel with synthetic
 * pointer and wheel input and reads the result back from the DOM.
 *
 * Run it against the harness:
 *
 *   npm run harness
 *   open http://127.0.0.1:1421/?wb-smoke=zoom
 *
 * The results also land on `globalThis.wbZoomSmoke` and in the console, and
 * the page title reports the run. It needs a vein open as Worldbuilding with
 * at least one card and one group that has a port.
 */
import { zoomMode } from '../../src/lib/worldbuild.js';

const ZOOMS = [1, 0.6, 0.2, 0.125];
// The view is driven by wheel events whose result is recomputed by the panel;
// this is the closeness to the requested scale that still counts as that step.
const ZOOM_TOLERANCE = 1e-4;
const STAGE_CLASSES = [
  'is-zoomed-out',
  'is-forge-zoom',
  'is-annotation-drag',
  'is-semantic-zoom',
  'is-icon-zoom',
];

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function describe(element) {
  if (!element) return 'nothing';
  const raw = element.className;
  const cls = typeof raw === 'string' ? raw : raw?.baseVal ?? '';
  const name = element.tagName ? element.tagName.toLowerCase() : 'node';
  return `<${name}${cls ? `.${cls.trim().split(/\s+/).filter(Boolean).join('.')}` : ''}>`;
}

function fail(message) {
  throw new Error(message);
}

function sameSet(a, b) {
  const left = [...a].sort();
  const right = [...b].sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function fire(target, type, x, y, buttons, extra = {}) {
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
function clickAt(target, x, y, extra = {}) {
  fire(target, 'pointerdown', x, y, 1, extra);
  fire(window, 'pointerup', x, y, 0, extra);
  target.dispatchEvent(new MouseEvent('click', {
    bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, ...extra,
  }));
}

function centreOf(rect) {
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function inside(outer, rect, margin = 0) {
  return rect.width > 1 && rect.height > 1
    && rect.left >= outer.left + margin && rect.right <= outer.right - margin
    && rect.top >= outer.top + margin && rect.bottom <= outer.bottom - margin;
}

function overlaps(outer, rect) {
  return rect.width > 1 && rect.height > 1
    && rect.right > outer.left && rect.left < outer.right
    && rect.bottom > outer.top && rect.top < outer.bottom;
}

function scaleOf(canvas) {
  return Number.parseFloat(canvas.style.getPropertyValue('--wb-zoom'));
}

function stageClassNames(stage) {
  return STAGE_CLASSES.filter((name) => stage.classList.contains(name));
}

function selectedAnchors() {
  return [...document.querySelectorAll('.wb-card.is-selected')].map((card) => card.dataset.anchor);
}

function menuOpen() {
  return Boolean(document.querySelector('.wb-menu'));
}

function worldRecord(app, path) {
  return app?.state?.world?.[path] ?? null;
}

function relationCount(app, path) {
  return Object.keys(worldRecord(app, path)?.relations ?? {}).length;
}

/** Every card in a group, including the members of its child groups. */
function groupMembers(app, path, groupId) {
  const groups = worldRecord(app, path)?.groups ?? {};
  const members = new Set();
  const visit = (id) => {
    const group = groups[id];
    if (!group) return;
    for (const anchor of group.members ?? []) members.add(anchor);
    for (const child of group.children ?? []) visit(child);
  };
  visit(groupId);
  return members;
}

/** A point on the stage where the background, not a card, takes the press. */
function blankPoint(stage) {
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
async function panBy(stage, dx, dy) {
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
async function bringCentreIntoView(stage, element, margin = 12) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
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

/** Pan just far enough for an element to sit wholly inside the stage. */
async function bringIntoView(stage, element, margin = 10) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const s = stage.getBoundingClientRect();
    const r = element.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) return false;
    if (inside(s, r, margin)) return true;
    const dx = r.left < s.left + margin ? (s.left + margin) - r.left
      : r.right > s.right - margin ? (s.right - margin) - r.right : 0;
    const dy = r.top < s.top + margin ? (s.top + margin) - r.top
      : r.bottom > s.bottom - margin ? (s.bottom - margin) - r.bottom : 0;
    if (!dx && !dy) return false;
    if (!(await panBy(stage, dx, dy))) return false;
  }
  const s = stage.getBoundingClientRect();
  return inside(s, element.getBoundingClientRect(), 0);
}

/**
 * Wait until the canvas shows the zoom the last wheel asked for. The panel
 * applies a wheel on the next frame, so on a heavy canvas (a thousand cards)
 * a fixed wait would read the previous scale and send another full step on top
 * of it — several steps compounding into one runaway zoom past the limits.
 */
async function settleZoom(canvas, from, timeout = 1500) {
  const until = performance.now() + timeout;
  while (performance.now() < until) {
    const now = scaleOf(canvas);
    if (Number.isFinite(now) && now !== from) return now;
    await wait(10);
  }
  return scaleOf(canvas);
}

/** Wheel the canvas to a scale, keeping one screen point still. */
async function zoomTo(stage, canvas, target, anchor) {
  const point = anchor ?? blankPoint(stage) ?? centreOf(stage.getBoundingClientRect());
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const current = scaleOf(canvas);
    if (!Number.isFinite(current)) return current;
    if (Math.abs(current - target) <= ZOOM_TOLERANCE) return current;
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

/** A card the checks may press: visible, and not one that refuses a grab. */
function pressableCards(stage) {
  const s = stage.getBoundingClientRect();
  return [...stage.querySelectorAll('.wb-card')]
    .filter((card) => !card.classList.contains('is-locked')
      && !card.classList.contains('is-frozen')
      && !card.classList.contains('is-pinned'))
    .map((card) => ({ card, rect: card.getBoundingClientRect() }))
    .filter(({ rect }) => overlaps(s, rect));
}

/** The pressable card nearest the middle of the stage, its centre on stage. */
async function pickCard(stage, target = '.wb-card') {
  const centre = centreOf(stage.getBoundingClientRect());
  const candidates = pressableCards(stage)
    .sort((a, b) => {
      const da = Math.hypot(centreOf(a.rect).x - centre.x, centreOf(a.rect).y - centre.y);
      const db = Math.hypot(centreOf(b.rect).x - centre.x, centreOf(b.rect).y - centre.y);
      return da - db;
    });
  for (const { card } of candidates) {
    if (!(await bringCentreIntoView(stage, card))) continue;
    const targetEl = target === '.wb-card' ? card : card.querySelector(target);
    if (!targetEl) continue;
    const point = centreOf(targetEl.getBoundingClientRect());
    const bounds = stage.getBoundingClientRect();
    if (point.x < bounds.left || point.x > bounds.right || point.y < bounds.top || point.y > bounds.bottom) continue;
    const hit = document.elementFromPoint(point.x, point.y);
    if (hit && targetEl.contains(hit) && hit.closest('.wb-card') === card) return card;
  }
  return null;
}

/** The first group chrome with a port that can be brought onto the screen. */
async function pickGroupChrome(stage) {
  const chrome = [...stage.querySelectorAll('.wb-group-tab, .wb-group-summary')]
    .filter((element) => element.querySelector('.wb-link-handle'));
  const centre = centreOf(stage.getBoundingClientRect());
  const sorted = chrome.sort((a, b) => {
    const ra = a.getBoundingClientRect();
    const rb = b.getBoundingClientRect();
    const da = Math.hypot(centreOf(ra).x - centre.x, centreOf(ra).y - centre.y);
    const db = Math.hypot(centreOf(rb).x - centre.x, centreOf(rb).y - centre.y);
    return da - db;
  });
  for (const element of sorted) {
    if (!(await bringIntoView(stage, element))) continue;
    const handle = element.querySelector('.wb-link-handle');
    if (!handle) continue;
    const point = centreOf(handle.getBoundingClientRect());
    const bounds = stage.getBoundingClientRect();
    if (point.x < bounds.left || point.x > bounds.right || point.y < bounds.top || point.y > bounds.bottom) continue;
    const hit = document.elementFromPoint(point.x, point.y);
    if (hit && handle.contains(hit)) return element;
  }
  return null;
}

function clearSelection(stage) {
  const inspectorClear = [...document.querySelectorAll('.wb-inspector button')]
    .find((button) => button.title === 'Clear the selection and close the inspector');
  if (inspectorClear) {
    inspectorClear.click();
    return;
  }
  const point = blankPoint(stage);
  if (!point) return;
  fire(stage, 'pointerdown', point.x, point.y, 1, { shiftKey: true });
  fire(window, 'pointerup', point.x, point.y, 0);
}

async function record(results, name, run) {
  try {
    const detail = await run();
    if (detail?.skip) results.push({ name, status: 'skip', detail: detail.skip });
    else results.push({ name, status: 'pass', detail: detail?.detail ?? '' });
  } catch (error) {
    results.push({ name, status: 'fail', detail: error?.message ?? String(error) });
  }
}

async function checkMode(stage, canvas, target) {
  const scale = await zoomTo(stage, canvas, target);
  if (Math.abs(scale - target) > ZOOM_TOLERANCE) {
    fail(`wheel landed at ${scale} instead of ${target}`);
  }
  const mode = zoomMode(scale);
  const classes = stageClassNames(stage);
  const expected = STAGE_CLASSES.filter((name) => mode.classes[name]);
  if (!sameSet(classes, expected)) {
    fail(`stage classes ${classes.join(' ') || '(none)'} do not match ${mode.label}: ${expected.join(' ') || '(none)'}`);
  }
  const badge = document.querySelector('.wb-zoom-hud-value')?.textContent ?? '';
  if (badge !== mode.label) fail(`badge reads ${badge} at scale ${scale}, expected ${mode.label}`);
  return `at ${mode.label}: classes ${classes.join(' ') || '(none)'}`;
}

async function checkRing(stage, app, path) {
  clearSelection(stage);
  const card = await pickCard(stage, '.wb-link-handle');
  if (!card) return { skip: 'no exposed card port could be brought into view' };
  const handle = card.querySelector('.wb-link-handle');
  if (!handle) fail(`${card.dataset.anchor} has no link port`);
  if (!(await bringIntoView(stage, handle, 2))) fail('the link port is outside the stage');
  const point = centreOf(handle.getBoundingClientRect());
  const hit = document.elementFromPoint(point.x, point.y);
  if (!hit || !handle.contains(hit)) fail(`the port is covered by ${describe(hit)}`);
  clearSelection(stage);
  const relations = relationCount(app, path);
  clickAt(hit, point.x, point.y);
  await wait(30);
  if (menuOpen()) fail('the click opened the relationship chooser instead of selecting');
  if (stage.classList.contains('is-linking')) fail('the click started a forge drag');
  if (relationCount(app, path) !== relations) fail('the click changed the canvas relationships');
  const picked = selectedAnchors();
  if (!sameSet(picked, [card.dataset.anchor])) {
    fail(`clicking the port selected ${picked.join(', ') || 'nothing'} instead of ${card.dataset.anchor}`);
  }
  return { detail: `${card.dataset.anchor} port selected it` };
}

async function checkCentre(stage, mode) {
  clearSelection(stage);
  const card = await pickCard(stage);
  if (!card) return { skip: 'no exposed card centre could be brought into view' };
  const anchor = card.dataset.anchor;
  const point = centreOf(card.getBoundingClientRect());
  const bounds = stage.getBoundingClientRect();
  if (point.x < bounds.left || point.x > bounds.right || point.y < bounds.top || point.y > bounds.bottom) {
    return { skip: `${anchor} centre is off stage` };
  }
  const hit = document.elementFromPoint(point.x, point.y);
  const owner = hit?.closest?.('.wb-card');
  if (!owner) fail(`the card centre is covered by ${describe(hit)}`);
  if (owner !== card) fail(`the card centre belongs to ${owner.dataset.anchor}, not ${anchor}`);
  clearSelection(stage);
  clickAt(hit, point.x, point.y);
  await wait(40);
  if (mode.detail) {
    // Above 75% the centre is the card's own prose: a press edits it rather
    // than selecting the card, and that editor is what must take the click.
    const editor = card.querySelector('textarea:not(.hidden)');
    if (!editor) fail('clicking the card centre did not open its body editor');
    if (document.activeElement !== editor) fail('the body editor did not take focus');
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await wait(30);
    return { detail: `${anchor} centre opened its editor` };
  }
  const picked = selectedAnchors();
  if (!sameSet(picked, [anchor])) {
    fail(`clicking the card centre selected ${picked.join(', ') || 'nothing'} instead of ${anchor}`);
  }
  return { detail: `${anchor} centre selected it` };
}

async function checkGroupPort(stage, app, path) {
  clearSelection(stage);
  const chrome = await pickGroupChrome(stage);
  if (!chrome) return { skip: 'no group port could be brought into view' };
  const groupId = chrome.dataset.groupId ?? chrome.closest('[data-group-id]')?.dataset.groupId;
  if (!groupId) fail(`the group port on ${describe(chrome)} has no group id`);
  const handle = chrome.querySelector('.wb-link-handle');
  if (!(await bringIntoView(stage, handle, 2))) fail('the group port is outside the stage');
  const point = centreOf(handle.getBoundingClientRect());
  const hit = document.elementFromPoint(point.x, point.y);
  if (!hit || !handle.contains(hit)) fail(`the group port is covered by ${describe(hit)}`);
  const expected = groupMembers(app, path, groupId);
  if (expected.size < 2) fail(`group ${groupId} has ${expected.size} members to select`);
  clearSelection(stage);
  const relations = relationCount(app, path);
  clickAt(hit, point.x, point.y);
  await wait(30);
  if (menuOpen()) fail('the group port click opened the relationship chooser');
  if (relationCount(app, path) !== relations) fail('the group port click changed the canvas relationships');
  // The canvas virtualises offscreen cards, so only a subset of a large
  // group's selected cards may have DOM nodes. The inspector summarizes the
  // whole model selection and identifies an exact group selection by name.
  const summary = document.querySelector('.wb-inspector-summary');
  const heading = summary?.querySelector('strong')?.textContent ?? '';
  const details = summary?.querySelector('span')?.textContent ?? '';
  const groupName = worldRecord(app, path)?.groups?.[groupId]?.name || 'Group';
  if (heading !== `Group “${groupName}”`) {
    fail(`the group port opened “${heading || 'no inspector summary'}”, expected Group “${groupName}”`);
  }
  if (!details.startsWith(`${expected.size} card`)) {
    fail(`the group inspector counts “${details}”, expected ${expected.size} cards`);
  }
  return { detail: `group port selected all ${expected.size} cards` };
}

/**
 * Run every check and return `{ ok, results }`. Safe to call again: it reads
 * the live canvas each time and leaves the view at its original scale.
 */
export async function runZoomSmoke() {
  const app = globalThis.macusanite;
  const results = [];
  const navigatorWasHidden = document.body.classList.contains('hide-canvas-navigator');
  document.body.classList.add('hide-canvas-navigator');
  const restoreNavigator = () => {
    document.body.classList.toggle('hide-canvas-navigator', navigatorWasHidden);
  };
  const stage = document.querySelector('.wb-stage');
  const canvas = document.querySelector('.wb-canvas');
  if (!app || !stage || !canvas) {
    results.push({ name: 'setup', status: 'fail', detail: 'the worldbuilding panel is not on the page' });
    restoreNavigator();
    return finish(results);
  }

  if (!app.state?.current) {
    try {
      await app.openPath('Home.md');
    } catch {
      results.push({ name: 'setup', status: 'fail', detail: 'no vein is open and Home.md could not be opened' });
      restoreNavigator();
      return finish(results);
    }
  }
  if (app.state.ui.mode !== 'world') app.setMode('world');
  await wait(150);
  if (!stage.offsetWidth) {
    results.push({ name: 'setup', status: 'fail', detail: 'the canvas is not visible' });
    restoreNavigator();
    return finish(results);
  }

  const path = app.state.current.path;
  const original = scaleOf(canvas);
  const startView = { s: original };

  for (const zoom of ZOOMS) {
    let mode = zoomMode(zoom);
    await record(results, `mode at ${mode.label}`, async () => {
      const detail = await checkMode(stage, canvas, zoom);
      mode = zoomMode(scaleOf(canvas));
      return { detail };
    });
    await record(results, `ring click at ${mode.label}`, () => checkRing(stage, app, path));
    await record(results, `card centre at ${mode.label}`, () => checkCentre(stage, mode));
    await record(results, `group port at ${mode.label}`, () => checkGroupPort(stage, app, path));
  }

  clearSelection(stage);
  await zoomTo(stage, canvas, startView.s);
  restoreNavigator();
  return finish(results);
}

function finish(results) {
  const failures = results.filter((result) => result.status === 'fail');
  const passes = results.filter((result) => result.status === 'pass');
  const summary = {
    ok: failures.length === 0 && passes.length > 0,
    passed: passes.length,
    failed: failures.length,
    skipped: results.filter((result) => result.status === 'skip').length,
    results,
  };
  globalThis.wbZoomSmoke = summary;
  if (globalThis.console?.table) console.table(results);
  document.title = `${summary.ok ? '✓' : '✗'} zoom smoke — ${summary.passed}/${results.length} passed`;
  return summary;
}
