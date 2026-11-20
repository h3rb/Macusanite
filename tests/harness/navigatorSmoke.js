/**
 * Harness smoke test for the navigator's placement setting and its drawer.
 *
 * The navigator is either docked as a drawer on the canvas's right edge or
 * floating as a card over its corner, and Settings → Worldbuilding → Navigator
 * placement is the control that flips it. Docked, the drawer is dragged by the
 * grip on its inner edge and the width it is left at is remembered as
 * `worldbuild.navigatorWidth`, so it comes back the size it was left. A window
 * at 1100 px or narrower caps both dock panels to a share of it, so the canvas
 * keeps room beside the drawer and the inspector.
 *
 * None of that is reachable from a unit test: the setting's effect is the class
 * the body carries, the drawer's width is a CSS custom property and a line in
 * settings.json, and the caps are a media query. This drives the real Settings
 * control and the real grip with synthetic input and reads the result back from
 * the DOM and the harness vault.
 *
 * Run it against the harness:
 *
 *   npm run harness
 *   open http://127.0.0.1:1421/?wb-smoke=navigator
 *
 * The results also land on `globalThis.wbNavSmoke` and in the console, and the
 * page title reports the run.
 *
 * The two caps and the floating map's corner all belong to one ≤1100 px media
 * rule, so the rule is read from the stylesheet and asserted at every window
 * size, and what it draws is then measured, which only says something below the
 * breakpoint. A window about 600 px wide makes the cap measurements bind. The
 * corner is measured beside the inspector, which asks for it at any width, and
 * on the media rule alone only below the breakpoint. A wider window still proves
 * the rule, and each measurement it cannot bind is reported as skipped, naming
 * the window that would exercise it — about 955 px for the drawer and 618 px for
 * the inspector. The run puts the navigator back where it found it, so it can be
 * repeated.
 */
import {
  bringCentreIntoView, fail, fire, inside, record, reportSmoke, selectedAnchors,
  VAULT_STORAGE_KEY, wait, waitFor,
} from './kit.js';

/** The Settings field that flips the navigator between its two homes. */
const PLACEMENT_LABEL = 'Navigator placement';
/** The drawer's share of a window at 1100 px or narrower, and the inspector's. */
const DRAWER_SHARE = 0.44;
const INSPECTOR_SHARE = 0.46;
/** The width both caps are declared under. */
const CAP_BREAKPOINT = 1100;
/** A share as the stylesheet spells it, without float noise from `× 100`. */
const shareVw = (share) => `${Math.round(share * 100)}vw`;
/** The inspector's own width, before any cap. */
const INSPECTOR_WIDTH = 284;
/** How far a floating map is inset from the corner it takes. */
const FLOAT_INSET = 12;
/** The navigator's remembered width, before the grip moves it. */
const DRAWER_NATURAL = 202;
/** How far inward the grip is dragged, and the width that leaves it at. */
const DRAG_STEP = 24;
/** A width only the remembered setting can explain: the DOM never had it. */
const SAVED_WIDTH = 236;

const dockHost = () => document.querySelector('.wb-dock');
const navigatorPanel = () => document.querySelector('.wb-navigator');

