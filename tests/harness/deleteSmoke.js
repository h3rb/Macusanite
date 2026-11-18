/**
 * Harness regression for deleting a marquee-picked set of cards.
 *
 * The Node suite proves that a snapshot carrying note prose restores it, and
 * that pruning keeps those payloads. It cannot prove the panel's own sweep:
 * a Shift+drag marquee selects the cards the reader sees, Delete takes their
 * prose out of the markdown and their boxes off the canvas, undo puts both
 * back byte-for-byte, and redo takes them away again. That is the contract, so
 * this drives the real panel and reads the markdown and the saved record back.
 *
 * Run it against the harness:
 *
 *   npm run harness
 *   open http://127.0.0.1:1421/?wb-smoke=delete
 *
 * The first visit seeds the fixture vein and reloads; the second runs it. The
 * results also land on `globalThis.wbDeleteSmoke` and in the console, and the
 * page title reports the run. The smoke covers both marquee-set Delete and a
 * card's own ✕, undoing each and leaving the fixture whole again.
 */

const STORAGE_KEY = 'macusanite.virtual-vault.v1';
const HARNESS_PATH = 'Deleting Set.md';

/** The four the sweep picks: a 2x2 block on the left of the fixture. */
const VICTIMS = ['alpha', 'beta', 'gamma', 'delta'];
/** Cards beside the block: the sweep must leave every one of them alone. */
const BYSTANDERS = ['echo', 'foxtrot'];
const TITLE_ANCHOR = 'deleting-set';
const ALL = [...VICTIMS, ...BYSTANDERS, TITLE_ANCHOR];

const TITLES = {
  'deleting-set': 'Deleting Set',
  alpha: 'Alpha',
  beta: 'Beta',
  gamma: 'Gamma',
  delta: 'Delta',
  echo: 'Echo',
  foxtrot: 'Foxtrot',
};

/** One sentence per card, so a prose check can name exactly what it wants. */
const PROSE = {
  'deleting-set': 'The fixture the delete smoke sweeps, deletes and puts back.',
  alpha: 'Alpha keeps this sentence beside its card.',
  beta: 'Beta keeps this sentence beside its card.',
  gamma: 'Gamma keeps this sentence beside its card.',
  delta: 'Delta keeps this sentence beside its card.',
  echo: 'Echo is outside the sweep and stays put.',
  foxtrot: 'Foxtrot is outside the sweep and stays put.',
};

/** The canvas record slices that must come back exactly, camera excluded. */
const RECORD_SLICES = [
  'positions', 'groups', 'relations', 'bondNotes', 'folded', 'types', 'fields',
  'colors', 'images', 'resources', 'pinned', 'locked', 'cardModes', 'cardSizes',
  'cardDims', 'stack', 'collapsedGroups', 'annotations',
];

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fail(message) {
  throw new Error(message);
}

function list(anchors) {
  return anchors.length ? anchors.join(', ') : 'nothing';
}

