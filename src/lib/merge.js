/**
 * A line-by-line merge of a vein that changed in two places at once.
 *
 * The awkward case the viewer has to survive is the reader typing into a vein
 * while another program edits the same file. Keeping the draft and warning is
 * safe but throws the other edit away; this is the alternative — a three-way
 * merge, which is well defined here because the viewer knows the common
 * ancestor: `state.current.raw` is the text the document was rendered from, so
 * every line is either untouched, touched by the draft, touched by the disk, or
 * touched by both.
 *
 * The rules are the ones a merge tool uses, and the one that matters is the last:
 *
 * * changed only on one side        → that side wins, no question to ask;
 * * changed the same way on both    → the change is taken once;
 * * changed differently on both,
 *   but in different lines          → both changes survive;
 * * changed differently on both,
 *   in the same lines               → a conflict, marked with `<<<<<<<`,
 *                                     `=======` and `>>>>>>>` so the reader
 *                                     resolves it in the editor.
 *
 * The merged text never silently drops anything: `hasMergeMarkers` is what lets
 * the editor refuse to autosave a draft that still has a conflict in it.
 */

/** Whole-file fallback threshold for the line diff, in table cells. */
const MAX_CELLS = 4_000_000;

const MINE_LABEL = 'your draft';
const THEIRS_LABEL = 'changed on disk';

const markerStart = `<<<<<<< ${MINE_LABEL}`;
const markerMiddle = '=======';
const markerEnd = `>>>>>>> ${THEIRS_LABEL}`;

const splitLines = (text) => String(text ?? '').split('\n');
const joinLines = (lines) => lines.join('\n');
const sameLines = (a, b) => a.length === b.length && a.every((line, i) => line === b[i]);

/**
 * The lines this text would have to change to become `other`, as hunks:
 * base lines `[baseStart, baseEnd)` replaced by `lines` (empty `lines` is a
 * deletion, `baseStart === baseEnd` an insertion).
 *
 * The common prefix and suffix are trimmed first, which is what keeps the table
 * small in practice: a one-line edit in a 5,000-line vein diffs one line.
 */
export function diffLines(base, other) {
  const baseLines = Array.isArray(base) ? base : splitLines(base);
  const otherLines = Array.isArray(other) ? other : splitLines(other);
  const hunks = [];

  let head = 0;
  while (head < baseLines.length && head < otherLines.length && baseLines[head] === otherLines[head]) head += 1;
  let baseEnd = baseLines.length;
  let otherEnd = otherLines.length;
  while (baseEnd > head && otherEnd > head && baseLines[baseEnd - 1] === otherLines[otherEnd - 1]) {
    baseEnd -= 1;
    otherEnd -= 1;
  }

  const a = baseLines.slice(head, baseEnd);
  const b = otherLines.slice(head, otherEnd);
  if (!a.length && !b.length) return hunks;
  if (!a.length) return [{ baseStart: head, baseEnd: head, lines: b.slice() }];
  if (!b.length) return [{ baseStart: head, baseEnd: baseEnd, lines: [] }];
  // Too much to align line by line: report it as one whole-region change rather
  // than pretend. The merge that follows then offers the reader both versions.
  if (a.length * b.length > MAX_CELLS) {
    return [{ baseStart: head, baseEnd: baseEnd, lines: b.slice() }];
  }

  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * width + j] = a[i] === b[j]
        ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }

  let hunk = null;
  const open = (at) => {
    if (!hunk) hunk = { baseStart: at, baseEnd: at, lines: [] };
    return hunk;
  };
  const close = () => {
    if (hunk) hunks.push(hunk);
    hunk = null;
  };

  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      close();
      i += 1;
      j += 1;
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      open(i).baseEnd = i + 1;
      i += 1;
    } else {
      open(i).lines.push(b[j]);
      j += 1;
    }
  }
  while (i < a.length) {
    open(i).baseEnd = i + 1;
    i += 1;
  }
  while (j < b.length) {
    open(Math.max(0, a.length)).lines.push(b[j]);
    j += 1;
  }
  close();

  // Back to absolute base indices.
  return hunks.map((entry) => ({
    baseStart: entry.baseStart + head,
    baseEnd: entry.baseEnd + head,
    lines: entry.lines,
  }));
}

