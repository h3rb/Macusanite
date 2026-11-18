/**
 * Harness smoke test for the relationship lens and its inspector.
 *
 * Unit tests can prove what `lensFocus` returns; they cannot prove that the
 * live canvas dims unrelated cards and wires, keeps the focused bonds at full
 * weight, lists the neighbours in the inspector, re-focuses after a row click,
 * or raises the kind chips at a readable size. This drives the real panel with
 * synthetic pointer and wheel input and reads the result back from the DOM.
 *
 * Run it against the harness:
 *
 *   npm run harness
 *   open http://127.0.0.1:1421/?wb-smoke=lens
 *
 * The results also land on `globalThis.wbLensSmoke` and in the console, and
 * the page title reports the run. It needs a vein open as Worldbuilding with
 * at least one card carrying an authored bond and an unrelated card.
 */
const ZOOM_TOLERANCE = 1e-4;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fail(message) {
  throw new Error(message);
}

function sameSet(a, b) {
  const left = [...a].sort();
  const right = [...b].sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function describe(element) {
  if (!element) return 'nothing';
  const raw = element.className;
  const cls = typeof raw === 'string' ? raw : raw?.baseVal ?? '';
  const name = element.tagName ? element.tagName.toLowerCase() : 'node';
  return `<${name}${cls ? `.${cls.trim().split(/\s+/).filter(Boolean).join('.')}` : ''}>`;
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

function overlaps(outer, rect) {
  return rect.width > 1 && rect.height > 1
    && rect.right > outer.left && rect.left < outer.right
    && rect.bottom > outer.top && rect.top < outer.bottom;
}

function scaleOf(canvas) {
  return Number.parseFloat(canvas.style.getPropertyValue('--wb-zoom'));
}

function selectedAnchors() {
  return [...document.querySelectorAll('.wb-card.is-selected')].map((card) => card.dataset.anchor);
}

function menuOpen() {
  return Boolean(document.querySelector('.wb-menu'));
}

function cardFor(stage, anchor) {
  return [...stage.querySelectorAll('.wb-card')]
    .find((card) => card.dataset.anchor === anchor) ?? null;
}

function cardTitle(card) {
  const title = card?.querySelector('.wb-card-title');
  return (title?.value ?? title?.textContent ?? '').trim();
}

/** A point on the stage where the background, not a card, takes the press. */
function blankPoint(stage) {
  const s = stage.getBoundingClientRect();
  const blocked = '.wb-card, .wb-group-tab, .wb-group-summary, .wb-annotation, .wb-menu, '
    + 'button, input, select, textarea, .wb-edge-label, [data-edge-key], .wb-zoom-hud, .wb-overlap-hud';
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

/** Pan just far enough for an element to sit wholly inside the stage. */
async function bringIntoView(stage, element, margin = 10) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const s = stage.getBoundingClientRect();
    const r = element.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) return false;
    const dx = r.left < s.left + margin ? (s.left + margin) - r.left
      : r.right > s.right - margin ? (s.right - margin) - r.right : 0;
    const dy = r.top < s.top + margin ? (s.top + margin) - r.top
      : r.bottom > s.bottom - margin ? (s.bottom - margin) - r.bottom : 0;
    if (!dx && !dy) return true;
    if (!(await panBy(stage, dx, dy))) return false;
  }
  const s = stage.getBoundingClientRect();
  const r = element.getBoundingClientRect();
  return r.left >= s.left && r.right <= s.right && r.top >= s.top && r.bottom <= s.bottom;
}

/** Wheel the canvas to a scale, keeping one screen point still. */
/**
 * Wait until the canvas shows the zoom the last wheel asked for. The panel
 * applies a wheel on the next frame, so on a heavy canvas a fixed wait would
 * read the previous scale and send another full step on top of it.
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

function clearSelection(stage) {
  const point = blankPoint(stage);
  if (!point) return;
  fire(stage, 'pointerdown', point.x, point.y, 1, { shiftKey: true });
  fire(window, 'pointerup', point.x, point.y, 0, { shiftKey: true });
}

/**
 * Cards that carry an authored bond and can be selected through their link
 * port, most connected first: the lens needs at least one real edge to show.
 */
