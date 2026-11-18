/**
 * The worldbuilding record, read and written by the headless tools.
 *
 * The canvas keeps a vein's layout in `.macusanite/state.json` under `world`,
 * beside the markdown it belongs to. The window edits that record through
 * `main.js`; the CLI and the MCP server edit it here, using the same pure
 * helpers from [worldbuild.js](worldbuild.js) the panel uses — so a card moved
 * by an agent is the same card the canvas draws, with the same migration,
 * cleaning, pruning and history rules.
 *
 * A patch merges: maps are keyed by card anchor (or group id), so naming one
 * card never disturbs the rest, and `null` removes an entry. Arrays — stack
 * order and saved views — replace as a whole, because their order is the
 * value. A `null` slice clears it.
 *
 * Nothing here touches a filesystem: a caller passes a parsed state object and
 * gets the next one back, which is what makes the record testable without a
 * vault.
 */
import {
  CANVAS_SCHEMA,
  DEFAULT_STEP_NAME,
  canvasRecordPatch,
  canvasSnapshot,
  cleanAnnotations,
  cleanBondNotes,
  cleanCardDims,
  cleanCardModes,
  cleanCardSizes,
  cleanCollapsedGroups,
  cleanGroups,
  cleanHistoryStack,
  cleanNodeResources,
  cleanPositions,
  cleanSavedViews,
  cleanStackOrder,
  cleanView,
  historyJump,
  migrateCanvasRecord,
  nodeFields,
  nodeType,
  nodeTypeOf,
  normalizeRouting,
  pushHistoryStep,
  relationKind,
  restoreSnapshot,
  setNodeField,
} from './worldbuild.js';

/** The canvas keeps 60 steps per vein; the headless tools keep the same stack. */
export const CANVAS_HISTORY_LIMIT = 60;

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** The slices `world set` accepts: every part of a canvas record except `marked` and `history`. */
export const CANVAS_PATCH_KEYS = [
  'positions',
  'groups',
  'relations',
  'bondNotes',
  'folded',
  'types',
  'fields',
  'colors',
  'images',
  'resources',
  'pinned',
  'locked',
  'cardModes',
  'cardSizes',
  'cardDims',
  'stack',
  'collapsedGroups',
  'annotations',
  'savedViews',
  'view',
  'routing',
  'pushAside',
];

/** Record parts that mean the vein has canvas work worth keeping when unmarked. */
const WORK_KEYS = [
  'positions', 'relations', 'bondNotes', 'types', 'fields', 'folded', 'view', 'groups',
  'colors', 'images', 'resources', 'pinned', 'locked', 'annotations', 'routing',
  'pushAside', 'history', 'cardModes', 'cardSizes', 'cardDims', 'stack',
  'collapsedGroups', 'savedViews', 'tables',
];

/** True when anything but `schema`/`marked` is stored for the vein. */
export function hasCanvasWork(record) {
  const holdsSomething = (value) => {
    if (value === null || value === undefined || value === false || value === '') return false;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'object') return Object.keys(value).length > 0;
    return true;
  };
  return WORK_KEYS.some((key) => holdsSomething(record?.[key]));
}

/** A vein's record from a parsed state object, migrated to the current schema. */
export function canvasRecordFrom(state, path) {
  return migrateCanvasRecord(state?.world?.[path] ?? {});
}

/** The anchors the vein actually has a heading for. */
export function anchorsOf(model) {
  return new Set((model?.notes ?? []).map((note) => note.anchor));
}

/** The id of the group holding one anchor, or null. */
function groupOf(record, anchor) {
  for (const [id, group] of Object.entries(record.groups ?? {})) {
    if ((group.members ?? []).includes(anchor)) return id;
  }
  return null;
}

/**
 * One row per card, as `world show` reports it: where it sits, how it is
 * drawn, and what the record knows about it beside its markdown.
 */
export function canvasCards(model, record) {
  return (model?.notes ?? []).map((note) => ({
    anchor: note.anchor,
    title: note.title,
    level: note.level,
    type: nodeTypeOf(record.types, note.anchor).id,
    fields: { ...(record.fields?.[note.anchor] ?? {}) },
    group: groupOf(record, note.anchor),
    position: record.positions?.[note.anchor] ?? null,
    folded: record.folded?.[note.anchor]?.card === true,
    pinned: record.pinned?.[note.anchor] === true,
    locked: record.locked?.[note.anchor] ?? false,
    mode: record.cardModes?.[note.anchor] ?? 'full',
    size: record.cardSizes?.[note.anchor] ?? null,
    dims: record.cardDims?.[note.anchor] ?? null,
    color: record.colors?.[note.anchor] ?? null,
    image: record.images?.[note.anchor] ?? null,
    resources: record.resources?.[note.anchor] ?? { files: [], urls: [] },
  }));
}

