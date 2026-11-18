/**
 * Harness regression for a marquee that never sees its pointerup.
 *
 * A Shift+drag opens a selection box and silences selection announcements
 * while it runs, so a sweep of forty cards does not read forty messages. The
 * browser can end that gesture without a release — the window loses focus, the
 * pointer is cancelled, or the pointer capture is lost — and each of those
 * paths must close the box and hand announcements back. If one is missed, the
 * box stays painted over the canvas and every later selection is silent.
 *
 * Run it against the harness:
 *
 *   npm run harness
 *   open http://127.0.0.1:1421/?wb-smoke=marquee
 *
 * The first visit seeds the fixture vein and reloads; the second runs it. The
 * results also land on `globalThis.wbMarqueeSmoke` and in the console, and the
 * page title reports the run.
 */
import {
  cardFor, fail, fire, fitAllCards, harnessPhase, intersects, record, reloadForRunPhase,
  reportSmoke, sameSet, seedHarnessVault, selectedAnchors, wait,
} from './kit.js';

const HARNESS_PATH = 'Marquee Cancellation.md';

/** The 2x2 block the box gathers. */
const SWEPT = ['one', 'two', 'three', 'four'];
/** Cards beyond the box's gutter: the sweep must never reach them. */
const OUTSIDE = ['five', 'six'];
const TITLE_ANCHOR = 'marquee-cancellation';

const TITLES = {
  'marquee-cancellation': 'Marquee Cancellation',
  one: 'One',
  two: 'Two',
  three: 'Three',
  four: 'Four',
  five: 'Five',
  six: 'Six',
};

function list(anchors) {
  return anchors.length ? anchors.join(', ') : 'nothing';
}

/** The marquee's own chrome: the box the reader sees, and the count it shows. */
function marqueeBox() {
  const box = document.querySelector('.wb-marquee');
  if (!box) return null;
  return {
    open: !box.classList.contains('hidden'),
    count: box.querySelector('.wb-marquee-count')?.textContent ?? '',
    rect: box.getBoundingClientRect(),
  };
}

/** What a screen reader would hear next; the panel writes it after 40ms. */
function liveText() {
  return document.querySelector('.wb-live')?.textContent ?? '';
}

/**
 * The fixture: six cards in three rows, four of them a 2x2 block with a wide
 * gutter to the last two, and the vein's own title card below the lot. No
 * groups, so the count the box shows and the sentence it announces are plain.
 */
export function marqueeVaultFiles() {
  const order = ['marquee-cancellation', ...SWEPT, ...OUTSIDE];
  const lines = [];
  for (const anchor of order) {
    lines.push(`${anchor === TITLE_ANCHOR ? '#' : '##'} ${TITLES[anchor]}`, '', `${TITLES[anchor]} sits on the canvas for the sweep to gather or leave.`, '');
  }
  const positions = {
    'marquee-cancellation': { x: 1040, y: 840 },
    one: { x: 40, y: 40 },
    two: { x: 480, y: 40 },
    three: { x: 40, y: 440 },
    four: { x: 480, y: 440 },
    five: { x: 1040, y: 40 },
    six: { x: 1040, y: 440 },
  };
  return {
    path: HARNESS_PATH,
    body: lines.join('\n'),
    record: {
      marked: true,
      positions,
      groups: {},
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
      cardDims: {},
      stack: [],
      collapsedGroups: {},
      annotations: {},
      view: { x: 0, y: 0, s: 1 },
    },
  };
}

/**
 * A box round the four swept cards that no other card touches. The rectangle
 * is drawn from the card rects the browser reports, so it is the same box the
 * reader sees, whatever the camera is doing.
 */
function boxAround(stage) {
  const stageRect = stage.getBoundingClientRect();
  const rects = SWEPT.map((anchor) => cardFor(anchor)?.getBoundingClientRect());
  if (rects.some((rect) => !rect || rect.width < 2 || rect.height < 2)) {
    fail('a swept card is not on the canvas');
  }
  const union = {
    left: Math.min(...rects.map((rect) => rect.left)),
    top: Math.min(...rects.map((rect) => rect.top)),
    right: Math.max(...rects.map((rect) => rect.right)),
    bottom: Math.max(...rects.map((rect) => rect.bottom)),
  };
  const outsiderRects = [...OUTSIDE, TITLE_ANCHOR].map((anchor) => cardFor(anchor)?.getBoundingClientRect());
  for (const margin of [12, 18, 26, 36, 48, 62, 78]) {
    const box = {
      left: union.left - margin,
      top: union.top - margin,
      right: union.right + margin,
      bottom: union.bottom + margin,
    };
    if (box.left < stageRect.left + 2 || box.top < stageRect.top + 2) continue;
    if (box.right > stageRect.right - 2 || box.bottom > stageRect.bottom - 2) continue;
    if (outsiderRects.some((rect) => rect && intersects(rect, box))) continue;
    return box;
  }
  fail('no marquee box fits round the four cards without touching another card');
}

/**
 * Start the sweep and drag it open over the four cards, leaving the gesture
 * live: no pointerup follows, which is the whole point.
 */
async function openSweep(stage) {
  const box = boxAround(stage);
  fire(stage, 'pointerdown', box.left, box.top, 1, { shiftKey: true });
  fire(window, 'pointermove', (box.left + box.right) / 2, (box.top + box.bottom) / 2, 1);
  fire(window, 'pointermove', box.right, box.bottom, 1);
  await wait(80);
  return box;
}