function focusCandidates(stage, app, path) {
  const relations = app?.state?.world?.[path]?.relations ?? {};
  const degree = new Map();
  for (const key of Object.keys(relations)) {
    const [from, to] = String(key).split('->');
    for (const endpoint of [from, to]) {
      if (!endpoint || endpoint.startsWith('group:')) continue;
      degree.set(endpoint, (degree.get(endpoint) ?? 0) + 1);
    }
  }
  return [...stage.querySelectorAll('.wb-card')]
    .filter((card) => degree.has(card.dataset.anchor))
    .filter((card) => !card.classList.contains('is-locked'))
    .filter((card) => !card.classList.contains('is-frozen'))
    .filter((card) => !card.classList.contains('is-group-hidden'))
    .filter((card) => card.querySelector('.wb-link-handle'))
    .sort((a, b) => degree.get(b.dataset.anchor) - degree.get(a.dataset.anchor));
}

/** Select one candidate through its link port, the dependable click target. */
async function selectFocus(stage, candidates) {
  for (const card of candidates.slice(0, 8)) {
    clearSelection(stage);
    await wait(20);
    if (!(await bringCentreIntoView(stage, card))) continue;
    const handle = card.querySelector('.wb-link-handle');
    if (!handle || !(await bringIntoView(stage, handle, 2))) continue;
    const point = centreOf(handle.getBoundingClientRect());
    const hit = document.elementFromPoint(point.x, point.y);
    if (!hit || !handle.contains(hit)) continue;
    clickAt(hit, point.x, point.y);
    await wait(100);
    if (menuOpen()) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await wait(40);
      continue;
    }
    if (sameSet(selectedAnchors(), [card.dataset.anchor])) return card;
  }
  return null;
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

function focusedEdgesFor(stage, anchor) {
  return [...stage.querySelectorAll('.wb-edge.is-lens')]
    .filter((edge) => edge.dataset.from === anchor || edge.dataset.to === anchor);
}

function neighbourEndpoints(stage, anchor) {
  const out = new Set();
  for (const edge of focusedEdgesFor(stage, anchor)) {
    if (edge.dataset.from === anchor) out.add(edge.dataset.to);
    if (edge.dataset.to === anchor) out.add(edge.dataset.from);
  }
  return out;
}

async function checkDimming(stage, anchor) {
  const card = cardFor(stage, anchor);
  if (!card) fail(`the selected card ${anchor} is no longer on the canvas`);
  if (card.classList.contains('is-dimmed')) fail(`the selected card ${anchor} is dimmed`);

  const own = focusedEdgesFor(stage, anchor);
  if (!own.length) fail('none of the focused wires belongs to the selected card');
  const dimmedWires = [...stage.querySelectorAll('.wb-edge.is-dimmed')];
  if (!dimmedWires.length) fail('no unrelated wire is dimmed');

  const neighbours = neighbourEndpoints(stage, anchor);
  const dimmedCards = [...stage.querySelectorAll('.wb-card')]
    .filter((other) => other.dataset.anchor !== anchor && !neighbours.has(other.dataset.anchor))
    .filter((other) => other.classList.contains('is-dimmed'));
  if (!dimmedCards.length) fail('no unrelated card is dimmed');

  return {
    detail: `${anchor}: ${dimmedCards.length} dimmed cards and ${dimmedWires.length} dimmed wires`,
  };
}

async function checkEmphasis(stage, anchor) {
  const own = focusedEdgesFor(stage, anchor);
  if (!own.length) fail('no focused wire is drawn for the selection');
  const spine = [...stage.querySelectorAll('.wb-edge.is-lens.wb-edge-contains')];
  if (spine.length) fail('the outline spine is counted as a focused wire');
  const dimmedWires = [...stage.querySelectorAll('.wb-edge.is-dimmed')];
  if (!dimmedWires.length) return { skip: 'no unrelated wire to compare with' };
  const focusWidth = Number.parseFloat(getComputedStyle(own[0]).strokeWidth);
  const dimWidth = Number.parseFloat(getComputedStyle(dimmedWires[0]).strokeWidth);
  if (!(focusWidth > dimWidth)) {
    fail(`focused wires are ${focusWidth}px wide and dimmed wires ${dimWidth}px; the focus is not emphasised`);
  }
  return { detail: `${own.length} focused wires at ${focusWidth}px, others at ${dimWidth}px` };
}

