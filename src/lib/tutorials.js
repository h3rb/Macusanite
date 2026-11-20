/**
 * The teaching notes the window shows, and the record of which ones a reader
 * has closed.
 *
 * A note is closed with its own control — “Got it” on the object-map note, “×”
 * beside the search tip and the editor hint — and remembered in `settings.json`
 * under `tutorialSeen`, stamped so a reader can see when they decided. It stays
 * closed for that vault until **Settings → Reading → Reset tutorials** forgets
 * the record, which is also what makes the notes teach again after a reader has
 * turned the whole set off and back on: the master switch (`tutorials: false`)
 * hides the notes but never forgets them.
 *
 * The ids are written into saved settings, so they are stable: adding a note is
 * a new id, and renaming one would strand every reader's decision.
 */

export const TUTORIALS = [
  {
    id: 'object-map',
    label: 'Object map',
    where: 'The worldbuilding canvas, the first time it passes below 65%',
  },
  {
    id: 'search-quote',
    label: 'Quoted search',
    where: 'The search pane, while the query is empty',
  },
  {
    id: 'editor-shortcuts',
    label: 'Editor shortcuts',
    where: 'The markdown source toolbar',
  },
];

export const TUTORIAL_IDS = TUTORIALS.map((tutorial) => tutorial.id);

const TUTORIAL_ID_SET = new Set(TUTORIAL_IDS);

/**
 * How long a remembered stamp may be. Real values are ISO timestamps; the
 * migration from the older `lowZoomTipSeen` flag writes `legacy`, because that
 * decision was made before there was a place to write the date.
 */
const SEEN_STAMP_MAX = 40;

/** Whether `id` names a note this build knows how to show. */
export function tutorialIsKnown(id) {
  return TUTORIAL_ID_SET.has(String(id ?? ''));
}

/**
 * A record that can be trusted: known notes only, each with a non-empty stamp.
 * Anything else — a hand-edited id, a boolean from an older file, a note this
 * build no longer has — is dropped rather than carried as a decision nothing
 * can honour.
 */
export function cleanTutorialSeen(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [id, value] of Object.entries(raw)) {
    if (!TUTORIAL_ID_SET.has(id)) continue;
    if (typeof value !== 'string' || !value.trim()) continue;
    out[id] = value.trim().slice(0, SEEN_STAMP_MAX);
  }
  return out;
}

/** Whether this note has been closed and should stay closed. */
export function tutorialWasSeen(seen, id) {
  return tutorialIsKnown(id) && Boolean(cleanTutorialSeen(seen)[id]);
}

/**
 * Remember that a note was closed, stamped when it happened. Marking one that
 * is already closed refreshes the stamp only — it is one decision, not a count.
 */
export function markTutorialSeen(seen, id, at = new Date().toISOString()) {
  if (!tutorialIsKnown(id)) return cleanTutorialSeen(seen);
  const next = cleanTutorialSeen(seen);
  const stamp = String(at ?? '').trim().slice(0, SEEN_STAMP_MAX);
  next[id] = stamp || new Date().toISOString();
  return next;
}

/** Every note may teach again: the reset behind Settings → Reading. */
export function clearTutorialSeen() {
  return {};
}
