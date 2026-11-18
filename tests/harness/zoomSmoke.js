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
 * The first visit seeds a compact fixture vein and reloads; the second runs
 * it. The fixture is three narrow cards — two of them a group — laid out for a
 * phone-width stage: at 100% a full 300px card's port sits further from its
 * centre than half a 288px stage, so on the sample vault the 100% port checks
 * could only skip. Here the card port and the group port both land on stage
 * without a pan, and tablet gestures (Settings → Worldbuilding) only enlarge
 * the targets they hit.
 *
 * The results also land on `globalThis.wbZoomSmoke` and in the console, and
 * the page title reports the run.
 */
import { zoomMode } from '../../src/lib/worldbuild.js';
import {
  blankPoint, bringCentreIntoView, bringIntoView, cardFor, centreOf, clickAt, fail, fire,
  harnessPhase, overlaps, record, reloadForRunPhase, reportSmoke, sameSet, scaleOf,
  seedHarnessVault, selectedAnchors, wait, zoomTo,
} from './kit.js';

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

const FIXTURE_PATH = 'Zoom Targets.md';
/** The three cards the checks press, top to bottom. */
const FIXTURE_CARDS = ['kite', 'lamp', 'mast'];
/** The group the group-port check selects, and the cards in it. */
const FIXTURE_GROUP = 'g-pair';

/**
 * The fixture the zoom checks aim at: narrow cards in one column near the
 * canvas origin, and a group of two whose tab sits in the gap above them.
 *
 * The card dimensions are the point: narrower than a phone-width stage, so a
 * card and the port at the far end of its head both fit at 100% — a default
 * 300px card is wider than the 288px stage a 480px window leaves, which is why
 * the sample vault's 100% port checks could only skip — and tall enough that
 * the card's centre is clear of the fold toggle at 20%, which stays a screen
 * size while the card shrinks. 220px also leaves the head room for the 24px
 * tablet port, which a minimum-width card pushes past its own edge.
 * The cards run down one column with a gap between them, so no two centres
 * land on one another at any zoom, and the group tab sits in the gap above its
 * cards rather than beside a port.
 */
export function zoomVaultFiles() {
  const order = ['zoom-targets', ...FIXTURE_CARDS];
  const titles = { 'zoom-targets': 'Zoom Targets', kite: 'Kite', lamp: 'Lamp', mast: 'Mast' };
  const lines = [];
  for (const anchor of order) {
    lines.push(`${anchor === 'zoom-targets' ? '#' : '##'} ${titles[anchor]}`, '',
      `${titles[anchor]} sits on the canvas for the zoom checks to press.`, '');
  }
  const dims = Object.fromEntries(order.map((anchor) => [anchor, { width: 220, height: 300 }]));
  return {
    path: FIXTURE_PATH,
    body: lines.join('\n'),
    record: {
      marked: true,
      positions: {
        // One column with a 20px gap between cards, and the title below the
        // fold: at 100% the first card and the group's tab share the stage.
        'zoom-targets': { x: 24, y: 1000 },
        kite: { x: 24, y: 8 },
        lamp: { x: 24, y: 336 },
        mast: { x: 24, y: 664 },
      },
      cardDims: dims,
      groups: {
        [FIXTURE_GROUP]: {
          id: FIXTURE_GROUP,
          name: 'Pair',
          color: '#d29922',
          members: ['lamp', 'mast'],
          children: [],
        },
      },
      relations: {},
      bondNotes: {},
      folded: {},
      types: {},
      fields: {},
      colors: {},
      images: {},
      resources: {},
      pinned: {},
      locked: {},
      cardModes: {},
      cardSizes: {},
      stack: [],
      collapsedGroups: {},
      annotations: {},
      // A known camera at 100%: the canvas origin is the stage's top-left.
      view: { x: 0, y: 0, s: 1 },
    },
  };
}

function describe(element) {
  if (!element) return 'nothing';
  const raw = element.className;
  const cls = typeof raw === 'string' ? raw : raw?.baseVal ?? '';
  const name = element.tagName ? element.tagName.toLowerCase() : 'node';
  return `<${name}${cls ? `.${cls.trim().split(/\s+/).filter(Boolean).join('.')}` : ''}>`;
}

