/**
 * Canvas export: the Worldbuilding graph as a standalone SVG, or as Mermaid
 * source for a markdown fence.
 *
 * The panel owns the live geometry — card positions, group boxes, connector
 * paths — and hands it here as a plain scene, so both formats describe exactly
 * what is on screen. Nothing here touches the DOM except by returning a string.
 *
 * A scene is:
 *   {
 *     title, bounds: { x, y, width, height },
 *     theme: { bg, raised, border, text, textDim, accent, ok, error, warn, sans, mono },
 *     cards: [{ anchor, title, typeLabel, typeIcon, color, mode, meta, fields, body, x, y, width, height }],
 *     groups: [{ id, name, icon, color, x, y, width, height, locked, summary? }],
 *     connectors: [{ from, to, kind, label, color, width, dashed, arrow, labelAt, d }],
 *     annotations: [{ x, y, width, height, text }],
 *   }
 */

const CARD_PAD = 12;
const LINE_HEIGHT = 15;

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const round = (value) => Math.round(Number(value) * 10) / 10;

/** Split text into lines of at most `maxChars`, keeping at most `maxLines`. */
export function wrapText(text, maxChars, maxLines = Infinity) {
  const words = String(text ?? '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    if (!line) line = word;
    else if (line.length + 1 + word.length <= maxChars) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
      if (lines.length >= maxLines) break;
    }
  }
  if (line && lines.length < maxLines) lines.push(line);
  if (lines.length >= maxLines && words.length) {
    const consumed = lines.join(' ').split(' ').length;
    if (consumed < words.length) lines[lines.length - 1] = `${lines[lines.length - 1].replace(/[.,;:]$/, '')}…`;
  }
  return lines;
}

/** How many characters of `fontSize` type fit across `width` pixels. */
function charsAcross(width, fontSize, factor = 0.52) {
  return Math.max(6, Math.floor(width / (fontSize * factor)));
}

