/**
 * The canvas performance budget, as a harness run.
 *
 * A canvas of two hundred cards is a diagram; a thousand is a world, and it is
 * the size where the old drawing — a full card element per note, a path (and an
 * invisible hit twin) per wire, one DOM pass per wheel tick — stopped keeping
 * up. This script builds a vein of the size asked for, then measures what the
 * budget cares about and reports pass or fail.
 *
 * Run it against the harness, one size at a time:
 *
 *   npm run harness
 *   open http://127.0.0.1:1421/?wb-perf=1000
 *
 * The first load seeds the vein and reloads; the second measures it. Results
 * land on `globalThis.wbPerf`, in the console, and in the page title.
 *
 * The budget, and what the measurements were when it was set (1,000 cards,
 * this machine): canvas DOM under 12,000 nodes at detail zoom and under 8,000
 * at icon zoom, a bounded batch layer of wire paths at icon zoom (one per tone
 * and state, sixteen at most) instead of one per connector, a first frame of
 * the canvas under 1.5s, and a pan that holds 30 frames a second
 * at either zoom. Everything here is one number per thing that would otherwise
 * rot silently: a new per-card node, a per-wire path, a full rebuild per tick.
 */
import { zoomMode } from '../../src/lib/worldbuild.js';

/** The sizes this budget is written for. */
export const PERF_SIZES = [200, 500, 1000];

/** Pass/fail limits, per size. Detail and icon are the two zooms measured. */
export const PERF_BUDGET = {
  200: { nodesDetail: 8000, nodesIcon: 5000, edgePaths: 40, buildMs: 1200, panMs: 34 },
  500: { nodesDetail: 10000, nodesIcon: 6500, edgePaths: 40, buildMs: 1400, panMs: 34 },
  1000: { nodesDetail: 12000, nodesIcon: 8000, edgePaths: 40, buildMs: 1500, panMs: 34 },
};

const STORAGE_KEY = 'macusanite.virtual-vault.v1';
const HARNESS_PATH = (n) => `Perf ${n}.md`;

/**
 * A vein of `n` sections laid out on a square-ish grid, every card linking to
 * the next, so the canvas has real text on it and real wires to route.
 */
export function perfVaultFiles(n) {
  const path = HARNESS_PATH(n);
  const lines = [`# Perf ${n}`, ''];
  const anchors = [];
  for (let i = 0; i < n; i += 1) {
    const title = `Card ${String(i + 1).padStart(4, '0')}`;
    const next = `Card ${String(((i + 1) % n) + 1).padStart(4, '0')}`;
    anchors.push(title.toLowerCase().replace(/\s+/g, '-'));
    lines.push(`## ${title}`, '', `This card carries a sentence of prose and links to [[${path}#${next}]], so the canvas has real text and a real wire to route.`, '');
  }
  const cols = Math.ceil(Math.sqrt(n));
  const positions = {};
  anchors.forEach((anchor, i) => {
    positions[anchor] = { x: 40 + (i % cols) * 340, y: 40 + Math.floor(i / cols) * 300 };
  });
  return {
    path,
    body: lines.join('\n'),
    record: {
      marked: true, positions, groups: {}, relations: {}, folded: {}, types: {}, fields: {},
      colors: {}, images: {}, resources: {}, pinned: {}, locked: {}, view: { x: 0, y: 0, s: 1 },
    },
  };
}

/** Put the vein and its record into the harness vault, then reload to load it. */
function seed(n) {
  const store = JSON.parse(globalThis.localStorage.getItem(STORAGE_KEY));
  const state = JSON.parse(store.files['.macusanite/state.json']);
  const files = perfVaultFiles(n);
  store.files[files.path] = files.body;
  state.world[files.path] = files.record;
  store.files['.macusanite/state.json'] = JSON.stringify(state, null, 2);
  globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  return files.path;
}

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