function stageClassNames(stage) {
  return STAGE_CLASSES.filter((name) => stage.classList.contains(name));
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
    const anchor = card.dataset.anchor;
    if (!(await bringCentreIntoView(stage, card))) continue;
    // A pan rebuilds the card window, so read the card again rather than
    // holding the element that was panned.
    const fresh = cardFor(anchor, stage) ?? card;
    const targetEl = target === '.wb-card' ? fresh : fresh.querySelector(target);
    if (!targetEl) continue;
    const point = centreOf(targetEl.getBoundingClientRect());
    const bounds = stage.getBoundingClientRect();
    if (point.x < bounds.left || point.x > bounds.right || point.y < bounds.top || point.y > bounds.bottom) continue;
    const hit = document.elementFromPoint(point.x, point.y);
    if (hit && targetEl.contains(hit) && hit.closest('.wb-card') === fresh) return fresh;
  }
  return null;
}

/** The group a piece of chrome belongs to, by its tab or summary element. */
function chromeGroupId(element) {
  return element.dataset.groupId
    ?? element.closest('[data-group-id]')?.getAttribute('data-group-id')
    ?? null;
}

/** A group's chrome as it stands now, after a pan may have rebuilt the layer. */
function groupChrome(stage, id) {
  return [...stage.querySelectorAll('.wb-group-tab, .wb-group-summary')]
    .find((element) => chromeGroupId(element) === id && element.querySelector('.wb-link-handle')) ?? null;
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
    const id = chromeGroupId(element);
    // Group tabs are drawn again on every pan, so each pan is followed by a
    // fresh look at the same group rather than at the element it panned.
    const relook = () => groupChrome(stage, id);
    if (!(await bringIntoView(stage, element, 10, id ? relook : null))) continue;
    const fresh = id ? relook() : element;
    if (!fresh) continue;
    const handle = fresh.querySelector('.wb-link-handle');
    if (!handle) continue;
    const point = centreOf(handle.getBoundingClientRect());
    const bounds = stage.getBoundingClientRect();
    if (point.x < bounds.left || point.x > bounds.right || point.y < bounds.top || point.y > bounds.bottom) continue;
    const hit = document.elementFromPoint(point.x, point.y);
    if (hit && handle.contains(hit)) return fresh;
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
  const groupId = chromeGroupId(chrome);
  if (!groupId) fail(`the group port on ${describe(chrome)} has no group id`);
  const relookHandle = () => groupChrome(stage, groupId)?.querySelector('.wb-link-handle') ?? null;
  const handle = chrome.querySelector('.wb-link-handle');
  if (!(await bringIntoView(stage, handle, 2, relookHandle))) fail('the group port is outside the stage');
  // The pan may have drawn the tab again; measure the port on screen now.
  const port = relookHandle() ?? handle;
  const point = centreOf(port.getBoundingClientRect());
  const hit = document.elementFromPoint(point.x, point.y);
  if (!hit || !port.contains(hit)) fail(`the group port is covered by ${describe(hit)}`);
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
export async function runZoomSmoke(search = globalThis.location?.search ?? '') {
  if (!import.meta.env.DEV) return null;

  if (harnessPhase(search) === 'seed') {
    const error = seedHarnessVault(zoomVaultFiles());
    if (error) return reportSmoke('zoom smoke', 'wbZoomSmoke', [{ name: 'setup', status: 'fail', detail: error }]);
    reloadForRunPhase();
    return null;
  }

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
    return reportSmoke('zoom smoke', 'wbZoomSmoke', results);
  }

  try {
    await app.openPath(FIXTURE_PATH);
  } catch (error) {
    results.push({ name: 'setup', status: 'fail', detail: `the zoom fixture could not be opened: ${error?.message ?? error}` });
    restoreNavigator();
    return reportSmoke('zoom smoke', 'wbZoomSmoke', results);
  }
  if (app.state.ui.mode !== 'world') app.setMode('world');
  await wait(200);
  if (!stage.offsetWidth) {
    results.push({ name: 'setup', status: 'fail', detail: 'the canvas is not visible' });
    restoreNavigator();
    return reportSmoke('zoom smoke', 'wbZoomSmoke', results);
  }

  // The checks below skip when a target cannot be brought into view on
  // purpose; the fixture itself missing is a failure, so it is named here
  // rather than showing up as four silent skips.
  await record(results, 'the fixture is on the canvas', async () => {
    const missing = FIXTURE_CARDS.filter((anchor) => !cardFor(anchor));
    if (missing.length) fail(`the canvas is missing ${missing.join(', ')}`);
    const tab = document.querySelector('.wb-group-tab, .wb-group-summary')?.querySelector('.wb-link-handle');
    if (!tab) fail('the fixture’s group has no link port');
    return { detail: `${FIXTURE_CARDS.length} cards and a group port at ${Math.round(scaleOf(canvas) * 100)}%` };
  });

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
  return reportSmoke('zoom smoke', 'wbZoomSmoke', results);
}
