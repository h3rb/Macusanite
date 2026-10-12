/**
 * Concept graph: documents, their sections, the links between them and the tags
 * that group them, plus a deterministic force-directed layout.
 *
 * Nodes carry the current colour of the page/section/concept they represent and
 * every edge carries *both* endpoint colours, which is what lets the renderer
 * fade a link's colour into its target's colour along the connecting line.
 */
import { slugify, titleFromPath, stem, dirname } from './path.js';
import { parseWikiLinks, resolveTarget, parseTags } from './wikilinks.js';
import { documentMeta, parseFrontmatter } from './frontmatter.js';

export const NODE = { DOCUMENT: 'document', SECTION: 'section', CONCEPT: 'concept', TAG: 'tag' };
export const EDGE = { LINK: 'link', CONTAINS: 'contains', TAG: 'tag' };

/**
 * Graph node kinds mapped onto the colour-store kinds. The `colorOf` callback
 * handed to {@link buildGraph} therefore always speaks the store's language
 * (`page`, `section`, `link`, `concept`), never the graph's.
 */
const COLOR_KIND = {
  [NODE.DOCUMENT]: 'page',
  [NODE.SECTION]: 'section',
  [NODE.CONCEPT]: 'concept',
  [NODE.TAG]: 'concept',
};

const colorFor = (colorOf, kind, parts) => colorOf(COLOR_KIND[kind] ?? kind, parts);

export const docId = (path) => `doc:${path}`;
export const sectionId = (path, anchor) => `sec:${path}#${anchor}`;
export const conceptId = (name) => `concept:${String(name).toLowerCase()}`;
export const tagId = (name) => `tag:${String(name).toLowerCase()}`;

