/**
 * Right pane: the concept graph.
 *
 * Rendered as hand-built SVG rather than mermaid, because each edge needs its own
 * `linearGradient` so a link's colour can fade into its target's colour. Mermaid
 * is still what documents use for their own diagrams.
 */
import { el, clear, qs, appendAll } from './dom.js';
import { buildGraph, layoutGraph, graphStats, neighbours, NODE, EDGE } from '../lib/graph.js';
import { contrastColor, withAlpha } from '../lib/colors.js';
import { titleFromPath } from '../lib/path.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgNode(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined) continue;
    node.setAttribute(key, String(value));
  }
  return node;
}

export function createGraphPanel({ app, root }) {
  const header = el('div', { class: 'graph-head' });
  const stage = el('div', { class: 'graph-stage' });
  const statsBar = el('div', { class: 'graph-stats' });
  const tooltip = el('div', { class: 'graph-tooltip hidden' });
  const footer = el('div', { class: 'graph-foot' });

  root.append(header, stage, statsBar, footer);
  stage.append(tooltip);

  let svg = null;
  let layer = null;
  let graph = null;
  let laidOut = null;
  let view = { x: 0, y: 0, k: 1 };
  let dragging = null;
  let hovered = null;

  const stageSize = () => ({
    width: Math.max(240, stage.clientWidth || 320),
    height: Math.max(260, stage.clientHeight || 420),
  });

  /* ----------------------------------------------------------- controls -- */

  function toggleButton(label, key, title) {
    return el('button', {
      class: `chip ${app.state.settings.graph[key] ? 'on' : ''}`,
      type: 'button',
      text: label,
      title,
      onclick: () => {
        app.setGraphOption(key, !app.state.settings.graph[key]);
      },
    });
  }

  function renderHeader() {
    clear(header).append(
      el('div', { class: 'graph-title' }, [
        el('span', { class: 'graph-dot' }),
        el('strong', { text: 'Concept graph' }),
      ]),
      el('div', { class: 'spacer' }),
      el('button', { class: 'icon-btn', type: 'button', title: 'Re-fit graph', text: '⤢', onclick: () => { view = { x: 0, y: 0, k: 1 }; draw(); } }),
      el('button', { class: 'icon-btn', type: 'button', title: 'Hide graph panel', text: '⇥', onclick: () => app.toggleGraph(false) }),
    );

    clear(footer).append(
      toggleButton('sections', 'showSections', 'Show the sections of the current vein'),
      toggleButton('tags', 'showTags', 'Show #tags as concept nodes'),
      toggleButton('ghosts', 'showUnresolved', 'Show links whose target does not exist yet'),
      toggleButton('context', 'showContext', 'Follow links out into the wider vault'),
      el('span', { class: 'spacer' }),
      el('label', { class: 'graph-depth' }, [
        el('span', { text: 'depth' }),
        el('input', {
          type: 'number',
          min: '1',
          max: '4',
          value: String(app.state.settings.graph.depth),
          onchange: (event) => app.setGraphOption('depth', Number(event.target.value)),
        }),
      ]),
    );
  }

  /* ------------------------------------------------------------ rendering */

  function render() {
    renderHeader();
    if (!app.state.settings.layout.showGraph) {
      stage.classList.add('hidden');
      statsBar.classList.add('hidden');
      return;
    }
    stage.classList.remove('hidden');
    statsBar.classList.remove('hidden');

    graph = buildGraph({
      index: app.state.index,
      settings: app.state.settings,
      focusPath: app.state.current?.path ?? null,
      colorOf: (kind, parts) => app.colorFor(kind, parts),
    });

    const { width, height } = stageSize();
    laidOut = layoutGraph(graph, {
      width,
      height,
      iterations: app.state.settings.graph.iterations,
      seed: 20261011,
    });

    draw();
    renderStats();
  }

  function renderStats() {
    const stats = graphStats(graph);
    appendAll(clear(statsBar), [
      chipStat(`${stats.nodes} nodes`),
      chipStat(`${stats.links} links`),
      chipStat(`${stats.sections} sections`),
      stats.ghosts ? chipStat(`${stats.ghosts} unwritten`, 'warn') : null,
      chipStat(`${stats.tags} tags`),
    ]);
  }

  const chipStat = (text, kind = '') => el('span', { class: `graph-stat ${kind}`, text });

  function draw() {
    const size = laidOut ?? { width: stageSize().width, height: stageSize().height, nodes: [], edges: [] };
    clear(stage);
    stage.append(tooltip);

    svg = svgNode('svg', {
      class: 'graph-svg',
      viewBox: `0 0 ${size.width} ${size.height}`,
      preserveAspectRatio: 'xMidYMid meet',
      role: 'img',
      'aria-label': 'Concept graph of the current vein',
    });

    const defs = svgNode('defs');
    layer = svgNode('g', { class: 'graph-layer', transform: `translate(${view.x} ${view.y}) scale(${view.k})` });

    const nodeById = new Map(size.nodes.map((n) => [n.id, n]));

    // ---- edges with per-edge gradients --------------------------------
    size.edges.forEach((edge, index) => {
      const from = nodeById.get(edge.from);
      const to = nodeById.get(edge.to);
      if (!from || !to) return;

      const gradientId = `grad-${index}`;
      const gradient = svgNode('linearGradient', {
        id: gradientId,
        gradientUnits: 'userSpaceOnUse',
        x1: from.x,
        y1: from.y,
        x2: to.x,
        y2: to.y,
      });
      const steps = Math.max(2, app.state.settings.linkFadeSteps);
      for (let i = 0; i < steps; i += 1) {
        const t = i / (steps - 1);
        const stop = svgNode('stop', {
          offset: `${Math.round(t * 100)}%`,
          'stop-color': mixStop(edge.fromColor, edge.toColor, t),
          'stop-opacity': edge.kind === EDGE.CONTAINS ? '0.5' : '1',
        });
        gradient.append(stop);
      }
      defs.append(gradient);

      const path = svgNode('path', {
        class: `graph-edge graph-edge-${edge.kind}`,
        d: curve(from, to),
        stroke: `url(#${gradientId})`,
        'stroke-width': edge.kind === EDGE.LINK ? 1.9 : 1.1,
        'stroke-dasharray': edge.kind === EDGE.CONTAINS ? '3 4' : null,
        fill: 'none',
        'data-edge': edge.id,
        'data-source': edge.from,
        'data-target': edge.to,
      });
      const edgeTitle = svgNode('title');
      edgeTitle.textContent = edge.label
        ? `${from.label} → ${to.label} (${edge.label})`
        : `${from.label} → ${to.label}`;
      path.append(edgeTitle);
      layer.append(path);
    });

    // ---- nodes ---------------------------------------------------------
    for (const node of size.nodes) {
      const radius = nodeRadius(node);
      const group = svgNode('g', {
        class: `graph-node graph-node-${node.kind} ${node.ghost ? 'ghost' : ''} ${node.ring === 0 ? 'focus' : ''}`,
        'data-node': node.id,
        transform: `translate(${node.x} ${node.y})`,
        tabindex: '0',
        role: 'button',
      });
      const nodeTitleNode = svgNode('title');
      nodeTitleNode.textContent = nodeTitle(node);
      group.append(nodeTitleNode);

      if (node.ring === 0) {
        group.append(svgNode('circle', {
          class: 'graph-halo',
          r: radius + 9,
          fill: withAlpha(node.color, 0.18),
          stroke: withAlpha(node.color, 0.4),
        }));
      }

      group.append(svgNode('circle', {
        class: 'graph-dot',
        r: radius,
        fill: node.color,
        stroke: node.ghost ? withAlpha(node.color === '#ffffff' ? '#888888' : node.color, 0.95) : '#0d1117',
        'stroke-width': node.ghost ? 1.6 : 1.4,
      }));

      if (node.kind === NODE.SECTION) {
        group.append(svgNode('circle', { class: 'graph-inner', r: radius * 0.45, fill: '#0d1117', opacity: 0.75 }));
      }
      if (node.kind === NODE.TAG) {
        const text = svgNode('text', { class: 'graph-tag-mark', x: 0, y: 3.5, 'text-anchor': 'middle' });
        text.textContent = '#';
        group.append(text);
      }

      const label = svgNode('text', {
        class: 'graph-label',
        x: 0,
        y: radius + 12,
        'text-anchor': 'middle',
        fill: node.ring === 0 ? '#f2f5f8' : '#c8d2dc',
      });
      label.textContent = truncateLabel(node.label);
      group.append(label);

      layer.append(group);
    }

    svg.append(defs, layer);
    stage.append(svg);
    bindInteractions();
  }

  function mixStop(from, to, t) {
    // local import avoidance: colours.js already normalises, keep the maths here
    const toRgb = (hex) => {
      const v = String(hex).replace('#', '');
      return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) || 0);
    };
    const a = toRgb(from);
    const b = toRgb(to);
    return `#${a.map((c, i) => Math.round(c + (b[i] - c) * t).toString(16).padStart(2, '0')).join('')}`;
  }

  function curve(from, to) {
    const mx = (from.x + to.x) / 2;
    const my = (from.y + to.y) / 2;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dist = Math.max(1, Math.hypot(dx, dy));
    const bow = Math.min(46, dist * 0.16);
    const cx = mx - (dy / dist) * bow;
    const cy = my + (dx / dist) * bow;
    return `M ${from.x} ${from.y} Q ${cx} ${cy} ${to.x} ${to.y}`;
  }

  function nodeRadius(node) {
    const base = app.state.settings.graph.nodeRadius;
    if (node.ring === 0) return base + 3.5;
    if (node.kind === NODE.SECTION) return base * 0.75;
    if (node.kind === NODE.TAG) return base * 0.7;
    const degree = Math.min(6, node.degree);
    return base + degree * 0.7;
  }

  function nodeTitle(node) {
    const kind = node.ghost ? 'unwritten page' : node.kind;
    const path = node.path ? `\n${node.path}${node.anchor ? `#${node.anchor}` : ''}` : '';
    return `${node.label} (${kind}, ${node.degree} connections)${path}`;
  }

  const truncateLabel = (label) => {
    const text = String(label ?? '');
    return text.length > 22 ? `${text.slice(0, 21)}…` : text;
  };

  /* ------------------------------------------------------- interactions -- */

  function bindInteractions() {
    for (const node of qs('.graph-layer', svg)?.children ?? []) {
      const id = node.getAttribute?.('data-node');
      if (!id) continue;
      node.addEventListener('mouseenter', () => showTooltip(id));
      node.addEventListener('mouseleave', () => hideTooltip());
      node.addEventListener('click', (event) => {
        event.stopPropagation();
        activate(id);
      });
      node.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          activate(id);
        }
      });
      node.addEventListener('focus', () => showTooltip(id));
      node.addEventListener('blur', () => hideTooltip());
    }

    svg.addEventListener('wheel', (event) => {
      event.preventDefault();
      const factor = event.deltaY < 0 ? 1.12 : 0.9;
      view.k = Math.max(0.35, Math.min(3.2, view.k * factor));
      applyView();
    }, { passive: false });

    svg.addEventListener('mousedown', (event) => {
      const node = event.target.closest?.('[data-node]');
      if (node) {
        const id = node.getAttribute('data-node');
        dragging = { id, moved: false };
        return;
      }
      dragging = { pan: true, startX: event.clientX - view.x, startY: event.clientY - view.y, moved: false };
    });

    window.addEventListener('mousemove', onDragMove);
    window.addEventListener('mouseup', onDragEnd);
  }

  function onDragMove(event) {
    if (!dragging) return;
    dragging.moved = true;
    if (dragging.pan) {
      view.x = event.clientX - dragging.startX;
      view.y = event.clientY - dragging.startY;
      applyView();
      return;
    }
    const svgRect = svg.getBoundingClientRect();
    const scaleX = laidOut.width / svgRect.width;
    const scaleY = laidOut.height / svgRect.height;
    const node = laidOut.nodes.find((n) => n.id === dragging.id);
    if (!node) return;
    node.x = (event.clientX - svgRect.left) * scaleX;
    node.y = (event.clientY - svgRect.top) * scaleY;
    const group = layer.querySelector(`[data-node="${cssEscape(node.id)}"]`);
    if (group) group.setAttribute('transform', `translate(${node.x} ${node.y})`);
    // Gradients are user-space, so re-draw after a manual move.
    clearTimeout(dragging.redrawTimer);
    dragging.redrawTimer = setTimeout(() => {
      const keep = new Map(laidOut.nodes.map((n) => [n.id, { x: n.x, y: n.y }]));
      draw();
      for (const n of laidOut.nodes) Object.assign(n, keep.get(n.id));
    }, 220);
  }

  function onDragEnd() {
    dragging = null;
  }

  function applyView() {
    if (!layer) return;
    layer.setAttribute('transform', `translate(${view.x} ${view.y}) scale(${view.k})`);
  }

  function activate(id) {
    const node = laidOut?.nodes.find((n) => n.id === id);
    if (!node) return;

    if (node.kind === NODE.SECTION) {
      app.openPath(node.path, { section: node.anchor });
      return;
    }

    // Tags are not pages: clicking one focuses every page that carries it.
    if (node.kind === NODE.TAG) {
      const tagged = graph.nodes.filter((n) => n.kind === NODE.DOCUMENT
        && graph.edges.some((e) => e.kind === EDGE.TAG && e.to === id && e.from === n.id));
      highlight(id);
      app.toast(`${tagged.length} vein${tagged.length === 1 ? '' : 's'} tagged ${node.label}`, 'info');
      return;
    }

    // A ghost has a suggested path, but no file behind it yet.
    if (node.ghost) {
      app.createFromGhost(node.label, node.path);
      return;
    }

    if (node.path) app.openPath(node.path, { anchor: node.anchor });
  }

  function showTooltip(id) {
    hovered = id;
    const node = laidOut?.nodes.find((n) => n.id === id);
    if (!node) return;
    highlight(id);
    const stats = graphStats(graph);
    appendAll(clear(tooltip), [
      el('strong', { class: 'tt-title', text: node.label }),
      el('span', { class: 'tt-kind', text: node.ghost ? 'unwritten — click to create' : node.kind }),
      node.path ? el('code', { class: 'tt-path', text: `${node.path}${node.anchor ? `#${node.anchor}` : ''}` }) : null,
      el('span', { class: 'tt-meta', text: `${node.degree} connection${node.degree === 1 ? '' : 's'} · ${stats.nodes} in view` }),
    ]);
    tooltip.classList.remove('hidden');
    const rect = stage.getBoundingClientRect();
    const nodeRect = svg.querySelector(`[data-node="${cssEscape(id)}"]`)?.getBoundingClientRect();
    if (nodeRect) {
      tooltip.style.left = `${Math.min(rect.width - 200, Math.max(8, nodeRect.left - rect.left + 14))}px`;
      tooltip.style.top = `${Math.max(8, nodeRect.top - rect.top - 8)}px`;
    }
  }

  function hideTooltip() {
    hovered = null;
    tooltip.classList.add('hidden');
    highlight(null);
  }

  function highlight(id) {
    if (!layer) return;
    const related = id ? new Set([id, ...neighbours(graph, id)]) : null;
    layer.classList.toggle('dimmed', Boolean(id));
    for (const group of layer.querySelectorAll('[data-node]')) {
      const nodeId = group.getAttribute('data-node');
      group.classList.toggle('related', Boolean(related?.has(nodeId)));
    }
    for (const edge of layer.querySelectorAll('[data-edge]')) {
      const on = related
        ? related.has(edge.getAttribute('data-source')) && related.has(edge.getAttribute('data-target'))
        : true;
      edge.classList.toggle('muted', !on);
    }
  }

  function cssEscape(value) {
    return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(value) : String(value).replace(/"/g, '\\"');
  }

  /* ------------------------------------------------------------- resize -- */

  const observer = typeof ResizeObserver !== 'undefined'
    ? new ResizeObserver(() => {
      if (!app.state.settings.layout.showGraph) return;
      app.scheduleGraphRefresh();
    })
    : null;
  observer?.observe(stage);

  return {
    render,
    refresh: render,
    get tooltip() {
      return tooltip;
    },
  };
}