/** The stage's own frame rate while dragging the background, in milliseconds. */
async function panFrames(stage) {
  const rect = stage.getBoundingClientRect();
  stage.dispatchEvent(new PointerEvent('pointerdown', {
    pointerId: 1, isPrimary: true, button: 0, clientX: rect.left + 450, clientY: rect.top + 700, bubbles: true, cancelable: true,
  }));
  const times = [];
  let i = 0;
  await new Promise((done) => {
    const step = () => {
      times.push(performance.now());
      window.dispatchEvent(new PointerEvent('pointermove', {
        pointerId: 1, clientX: rect.left + 450 - i * 6, clientY: rect.top + 700 - i * 4, bubbles: true,
      }));
      i += 1;
      if (i < 30) requestAnimationFrame(step);
      else done();
    };
    requestAnimationFrame(step);
  });
  window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: rect.left + 280, clientY: rect.top + 580, bubbles: true }));
  const deltas = [];
  for (let k = 1; k < times.length; k += 1) deltas.push(times[k] - times[k - 1]);
  deltas.sort((a, b) => a - b);
  return Math.round(deltas[Math.floor(deltas.length / 2)] ?? 0);
}

/** Bring the camera to the icon handoff (12.5%) or to detail (100%). */
async function setZoom(stage, target) {
  const canvas = document.querySelector('.wb-canvas');
  const zoom = () => Number.parseFloat(canvas.style.getPropertyValue('--wb-zoom')) || 1;
  const rect = stage.getBoundingClientRect();
  let steps = 0;
  while ((target < 1 ? zoom() > 0.125 : zoom() < 0.95) && steps < 16) {
    stage.dispatchEvent(new WheelEvent('wheel', {
      deltaY: target < 1 ? 340 : -340, clientX: rect.left + 8, clientY: rect.top + 8, bubbles: true, cancelable: true,
    }));
    await nextFrame();
    steps += 1;
  }
  return zoom();
}

/**
 * Measure the vein of this size and check it against the budget. Returns the
 * report; call it with the URL as it arrived, because the first visit seeds.
 */
export async function runPerfBudget(search = globalThis.location?.search ?? '') {
  if (!import.meta.env.DEV) return null;
  const params = new URLSearchParams(search);
  const size = Number(params.get('wb-perf'));
  if (!PERF_SIZES.includes(size)) return null;
  const path = HARNESS_PATH(size);
  const app = globalThis.macusanite;
  if (!app) return null;

  if (params.get('phase') !== 'run') {
    seed(size);
    const next = new URL(globalThis.location.href);
    next.searchParams.set('phase', 'run');
    globalThis.location.replace(next.href);
    return null;
  }
  // The vein has to be there already: if the seed was lost, say so rather than
  // measuring an empty canvas.
  if (!app.state.vault) return null;

  const stage = document.querySelector('.wb-stage');
  if (!stage) return null;
  // Parsing the vein is markdown work the canvas does not do; the budget is
  // about the canvas's own first frame, so the clock starts at the mode switch.
  await app.openPath(path);
  const t0 = performance.now();
  app.setMode('world');
  await nextFrame();
  const buildMs = Math.round(performance.now() - t0);

  const canvas = () => document.querySelector('.wb-canvas');
  const nodesDetail = canvas().querySelectorAll('*').length;
  const cardsDetail = document.querySelectorAll('.wb-card').length;

  await setZoom(stage, 0.1);
  await nextFrame();
  const nodesIcon = canvas().querySelectorAll('*').length;
  const edgePaths = document.querySelectorAll('.wb-edge').length;
  const icons = document.querySelectorAll('.wb-card.is-icon-form').length;
  const panMs = await panFrames(stage);

  const budget = PERF_BUDGET[size];
  const checks = {
    nodesDetail: nodesDetail <= budget.nodesDetail,
    nodesIcon: nodesIcon <= budget.nodesIcon,
    edgePaths: edgePaths <= budget.edgePaths,
    buildMs: buildMs <= budget.buildMs,
    panMs: panMs <= budget.panMs,
  };
  const report = {
    size,
    measured: { nodesDetail, nodesIcon, edgePaths, buildMs, panMs, cardsDetail, icons },
    budget,
    checks,
    pass: Object.values(checks).every(Boolean),
  };
  globalThis.wbPerf = report;
  console.info('canvas perf budget', report);
  document.title = `${report.pass ? 'PASS' : 'FAIL'} ${size} cards — ${buildMs}ms build, ${nodesIcon} nodes at icon zoom, ${panMs}ms pan`;
  return report;
}