async function checkInspector(stage, anchor) {
  const inspector = document.querySelector('.wb-inspector');
  if (!inspector || inspector.classList.contains('hidden')) fail('the inspector did not open');
  const title = inspector.querySelector('.wb-inspector-title')?.textContent?.trim() ?? '';
  if (!title) fail('the inspector has no selected-card title');
  const rows = [...inspector.querySelectorAll('.wb-inspector-link')];
  if (!rows.length) fail('the inspector lists no neighbours');
  if (rows.some((row) => !row.dataset.endpoint)) fail('an inspector row does not name its endpoint');
  if (rows.some((row) => !row.querySelector('.wb-inspector-link-name')?.textContent?.trim())) {
    fail('an inspector row has no neighbour name');
  }
  if (rows.some((row) => !row.querySelector('.wb-inspector-link-kind')?.textContent?.trim())) {
    fail('an inspector row has no kind');
  }
  const connections = [...inspector.querySelectorAll('.wb-inspector-section')]
    .find((section) => section.querySelector('.wb-inspector-section-title')?.textContent === 'Connections');
  if (!connections) fail('the inspector has no Connections section');
  const neighbours = neighbourEndpoints(stage, anchor);
  if (!rows.some((row) => neighbours.has(row.dataset.endpoint))) {
    fail('no inspector row matches a focused wire');
  }
  return { detail: `${rows.length} neighbour rows under “${title}”` };
}

async function checkJump(stage) {
  const inspector = document.querySelector('.wb-inspector');
  const rows = [...(inspector?.querySelectorAll('.wb-inspector-link') ?? [])]
    .filter((row) => row.dataset.endpoint && !row.dataset.endpoint.startsWith('group:'));
  const row = rows[0];
  if (!row) return { skip: 'the inspector has no card neighbour row to jump to' };
  const target = row.dataset.endpoint;
  if (!cardFor(stage, target)) fail(`the neighbour ${target} has no card to jump to`);

  row.click();
  await wait(150);
  // A jump can reveal a collapsed group and rebuild the card layer, so read
  // the card again after the click rather than holding the old element.
  const targetCard = cardFor(stage, target);
  if (!targetCard) fail(`the neighbour ${target} disappeared while jumping`);
  const picked = selectedAnchors();
  if (!sameSet(picked, [target])) {
    fail(`the row jumped to ${picked.join(', ') || 'nothing'} instead of ${target}`);
  }
  if (targetCard.classList.contains('is-dimmed')) fail(`the jumped-to card ${target} is dimmed`);

  const focused = [...stage.querySelectorAll('.wb-edge.is-lens')]
    .filter((edge) => edge.dataset.from === target || edge.dataset.to === target);
  if (!focused.length) fail(`the lens did not re-focus around ${target}`);

  const stageBox = stage.getBoundingClientRect();
  const point = centreOf(targetCard.getBoundingClientRect());
  if (point.x < stageBox.left || point.x > stageBox.right
    || point.y < stageBox.top || point.y > stageBox.bottom) {
    fail(`the row did not bring ${target} into view`);
  }
  const title = document.querySelector('.wb-inspector-title')?.textContent?.trim() ?? '';
  if (title && title !== cardTitle(targetCard)) {
    fail(`the inspector shows “${title}” instead of “${cardTitle(targetCard)}”`);
  }
  return { detail: `${target} selected, centred and re-focused` };
}

function lensChipState() {
  const layer = document.querySelector('.wb-lens-labels');
  const chips = layer ? [...layer.querySelectorAll('.wb-lens-label')] : [];
  return { layer, chips, hidden: !layer || layer.classList.contains('hidden') };
}

async function checkChips(stage, canvas, anchor, scale) {
  const card = cardFor(stage, anchor);
  if (!card) fail(`the focused card ${anchor} is no longer on the canvas`);
  const landed = await zoomTo(stage, canvas, scale, centreOf(card.getBoundingClientRect()));
  if (Math.abs(landed - scale) > ZOOM_TOLERANCE) fail(`the wheel landed at ${landed} instead of ${scale}`);
  await wait(180);
  const { layer, chips, hidden } = lensChipState();
  if (!layer) fail('the lens label layer is missing');
  if (hidden) fail(`kind chips are hidden at ${Math.round(scale * 100)}%`);
  if (!chips.length) fail(`no kind chips are drawn at ${Math.round(scale * 100)}%`);
  if (chips.some((chip) => !chip.textContent.trim())) fail('a kind chip has no kind');
  if (chips.some((chip) => !/\bwb-rel-/.test(chip.className))) fail('a kind chip does not name its relationship');
  const stageBox = stage.getBoundingClientRect();
  if (!chips.some((chip) => overlaps(stageBox, chip.getBoundingClientRect()))) {
    fail(`every kind chip is off stage at ${Math.round(scale * 100)}%`);
  }
  const percent = Number((scale * 100).toFixed(1));
  return { detail: `${chips.length} kind chip${chips.length === 1 ? '' : 's'} at ${percent}%` };
}