/** Markdown headings with their anchors. Fences and front matter are skipped. */
export function extractHeadings(body) {
  const src = String(body ?? '');
  const out = [];
  const seen = new Map();
  let inFence = false;
  let fenceMarker = '';

  for (const line of src.split(/\r?\n/)) {
    const fence = /^[ \t]*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fence[1][0];
      } else if (fence[1][0] === fenceMarker) {
        inFence = false;
      }
      continue;
    }
    if (inFence) continue;

    const heading = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line);
    if (!heading) continue;
    const level = heading[1].length;
    const text = heading[2].trim();
    const base = slugify(text) || `section-${out.length + 1}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    const anchor = count === 0 ? base : `${base}-${count}`;
    out.push({ level, text, anchor });
  }
  return out;
}

/**
 * Build the lookup table used by wiki-link resolution and by the graph.
 * @param {Record<string, string>} bodies vault path -> markdown source
 */
export function buildDocumentIndex(bodies = {}) {
  return Object.entries(bodies).map(([path, text]) => {
    const { data, body } = parseFrontmatter(text);
    const meta = documentMeta(data);
    const headings = extractHeadings(body);
    return {
      path,
      stem: stem(path),
      title: meta.title ?? titleFromPath(path),
      aliases: [...meta.aliases, stem(path)].filter(Boolean),
      tags: [...new Set([...meta.tags, ...parseTags(body)])],
      headings,
      color: meta.pageColor,
      linkColor: meta.linkColor,
      sectionColor: meta.sectionColor,
      depth: path.split('/').length - 1,
      chamber: dirname(path),
      links: parseWikiLinks(body).map((l) => ({
        target: l.target,
        section: l.section,
        alias: l.alias,
        embed: l.embed,
        start: l.start,
      })),
    };
  }).sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * @param {object} input
 * @param {Array} input.index   result of buildDocumentIndex
 * @param {object} input.settings
 * @param {string|null} input.focusPath
 * @param {(kind: string, parts: object) => string} input.colorOf
 */
export function buildGraph({ index, settings, focusPath = null, colorOf }) {
  const graph = settings?.graph ?? {};
  const depthLimit = Math.max(1, graph.depth ?? 2);
  const showSections = graph.showSections !== false;
  const showTags = graph.showTags !== false;
  const showUnresolved = graph.showUnresolved !== false;
  const showContext = graph.showContext !== false;

  const byPath = new Map(index.map((d) => [d.path, d]));
  const nodes = new Map();
  const edges = [];

  /** Ask the caller's colour resolver, in the colour store's vocabulary. */
  const colorOfNode = (kind, parts) => colorFor(colorOf, kind, parts);

  const addNode = (node) => {
    if (!nodes.has(node.id)) {
      nodes.set(node.id, {
        degree: 0,
        color: colorFor(colorOf, node.kind ?? NODE.DOCUMENT, node.kind === NODE.TAG
          ? { name: node.label }
          : node.kind === NODE.SECTION
            ? { path: node.path ?? '', anchor: node.anchor ?? '' }
            : node.kind === NODE.CONCEPT
              ? { name: node.label }
              : { path: node.path ?? '' }),
        ...node,
      });
    }
    return nodes.get(node.id);
  };

  const addEdge = (edge) => {
    if (edges.some((e) => e.id === edge.id)) return;
    edges.push(edge);
    for (const id of [edge.from, edge.to]) {
      const node = nodes.get(id);
      if (node) node.degree += 1;
    }
  };

  const focus = focusPath ? byPath.get(focusPath) : null;
  const origins = focus ? [focus] : index;

  // ---- pass 1: the focus document and its sections ----------------------
  if (focus) {
    addNode({
      id: docId(focus.path),
      kind: NODE.DOCUMENT,
      path: focus.path,
      label: focus.title,
      ring: 0,
      color: colorOfNode(NODE.DOCUMENT, { path: focus.path }),
    });
    if (showSections) {
      for (const heading of focus.headings) {
        // Level-1 headings are the document title, which the focus node already
        // represents — drawing them again just doubles the hub.
        if (heading.level === 1) continue;
        const id = sectionId(focus.path, heading.anchor);
        addNode({
          id,
          kind: NODE.SECTION,
          path: focus.path,
          anchor: heading.anchor,
          label: heading.text,
          level: heading.level,
          ring: 1,
          color: colorOfNode(NODE.SECTION, { path: focus.path, anchor: heading.anchor }),
        });
        addEdge({
          id: `contains:${id}`,
          from: docId(focus.path),
          to: id,
          kind: EDGE.CONTAINS,
          fromColor: colorOfNode(NODE.DOCUMENT, { path: focus.path }),
          toColor: colorOfNode(NODE.SECTION, { path: focus.path, anchor: heading.anchor }),
          label: '',
        });
      }
    }
  }

  // ---- pass 2: BFS over wiki links -------------------------------------
  const visited = new Set();
  let frontier = (focus ? [focus] : origins).map((d) => ({ doc: d, ring: focus ? 1 : 1, via: null }));
  for (const item of frontier) visited.add(item.doc.path);

  while (frontier.length) {
    const next = [];
    for (const { doc, ring, via } of frontier) {
      if (ring > depthLimit + (focus ? 1 : 0)) continue;
      const isFocus = focus ? doc.path === focus.path : false;
      const fromNodeId = via?.fromNodeId && via.fromNodeId.startsWith('sec:')
        ? via.fromNodeId
        : docId(doc.path);

      addNode({
        id: docId(doc.path),
        kind: NODE.DOCUMENT,
        path: doc.path,
        label: doc.title,
        ring,
        color: colorOfNode(NODE.DOCUMENT, { path: doc.path }),
        context: !isFocus && focus ? ring > 1 : false,
      });
      if (fromNodeId !== docId(doc.path)) {
        addNode({
          id: fromNodeId,
          kind: NODE.SECTION,
          path: doc.path,
          label: '',
          ring,
          color: colorOfNode(NODE.SECTION, { path: doc.path, anchor: '' }),
        });
      }

      for (const link of doc.links) {
        const resolved = resolveTarget(
          { ...link, target: link.target, section: link.section, samePage: link.target === '', anchor: link.section ? slugify(link.section) : '' },
          doc.path,
          index,
        );

        let toNodeId;
        if (resolved.ok && resolved.path) {
          toNodeId = docId(resolved.path);
          const target = byPath.get(resolved.path);
          addNode({
            id: toNodeId,
            kind: NODE.DOCUMENT,
            path: resolved.path,
            label: target?.title ?? titleFromPath(resolved.path),
            ring: ring + 1,
            color: colorOfNode(NODE.DOCUMENT, { path: resolved.path }),
          });
          if (!visited.has(resolved.path)) {
            visited.add(resolved.path);
            if (target && ring + 1 <= depthLimit + (focus ? 1 : 0)) next.push({ doc: target, ring: ring + 1 });
          }
        } else if (showUnresolved) {
          const name = titleFromPath(link.target);
          toNodeId = conceptId(name);
          addNode({
            id: toNodeId,
            kind: NODE.CONCEPT,
            path: resolved.suggestedPath ?? null,
            label: name,
            ring: ring + 1,
            color: colorOfNode(NODE.CONCEPT, { name }),
            ghost: true,
          });
        } else {
          continue;
        }

        const linkColor = colorOfNode(EDGE.LINK, { from: doc.path, to: resolved.path ?? null, section: link.section });
        const toColor = colorOfNode(NODE.DOCUMENT, { path: resolved.path ?? '' });
        addEdge({
          id: `link:${doc.path}#${link.section}->${resolved.path ?? nameOf(targetLabel(link))}`,
          from: fromNodeId,
          to: toNodeId,
          kind: EDGE.LINK,
          fromColor: linkColor,
          toColor,
          label: link.section || (link.alias ?? ''),
          section: link.section ?? '',
          sourcePath: doc.path,
          targetPath: resolved.path ?? null,
        });

        // Section-level anchors get their own node so a `[[doc#heading]]` link
        // can be coloured and pointed at exactly.
        if (resolved.ok && resolved.path && resolved.anchor) {
          const target = byPath.get(resolved.path);
          const heading = target?.headings.find((h) => h.anchor === resolved.anchor);
          if (heading) {
            const anchorId = sectionId(resolved.path, heading.anchor);
            addNode({
              id: anchorId,
              kind: NODE.SECTION,
              path: resolved.path,
              anchor: heading.anchor,
              label: heading.text,
              level: heading.level,
              ring: ring + 1,
              color: colorOfNode(NODE.SECTION, { path: resolved.path, anchor: heading.anchor }),
            });
            addEdge({
              id: `contains:${anchorId}`,
              from: docId(resolved.path),
              to: anchorId,
              kind: EDGE.CONTAINS,
              fromColor: colorOfNode(NODE.DOCUMENT, { path: resolved.path }),
              toColor: colorOfNode(NODE.SECTION, { path: resolved.path, anchor: heading.anchor }),
              label: '',
            });
            addEdge({
              id: `link:${doc.path}->${anchorId}`,
              from: fromNodeId,
              to: anchorId,
              kind: EDGE.LINK,
              fromColor: linkColor,
              toColor: colorOfNode(NODE.SECTION, { path: resolved.path, anchor: heading.anchor }),
              label: heading.text,
              section: heading.anchor,
              sourcePath: doc.path,
              targetPath: resolved.path,
            });
          }
        }
      }
    }
    frontier = showContext ? next.slice(0, 60) : [];
    if (!showContext) break;
  }

  // ---- pass 3: tags ------------------------------------------------------
  if (showTags) {
    for (const doc of focus ? [focus] : index.slice(0, 40)) {
      for (const tag of doc.tags) {
        const id = tagId(tag);
        addNode({
          id,
          kind: NODE.TAG,
          path: null,
          label: `#${tag}`,
          ring: 2,
          color: colorOfNode(NODE.TAG, { name: tag }),
        });
        addEdge({
          id: `tag:${doc.path}->${id}`,
          from: docId(doc.path),
          to: id,
          kind: EDGE.TAG,
          fromColor: colorOfNode(NODE.DOCUMENT, { path: doc.path }),
          toColor: colorOfNode(NODE.TAG, { name: tag }),
          label: '',
        });
      }
    }
  }

  return {
    focus: focusPath,
    nodes: [...nodes.values()],
    edges,
  };
}

