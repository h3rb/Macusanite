/**
 * Chamber (folder) / vein (.md file) tree helpers.
 *
 * The Rust side ships a ready-made tree, but the sidebar, the browser fallback
 * and the graph all need to re-shape it, so the pure logic lives here too.
 */
import { dirname, basename, extname, isMarkdown } from './path.js';

export const CHAMBER = 'chamber';
export const VEIN = 'vein';

/** Build a nested tree from flat vault-relative vein paths. */
export function buildTree(paths = []) {
  const root = [];
  const chamberMap = new Map();

  const chamberAt = (path) => {
    if (!path) return root;
    if (chamberMap.has(path)) return chamberMap.get(path);
    const parent = chamberAt(dirname(path));
    const node = {
      kind: CHAMBER,
      name: basename(path),
      path,
      children: [],
    };
    parent.push(node);
    chamberMap.set(path, node.children);
    return node.children;
  };

  for (const rawPath of paths) {
    const path = String(rawPath).replace(/\\/g, '/');
    if (!path) continue;
    chamberAt(dirname(path)).push({
      kind: VEIN,
      name: basename(path),
      path,
      children: [],
    });
  }

  return sortNodes(root);
}

/** Chambers first, then veins, each alphabetically. */
export function sortNodes(nodes) {
  nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === CHAMBER ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });
  for (const node of nodes) if (node.children?.length) sortNodes(node.children);
  return nodes;
}

/** Depth-first walk over a tree. */
export function walk(nodes, visit, depth = 0) {
  for (const node of nodes ?? []) {
    visit(node, depth);
    if (node.children?.length) walk(node.children, visit, depth + 1);
  }
}

export function findNode(nodes, path) {
  let found = null;
  walk(nodes, (node) => {
    if (!found && node.path === path) found = node;
  });
  return found;
}

export function flatten(nodes) {
  const out = [];
  walk(nodes, (node) => out.push(node));
  return out;
}

export function veinPaths(nodes) {
  return flatten(nodes).filter((n) => n.kind === VEIN).map((n) => n.path);
}

/** Chambers that must be open for `path` to be visible. */
export function ancestorPaths(path) {
  const parts = String(path ?? '').replace(/\\/g, '/').split('/').slice(0, -1);
  const out = [];
  let acc = '';
  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : part;
    out.push(acc);
  }
  return out;
}

/**
 * Keep only nodes matching `query` plus their ancestors. Chambers whose own name
 * matches keep their whole subtree, so searching a chamber name is useful.
 */
export function filterTree(nodes, query) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return nodes;

  const visit = (list) => {
    const kept = [];
    for (const node of list) {
      const children = node.children?.length ? visit(node.children) : [];
      const selfMatch = node.name.toLowerCase().includes(q) || node.path.toLowerCase().includes(q);
      if (selfMatch && node.kind === CHAMBER) {
        kept.push(node);
      } else if (selfMatch || children.length) {
        kept.push({ ...node, children });
      }
    }
    return kept;
  };

  return visit(nodes);
}

export function countVeins(nodes) {
  let count = 0;
  walk(nodes, (node) => {
    if (node.kind === VEIN) count += 1;
  });
  return count;
}

/** Counts of veins grouped per chamber path, used by the graph/sidebar footer. */
export function chamberStats(nodes) {
  const stats = new Map();
  const visit = (list, chamber) => {
    for (const node of list) {
      if (node.kind === CHAMBER) {
        stats.set(node.path, 0);
        visit(node.children, node.path);
      } else if (chamber) {
        stats.set(chamber, (stats.get(chamber) ?? 0) + 1);
      }
    }
  };
  visit(nodes, '');
  return stats;
}

/** Split a vault path into breadcrumb steps for the nav bar. */
export function pathBreadcrumbs(path) {
  const parts = String(path ?? '').replace(/\\/g, '/').split('/').filter(Boolean);
  const crumbs = [];
  let acc = '';
  parts.forEach((part, i) => {
    acc = acc ? `${acc}/${part}` : part;
    const last = i === parts.length - 1;
    crumbs.push({
      label: part,
      path: acc,
      kind: last && isMarkdown(part) ? VEIN : CHAMBER,
      ext: last ? extname(part) : '',
    });
  });
  return crumbs;
}