/** The canvas's groups, with the drawing state the record keeps for each. */
export function canvasGroups(record) {
  return Object.entries(record.groups ?? {}).map(([id, group]) => ({
    id,
    name: group.name ?? '',
    members: [...(group.members ?? [])],
    children: [...(group.children ?? [])],
    color: group.color ?? null,
    icon: group.icon ?? null,
    pinned: group.pinned === true,
    locked: group.locked === true,
    collapsed: record.collapsedGroups?.[id] === true,
    frame: group.frame ?? null,
  }));
}

/** Every asserted bond, with its kind and the note it carries. */
export function canvasBonds(record) {
  const notes = cleanBondNotes(record.bondNotes);
  const bonds = [];
  for (const [key, kind] of Object.entries(record.relations ?? {})) {
    const [from, to] = key.split('->');
    if (!from || !to) continue;
    bonds.push({ from, to, kind, note: notes[key] ?? null });
  }
  return bonds;
}

/** The two stacks as names only: the snapshots are large and private to a jump. */
export function canvasCheckpoints(record) {
  const stack = cleanHistoryStack(record.history, CANVAS_HISTORY_LIMIT);
  return {
    past: [...stack.past].reverse().map((entry, index) => ({ name: entry.name, stepsBack: index + 1 })),
    future: [...stack.future].reverse().map((entry, index) => ({ name: entry.name, stepsForward: index + 1 })),
    undo: stack.past.length,
    redo: stack.future.length,
  };
}

/** The one-line inventory `world list` prints for a vein. */
export function canvasSummary(path, model, record, exists = true) {
  const checkpoints = canvasCheckpoints(record);
  return {
    path,
    exists,
    marked: record.marked === true,
    cards: model?.notes?.length ?? 0,
    groups: Object.keys(record.groups ?? {}).length,
    bonds: Object.keys(record.relations ?? {}).length,
    annotations: Object.keys(cleanAnnotations(record.annotations)).length,
    steps: checkpoints.undo + checkpoints.redo,
  };
}

/** The full canvas `world show` reports. */
export function canvasDetail(path, model, record) {
  return {
    path,
    marked: record.marked === true,
    schema: record.schema ?? CANVAS_SCHEMA,
    cards: canvasCards(model, record),
    groups: canvasGroups(record),
    bonds: canvasBonds(record),
    annotations: Object.values(cleanAnnotations(record.annotations)),
    views: cleanSavedViews(record.savedViews),
    checkpoints: canvasCheckpoints(record),
    view: cleanView(record.view) ?? { x: 0, y: 0, s: 1 },
    routing: normalizeRouting(record.routing),
    pushAside: record.pushAside === true,
  };
}

/* ─────────────────────────────────────────────────────── writing ─────── */

function requireObject(value, slice) {
  if (!isPlainObject(value)) throw new Error(`${slice} must be an object keyed by card anchor`);
  return value;
}

function checkAnchors(value, slice, live) {
  if (!live) return;
  const missing = Object.keys(value).filter((anchor) => !live.has(anchor));
  if (missing.length) {
    throw new Error(`${slice} names card${missing.length === 1 ? '' : 's'} the vein has no heading for: ${missing.join(', ')}`);
  }
}

/** Validate a patch's map entries, skipping the `null`s that mean "remove". */
function mapOf(value, slice, check) {
  const out = {};
  for (const [key, raw] of Object.entries(requireObject(value, slice))) {
    if (!key || raw === null) continue;
    out[key] = check(raw, key);
  }
  return out;
}

const removable = (value) => Object.fromEntries(Object.entries(value).filter(([, raw]) => raw !== null));

/**
 * Merge an anchor-keyed slice over the record: the named entries change,
 * everything else stays, and `null` forgets one entry. A `null` slice clears
 * the whole map.
 */