function sameSet(a, b) {
  const left = [...a].sort();
  const right = [...b].sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** A key-sorted serialisation, so two records compare without key order. */
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
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

/** Poll until `predicate` answers something truthy, or the time runs out. */
async function waitFor(predicate, timeout = 2000) {
  const until = performance.now() + timeout;
  for (;;) {
    const answer = predicate();
    if (answer) return answer;
    if (performance.now() >= until) return null;
    await wait(25);
  }
}

function cardOf(anchor) {
  return document.querySelector(`.wb-card[data-anchor="${anchor}"]`);
}

function cardAnchors() {
  return [...document.querySelectorAll('.wb-card')]
    .sort((left, right) => Number(left.dataset.note) - Number(right.dataset.note))
    .map((card) => card.dataset.anchor);
}

function selectedAnchors() {
  return [...document.querySelectorAll('.wb-card.is-selected')].map((card) => card.dataset.anchor);
}

function canvasRecord(app, path) {
  return app?.state?.world?.[path] ?? {};
}

/**
 * A record slice in the shape the canvas compares: a group's empty `children`
 * list is dropped when the record is loaded and written back when the canvas
 * saves one, so a saved group and a restored group differ only by that key.
 */
function canonicalSlice(key, value) {
  const slice = value ?? {};
  if (key !== 'groups') return slice;
  return Object.fromEntries(Object.entries(slice).map(([id, group]) => [
    id, { ...group, children: group?.children ?? [] },
  ]));
}

/** Everything the checks compare: the prose, the canvas record and the cards. */
function snapshotOf(app, path) {
  const record = canvasRecord(app, path);
  return {
    text: app?.state?.draft ?? '',
    codes: stable(Object.fromEntries(RECORD_SLICES.map((key) => [key, canonicalSlice(key, record[key])]))),
    cards: cardAnchors(),
    steps: (app?.worldRecord?.(path)?.history?.past ?? []).map((step) => step.name),
  };
}

/**
 * The fixture: seven sections in a grid, four of them a 2x2 block with a wide
 * gutter to the two bystanders, and the vein's own title card below them. The
 * four carry prose, a bond, a bond note, a group, a pin, a colour, a field, a
 * type and a fold, so undo has more than boxes to restore.
 */
export function deleteVaultFiles() {
  const order = ['deleting-set', 'alpha', 'beta', 'gamma', 'delta', 'echo', 'foxtrot'];
  const lines = [];
  for (const anchor of order) {
    // The vein's title is its own card; the rest are sections inside it.
    lines.push(`${anchor === TITLE_ANCHOR ? '#' : '##'} ${TITLES[anchor]}`, '', PROSE[anchor], '');
  }
  const positions = {
    'deleting-set': { x: 1040, y: 840 },
    alpha: { x: 40, y: 40 },
    beta: { x: 480, y: 40 },
    gamma: { x: 40, y: 440 },
    delta: { x: 480, y: 440 },
    echo: { x: 1040, y: 40 },
    foxtrot: { x: 1040, y: 440 },
  };
  const group = (id, name, color, members) => ({ id, name, color, members, children: [] });
  return {
    path: HARNESS_PATH,
    body: lines.join('\n'),
    record: {
      marked: true,
      positions,
      groups: {
        'g-victims': group('g-victims', 'Swept pair', '#d29922', ['gamma', 'delta']),
        'g-mixed': group('g-mixed', 'Mixed pair', '#45c4b0', ['alpha', 'echo']),
        'g-others': group('g-others', 'Bystanders', '#57d364', ['echo', 'foxtrot']),
      },
      relations: {
        'alpha->beta': 'ally',
        'beta->gamma': 'contains',
        'alpha->echo': 'mentor',
        'echo->foxtrot': 'ally',
      },
      bondNotes: {
        'alpha->beta': 'They met at the gate.',
        'echo->foxtrot': 'Old friends.',
      },
      folded: { beta: { card: true } },
      types: { alpha: 'place', delta: 'note' },
      fields: { alpha: { level: 3 }, echo: { level: 9 } },
      colors: { alpha: '#57d364', echo: '#ffa657' },
      images: {},
      resources: {},
      pinned: { gamma: true },
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

/** Write the fixture into the harness vault; returns an error message or null. */
function seed() {
  const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
  if (!raw) return 'the harness vault is not in localStorage';
  const store = JSON.parse(raw);
  if (!store?.files) return 'the harness vault has no files';
  const state = JSON.parse(store.files['.macusanite/state.json'] ?? '{}');
  state.world = state.world && typeof state.world === 'object' ? state.world : {};
  const fixture = deleteVaultFiles();
  store.files[fixture.path] = fixture.body;
  state.world[fixture.path] = fixture.record;
  store.files['.macusanite/state.json'] = JSON.stringify(state, null, 2);
  globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  return null;
}

/** Frame every card of the fixture in the stage, so all of them are built. */
async function fitAll(stage) {
  const button = [...document.querySelectorAll('button')]
    .find((candidate) => (candidate.title ?? '').startsWith('Zoom to fit every card'));
  if (!button) fail('the canvas has no Fit button');
  button.click();
  const fitted = await waitFor(() => {
    const bounds = stage.getBoundingClientRect();
    const cards = ALL.map((anchor) => cardOf(anchor));
    if (cards.some((card) => !card)) return null;
    const inside = cards.map((card) => card.getBoundingClientRect()).every((rect) => (
      rect.width > 2 && rect.height > 2
      && rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1
      && rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1
    ));
    return inside ? true : null;
  }, 3000);
  if (!fitted) fail('the fixture cards could not all be brought into the stage');
}

/** Whether a screen rectangle would be picked by a marquee box. */
function intersects(rect, box) {
  return rect.right > box.left && rect.left < box.right && rect.bottom > box.top && rect.top < box.bottom;
}

/**
 * Shift+drag a marquee around the victims and nobody else. The card rects the
 * browser reports are what the reader sees, so the box is drawn a margin
 * outside the four cards' union and checked against the bystanders' own rects
 * before a single pointer moves.
 */
async function sweepVictims(stage) {
  const stageRect = stage.getBoundingClientRect();
  const rects = VICTIMS.map((anchor) => cardOf(anchor)?.getBoundingClientRect());
  if (rects.some((rect) => !rect || rect.width < 2 || rect.height < 2)) {
    fail('a victim card is not on the canvas');
  }
  const union = {
    left: Math.min(...rects.map((rect) => rect.left)),
    top: Math.min(...rects.map((rect) => rect.top)),
    right: Math.max(...rects.map((rect) => rect.right)),
    bottom: Math.max(...rects.map((rect) => rect.bottom)),
  };
  const outsiderRects = [...BYSTANDERS, TITLE_ANCHOR].map((anchor) => cardOf(anchor)?.getBoundingClientRect());
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
    const start = { x: box.left, y: box.top };
    const end = { x: box.right, y: box.bottom };
    fire(stage, 'pointerdown', start.x, start.y, 1, { shiftKey: true });
    fire(window, 'pointermove', (start.x + end.x) / 2, (start.y + end.y) / 2, 1);
    fire(window, 'pointermove', end.x, end.y, 1);
    fire(window, 'pointerup', end.x, end.y, 0);
    await wait(80);
    return { start, end, margin };
  }
  fail('no marquee box fits round the four cards without touching a bystander');
}

function historyStep(app, path) {
  const past = app?.worldRecord?.(path)?.history?.past ?? [];
  return past[past.length - 1] ?? null;
}

function toolbarButton(label) {
  return [...document.querySelectorAll('.wb-toolbar button')]
    .find((button) => (button.getAttribute('aria-label') ?? '').startsWith(label)) ?? null;
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

/** The whole run, one check at a time, against the fixture vein. */
async function sweepDeleteUndoRedo(app, results) {
  const path = HARNESS_PATH;
  const stage = document.querySelector('.wb-stage');
  if (!stage || !stage.offsetWidth) {
    results.push({ name: 'setup', status: 'fail', detail: 'the canvas is not visible' });
    return;
  }
  const ctx = {};

  await record(results, 'marquee selects exactly the four cards', async () => {
    await fitAll(stage);
    ctx.before = snapshotOf(app, path);
    if (ctx.before.cards.length < ALL.length) {
      fail(`the canvas shows ${ctx.before.cards.length} cards, expected ${ALL.length}`);
    }
    const box = await sweepVictims(stage);
    const picked = selectedAnchors();
    if (!sameSet(picked, VICTIMS)) {
      fail(`the sweep selected ${list(picked)} instead of ${list(VICTIMS)}`);
    }
    const bar = document.querySelector('.wb-selection-bar');
    if (!bar || bar.classList.contains('hidden')) fail('the selection bar did not open');
    const count = bar.querySelector('.wb-selection-count')?.textContent ?? '';
    if (!count.includes(String(VICTIMS.length))) fail(`the selection bar reads “${count}”`);
    return { detail: `${picked.length} cards, ${Math.round(box.end.x - box.start.x)}x${Math.round(box.end.y - box.start.y)} px box` };
  });

  await record(results, 'Delete takes the cards and their prose away', async () => {
    if (!ctx.before) fail('the sweep did not run');
    const bar = document.querySelector('.wb-selection-bar');
    // The bar's controls carry their count, so the Delete button reads
    // “Delete 4” and its title names the set.
    const button = [...(bar?.querySelectorAll('button') ?? [])]
      .find((candidate) => /^Delete the \d+ selected notes$/.test(candidate.title ?? ''));
    if (!button) fail('the selection bar has no Delete button');
    if (button.textContent.trim() !== `Delete ${VICTIMS.length}`) {
      fail(`the Delete button reads “${button.textContent.trim()}”`);
    }
    button.click();
    const dialog = await waitFor(() => document.querySelector('dialog.md-dialog'), 1000);
    if (!dialog) fail('Delete did not ask before removing prose');
    const title = dialog.querySelector('.md-dialog-title')?.textContent ?? '';
    if (title !== `Delete ${VICTIMS.length} notes?`) fail(`the confirmation asks “${title}”`);
    dialog.querySelector('button[type="submit"]')?.click();

    const cleared = await waitFor(() => VICTIMS.every((anchor) => !cardOf(anchor)), 2000);
    if (!cleared) fail(`the canvas still shows ${list(VICTIMS.filter(cardOf))}`);
    if (document.querySelector('dialog.md-dialog')) fail('the confirmation stayed open');
    ctx.after = snapshotOf(app, path);

    const staying = BYSTANDERS.filter(cardOf);
    if (!sameSet(staying, BYSTANDERS)) fail(`the delete took bystanders ${list(BYSTANDERS.filter((a) => !cardOf(a)))}`);
    if (!ctx.after.cards.includes(TITLE_ANCHOR)) fail('the delete took the vein’s own title card');
    for (const anchor of VICTIMS) {
      if (ctx.after.text.includes(`## ${TITLES[anchor]}`)) fail(`the markdown still has ## ${TITLES[anchor]}`);
      if (ctx.after.text.includes(PROSE[anchor])) fail(`the markdown still has ${anchor}’s prose`);
    }
    for (const anchor of BYSTANDERS) {
      if (!ctx.after.text.includes(PROSE[anchor])) fail(`the markdown lost ${anchor}’s prose`);
    }
    const record = canvasRecord(app, path);
    for (const anchor of VICTIMS) {
      if (record.positions?.[anchor]) fail(`${anchor} kept its canvas position`);
      if (record.pinned?.[anchor]) fail(`${anchor} stayed pinned`);
      if (record.colors?.[anchor]) fail(`${anchor} kept its colour`);
      if (record.types?.[anchor]) fail(`${anchor} kept its type`);
      if (record.folded?.[anchor]) fail(`${anchor} stayed folded`);
      if (record.fields?.[anchor]) fail(`${anchor} kept its fields`);
    }
    if (record.groups?.['g-victims']) fail('the swept pair’s group survived both its cards');
    if (record.groups?.['g-mixed']) fail('the mixed group survived with one card left');
    if (!record.groups?.['g-others']) fail('the bystanders’ group was dissolved too');
    for (const key of Object.keys(record.relations ?? {})) {
      if (VICTIMS.some((anchor) => key.split('->').includes(anchor))) fail(`the bond ${key} survived a deleted end`);
    }
    if (record.relations?.['echo->foxtrot'] !== 'ally') fail('the bystanders lost their own bond');
    if (!sameSet(ctx.after.steps, [`Delete ${VICTIMS.length} notes`])) {
      fail(`the stack reads ${list(ctx.after.steps)} instead of one delete step`);
    }
    const bar2 = document.querySelector('.wb-selection-bar');
    if (bar2 && !bar2.classList.contains('hidden')) fail('the selection bar stayed over the empty cards');
    return { detail: `${VICTIMS.length} cards and ${VICTIMS.length} prose sections gone, ${BYSTANDERS.length} bystanders kept` };
  });

  await record(results, 'undo restores the cards and their prose exactly', async () => {
    if (!ctx.after) fail('the delete did not run');
    const undo = toolbarButton('Undo');
    if (!undo || undo.disabled) fail('undo is not offered after the delete');
    if (!undo.title.startsWith(`Undo: Delete ${VICTIMS.length} notes`)) fail(`undo names “${undo.title}”`);
    undo.click();
    const back = await waitFor(() => VICTIMS.every(cardOf), 2000);
    if (!back) fail(`undo left ${list(VICTIMS.filter((anchor) => !cardOf(anchor)))} off the canvas`);
    const now = snapshotOf(app, path);
    if (now.text !== ctx.before.text) fail(`the markdown came back different:\n${diffSummary(ctx.before.text, now.text)}`);
    if (now.codes !== ctx.before.codes) fail(`the canvas record came back different (${diffKeys(ctx.before.codes, now.codes)})`);
    if (!sameSet(now.cards, ctx.before.cards)) fail(`the cards are ${list(now.cards)}, were ${list(ctx.before.cards)}`);
    if (now.cards.join('|') !== ctx.before.cards.join('|')) {
      fail(`the cards came back in a different order: ${list(now.cards)}; expected ${list(ctx.before.cards)}`);
    }
    if (undo.disabled !== true) fail('undo is still offered with nothing left to undo');
    const redo = toolbarButton('Redo');
    if (!redo || redo.disabled) fail('redo is not offered after undoing the delete');
    if (!redo.title.startsWith(`Redo: Delete ${VICTIMS.length} notes`)) fail(`redo names “${redo.title}”`);
    if (selectedAnchors().length) fail('undo left its restored cards selected');
    return { detail: `${now.cards.length} cards, ${now.text.length} characters of markdown, record identical` };
  });

  await record(results, 'redo takes the cards and their prose away again', async () => {
    if (!ctx.before) fail('the delete did not run');
    const redo = toolbarButton('Redo');
    if (!redo || redo.disabled) fail('redo is not offered');
    redo.click();
    const cleared = await waitFor(() => VICTIMS.every((anchor) => !cardOf(anchor)), 2000);
    if (!cleared) fail(`redo left ${list(VICTIMS.filter(cardOf))} on the canvas`);
    const now = snapshotOf(app, path);
    if (now.text !== ctx.after.text) fail(`redo left different markdown:\n${diffSummary(ctx.after.text, now.text)}`);
    if (now.codes !== ctx.after.codes) fail(`redo left a different record (${diffKeys(ctx.after.codes, now.codes)})`);
    if (!sameSet(now.cards, ctx.after.cards)) fail(`redo left ${list(now.cards)}, expected ${list(ctx.after.cards)}`);
    for (const anchor of VICTIMS) {
      if (now.text.includes(PROSE[anchor])) fail(`redo left ${anchor}’s prose in the markdown`);
    }
    return { detail: `${VICTIMS.length} cards and their prose gone again` };
  });

  await record(results, 'a second undo restores them once more', async () => {
    if (!ctx.before) fail('the delete did not run');
    const undo = toolbarButton('Undo');
    if (!undo || undo.disabled) fail('undo is not offered after the redo');
    undo.click();
    const back = await waitFor(() => VICTIMS.every(cardOf), 2000);
    if (!back) fail('the second undo did not put the cards back');
    const now = snapshotOf(app, path);
    if (now.text !== ctx.before.text) fail(`the markdown differs after the second undo:\n${diffSummary(ctx.before.text, now.text)}`);
    if (now.codes !== ctx.before.codes) fail(`the record differs after the second undo (${diffKeys(ctx.before.codes, now.codes)})`);
    return { detail: 'the fixture is whole again' };
  });

  await record(results, 'card ✕ undo restores its prose, bonds and saved position', async () => {
    const before = snapshotOf(app, path);
    const savedPosition = canvasRecord(app, path).positions?.alpha;
    if (!savedPosition) fail('Alpha has no saved canvas position');
    if (canvasRecord(app, path).relations?.['alpha->beta'] !== 'ally') fail('Alpha has no fixture bond to Beta');
    if (canvasRecord(app, path).relations?.['alpha->echo'] !== 'mentor') fail('Alpha has no fixture bond to Echo');

    const remove = cardOf('alpha')?.querySelector('.wb-card-del');
    if (!remove) fail('Alpha has no card ✕ control');
    remove.click();
    if (!(await waitFor(() => remove.classList.contains('is-armed'), 500))) fail('the first ✕ click did not arm deletion');
    remove.click();

    const gone = await waitFor(() => !cardOf('alpha'), 2000);
    if (!gone) fail('the ✕ did not remove Alpha from the canvas');
    if ((app.state.draft ?? '').includes(PROSE.alpha)) fail('the ✕ left Alpha’s prose in the markdown');
    const deleted = canvasRecord(app, path);
    if (deleted.positions?.alpha) fail('the ✕ kept Alpha’s saved canvas position');
    for (const key of Object.keys(deleted.relations ?? {})) {
      if (key.split('->').includes('alpha')) fail(`the ✕ left Alpha’s bond ${key}`);
    }
    const undo = toolbarButton('Undo');
    if (!undo || undo.disabled || !undo.title.startsWith('Undo: Delete “Alpha”')) fail(`the ✕ produced an unexpected step: ${undo?.title ?? 'none'}`);

    undo.click();
    const restored = await waitFor(() => cardOf('alpha'), 2000);
    if (!restored) fail('undo did not restore Alpha’s card');
    const now = snapshotOf(app, path);
    if (now.text !== before.text) fail(`undo did not restore Alpha’s prose exactly: ${diffSummary(before.text, now.text)}`);
    if (now.codes !== before.codes) fail(`undo did not restore Alpha’s bonds and canvas state exactly (${diffKeys(before.codes, now.codes)})`);
    if (stable(canvasRecord(app, path).positions?.alpha) !== stable(savedPosition)) {
      fail(`undo restored Alpha at ${JSON.stringify(canvasRecord(app, path).positions?.alpha)}, expected ${JSON.stringify(savedPosition)}`);
    }
    if (!sameSet(now.cards, before.cards)) fail(`undo restored ${list(now.cards)}, expected ${list(before.cards)}`);
    if (now.cards.join('|') !== before.cards.join('|')) {
      fail(`undo restored Alpha in a different card order: ${list(now.cards)}; expected ${list(before.cards)}`);
    }
    return { detail: 'Alpha’s prose, both bonds, saved position and card order restored exactly' };
  });
}

/** The first line that differs, with a little context, for a readable failure. */
function diffSummary(expected, actual) {
  const left = String(expected).split('\n');
  const right = String(actual).split('\n');
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    if (left[i] === right[i]) continue;
    return `line ${i + 1}: expected ${JSON.stringify(left[i] ?? '(end)')}, got ${JSON.stringify(right[i] ?? '(end)')}`;
  }
  return 'no line differs';
}

/**
 * Which record slices differ, named, plus the entries inside them — one group
 * or one anchor, not the whole record. A regression should say what moved.
 */
function diffKeys(expected, actual) {
  const left = JSON.parse(expected);
  const right = JSON.parse(actual);
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  const parts = [];
  for (const key of keys) {
    const before = left[key] ?? {};
    const after = right[key] ?? {};
    if (stable(before) === stable(after)) continue;
    const entries = new Set([...Object.keys(before), ...Object.keys(after)]);
    const changed = [...entries]
      .filter((entry) => stable(before[entry]) !== stable(after[entry]))
      .slice(0, 3)
      .map((entry) => `${entry}: ${JSON.stringify(before[entry])} -> ${JSON.stringify(after[entry])}`);
    parts.push(`${key}${changed.length ? ` (${changed.join('; ')})` : ''}`);
  }
  return parts.length ? parts.join(' | ') : 'no slice differs';
}

/**
 * Seed on the first visit and reload so the vault is read fresh, then run the
 * checks. Returns the summary, or null when the URL did not ask for this run.
 */
export async function runDeleteSmoke(search = globalThis.location?.search ?? '') {
  if (!import.meta.env.DEV) return null;
  const params = new URLSearchParams(search);
  if (params.get('wb-smoke') !== 'delete') return null;
  const app = globalThis.macusanite;
  if (!app) return null;

  if (params.get('phase') !== 'run') {
    const error = seed();
    if (error) {
      const summary = finish([{ name: 'setup', status: 'fail', detail: error }]);
      return summary;
    }
    const next = new URL(globalThis.location.href);
    next.searchParams.set('phase', 'run');
    globalThis.location.replace(next.href);
    return null;
  }

  const results = [];
  try {
    await app.openPath(HARNESS_PATH);
    if (app.state.ui.mode !== 'world') app.setMode('world');
    await wait(150);
  } catch (error) {
    results.push({ name: 'setup', status: 'fail', detail: `the fixture vein could not be opened: ${error?.message ?? error}` });
    return finish(results);
  }
  await sweepDeleteUndoRedo(app, results);
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
  globalThis.wbDeleteSmoke = summary;
  if (globalThis.console?.table) console.table(results);
  document.title = `${summary.ok ? '✓' : '✗'} delete smoke — ${summary.passed}/${results.length} passed`;
  return summary;
}