/** Apply non-overlapping hunks to a slice of the base that starts at `offset`. */
function applyHunks(region, hunks, offset) {
  const out = [];
  let cursor = 0;
  const ordered = [...hunks].sort((left, right) => left.baseStart - right.baseStart
    || left.baseEnd - right.baseEnd
    || (left.side === right.side ? 0 : left.side === 'mine' ? -1 : 1));
  for (const hunk of ordered) {
    const start = Math.max(0, hunk.baseStart - offset);
    const end = Math.max(start, Math.min(region.length, hunk.baseEnd - offset));
    if (start > cursor) out.push(...region.slice(cursor, start));
    out.push(...hunk.lines);
    cursor = Math.max(cursor, end);
  }
  out.push(...region.slice(cursor));
  return out;
}

/** Do two hunks disagree about the same base lines? */
function clashes(left, right) {
  const low = Math.max(left.baseStart, right.baseStart);
  const high = Math.min(left.baseEnd, right.baseEnd);
  if (low < high) return true;
  if (low > high) return false;
  const leftEmpty = left.baseStart === left.baseEnd;
  const rightEmpty = right.baseStart === right.baseEnd;
  // Touching ranges are fine — one rewrite ending where another begins — except
  // when both sides *insert* at the same point, or one inserts inside the range
  // the other rewrites. Those are real disagreements about the same place.
  if (leftEmpty && rightEmpty) return true;
  if (leftEmpty) return right.baseStart < left.baseStart && left.baseStart < right.baseEnd;
  if (rightEmpty) return left.baseStart < right.baseStart && right.baseStart < left.baseEnd;
  return false;
}

/** Group hunks whose base ranges touch, so each group is decided at once. */
function clustersFor(mineHunks, theirsHunks) {
  const all = [
    ...mineHunks.map((hunk) => ({ ...hunk, side: 'mine' })),
    ...theirsHunks.map((hunk) => ({ ...hunk, side: 'theirs' })),
  ].sort((left, right) => left.baseStart - right.baseStart || left.baseEnd - right.baseEnd);

  const clusters = [];
  for (const hunk of all) {
    const last = clusters[clusters.length - 1];
    if (last && hunk.baseStart <= last.end) {
      last.hunks.push(hunk);
      last.end = Math.max(last.end, hunk.baseEnd);
    } else {
      clusters.push({ start: hunk.baseStart, end: hunk.baseEnd, hunks: [hunk] });
    }
  }
  return clusters;
}

/**
 * Merge a vein that changed on both sides.
 *
 * @param {object} input
 * @param {string|null} input.base   the text both sides started from; null when
 *   there is no ancestor to compare against, which is the one case a merge
 *   cannot answer
 * @param {string} input.mine        the draft in the editor
 * @param {string} input.theirs      the text on disk now
 * @returns {{
 *   supported: boolean, text: string, lines: string[], clean: boolean,
 *   conflicts: number, mineOnly: number, theirsOnly: number, agreed: number,
 *   reason: string|null, unchanged: boolean,
 *   parts: Array<{kind: 'same'|'mine'|'theirs'|'both'|'conflict', lines: string[]}>
 * }}
 *   `unchanged` means `text === mine`: the draft already says what both sides say.
 */