/**
 * Run every check and return `{ ok, results }`. Safe to call again: it reads
 * the live canvas each time and leaves the view at its original scale.
 */
export async function runLensSmoke() {
  const app = globalThis.macusanite;
  const results = [];
  const stage = document.querySelector('.wb-stage');
  const canvas = document.querySelector('.wb-canvas');
  if (!app || !stage || !canvas) {
    results.push({ name: 'setup', status: 'fail', detail: 'the worldbuilding panel is not on the page' });
    return finish(results);
  }

  /** Open the sample vault's fixture vein, whichever vein was open before. */
  const openFixture = async () => {
    try {
      await app.openPath('Home.md');
      if (app.state.ui.mode !== 'world') app.setMode('world');
      await wait(200);
      return true;
    } catch {
      return false;
    }
  };

  if (!app.state?.current && !(await openFixture())) {
    results.push({ name: 'setup', status: 'fail', detail: 'no vein is open and Home.md could not be opened' });
    return finish(results);
  }
  if (app.state.ui.mode !== 'world') app.setMode('world');
  await wait(200);
  if (!stage.offsetWidth) {
    results.push({ name: 'setup', status: 'fail', detail: 'the canvas is not visible' });
    return finish(results);
  }

  // Another harness run (the perf budget, say) can leave its own vein open;
  // these checks need the sample vault's authored bonds, so use the fixture
  // rather than reporting its absence as a lens failure.
  let path = app.state.current.path;
  let candidates = focusCandidates(stage, app, path);
  if (!candidates.length && path !== 'Home.md' && (await openFixture())) {
    path = app.state.current.path;
    candidates = focusCandidates(stage, app, path);
  }
  if (!candidates.length) {
    results.push({ name: 'setup', status: 'fail', detail: 'no card with an authored bond could be selected' });
    return finish(results);
  }
  const original = scaleOf(canvas);

  let focus = null;
  try {
    await zoomTo(stage, canvas, 1);
    await wait(120);
    await record(results, 'select a card through its link port', async () => {
      focus = await selectFocus(stage, candidates);
      if (!focus) fail('no candidate card could be selected through its port');
      return { detail: focus.dataset.anchor };
    });
    if (!focus) return finish(results);
    const anchor = focus.dataset.anchor;

    await record(results, 'unrelated cards and wires dim', () => checkDimming(stage, anchor));
    await record(results, 'own bonds are emphasised', () => checkEmphasis(stage, anchor));
    await record(results, 'the inspector lists neighbours', () => checkInspector(stage, anchor));
    await record(results, 'an inspector row jumps and re-focuses', () => checkJump(stage));

    // The jump may have moved the lens to another card; the chips belong to
    // whichever card is focused now.
    const chipAnchor = selectedAnchors()[0] ?? anchor;
    const chipCard = cardFor(stage, chipAnchor);
    await record(results, 'kind chips stay hidden above 20%', async () => {
      await zoomTo(stage, canvas, 1, chipCard ? centreOf(chipCard.getBoundingClientRect()) : undefined);
      await wait(100);
      const { hidden } = lensChipState();
      if (!hidden) fail('kind chips are visible above the semantic zoom');
      return { detail: 'hidden at 100%' };
    });
    await record(results, 'kind chips appear at 20%', () => checkChips(stage, canvas, chipAnchor, 0.2));
    await record(results, 'kind chips appear at 12.5%', () => checkChips(stage, canvas, chipAnchor, 0.125));
  } finally {
    clearSelection(stage);
    await zoomTo(stage, canvas, original);
  }
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
  globalThis.wbLensSmoke = summary;
  if (globalThis.console?.table) console.table(results);
  document.title = `${summary.ok ? '✓' : '✗'} lens smoke — ${summary.passed}/${results.length} passed`;
  return summary;
}