/** This vault's settings.json as the harness store holds it, or null. */
function storedSettings() {
  try {
    const store = JSON.parse(globalThis.localStorage?.getItem(VAULT_STORAGE_KEY) ?? 'null');
    const text = store?.files?.['.macusanite/settings.json'];
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/** What the dock was told its panel should be, in px. */
function appliedWidth() {
  const raw = dockHost()?.style.getPropertyValue('--wb-nav-w') ?? '';
  return Number.parseFloat(raw);
}

/** The dock's panel slot as laid out, after the window's caps have had their say. */
function panelWidth() {
  const slot = dockHost()?.querySelector('.dock-slot');
  return slot ? slot.getBoundingClientRect().width : 0;
}

/** The width 44vw or 46vw leaves at this window, or the panel's own when wide. */
function cappedWidth(natural, share) {
  if (globalThis.innerWidth > CAP_BREAKPOINT) return natural;
  return Math.min(natural, globalThis.innerWidth * share);
}

/** A declaration or selector with the whitespace and quote style CSS ignores. */
function squeeze(value) {
  return String(value).replace(/\s+/g, '').replace(/["']/g, '"');
}

/** The arguments of a `min(…)`, or null for any other value. */
function minArgs(value) {
  const text = squeeze(value);
  if (!text.startsWith('min(') || !text.endsWith(')')) return null;
  const body = text.slice(4, -1);
  const args = [];
  let depth = 0;
  let from = 0;
  for (let at = 0; at < body.length; at += 1) {
    if (body[at] === '(') depth += 1;
    else if (body[at] === ')') depth -= 1;
    else if (body[at] === ',' && depth === 0) {
      args.push(body.slice(from, at));
      from = at + 1;
    }
  }
  args.push(body.slice(from));
  return args;
}

/**
 * Every rule the shipped stylesheet puts under the ≤1100 px media query for one
 * selector, with its declarations and the query's own text.
 *
 * These rules hold at every window size, while what they draw only binds below
 * the breakpoint, so a wide window would otherwise leave them unchecked.
 * Reading the CSSOM checks what ships, not what this window happens to draw.
 */
function narrowRules(selector) {
  const wanted = squeeze(selector);
  const found = [];
  for (const sheet of document.styleSheets) {
    let rules;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // a sheet from another origin hides its rules
    }
    for (const rule of rules ?? []) {
      const media = rule.media?.mediaText ?? rule.conditionText ?? '';
      if (!squeeze(media).includes(`max-width:${CAP_BREAKPOINT}px`)) continue;
      for (const inner of rule.cssRules ?? []) {
        if (squeeze(inner.selectorText ?? '') !== wanted) continue;
        found.push({ style: inner.style, media: media.trim() });
      }
    }
  }
  return found;
}

/** The `--wb-dock-w` one dock panel is capped at inside that rule, or null. */
function shippedPanelCap(panel) {
  for (const rule of narrowRules(`.wb-dock[data-panel='${panel}']`)) {
    const value = rule.style?.getPropertyValue('--wb-dock-w') ?? '';
    if (value.trim()) return { value: value.trim(), media: rule.media };
  }
  return null;
}

/** Where the 12 px inset a floating map takes lands from the stage's left edge. */
function floatInset() {
  const map = navigatorPanel();
  const stage = document.querySelector('.wb-stage');
  if (!map || !stage) return null;
  return map.getBoundingClientRect().left - stage.getBoundingClientRect().left;
}

/** The inspector card's dock, when it is the panel on show. */
function inspectorCard() {
  if (dockHost()?.dataset.panel !== 'inspector') return null;
  const rect = dockHost().getBoundingClientRect();
  return rect.width > 2 ? rect : null;
}

/**
 * The width the panel applies for a remembered one: the grip's own limits are
 * 160–420 px, and never more than 60% of the window.
 */
function appliedFor(px) {
  const cap = Math.min(420, Math.max(160, Math.round(globalThis.innerWidth * 0.6)));
  return Math.max(160, Math.min(cap, Math.round(px)));
}

/** What the dock is showing right now, read from the class and the two panels. */
function dockState() {
  const host = dockHost();
  const navigator = navigatorPanel();
  const stage = document.querySelector('.wb-stage');
  const rail = host?.querySelector('.dock-rail');
  const navTabs = [...(host?.querySelectorAll('.dock-tab') ?? [])]
    .filter((tab) => tab.textContent.trim().startsWith('Navigator'));
  return {
    docked: document.body.classList.contains('nav-dock-drawer'),
    inDock: Boolean(host && navigator && host.contains(navigator)),
    inStage: Boolean(stage && navigator && navigator.parentElement === stage),
    hostHidden: host ? host.classList.contains('hidden') : true,
    hostOpen: Boolean(host?.classList.contains('is-open')),
    panel: host?.dataset?.panel ?? null,
    navHidden: navigator ? navigator.classList.contains('hidden') : true,
    railShown: Boolean(rail && getComputedStyle(rail).display !== 'none'),
    tabShown: navTabs.some((tab) => !tab.classList.contains('hidden')),
  };
}

/** The dialog's Navigator placement select, when Settings is open. */
function placementSelect() {
  const field = [...document.querySelectorAll('dialog.settings-dialog .settings-field')]
    .find((candidate) => candidate.querySelector('.settings-label')?.textContent === PLACEMENT_LABEL);
  return field?.querySelector('select') ?? null;
}

/** Open Settings and wait for its placement control to be in the page. */
async function openSettings(app) {
  app.openSettings();
  const select = await waitFor(() => placementSelect(), 2000);
  if (!select) fail('Settings has no Navigator placement control');
  return select;
}

/** Choose a placement the way the reader does, and wait for the canvas to obey. */
async function setPlacement(app, value) {
  const select = placementSelect();
  if (!select) fail('the Navigator placement control left the Settings dialog');
  select.value = value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
  const settled = await waitFor(() => {
    const docked = document.body.classList.contains('nav-dock-drawer');
    return app.state.settings.worldbuild?.navigatorDock === value && docked === (value === 'drawer');
  }, 3000);
  if (!settled) fail(`the canvas did not ${value === 'drawer' ? 'dock the navigator' : 'float the navigator'}`);
  // The dock settles from the body's class, after the mutation observer runs.
  await wait(60);
}

/**
 * Remember a width and put it on the dock. Nothing pushes a new width into the
 * panel but a layout settle — the grip's drag, a placement change, or the
 * window resize the listener on it answers — so that is what this asks for.
 */
async function applyWidth(app, px) {
  app.updateSettings({ worldbuild: { navigatorWidth: px } });
  globalThis.dispatchEvent(new Event('resize'));
  const reached = await waitFor(() => Math.round(appliedWidth()) === appliedFor(px), 3000);
  if (!reached) fail(`the drawer did not take the ${appliedFor(px)} px width it was asked for`);
  await wait(40);
}

/**
 * Ask for a placement the way a stored setting does: through the same
 * `updateSettings` the dialog's change handler calls.
 *
 * The promise is not awaited. `updateSettings` re-renders the vein before it
 * resolves, and a re-render waits for a frame; a harness tab that is not on
 * screen never gets one. What a reader sees is already applied by then — the
 * body's class and the dock settle synchronously — so the check reads that
 * instead of waiting on the app.
 */
async function setPlacementVia(app, value) {
  app.updateSettings({ worldbuild: { navigatorDock: value } });
  const settled = await waitFor(() => {
    const docked = document.body.classList.contains('nav-dock-drawer');
    return app.state.settings.worldbuild?.navigatorDock === value && docked === (value === 'drawer');
  }, 3000);
  if (!settled) fail(`the canvas did not ${value === 'drawer' ? 'dock' : 'float'} the navigator`);
  await wait(60);
}

/**
 * Select one card, through the Ctrl+click the canvas reserves for picking: it
 * is what raises the inspector's tab, and so what a dock can show in its place.
 */
async function selectCard(stage) {
  const card = [...stage.querySelectorAll('.wb-card[data-anchor]')]
    .find((candidate) => !candidate.classList.contains('is-locked')
      && !candidate.classList.contains('is-frozen')
      && !candidate.classList.contains('is-group-hidden'));
  if (!card) fail('the canvas has no card to select');
  if (!(await bringCentreIntoView(stage, card, 40))) fail('no card could be brought into view');
  const head = card.querySelector('.wb-card-head') ?? card;
  const rect = head.getBoundingClientRect();
  const x = rect.left + Math.min(40, rect.width / 2);
  const y = rect.top + Math.min(10, rect.height / 2);
  fire(head, 'pointerdown', x, y, 1, { ctrlKey: true });
  fire(window, 'pointerup', x, y, 0, { ctrlKey: true });
  const picked = await waitFor(() => selectedAnchors().includes(card.dataset.anchor), 2000);
  if (!picked) fail(`the card ${card.dataset.anchor} could not be selected`);
  return card.dataset.anchor;
}

export async function runNavigatorSmoke(search = globalThis.location?.search ?? '') {
  if (!import.meta.env.DEV) return null;
  const params = new URLSearchParams(search);
  if (params.get('wb-smoke') !== 'navigator') return null;
  const app = globalThis.macusanite;
  if (!app) return null;

  const results = [];
  try {
    if (!app.state?.current) await app.openPath('Home.md');
    if (!app.state?.current) {
      results.push({ name: 'setup', status: 'fail', detail: 'no vein is open and Home.md could not be opened' });
      return reportSmoke('navigator smoke', 'wbNavSmoke', results);
    }
    if (app.state.ui.mode !== 'world') app.setMode('world');
    await wait(240);
  } catch (error) {
    results.push({ name: 'setup', status: 'fail', detail: `the canvas could not be opened: ${error?.message ?? error}` });
    return reportSmoke('navigator smoke', 'wbNavSmoke', results);
  }

  const stage = document.querySelector('.wb-stage');
  if (!stage || !stage.offsetWidth || !dockHost()) {
    results.push({ name: 'setup', status: 'fail', detail: 'the canvas dock is not on the page' });
    return reportSmoke('navigator smoke', 'wbNavSmoke', results);
  }
  if (app.state.settings.worldbuild?.navigator === false) {
    app.updateSettings({ worldbuild: { navigator: true } });
    await waitFor(() => app.state.settings.worldbuild?.navigator === true, 3000);
    await wait(80);
  }
  const original = { ...app.state.settings.worldbuild };

  try {
    await record(results, 'Settings → Navigator placement → Floating returns the map to the canvas', async () => {
      await openSettings(app);
      await setPlacement(app, 'float');
      const state = dockState();
      if (state.docked) fail('the body still carries nav-dock-drawer');
      if (!state.inStage) fail('the navigator did not move back onto the canvas');
      if (state.inDock) fail('the dock still holds the navigator');
      if (state.navHidden) fail('the floating navigator is hidden');
      if (!state.hostHidden) fail('the dock stayed on the canvas with no panel to show');
      if (state.railShown) fail('the dock still offers its rail while the map floats');
      if (state.tabShown) fail('the navigator tab is still offered while the map floats');
      const rect = navigatorPanel().getBoundingClientRect();
      if (!(rect.width > 2 && rect.height > 2)) fail('the floating navigator has no size');
      if (!inside(stage.getBoundingClientRect(), rect, 0)) fail('the floating navigator sits outside the canvas');
      const stored = await waitFor(() => storedSettings()?.worldbuild?.navigatorDock === 'float', 3000);
      if (!stored) fail('settings.json never recorded navigatorDock: float');
      return { detail: `${Math.round(rect.width)}×${Math.round(rect.height)} over the canvas, dock and rail hidden` };
    });

    await record(results, '…and Docked puts it back in the drawer, written to settings.json', async () => {
      await setPlacement(app, 'drawer');
      const state = dockState();
      if (!state.docked) fail('the body does not carry nav-dock-drawer');
      if (!state.inDock) fail('the navigator is not inside the dock');
      if (state.hostHidden) fail('the dock is hidden while the navigator is docked');
      if (!state.hostOpen) fail('the dock is shut');
      if (state.panel !== 'navigator') fail(`the dock shows “${state.panel}” instead of the navigator`);
      if (state.navHidden) fail('the docked navigator is hidden');
      if (!state.railShown) fail('the docked navigator has no rail to come back by');
      if (!state.tabShown) fail('the navigator tab is hidden while docked');
      const stored = await waitFor(() => storedSettings()?.worldbuild?.navigatorDock === 'drawer', 3000);
      if (!stored) fail('settings.json never recorded navigatorDock: drawer');
      return { detail: `panel ${Math.round(panelWidth())} px wide, written to settings.json` };
    });

    // The drag is done with Settings shut: a modal dialog makes the page behind
    // it inert, and the grip is behind it.
    document.querySelector('dialog.settings-dialog')?.close();
    await wait(60);

    await record(results, 'dragging the drawer grip sets worldbuild.navigatorWidth', async () => {
      await setPlacementVia(app, 'drawer');
      await applyWidth(app, DRAWER_NATURAL);
      if (Math.round(appliedWidth()) !== DRAWER_NATURAL) {
        fail(`the drawer opened at ${appliedWidth()} px instead of ${DRAWER_NATURAL}`);
      }
      const grip = document.querySelector('.wb-nav-grip');
      if (!grip) fail('the drawer has no grip');
      const rect = grip.getBoundingClientRect();
      if (!(rect.width > 0 && rect.height > 0)) fail('the grip is not on screen');
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const to = x - DRAG_STEP;
      fire(grip, 'pointerdown', x, y, 1);
      fire(grip, 'pointermove', to, y, 1);
      fire(grip, 'pointerup', to, y, 0);
      await wait(80);

      const expected = DRAWER_NATURAL + DRAG_STEP;
      const applied = appliedWidth();
      if (Math.round(applied) !== expected) fail(`the drag left the drawer at ${applied} px instead of ${expected}`);
      if (Number(app.state.settings.worldbuild?.navigatorWidth) !== expected) {
        fail(`the setting is ${app.state.settings.worldbuild?.navigatorWidth} px instead of ${expected}`);
      }
      if (grip.getAttribute('aria-valuenow') !== String(expected)) {
        fail(`the grip reports ${grip.getAttribute('aria-valuenow')} px instead of ${expected}`);
      }
      const written = await waitFor(() => storedSettings()?.worldbuild?.navigatorWidth === expected, 3000);
      if (!written) fail(`settings.json never recorded navigatorWidth: ${expected}`);
      const visual = panelWidth();
      const wanted = cappedWidth(expected, DRAWER_SHARE);
      if (Math.abs(visual - wanted) > 1) fail(`the drawer is ${visual.toFixed(1)} px wide instead of ${wanted}`);
      return { detail: `${DRAWER_NATURAL} → ${expected} px, in settings and on disk` };
    });

    await record(results, 'the remembered width comes back with the drawer', async () => {
      await applyWidth(app, SAVED_WIDTH);
      await setPlacementVia(app, 'float');
      await setPlacementVia(app, 'drawer');
      const applied = Math.round(appliedWidth());
      if (applied !== SAVED_WIDTH) fail(`the drawer came back at ${applied} px instead of ${SAVED_WIDTH}`);
      const grip = document.querySelector('.wb-nav-grip');
      if (grip?.getAttribute('aria-valuenow') !== String(SAVED_WIDTH)) {
        fail(`the grip reports ${grip?.getAttribute('aria-valuenow')} px instead of ${SAVED_WIDTH}`);
      }
      const visual = panelWidth();
      const wanted = cappedWidth(SAVED_WIDTH, DRAWER_SHARE);
      if (Math.abs(visual - wanted) > 1) fail(`the drawer is ${visual.toFixed(1)} px wide instead of ${wanted}`);
      if (SAVED_WIDTH === DRAWER_NATURAL + DRAG_STEP) fail('the saved width is the dragged one, so it proves nothing');
      return { detail: `${SAVED_WIDTH} px re-applied after floating and docking again` };
    });

    await record(results, 'the ≤1100 px rule ships a 44vw cap for the drawer', async () => {
      const cap = shippedPanelCap('navigator');
      if (!cap) fail('the stylesheet has no ≤1100 px rule setting --wb-dock-w for the navigator drawer');
      const args = minArgs(cap.value);
      if (!args || args.length !== 2) fail(`the drawer's rule is “${cap.value}”, not a min() of two widths`);
      if (args[0] !== 'var(--wb-nav-w,202px)') {
        fail(`the drawer's rule caps “${args[0]}” instead of the remembered var(--wb-nav-w, 202px)`);
      }
      if (args[1] !== shareVw(DRAWER_SHARE)) {
        fail(`the drawer's rule caps at ${args[1]} instead of ${shareVw(DRAWER_SHARE)}`);
      }
      return { detail: `${cap.media} → min(${args[0]}, ${args[1]}), read from the shipped rule` };
    });

    await record(results, '…and a narrow window draws the drawer at 44vw', async () => {
      await setPlacementVia(app, 'drawer');
      // A width above every window's own limit, so the media query is what has
      // to hold it back rather than the grip's ceiling.
      await applyWidth(app, 420);
      const applied = Math.round(appliedWidth());
      const wanted = cappedWidth(applied, DRAWER_SHARE);
      const narrowest = Math.ceil(applied / DRAWER_SHARE);
      if (wanted >= applied - 1) {
        const share = globalThis.innerWidth * DRAWER_SHARE;
        return { skip: `the shipped ${shareVw(DRAWER_SHARE)} rule is checked above; ${shareVw(DRAWER_SHARE)} of this ${globalThis.innerWidth} px window is ${share.toFixed(0)} px, more than the ${applied} px the drawer asks for, so the cap cannot bind and its drawn width goes unmeasured here. A window ${narrowest} px or narrower draws it.` };
      }
      const visual = panelWidth();
      if (Math.abs(visual - wanted) > 1) {
        fail(`the drawer is ${visual.toFixed(1)} px wide at ${globalThis.innerWidth} px; ${shareVw(DRAWER_SHARE)} caps it at ${wanted.toFixed(1)}`);
      }
      return { detail: `${applied} → ${wanted.toFixed(0)} px at ${globalThis.innerWidth} px wide` };
    });

    let picked = null;
    const openInspector = async () => {
      picked = await selectCard(stage);
      // Picking a card gives the inspector the dock on its own; its tab is the
      // way back to it when the map was the panel chosen by hand.
      if (dockHost()?.dataset.panel !== 'inspector') {
        const tab = [...dockHost().querySelectorAll('.dock-tab')]
          .find((candidate) => candidate.textContent.trim().startsWith('Inspector'));
        if (!tab || tab.classList.contains('hidden')) fail('the inspector has no tab after a card was selected');
        tab.click();
      }
      const shown = await waitFor(() => dockHost()?.dataset.panel === 'inspector', 2000);
      if (!shown) fail('the dock did not switch to the inspector');
      await wait(60);
    };

    await record(results, 'the ≤1100 px rule ships a 46vw cap for the inspector', async () => {
      const cap = shippedPanelCap('inspector');
      if (!cap) fail('the stylesheet has no ≤1100 px rule setting --wb-dock-w for the inspector');
      const args = minArgs(cap.value);
      if (!args || args.length !== 2) fail(`the inspector's rule is “${cap.value}”, not a min() of two widths`);
      if (args[0] !== `${INSPECTOR_WIDTH}px`) {
        fail(`the inspector's rule caps “${args[0]}” instead of its own ${INSPECTOR_WIDTH}px`);
      }
      if (args[1] !== shareVw(INSPECTOR_SHARE)) {
        fail(`the inspector's rule caps at ${args[1]} instead of ${shareVw(INSPECTOR_SHARE)}`);
      }
      return { detail: `${cap.media} → min(${args[0]}, ${args[1]}), read from the shipped rule` };
    });

    await record(results, '…and a narrow window draws the inspector at 46vw', async () => {
      await openInspector();
      const wanted = cappedWidth(INSPECTOR_WIDTH, INSPECTOR_SHARE);
      const narrowest = Math.ceil(INSPECTOR_WIDTH / INSPECTOR_SHARE);
      if (wanted >= INSPECTOR_WIDTH - 1) {
        const share = globalThis.innerWidth * INSPECTOR_SHARE;
        return { skip: `the shipped ${shareVw(INSPECTOR_SHARE)} rule is checked above; ${shareVw(INSPECTOR_SHARE)} of this ${globalThis.innerWidth} px window is ${share.toFixed(0)} px, more than the ${INSPECTOR_WIDTH} px the inspector takes, so the cap cannot bind and its drawn width goes unmeasured here. A window ${narrowest} px or narrower draws it.` };
      }
      const visual = panelWidth();
      if (Math.abs(visual - wanted) > 1) {
        fail(`the inspector is ${visual.toFixed(1)} px wide at ${globalThis.innerWidth} px; ${shareVw(INSPECTOR_SHARE)} caps it at ${wanted.toFixed(1)}`);
      }
      return { detail: `${INSPECTOR_WIDTH} → ${wanted.toFixed(0)} px at ${globalThis.innerWidth} px wide` };
    });

    await record(results, 'the ≤1100 px rule moves a floating map to the left corner', async () => {
      const [rule] = narrowRules('.wb-stage > .wb-navigator');
      if (!rule) fail('the stylesheet has no ≤1100 px rule for a floating map on the stage');
      const right = rule.style?.getPropertyValue('right') ?? '';
      const left = rule.style?.getPropertyValue('left') ?? '';
      if (right !== 'auto') fail(`the floating map's narrow rule sets right: ${right || 'nothing'} instead of auto`);
      if (left !== `${FLOAT_INSET}px`) {
        fail(`the floating map's narrow rule sets left: ${left || 'nothing'} instead of ${FLOAT_INSET}px`);
      }
      return { detail: `${rule.media} → right: auto, left: ${FLOAT_INSET}px, read from the shipped rule` };
    });

    await record(results, '…and a floating map beside the inspector takes the left corner', async () => {
      await setPlacementVia(app, 'float');
      const map = navigatorPanel();
      if (!map || map.parentElement !== stage) fail('the navigator did not float onto the stage');
      if (map.classList.contains('hidden')) fail('the floating map is hidden beside the inspector');
      if (!stage.classList.contains('is-inspector-edge')) fail('the stage does not know the inspector holds its edge');
      const card = inspectorCard();
      if (!card) fail('the dock is not showing the inspector, so the map has nothing to sit beside');
      const rect = map.getBoundingClientRect();
      const inset = floatInset();
      if (Math.abs(inset - FLOAT_INSET) > 1) {
        fail(`the floating map sits ${inset.toFixed(1)} px from the stage's left edge instead of ${FLOAT_INSET}`);
      }
      // The inspector is drawn over the canvas's right edge, and on a narrow
      // canvas the two cards can want more room than the stage has: clearance is
      // only asked for where the corner leaves the map a place to sit.
      const room = card.left - stage.getBoundingClientRect().left - FLOAT_INSET;
      const clear = Math.round(card.left - rect.right);
      if (room >= rect.width + 1 && clear < -1) {
        fail(`the floating map reaches ${Math.round(rect.right)} px with ${Math.round(room)} px free beside it, under the inspector card at ${Math.round(card.left)} px`);
      }
      return {
        detail: room >= rect.width + 1
          ? `${Math.round(rect.width)}×${Math.round(rect.height)} at ${FLOAT_INSET} px from the left, ${clear} px clear of the inspector card`
          : `${Math.round(rect.width)}×${Math.round(rect.height)} at ${FLOAT_INSET} px from the left; the ${Math.round(card.width)} px card leaves ${Math.round(room)} px, so they meet on this ${globalThis.innerWidth} px canvas`,
      };
    });

    await record(results, '…and below the breakpoint it takes that corner without the inspector', async () => {
      // The inspector's own tab shuts it, which clears the selection with it,
      // so nothing but the media rule can be putting the map on the left.
      const tab = [...dockHost().querySelectorAll('.dock-tab')]
        .find((candidate) => candidate.textContent.trim().startsWith('Inspector'));
      if (tab && !tab.classList.contains('hidden')) tab.click();
      await wait(80);
      if (globalThis.innerWidth > CAP_BREAKPOINT) {
        return { skip: `the shipped corner is checked above and drawn beside the inspector at this ${globalThis.innerWidth} px window; the media rule alone only places a floating map when the window is ${CAP_BREAKPOINT} px or narrower, so the corner it takes with no inspector goes unmeasured here.` };
      }
      const map = navigatorPanel();
      if (!map || map.parentElement !== stage) fail('the navigator is not floating on the stage');
      if (map.classList.contains('hidden')) fail('the floating map is hidden with no inspector beside it');
      if (stage.classList.contains('is-inspector-edge')) fail('the stage still holds the inspector edge, so the inspector, not the rule, moves the map');
      const inset = floatInset();
      if (Math.abs(inset - FLOAT_INSET) > 1) {
        fail(`the floating map sits ${inset.toFixed(1)} px from the stage's left edge instead of ${FLOAT_INSET}`);
      }
      const fromRight = stage.getBoundingClientRect().right - map.getBoundingClientRect().right;
      if (fromRight <= FLOAT_INSET + 1) fail(`the floating map is ${fromRight.toFixed(1)} px from the right edge, not the left corner`);
      return { detail: `${FLOAT_INSET} px from the left at ${globalThis.innerWidth} px wide, ${Math.round(fromRight)} px short of the right corner` };
    });

    await record(results, 'the canvas is left with the settings it had', async () => {
      // The inspector's own tab shuts it, which clears the selection with it.
      const tab = [...dockHost().querySelectorAll('.dock-tab')]
        .find((candidate) => candidate.textContent.trim().startsWith('Inspector'));
      if (tab && !tab.classList.contains('hidden')) tab.click();
      await wait(80);
      const restored = Number.isFinite(original.navigatorWidth) ? original.navigatorWidth : DRAWER_NATURAL;
      app.updateSettings({
        worldbuild: {
          navigator: original.navigator !== false,
          navigatorDock: original.navigatorDock === 'drawer' ? 'drawer' : 'float',
          navigatorWidth: restored,
        },
      });
      await applyWidth(app, restored);
      await wait(80);
      if (picked && selectedAnchors().includes(picked)) fail(`the card ${picked} is still selected`);
      if (Math.round(appliedWidth()) !== appliedFor(restored)) {
        fail(`the drawer was left at ${appliedWidth()} px instead of ${appliedFor(restored)}`);
      }
      return { detail: `placement ${original.navigatorDock === 'drawer' ? 'drawer' : 'float'}, width ${original.navigatorWidth ?? DRAWER_NATURAL} px` };
    });
  } finally {
    document.querySelector('dialog.settings-dialog')?.close();
  }

  return reportSmoke('navigator smoke', 'wbNavSmoke', results);
}