export function mergeVein({ base = null, mine = '', theirs = '' } = {}) {
  const mineLines = splitLines(mine);
  const theirsLines = splitLines(theirs);

  if (base === null || base === undefined) {
    return report({ lines: mineLines, clean: false, reason: 'no-base', supported: false });
  }

  const baseLines = splitLines(base);

  // Same text on both sides: the draft is already what the disk says, so there is
  // nothing to merge and nothing to resolve.
  if (sameLines(mineLines, theirsLines)) {
    return report({
      lines: mineLines,
      parts: [{ kind: 'both', lines: mineLines }],
      draft: mine,
    });
  }
  // One side untouched: hand over the other one. (A draft that never differed
  // from the base is the common case — the file simply moved on.)
  if (sameLines(baseLines, mineLines)) {
    return report({
      lines: theirsLines,
      parts: [{ kind: 'theirs', lines: theirsLines }],
      theirsOnly: 1,
      draft: mine,
    });
  }
  if (sameLines(baseLines, theirsLines)) {
    return report({
      lines: mineLines,
      parts: [{ kind: 'mine', lines: mineLines }],
      mineOnly: 1,
      draft: mine,
    });
  }

  const mineHunks = diffLines(baseLines, mineLines);
  const theirsHunks = diffLines(baseLines, theirsLines);
  const parts = [];
  let conflicts = 0;
  let mineOnly = 0;
  let theirsOnly = 0;
  let agreed = 0;

  let cursor = 0;
  const push = (kind, lines) => {
    if (!lines.length) return;
    const last = parts[parts.length - 1];
    if (last && last.kind === kind) last.lines.push(...lines);
    else parts.push({ kind, lines: [...lines] });
  };
  /**
   * A region both sides edited in different lines: name the side each hunk came
   * from, so the preview can say which of these lines are the disk's.
   */
  const pushAttributed = (region, hunks, offset) => {
    let at = 0;
    for (const hunk of [...hunks].sort((left, right) => left.baseStart - right.baseStart || left.baseEnd - right.baseEnd)) {
      const start = Math.max(0, hunk.baseStart - offset);
      const end = Math.max(start, Math.min(region.length, hunk.baseEnd - offset));
      push('same', region.slice(at, start));
      push(hunk.side, hunk.lines);
      at = Math.max(at, end);
    }
    push('same', region.slice(at));
  };

  for (const cluster of clustersFor(mineHunks, theirsHunks)) {
    push('same', baseLines.slice(cursor, cluster.start));
    cursor = cluster.end;

    const region = baseLines.slice(cluster.start, cluster.end);
    const mineSide = cluster.hunks.filter((hunk) => hunk.side === 'mine');
    const theirsSide = cluster.hunks.filter((hunk) => hunk.side === 'theirs');
    const mineRegion = applyHunks(region, mineSide, cluster.start);
    const theirsRegion = applyHunks(region, theirsSide, cluster.start);

    if (sameLines(mineRegion, theirsRegion)) {
      // Both sides made the same edit.
      push('both', mineRegion);
      agreed += 1;
    } else if (sameLines(theirsRegion, region)) {
      // Only the draft changed these lines.
      push('mine', mineRegion);
      mineOnly += 1;
    } else if (sameLines(mineRegion, region)) {
      // Only the disk changed these lines.
      push('theirs', theirsRegion);
      theirsOnly += 1;
    } else if (!mineSide.some((left) => theirsSide.some((right) => clashes(left, right)))) {
      // Different lines inside one cluster: both edits survive, nothing to ask.
      pushAttributed(region, [...mineSide, ...theirsSide], cluster.start);
      agreed += 1;
    } else {
      push('conflict', [markerStart, ...mineRegion, markerMiddle, ...theirsRegion, markerEnd]);
      conflicts += 1;
    }
  }
  push('same', baseLines.slice(cursor));

  return report({
    lines: parts.flatMap((part) => part.lines),
    parts,
    conflicts,
    mineOnly,
    theirsOnly,
    agreed,
    draft: mine,
  });
}

function report({
  lines,
  parts = null,
  conflicts = 0,
  mineOnly = 0,
  theirsOnly = 0,
  agreed = 0,
  clean,
  reason = null,
  supported = true,
  draft = '',
}) {
  const text = joinLines(lines);
  return {
    supported,
    text,
    lines,
    parts: parts ?? [{ kind: 'same', lines }],
    clean: clean ?? conflicts === 0,
    conflicts,
    mineOnly,
    theirsOnly,
    agreed,
    // The merged text is exactly the draft: nothing to apply, nothing to resolve.
    unchanged: text === String(draft ?? ''),
    reason,
  };
}

/**
 * Markers *this* application wrote, labelled the way `mergeVein` labels them.
 *
 * Autosave and the save warning key off these two labelled lines rather than off
 * any `<<<<<<<`, so a vein that quotes a git conflict in its prose — or a setext
 * heading, which is a line of `=======` — is not mistaken for an unresolved
 * merge of ours.
 */
export function hasMergeMarkers(text) {
  // Only the two labelled lines: a line of `=======` on its own is a markdown
  // setext heading as easily as it is the middle of a conflict.
  return splitLines(text).some((line) => line.startsWith(markerStart) || line.startsWith(markerEnd));
}

/** How many conflicts this application's markers record. */
export function countConflicts(text) {
  return splitLines(text).filter((line) => line.startsWith(markerStart)).length;
}

/** One line for the toast, the dialog and the session log. */
export function describeMerge(result) {
  if (!result?.supported) return 'the two versions cannot be merged line by line';
  if (result.unchanged) return 'no changes · no conflicts';
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const kept = [];
  if (result.theirsOnly) kept.push(`${plural(result.theirsOnly, 'change')} from disk`);
  if (result.mineOnly) kept.push(`${plural(result.mineOnly, 'change')} of yours`);
  if (result.agreed) kept.push(`${plural(result.agreed, 'change')} both sides made`);
  const summary = kept.length ? kept.join(', ') : 'no changes';
  if (result.conflicts) return `${summary} · ${plural(result.conflicts, 'conflict')} to resolve`;
  return `${summary} · no conflicts`;
}

/** The labels the markers carry, for the dialog to explain them. */
export const MERGE_LABELS = { mine: MINE_LABEL, theirs: THEIRS_LABEL };