/** Markdown prose as the few plain words a card preview can carry. */
export function plainProse(body) {
  return String(body ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[\[([^\]]*)\]\]/g, (match, inner) => inner.split('|').pop().replace(/^#/, ''))
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function textEl(x, y, text, { size = 12, fill, weight = 400, anchor = 'start', mono = false, opacity = 1, family, halo } = {}) {
  const attrs = [
    `x="${round(x)}"`,
    `y="${round(y)}"`,
    `font-size="${size}"`,
    `font-weight="${weight}"`,
    `fill="${fill ?? 'currentColor'}"`,
    `text-anchor="${anchor}"`,
  ];
  if (mono) attrs.push('font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"');
  else if (family) attrs.push(`font-family="${escapeXml(family)}"`);
  if (opacity !== 1) attrs.push(`fill-opacity="${opacity}"`);
  if (halo) attrs.push(`stroke="${halo}"`, 'stroke-width="3"', 'stroke-linejoin="round"', 'paint-order="stroke"');
  return `<text ${attrs.join(' ')}>${escapeXml(text)}</text>`;
}

function cardSvg(card, theme, id) {
  const { x, y, width, height } = card;
  const color = card.color || theme.accent;
  const parts = [`<g${id ? ` id="${id}" inkscape:label="${escapeXml(card.title ?? '')}"` : ''}>`];
  parts.push(`<rect x="${round(x)}" y="${round(y)}" width="${round(width)}" height="${round(height)}" rx="10" fill="${theme.raised}" stroke="${theme.border}" stroke-width="1"/>`);
  // The accent edge that tells one card from another at a glance.
  parts.push(`<rect x="${round(x)}" y="${round(y + 1)}" width="3" height="${round(height - 2)}" fill="${color}"/>`);

  const innerX = x + CARD_PAD;
  const innerWidth = width - CARD_PAD * 2;

  if (card.mode === 'thumbnail') {
    const initial = String(card.title ?? '?').trim().charAt(0).toUpperCase() || '?';
    parts.push(textEl(x + width / 2, y + height / 2 - 4, initial, { size: 64, fill: color, weight: 700, anchor: 'middle' }));
    const lines = wrapText(card.title, charsAcross(innerWidth, 12), 2);
    lines.forEach((line, index) => {
      parts.push(textEl(x + width / 2, y + height - 30 + index * 15, line, { size: 12, fill: theme.text, weight: 600, anchor: 'middle' }));
    });
    parts.push('</g>');
    return parts.join('');
  }

  const folded = card.folded || height < 64;
  if (folded) {
    const label = `${card.typeIcon ? `${card.typeIcon} ` : ''}${card.title}`;
    const line = wrapText(label, charsAcross(innerWidth, 12.5), 1)[0] ?? '';
    parts.push(textEl(innerX, y + height / 2 + 4, line, { size: 12.5, fill: theme.text, weight: 600 }));
    parts.push('</g>');
    return parts.join('');
  }

  let cursor = y + 22;
  const titleLines = wrapText(card.title, charsAcross(innerWidth, 13), card.mode === 'compact' ? 1 : 2);
  for (const line of titleLines) {
    parts.push(textEl(innerX, cursor, line, { size: 13, fill: theme.text, weight: 600 }));
    cursor += 17;
  }
  const typeLine = `${card.typeIcon ? `${card.typeIcon} ` : ''}${card.typeLabel ?? ''}${card.meta ? ` · ${card.meta}` : ''}`;
  parts.push(textEl(innerX, cursor, typeLine, { size: 11, fill: color }));
  cursor += LINE_HEIGHT + 4;

  if (card.mode === 'compact') {
    parts.push('</g>');
    return parts.join('');
  }

  for (const field of card.fields ?? []) {
    if (cursor > y + height - 16) break;
    parts.push(textEl(innerX, cursor, `${field.label}: ${field.value}`, { size: 11, fill: theme.textDim }));
    cursor += LINE_HEIGHT;
  }

  const excerpt = plainProse(card.body);
  if (excerpt) {
    cursor += 4;
    const maxLines = Math.max(0, Math.floor((y + height - 12 - cursor) / LINE_HEIGHT));
    if (maxLines > 0) {
      for (const line of wrapText(excerpt, charsAcross(innerWidth, 11), maxLines)) {
        parts.push(textEl(innerX, cursor, line, { size: 11, fill: theme.textDim }));
        cursor += LINE_HEIGHT;
      }
    }
  }
  parts.push('</g>');
  return parts.join('');
}

function groupSvg(group, theme, id) {
  const { x, y, width, height } = group;
  const color = group.color || theme.accent;
  const label = id ? ` inkscape:label="${escapeXml(group.name ?? 'Group')}"` : '';
  if (group.summary) {
    const parts = [`<g${id ? ` id="${id}"` : ''}${label}>`];
    parts.push(`<rect x="${round(x)}" y="${round(y)}" width="${round(width)}" height="${round(height)}" rx="8" fill="${theme.raised}" stroke="${theme.border}" stroke-width="1"/>`);
    parts.push(`<rect x="${round(x)}" y="${round(y + 1)}" width="3" height="${round(height - 2)}" fill="${color}"/>`);
    parts.push(textEl(x + 14, y + height / 2 + 9, group.icon || '⁂', { size: 26, fill: color, mono: true }));
    parts.push(textEl(x + 52, y + 34, wrapText(group.name, charsAcross(width - 66, 13), 1)[0] ?? '', { size: 13, fill: theme.text, weight: 700 }));
    parts.push(textEl(x + 52, y + 54, group.meta ?? '', { size: 11, fill: theme.textDim }));
    parts.push('</g>');
    return parts.join('');
  }
  const parts = [`<g${id ? ` id="${id}"` : ''}${label}>`];
  const dash = group.locked ? ' stroke-dasharray="7 5"' : '';
  parts.push(`<rect x="${round(x)}" y="${round(y)}" width="${round(width)}" height="${round(height)}" rx="10" fill="${color}" fill-opacity="0.07" stroke="${color}" stroke-opacity="0.75" stroke-width="2"${dash}/>`);
  const tabWidth = Math.min(width, 34 + String(group.name ?? '').length * 6.8);
  parts.push(`<rect x="${round(x)}" y="${round(y - 12)}" width="${round(tabWidth)}" height="22" rx="6" fill="${theme.raised}" stroke="${theme.border}" stroke-width="1"/>`);
  parts.push(textEl(x + 8, y + 4, group.icon || '⁂', { size: 12, fill: color, mono: true }));
  parts.push(textEl(x + 24, y + 4, wrapText(group.name, charsAcross(tabWidth - 28, 12), 1)[0] ?? '', { size: 12, fill: theme.text, weight: 600 }));
  parts.push('</g>');
  return parts.join('');
}

function connectorSvg(connector, theme, id) {
  const parts = [`<g${id ? ` id="${id}"` : ''}>`];
  parts.push(`<path d="${connector.d}" fill="none" stroke="${connector.color}" stroke-width="${connector.width}"${connector.dashed ? ' stroke-dasharray="4 5"' : ''} opacity="${connector.opacity ?? 0.6}"/>`);
  if (connector.arrow) {
    const { x, y, angle } = connector.arrow;
    parts.push(`<path d="M0,0 L10,5 L0,10 z" transform="translate(${round(x)} ${round(y)}) rotate(${round(angle)})" fill="${connector.color}"/>`);
  }
  if (connector.label) {
    parts.push(textEl(connector.labelAt.x, connector.labelAt.y, connector.label, {
      size: 10, fill: connector.color, mono: true, anchor: 'middle', halo: theme.bg,
    }));
  }
  parts.push('</g>');
  return parts.join('');
}

function annotationSvg(annotation, theme, id) {
  const { x, y, width, height, text } = annotation;
  const parts = [`<g${id ? ` id="${id}"` : ''}>`];
  parts.push(`<rect x="${round(x)}" y="${round(y)}" width="${round(width)}" height="${round(height)}" rx="3" fill="#fff3a6" stroke="#d8c94c" stroke-width="1"/>`);
  parts.push(textEl(x + 8, y + 18, 'ANNOTATION', { size: 9, fill: '#3a3300', weight: 700 }));
  const lines = wrapText(text, charsAcross(width - 16, 11), Math.max(1, Math.floor((height - 26) / 14)));
  lines.forEach((line, index) => {
    parts.push(textEl(x + 8, y + 34 + index * 14, line, { size: 11, fill: '#3a3300' }));
  });
  parts.push('</g>');
  return parts.join('');
}

/**
 * An SVG id safe to hand to an editor: no spaces, quotes or slashes. The
 * index keeps it unique even when two objects would read the same (two
 * relationships between one pair, two annotations with one text).
 */
function objectId(prefix, value, index) {
  const clean = String(value ?? '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return `${prefix}-${clean || 'item'}-${index}`;
}

/**
 * The whole canvas as one standalone SVG document.
 *
 * With `{ inkscape: true }` the same drawing is wrapped in Inkscape layers
 * (Groups, Connectors, Cards, Annotations) with named objects and a document
 * page colour, so it opens there as an editable file instead of one picture.
 */
export function buildCanvasSvg(scene, { inkscape = false } = {}) {
  const { bounds, theme, cards = [], groups = [], connectors = [], annotations = [] } = scene ?? {};
  const box = bounds ?? { x: 0, y: 0, width: 800, height: 600 };
  const font = theme?.sans || 'system-ui, sans-serif';
  const namespaces = inkscape
    ? ' xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.0.dtd"'
    : '';
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg"${namespaces} version="1.1" width="${round(box.width)}" height="${round(box.height)}" viewBox="${round(box.x)} ${round(box.y)} ${round(box.width)} ${round(box.height)}" font-family="${escapeXml(font)}">`,
    `<title>${escapeXml(scene?.title ?? 'Worldbuilding canvas')}</title>`,
  ];
  if (inkscape) {
    parts.push(`<sodipodi:namedview inkscape:document-units="px" pagecolor="${theme?.bg ?? '#0d1117'}" bordercolor="${theme?.border ?? '#2f4257'}" inkscape:pageopacity="1" showgrid="false"/>`);
  }
  parts.push(`<rect x="${round(box.x)}" y="${round(box.y)}" width="${round(box.width)}" height="${round(box.height)}" fill="${theme?.bg ?? '#0d1117'}"/>`);

  const layer = (name, label, children) => {
    if (!inkscape) return children.join('');
    return `<g id="layer-${name}" inkscape:groupmode="layer" inkscape:label="${label}">${children.join('')}</g>`;
  };
  // Back to front, exactly as the canvas paints them.
  parts.push(layer('groups', 'Groups', groups
    .filter((group) => !group.hidden)
    .map((group, index) => groupSvg(group, theme, inkscape ? objectId('group', group.id, index) : null))));
  parts.push(layer('connectors', 'Connectors', connectors
    .map((connector, index) => connectorSvg(connector, theme, inkscape ? objectId('edge', `${connector.from}-${connector.to}`, index) : null))));
  parts.push(layer('cards', 'Cards', cards
    .filter((card) => !card.hidden)
    .map((card, index) => cardSvg(card, theme, inkscape ? objectId('card', card.anchor, index) : null))));
  parts.push(layer('annotations', 'Annotations', annotations
    .map((annotation, index) => annotationSvg(annotation, theme, inkscape ? objectId('note', annotation.text, index) : null))));

  parts.push('</svg>');
  return parts.join('');
}

/** One label for a Mermaid node: its title, and its type when it is not a note. */
function mermaidLabel(card) {
  const title = String(card.title ?? '').replace(/"/g, "'").replace(/\s+/g, ' ').trim();
  const type = card.typeLabel && card.typeLabel !== 'Note' ? String(card.typeLabel).replace(/"/g, "'") : '';
  return type ? `${title}<br/>${type}` : title;
}

function mermaidEdgeLabel(label) {
  return String(label ?? '').replace(/[|"<>]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * The canvas as Mermaid `flowchart` source. Groups become subgraphs (nested
 * groups are flattened into the top-level one), prose links, bonds and the
 * outline spine keep their direction, and an asserted relationship rides on
 * the arrow.
 */
export function buildCanvasMermaid(scene) {
  const { cards = [], groups = [], connectors = [] } = scene ?? {};
  const idOf = new Map();
  cards.forEach((card, index) => idOf.set(card.anchor, `n${index}`));

  const parents = new Map();
  for (const group of groups) {
    for (const child of group.children ?? []) parents.set(child, group.id);
  }
  const topGroups = groups.filter((group) => !parents.has(group.id));
  const groupById = new Map(groups.map((group) => [group.id, group]));
  const topOf = (id) => {
    let current = id;
    while (parents.has(current)) current = parents.get(current);
    return current;
  };
  const groupIdOf = (id) => {
    const index = topGroups.findIndex((group) => group.id === id);
    return index >= 0 ? `g${index}` : null;
  };
  const endpointId = (endpoint) => {
    if (String(endpoint).startsWith('group:')) {
      const id = String(endpoint).slice('group:'.length);
      return groupById.has(id) ? groupIdOf(topOf(id)) : null;
    }
    return idOf.get(endpoint) ?? null;
  };

  // A card in a nested group joins the top-level subgraph, so no card is lost.
  const membersOf = new Map();
  for (const card of cards) {
    const top = card.groupId ? topOf(card.groupId) : null;
    if (!top || !groupById.has(top)) continue;
    const list = membersOf.get(top) ?? [];
    list.push(card);
    membersOf.set(top, list);
  }

  const lines = ['flowchart LR'];
  const placed = new Set();
  for (const group of topGroups) {
    const members = membersOf.get(group.id) ?? [];
    if (!members.length) continue;
    lines.push(`  subgraph ${groupIdOf(group.id)}["${String(group.name ?? 'Group').replace(/"/g, "'")}"]`);
    for (const card of members) {
      lines.push(`    ${idOf.get(card.anchor)}["${mermaidLabel(card)}"]`);
      placed.add(card.anchor);
    }
    lines.push('  end');
  }
  for (const card of cards) {
    if (placed.has(card.anchor)) continue;
    lines.push(`  ${idOf.get(card.anchor)}["${mermaidLabel(card)}"]`);
  }

  for (const connector of connectors) {
    const from = endpointId(connector.from);
    const to = endpointId(connector.to);
    if (!from || !to || from === to) continue;
    const label = connector.kind === 'contains' ? '' : mermaidEdgeLabel(connector.label);
    const text = label ? `|${label}|` : '';
    if (connector.kind === 'contains') lines.push(`  ${from} -.-> ${to}`);
    else if (connector.kind === 'group') lines.push(`  ${from} ==>${text} ${to}`);
    else lines.push(`  ${from} -->${text} ${to}`);
  }
  return `${lines.join('\n')}\n`;
}

/** A file-name base for this vein's export, without an extension. */
export function canvasExportName(path, suffix = 'canvas') {
  const leaf = String(path ?? '').split('/').pop().replace(/\.md$/i, '');
  const clean = leaf.replace(/[^\w .-]+/g, '').trim().replace(/\s+/g, '-');
  return `${clean || 'vein'}-${suffix}`;
}