function mergeAnchors(previous, raw, slice, check, clean = null) {
  if (raw === null) return {};
  requireObject(raw, slice);
  const cleaned = mapOf(raw, slice, check);
  const merged = { ...(previous ?? {}) };
  for (const key of Object.keys(removable(raw))) merged[key] = cleaned[key];
  for (const key of Object.keys(raw).filter((key) => raw[key] === null)) delete merged[key];
  return clean ? clean(merged) : merged;
}

const stringRef = (value, key, slice) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${slice}.${key} must be a non-empty string`);
  return value.trim();
};

/**
 * Apply one canvas patch over a record.
 *
 * Every slice is validated with the same cleaners the window uses: unknown
 * anchors, types, fields and relationship kinds are refused rather than
 * silently dropped, so a typo in an agent's patch is reported instead of
 * half-applied. Map slices merge, arrays replace, and `null` removes an entry
 * or clears a slice. Anchor-bearing slices are then pruned to the cards the
 * vein actually has, exactly as the window prunes a reloaded record — a
 * heading deleted in the editor can never leave a bond behind.
 *
 * @returns {object} the next record, history untouched
 */
export function applyCanvasPatch(record, patch, live = null) {
  if (!isPlainObject(patch)) throw new Error('patch must be a JSON object');
  const unknown = Object.keys(patch).filter((key) => !CANVAS_PATCH_KEYS.includes(key));
  if (unknown.length) {
    throw new Error(`unknown canvas slice: ${unknown.join(', ')} — allowed: ${CANVAS_PATCH_KEYS.join(', ')}`);
  }
  if (!Object.keys(patch).length) throw new Error('the patch is empty — nothing to change');

  const next = migrateCanvasRecord(record);

  if ('positions' in patch) {
    checkAnchors(removable(requireObject(patch.positions ?? {}, 'positions')), 'positions', live);
    next.positions = mergeAnchors(next.positions, patch.positions, 'positions', (value, anchor) => {
      if (!isPlainObject(value) || !Number.isFinite(value.x) || !Number.isFinite(value.y)) {
        throw new Error(`positions.${anchor} needs finite x and y`);
      }
      return { x: Math.round(value.x), y: Math.round(value.y) };
    }, cleanPositions);
  }

  if ('groups' in patch) {
    if (patch.groups === null) {
      next.groups = {};
    } else {
      const raw = requireObject(patch.groups, 'groups');
      const cleaned = cleanGroups(raw);
      const merged = { ...(next.groups ?? {}) };
      for (const [id, group] of Object.entries(raw)) {
        if (group === null) {
          delete merged[id];
          continue;
        }
        if (!cleaned[id]) throw new Error(`groups.${id} is not a usable group`);
        merged[id] = cleaned[id];
      }
      next.groups = merged;
      for (const [id, group] of Object.entries(cleaned)) {
        checkAnchors(Object.fromEntries((group.members ?? []).map((member) => [member, true])), `groups.${id}.members`, live);
      }
    }
  }

  if ('relations' in patch) {
    const raw = patch.relations === null ? {} : requireObject(patch.relations, 'relations');
    const merged = patch.relations === null ? {} : { ...(next.relations ?? {}) };
    for (const [key, value] of Object.entries(raw)) {
      const ends = key.split('->');
      if (ends.length !== 2 || !ends[0] || !ends[1]) throw new Error(`relations.${key} must be written "from->to"`);
      if (value === null) {
        delete merged[key];
        continue;
      }
      const kind = relationKind(value);
      if (!kind) throw new Error(`relations.${key} uses an unknown relationship kind: ${value}`);
      merged[key] = kind.id;
    }
    next.relations = merged;
    for (const key of Object.keys(next.relations)) {
      for (const end of key.split('->')) {
        if (live && !live.has(end) && !(end.startsWith('group:') && next.groups?.[end.slice(6)])) {
          throw new Error(`relations.${key} names ${end}, which is neither a card nor a group on this canvas`);
        }
      }
    }
    // A note explains a bond; with the bond gone it has nothing to say.
    const notes = { ...(next.bondNotes ?? {}) };
    for (const key of Object.keys(notes)) if (!next.relations[key]) delete notes[key];
    next.bondNotes = cleanBondNotes(notes);
  }

  if ('bondNotes' in patch) {
    const raw = patch.bondNotes === null ? {} : requireObject(patch.bondNotes, 'bondNotes');
    const merged = patch.bondNotes === null ? {} : { ...(next.bondNotes ?? {}) };
    for (const [key, value] of Object.entries(raw)) {
      if (value === null || String(value).trim() === '') delete merged[key];
      else merged[key] = value;
    }
    next.bondNotes = cleanBondNotes(merged);
    for (const key of Object.keys(next.bondNotes)) {
      if (!next.relations?.[key]) throw new Error(`bondNotes.${key} has no assert-ed relationship to describe`);
    }
  }

  if ('folded' in patch) {
    next.folded = mergeAnchors(next.folded, patch.folded, 'folded', (value, anchor) => {
      if (value === true || value?.card === true) return { card: true };
      throw new Error(`folded.${anchor} must be true or { "card": true }`);
    });
  }

  if ('types' in patch) {
    next.types = mergeAnchors(next.types, patch.types, 'types', (value, anchor) => {
      const known = nodeType(value);
      if (!known) throw new Error(`types.${anchor} is not a node type: ${value}`);
      return known.id;
    });
  }

  if ('fields' in patch) {
    if (patch.fields === null) {
      next.fields = {};
    } else {
      const raw = requireObject(patch.fields, 'fields');
      const merged = { ...(next.fields ?? {}) };
      for (const [anchor, value] of Object.entries(raw)) {
        if (value === null) {
          delete merged[anchor];
          continue;
        }
        if (!isPlainObject(value)) throw new Error(`fields.${anchor} must be an object of field values`);
        if (live && !live.has(anchor)) throw new Error(`fields names card ${anchor}, which the vein has no heading for`);
        const type = next.types?.[anchor] ?? record.types?.[anchor] ?? 'note';
        let pair = { ...(merged[anchor] ?? {}) };
        for (const [field, fieldValue] of Object.entries(value)) {
          if (!nodeFields(type).some((spec) => spec.id === field)) {
            throw new Error(`fields.${anchor}.${field} is not a field of a ${type} card`);
          }
          if (fieldValue === null) {
            delete pair[field];
            continue;
          }
          const applied = setNodeField({ [anchor]: pair }, type, anchor, field, fieldValue);
          pair = applied[anchor] ?? {};
        }
        if (Object.keys(pair).length) merged[anchor] = pair;
        else delete merged[anchor];
      }
      next.fields = merged;
    }
  }

  if ('colors' in patch) {
    next.colors = mergeAnchors(next.colors, patch.colors, 'colors', (value, anchor) => stringRef(value, anchor, 'colors'));
  }

  if ('images' in patch) {
    next.images = mergeAnchors(next.images, patch.images, 'images', (value, anchor) => stringRef(value, anchor, 'images'));
  }

  if ('resources' in patch) {
    if (patch.resources === null) {
      next.resources = {};
    } else {
      const raw = requireObject(patch.resources, 'resources');
      checkAnchors(removable(raw), 'resources', live);
      const merged = { ...(next.resources ?? {}) };
      for (const [anchor, entry] of Object.entries(raw)) {
        if (entry === null) delete merged[anchor];
        else if (!isPlainObject(entry)) throw new Error(`resources.${anchor} must be an object of files and URLs`);
        else merged[anchor] = entry;
      }
      next.resources = cleanNodeResources(merged);
    }
  }

  if ('pinned' in patch) {
    next.pinned = mergeAnchors(next.pinned, patch.pinned, 'pinned', (value, anchor) => {
      if (value !== true) throw new Error(`pinned.${anchor} must be true (use null to unpin)`);
      return true;
    });
  }

  if ('locked' in patch) {
    next.locked = mergeAnchors(next.locked, patch.locked, 'locked', (value, anchor) => {
      if (value === true || value === 'frozen') return value;
      throw new Error(`locked.${anchor} must be true or "frozen" (use null to unlock)`);
    });
  }

  if ('cardModes' in patch) {
    next.cardModes = mergeAnchors(next.cardModes, patch.cardModes, 'cardModes', (value, anchor) => {
      if (!['full', 'compact', 'thumbnail'].includes(value)) throw new Error(`cardModes.${anchor} must be full, compact or thumbnail`);
      return value;
    }, cleanCardModes);
  }

  if ('cardSizes' in patch) {
    next.cardSizes = mergeAnchors(next.cardSizes, patch.cardSizes, 'cardSizes', (value, anchor) => {
      if (!['fixed', 'content'].includes(value)) throw new Error(`cardSizes.${anchor} must be fixed or content`);
      return value;
    }, cleanCardSizes);
  }

  if ('cardDims' in patch) {
    next.cardDims = mergeAnchors(next.cardDims, patch.cardDims, 'cardDims', (value, anchor) => {
      if (!isPlainObject(value) || !Number.isFinite(Number(value.width)) || !Number.isFinite(Number(value.height))) {
        throw new Error(`cardDims.${anchor} needs numeric width and height`);
      }
      return { width: Number(value.width), height: Number(value.height) };
    }, cleanCardDims);
  }

  if ('stack' in patch) {
    if (patch.stack === null) next.stack = [];
    else {
      if (!Array.isArray(patch.stack)) throw new Error('stack must be an array of card anchors, bottom to top');
      next.stack = cleanStackOrder(patch.stack);
      if (live) {
        const missing = next.stack.filter((anchor) => !live.has(anchor));
        if (missing.length) throw new Error(`stack names card${missing.length === 1 ? '' : 's'} the vein has no heading for: ${missing.join(', ')}`);
      }
    }
  }

  if ('collapsedGroups' in patch) {
    if (patch.collapsedGroups === null) {
      next.collapsedGroups = {};
    } else {
      const raw = requireObject(patch.collapsedGroups, 'collapsedGroups');
      const merged = { ...(next.collapsedGroups ?? {}) };
      for (const [id, value] of Object.entries(raw)) {
        if (value === true) merged[id] = true;
        else delete merged[id];
      }
      next.collapsedGroups = cleanCollapsedGroups(merged);
      for (const id of Object.keys(next.collapsedGroups)) {
        if (!next.groups?.[id]) throw new Error(`collapsedGroups names group ${id}, which is not on this canvas`);
      }
    }
  }

  if ('annotations' in patch) {
    if (patch.annotations === null) {
      next.annotations = {};
    } else {
      const raw = requireObject(patch.annotations, 'annotations');
      for (const [id, value] of Object.entries(raw)) {
        if (value === null) continue;
        if (!isPlainObject(value) || !Number.isFinite(value.x) || !Number.isFinite(value.y) || !String(value.text ?? '').trim()) {
          throw new Error(`annotations.${id} needs finite x and y and some text`);
        }
      }
      next.annotations = cleanAnnotations({ ...(next.annotations ?? {}), ...raw });
    }
  }

  if ('savedViews' in patch) {
    if (patch.savedViews === null) next.savedViews = [];
    else {
      if (!Array.isArray(patch.savedViews)) throw new Error('savedViews must be an array');
      next.savedViews = cleanSavedViews(patch.savedViews);
    }
  }

  if ('view' in patch) {
    const view = cleanView(patch.view);
    if (!view) throw new Error('view needs finite x and y (and an optional numeric s)');
    next.view = view;
  }

  if ('routing' in patch) {
    if (patch.routing === null) {
      next.routing = normalizeRouting({});
    } else {
      const current = normalizeRouting(next.routing);
      const changed = requireObject(patch.routing, 'routing');
      next.routing = normalizeRouting({
        ...current,
        ...changed,
        edges: { ...current.edges, ...(isPlainObject(changed.edges) ? changed.edges : {}) },
      });
    }
  }

  if ('pushAside' in patch) {
    if (patch.pushAside === null || patch.pushAside === false) delete next.pushAside;
    else next.pushAside = true;
  }

  // A record may have earned dead references from an editor deletion; writing
  // it fixes those too, exactly as the panel's restore does.
  if (live) {
    const pruned = restoreSnapshot(
      {
        positions: next.positions,
        groups: next.groups,
        relations: next.relations,
        bondNotes: next.bondNotes,
        folded: next.folded,
        types: next.types ?? {},
        fields: next.fields ?? {},
        colors: next.colors ?? {},
        images: next.images ?? {},
        resources: next.resources ?? {},
        pinned: next.pinned ?? {},
        locked: next.locked ?? {},
        cardModes: next.cardModes ?? {},
        cardSizes: next.cardSizes ?? {},
        cardDims: next.cardDims ?? {},
        stack: next.stack ?? [],
        collapsedGroups: next.collapsedGroups ?? {},
        annotations: next.annotations ?? {},
      },
      live,
      next,
    );
    if (!pruned) throw new Error('the canvas record could not be read');
    const { tables: _tables, ...slices } = pruned;
    for (const key of Object.keys(slices)) delete next[key];
    Object.assign(next, slices);
  }

  next.schema = CANVAS_SCHEMA;
  return next;
}

/**
 * The name a patch earns on the canvas stack, in the same past-tense voice as
 * the panel: `Moved 3 cards`, `Updated 1 group`, `Changed 2 bonds`, and a
 * composed name when a patch touches several kinds of thing.
 */
export function canvasStepName(patch, record) {
  const parts = [];
  const named = (value) => Object.entries(value ?? {}).filter(([, entry]) => entry !== null);
  if (patch.positions) {
    const count = named(patch.positions).length;
    if (count) parts.push(`Moved ${plural(count, 'card')}`);
  }
  if (patch.groups) {
    const count = Object.keys(patch.groups ?? {}).length;
    if (count) parts.push(`Updated ${plural(count, 'group')}`);
  }
  const cards = new Set();
  for (const slice of ['types', 'fields', 'colors', 'images', 'resources', 'pinned', 'locked', 'cardModes', 'cardSizes', 'cardDims']) {
    for (const [anchor, value] of named(patch[slice])) cards.add(anchor);
  }
  if (cards.size) parts.push(`Edited ${plural(cards.size, 'card')}`);
  if ('relations' in patch || 'bondNotes' in patch) {
    const count = Object.keys(patch.relations ?? {}).length || Object.keys(patch.bondNotes ?? {}).length;
    parts.push(`Changed ${plural(count || Object.keys(record.relations ?? {}).length, 'bond')}`);
  }
  if (patch.annotations) {
    const count = Object.keys(patch.annotations ?? {}).length;
    if (count) parts.push(`Edited ${plural(count, 'annotation')}`);
  }
  if (patch.stack) parts.push('Reordered the cards');
  if (patch.collapsedGroups) parts.push('Collapsed or expanded a group');
  if (patch.view) parts.push('Moved the canvas view');
  if (patch.savedViews) parts.push('Saved the canvas views');
  if (patch.routing) parts.push('Changed connector routing');
  if ('pushAside' in patch) parts.push('Toggled push aside');
  if (!parts.length) return DEFAULT_STEP_NAME;
  return parts.join(' · ');
}

/**
 * Put one change on the canvas stack: the record before it, under the name it
 * earns. A patch that changed nothing pushes nothing, exactly as a drag that
 * ends where it began does not.
 */
export function recordCanvasStep(record, next, name) {
  const before = canvasSnapshot(record);
  const after = canvasSnapshot(next);
  if (before === after) return { record: next, pushed: false };
  const stack = cleanHistoryStack(record.history, CANVAS_HISTORY_LIMIT);
  const pushed = pushHistoryStep(stack, after, before, name || DEFAULT_STEP_NAME, CANVAS_HISTORY_LIMIT);
  return {
    record: pushed ? { ...next, history: { past: stack.past, future: stack.future } } : next,
    pushed,
  };
}

/**
 * Jump the canvas to a checkpoint, `count` steps back or forward.
 *
 * The leapfrogged steps land on the opposite stack with their names intact, so
 * single-stepping works from either end afterwards — the same contract the
 * checkpoints popover offers.
 */
export function jumpCanvas(record, live, direction, count) {
  const stack = cleanHistoryStack(record.history, CANVAS_HISTORY_LIMIT);
  const kind = direction === 'back' ? 'undo' : 'redo';
  const available = kind === 'undo' ? stack.past.length : stack.future.length;
  if (!Number.isInteger(count) || count < 1) throw new Error('how many steps must be a whole number of at least 1');
  if (count > available) {
    throw new Error(`only ${plural(available, 'step')} ${kind === 'undo' ? 'behind' : 'ahead'} on this canvas`);
  }
  const jumped = historyJump(stack, kind, count, canvasSnapshot(record));
  if (!jumped) throw new Error('there is nothing to jump to');
  const restored = restoreSnapshot(jumped.restore, live, record);
  if (!restored) throw new Error('that checkpoint cannot be read');
  const { tables, ...slices } = restored;
  const checkpoint = kind === 'undo'
    ? stack.past[stack.past.length - count].name
    : stack.future[stack.future.length - count].name;
  return {
    record: {
      ...record,
      ...canvasRecordPatch(slices),
      schema: CANVAS_SCHEMA,
      history: { past: jumped.past, future: jumped.future },
    },
    tables: tables ?? null,
    checkpoint,
  };
}
