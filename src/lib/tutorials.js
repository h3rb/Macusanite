/**
 * The teaching notes the window shows, and the record of which ones a reader
 * has closed.
 *
 * A note is closed with its own control — “Got it” on the object-map note, “×”
 * beside the search tip and the editor hint — and remembered once for the whole
 * installation, stamped so a reader can see when they decided. The record is
 * `tutorials.json` beside the vault list in the local-storage folder
 * (`<CurrentUser>/Documents/macusanite/localstorage` on the desktop, a
 * `localStorage` key in a plain browser), so a note dismissed in one vault
 * stays dismissed in the next. It stays closed until **Settings → Reading →
 * Reset tutorials** forgets the record, which is also what makes the notes
 * teach again after a reader has turned the whole set off and back on: the
 * master switch (`tutorials: false`) hides the notes but never forgets them.
 *
 * The ids are written into that file, so they are stable: adding a note is a
 * new id, and renaming one would strand every reader's decision.
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

/** File name inside the installation's local-storage folder. */
export const TUTORIALS_FILE = 'tutorials.json';

/** The record shape's version, so a future build can migrate old files. */
export const TUTORIALS_VERSION = 1;

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

/** A brand-new record: nothing closed, nothing to remember. */
export function emptyTutorialRecord() {
  return { version: TUTORIALS_VERSION, seen: {} };
}

/**
 * A record read from `tutorials.json`, or from whatever is on disk there.
 *
 * A damaged file is an empty record rather than an error — a note that teaches
 * twice is a far smaller harm than a window that will not start — and a bare map
 * (a file written by hand, or before the version frame existed) is read as its
 * own `seen` map.
 */
export function parseTutorialRecord(raw) {
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return emptyTutorialRecord();
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyTutorialRecord();
  const seen = 'seen' in value ? value.seen : value;
  return { version: TUTORIALS_VERSION, seen: cleanTutorialSeen(seen) };
}

/**
 * The record as the file keeps it: plain, pretty JSON, so a reader can inspect
 * or edit it by hand.
 */
export function serializeTutorialRecord(record) {
  const seen = cleanTutorialSeen(record && typeof record === 'object' ? record.seen ?? record : null);
  return `${JSON.stringify({ version: TUTORIALS_VERSION, seen }, null, 2)}\n`;
}

/**
 * Every decision from every record given, by id. Used when a vault opened by an
 * older build still carries its own closed notes: they join the installation's
 * record instead of being forgotten.
 */
export function mergeTutorialSeen(...records) {
  const out = {};
  for (const record of records) {
    Object.assign(out, cleanTutorialSeen(record && typeof record === 'object' ? record.seen ?? record : null));
  }
  return out;
}