/** A Shift+click on the background: a marquee that moves nowhere, so it clears. */
async function clearSelection(stage) {
  const box = boxAround(stage);
  fire(stage, 'pointerdown', box.left, box.top, 1, { shiftKey: true });
  fire(window, 'pointerup', box.left, box.top, 0);
  await wait(140);
}

/** Clear, sweep, cancel through one path, and read the canvas back. */
async function checkCancelPath(stage, results, name, cancel) {
  await record(results, `${name} closes the box and resumes announcements`, async () => {
    await clearSelection(stage);
    const before = marqueeBox();
    if (!before) fail('the canvas has no marquee box');
    if (before.open) fail('the marquee box was open before the sweep began');
    if (selectedAnchors().length) fail('the selection was not cleared before the sweep');
    if (liveText() !== 'Selection cleared') fail(`the live region reads “${liveText()}” after clearing`);

    await openSweep(stage);
    const running = marqueeBox();
    if (!running?.open) fail('the box did not open over the sweep');
    if (running.rect.width < 8 || running.rect.height < 8) fail('the box has no size');
    if (running.count !== `${SWEPT.length} cards`) fail(`the box counts “${running.count}”`);
    const swept = selectedAnchors();
    if (!sameSet(swept, SWEPT)) fail(`the sweep selected ${list(swept)} instead of ${list(SWEPT)}`);
    // The drag is quiet: the reader hears nothing until the gesture ends.
    if (liveText() !== 'Selection cleared') fail(`the live region changed mid-drag: “${liveText()}”`);

    cancel();
    await wait(160);
    const closed = marqueeBox();
    if (!closed) fail('the marquee box left the page');
    if (closed.open) fail(`the ${name} left the box open`);
    if (closed.count) fail(`the ${name} left “${closed.count}” in the box`);
    const kept = selectedAnchors();
    if (!sameSet(kept, SWEPT)) fail(`the ${name} kept ${list(kept)} instead of ${list(SWEPT)}`);
    if (liveText() !== `${SWEPT.length} cards selected`) {
      fail(`the ${name} left the live region at “${liveText()}”`);
    }

    // And the next selection is heard normally, not swallowed by a stuck gate.
    await clearSelection(stage);
    if (selectedAnchors().length) fail('the selection did not clear after the cancelled sweep');
    if (liveText() !== 'Selection cleared') fail(`announcements did not resume: “${liveText()}”`);
    return { detail: `box closed, “${SWEPT.length} cards selected”, then “Selection cleared”` };
  });
}

const PATHS = [
  ['Window blur', () => {
    window.dispatchEvent(new Event('blur'));
  }],
  ['Pointer cancel', () => {
    const stage = document.querySelector('.wb-stage');
    const box = stage?.getBoundingClientRect();
    if (box) fire(stage, 'pointercancel', box.right - 6, box.bottom - 6, 0);
  }],
  ['Lost pointer capture', () => {
    const stage = document.querySelector('.wb-stage');
    // The panel listens in the capture phase because the event does not bubble.
    stage?.dispatchEvent(new PointerEvent('lostpointercapture', {
      bubbles: false, cancelable: false, composed: true, pointerId: 1,
    }));
  }],
];

async function runPaths(results) {
  const stage = document.querySelector('.wb-stage');
  if (!stage || !stage.offsetWidth) {
    results.push({ name: 'setup', status: 'fail', detail: 'the canvas is not visible' });
    return;
  }
  await record(results, 'the fixture is on the canvas', async () => {
    await fitAllCards(stage, [TITLE_ANCHOR, ...SWEPT, ...OUTSIDE]);
    const anchors = [TITLE_ANCHOR, ...SWEPT, ...OUTSIDE];
    const missing = anchors.filter((anchor) => !cardFor(anchor));
    if (missing.length) fail(`the canvas is missing ${list(missing)}`);
    return { detail: `${anchors.length} cards in view` };
  });
  for (const [name, cancel] of PATHS) await checkCancelPath(stage, results, name, cancel);
  await record(results, 'the canvas is left clean', async () => {
    const box = marqueeBox();
    if (box?.open) fail('the marquee box is still open');
    if (selectedAnchors().length) fail('a selection was left behind');
    return { detail: 'no box, no selection' };
  });
}

/** Seed on the first visit and reload so the vault is read fresh, then run. */
export async function runMarqueeSmoke(search = globalThis.location?.search ?? '') {
  if (!import.meta.env.DEV) return null;
  const params = new URLSearchParams(search);
  if (params.get('wb-smoke') !== 'marquee') return null;
  const app = globalThis.macusanite;
  if (!app) return null;

  if (harnessPhase(search) === 'seed') {
    const error = seedHarnessVault(marqueeVaultFiles());
    if (error) return reportSmoke('marquee smoke', 'wbMarqueeSmoke', [{ name: 'setup', status: 'fail', detail: error }]);
    reloadForRunPhase();
    return null;
  }

  const results = [];
  try {
    await app.openPath(HARNESS_PATH);
    if (app.state.ui.mode !== 'world') app.setMode('world');
    await wait(150);
  } catch (error) {
    results.push({ name: 'setup', status: 'fail', detail: `the fixture vein could not be opened: ${error?.message ?? error}` });
    return reportSmoke('marquee smoke', 'wbMarqueeSmoke', results);
  }
  await runPaths(results);
  return reportSmoke('marquee smoke', 'wbMarqueeSmoke', results);
}