function targetLabel(link) {
  return link.target || 'untitled';
}

function nameOf(label) {
  return titleFromPath(String(label).replace(/[#|]/g, ''));
}

/** Small stats block for the graph panel header. */
export function graphStats(graph) {
  const counts = { document: 0, section: 0, concept: 0, tag: 0 };
  for (const node of graph.nodes) counts[node.kind] = (counts[node.kind] ?? 0) + 1;
  return {
    ...counts,
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    links: graph.edges.filter((e) => e.kind === EDGE.LINK).length,
    contains: graph.edges.filter((e) => e.kind === EDGE.CONTAINS).length,
    tagEdges: graph.edges.filter((e) => e.kind === EDGE.TAG).length,
    documents: counts.document,
    sections: counts.section,
    concepts: counts.concept,
    tags: counts.tag,
    ghosts: counts.concept,
  };
}

/** Seeded PRNG so layouts are reproducible (and testable). */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic Fruchterman-Reingold-ish layout. Rings are seeded around the
 * centre so the focus document stays in the middle and context orbits it.
 */
export function layoutGraph(graph, options = {}) {
  const width = options.width ?? 420;
  const height = options.height ?? 520;
  const iterations = options.iterations ?? 260;
  const seed = options.seed ?? 20261011;
  // Nodes label themselves below the dot, so keep them off the frame edge.
  const margin = options.margin ?? 40;
  const rand = mulberry32(seed);

  const cx = width / 2;
  const cy = height / 2;
  const nodes = graph.nodes.map((node, i) => {
    const ring = node.ring ?? 1;
    const angle = (i / Math.max(1, graph.nodes.length)) * Math.PI * 2 + rand() * 0.3;
    const radius = ring === 0 ? 0 : Math.min(width, height) * (0.14 + ring * 0.13);
    return {
      ...node,
      x: ring === 0 ? cx : cx + Math.cos(angle) * radius,
      y: ring === 0 ? cy : cy + Math.sin(angle) * radius,
      vx: 0,
      vy: 0,
    };
  });

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const links = graph.edges
    .map((e) => ({ a: byId.get(e.from), b: byId.get(e.to), edge: e }))
    .filter((l) => l.a && l.b);

  const area = width * height;
  const k = Math.sqrt(area / Math.max(1, nodes.length)) * 0.55;
  const maxStep = 14;
  let temperature = Math.min(width, height) * 0.12;

  for (let step = 0; step < iterations; step += 1) {
    for (const node of nodes) {
      node.dx = 0;
      node.dy = 0;
    }

    // repulsion
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const a = nodes[i];
        const b = nodes[j];
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let dist = Math.hypot(dx, dy);
        if (dist < 0.01) {
          dx = (rand() - 0.5) * 0.6;
          dy = (rand() - 0.5) * 0.6;
          dist = 0.6;
        }
        const force = (k * k) / dist;
        const ux = dx / dist;
        const uy = dy / dist;
        a.dx += ux * force;
        a.dy += uy * force;
        b.dx -= ux * force;
        b.dy -= uy * force;
      }
    }

    // springs
    for (const { a, b } of links) {
      const weight = a.ring === 0 || b.ring === 0 ? 1.6 : 1;
      let dx = a.x - b.x;
      let dy = a.y - b.y;
      const dist = Math.max(0.01, Math.hypot(dx, dy));
      const force = ((dist * dist) / k) * weight * 0.35;
      const ux = dx / dist;
      const uy = dy / dist;
      a.dx -= ux * force;
      a.dy -= uy * force;
      b.dx += ux * force;
      b.dy += uy * force;
    }

    // centring + integration
    for (const node of nodes) {
      node.dx += (cx - node.x) * 0.02 * (node.ring === 0 ? 4 : 1);
      node.dy += (cy - node.y) * 0.02 * (node.ring === 0 ? 4 : 1);
      const step2 = Math.hypot(node.dx, node.dy);
      const limited = step2 > 0 ? Math.min(step2, temperature, maxStep) / step2 : 0;
      node.x += node.dx * limited;
      node.y += node.dy * limited;
      node.x = Math.max(margin, Math.min(width - margin, node.x));
      node.y = Math.max(margin, Math.min(height - margin, node.y));
    }
    temperature = Math.max(1.2, temperature * 0.97);
  }

  for (const node of nodes) {
    delete node.vx;
    delete node.vy;
    node.x = Math.round(node.x * 100) / 100;
    node.y = Math.round(node.y * 100) / 100;
  }

  return { ...graph, nodes, links: links.map((l) => l.edge), width, height };
}

/** Neighbours of a node — used for hover highlighting. */
export function neighbours(graph, id) {
  const out = new Set();
  for (const edge of graph.edges) {
    if (edge.from === id) out.add(edge.to);
    if (edge.to === id) out.add(edge.from);
  }
  return [...out];
}

/** Reachable document paths, used to scope a full-vault graph to one note. */
export function reachableDocuments(graph, limit = 200) {
  const out = new Set();
  for (const node of graph.nodes) {
    if (node.kind === NODE.DOCUMENT && node.path) out.add(node.path);
    if (node.kind === NODE.CONCEPT && node.path) out.add(node.path);
    if (out.size >= limit) break;
  }
  return [...out];
}
