/**
 * Pure text transforms behind the editor's formatting toolbar.
 *
 * Every function takes the whole source plus a selection and returns
 * `{ text, start, end }` — the new source and where the caret (or selection)
 * lands. Nothing here touches the DOM, which is what makes the toolbar's
 * behaviour testable without a browser.
 */
const FENCE = '```';

const clampIndex = (text, value) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(Math.round(number), text.length));
};

/** The full lines a selection touches, as `[from, to)` offsets. */
export function lineBounds(text, start, end) {
  const from = clampIndex(text, start);
  let to = clampIndex(text, end);
  const lineStart = text.lastIndexOf('\n', from - 1) + 1;
  // A selection that stops exactly at the next line's first character touches
  // only the line it started on.
  if (to > lineStart && text[to - 1] === '\n') to -= 1;
  const breakAt = text.indexOf('\n', Math.max(to, lineStart));
  return { from: lineStart, to: breakAt === -1 ? text.length : breakAt };
}

const LIST_MARKER = /^(\s*)(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/;

const stripListMarker = (line) => line.replace(LIST_MARKER, '$1');

const LINE_STYLES = {
  quote: { prefix: '> ', strip: /^>\s?/, test: /^>\s?/ },
  bullet: { prefix: '- ', strip: /^\s*[-*+]\s+/, test: /^\s*[-*+]\s+/ },
  ordered: { prefix: null, strip: /^\s*\d+[.)]\s+/, test: /^\s*\d+[.)]\s+/ },
  task: { prefix: '- [ ] ', strip: /^\s*[-*+]\s+\[[ xX]\]\s+/, test: /^\s*[-*+]\s+\[[ xX]\]\s+/ },
};

/**
 * Wrap the selection in an inline marker (`**`, `*`, `~~`, a backtick).
 * Wrapping already-wrapped text removes the markers, so the button toggles.
 */
export function wrapInline(text, start, end, marker, placeholder = '') {
  const from = clampIndex(text, start);
  const to = Math.max(from, clampIndex(text, end));
  const selected = text.slice(from, to);
  const before = text.slice(Math.max(0, from - marker.length), from);
  const after = text.slice(to, to + marker.length);
  if (selected && before === marker && after === marker) {
    return {
      text: text.slice(0, from - marker.length) + selected + text.slice(to + marker.length),
      start: from - marker.length,
      end: to - marker.length,
    };
  }
  const body = selected || placeholder;
  const insert = `${marker}${body}${marker}`;
  return {
    text: text.slice(0, from) + insert + text.slice(to),
    start: from + marker.length,
    end: from + marker.length + body.length,
  };
}

/**
 * Add or remove a line prefix for every selected non-blank line.
 * `kind` is one of quote, bullet, ordered or task; list kinds convert between
 * each other instead of stacking markers.
 */
export function toggleLinePrefix(text, start, end, kind) {
  const style = LINE_STYLES[kind];
  if (!style) return { text, start, end };
  const { from, to } = lineBounds(text, start, end);
  const lines = text.slice(from, to).split('\n');
  const filled = lines.filter((line) => line.trim() !== '');
  const active = filled.length > 0 && filled.every((line) => style.test.test(line));
  let counter = 0;
  const next = lines.map((line) => {
    if (!line.trim()) return line;
    if (active) return line.replace(style.strip, '');
    if (kind === 'ordered') {
      counter += 1;
      return `${counter}. ${stripListMarker(line)}`;
    }
    const body = kind === 'quote' ? line : stripListMarker(line);
    return `${style.prefix}${body}`;
  });
  const block = next.join('\n');
  return { text: text.slice(0, from) + block + text.slice(to), start: from, end: from + block.length };
}

/** Set every selected line to a heading level (0 makes them paragraphs). */
export function setHeading(text, start, end, level) {
  const marks = '#'.repeat(Math.max(0, Math.min(6, Math.round(Number(level) || 0))));
  const { from, to } = lineBounds(text, start, end);
  const lines = text.slice(from, to).split('\n');
  const levelOf = (line) => /^(#{1,6})\s+/.exec(line)?.[1].length ?? 0;
  const filled = lines.filter((line) => line.trim() !== '');
  const active = marks.length > 0 && filled.length > 0 && filled.every((line) => levelOf(line) === marks.length);
  const target = active ? 0 : marks.length;
  const block = lines.map((line) => {
    const bare = line.replace(/^\s*#{1,6}\s+/, '');
    return target > 0 ? `${'#'.repeat(target)} ${bare}` : bare;
  }).join('\n');
  return { text: text.slice(0, from) + block + text.slice(to), start: from, end: from + block.length };
}

/**
 * Put a block on lines of its own: one blank line before and after it, without
 * adding a second one where the source already has it.
 */
function insertBlock(text, start, end, block, selection = {}) {
  const from = clampIndex(text, start);
  const to = Math.max(from, clampIndex(text, end));
  const before = text.slice(0, from);
  const after = text.slice(to);
  const lead = before === '' || /\n\s*\n$/.test(before) ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  const trail = after === '' ? '\n' : after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n';
  const base = from + lead.length;
  const selectStart = base + (selection.start ?? 0);
  const selectEnd = base + (selection.end ?? selection.start ?? 0);
  return {
    text: `${before}${lead}${block}${trail}${after}`,
    start: selectStart,
    end: selectEnd,
  };
}

/** Insert a fenced code block, keeping the selection as its body. */
export function insertCodeBlock(text, start, end) {
  const from = clampIndex(text, start);
  const to = Math.max(from, clampIndex(text, end));
  const body = text.slice(from, to) || 'code';
  const block = `${FENCE}\n${body}\n${FENCE}`;
  const offset = FENCE.length + 1;
  return insertBlock(text, from, to, block, { start: offset, end: offset + body.length });
}

/** A thematic break on its own lines. */
export function insertRule(text, start, end) {
  return insertBlock(text, start, end, '---', { start: 3, end: 3 });
}

/**
 * A GitHub-flavoured table. Markdown always needs a header row, so without one
 * the cells are simply left empty.
 */
export function insertTable(text, start, end, { columns = 3, rows = 2, header = true, align = 'left' } = {}) {
  const cols = Math.max(1, Math.min(10, Math.round(Number(columns) || 3)));
  const bodyRows = Math.max(0, Math.min(50, Math.round(Number(rows) || 0)));
  const rule = align === 'center' ? ':---:' : align === 'right' ? '---:' : ':---';
  const headers = Array.from({ length: cols }, (_, index) => (header ? `Column ${index + 1}` : ''));
  const blank = `| ${Array.from({ length: cols }, () => '').join(' | ')} |`;
  const block = [
    `| ${headers.join(' | ')} |`,
    `| ${Array.from({ length: cols }, () => rule).join(' | ')} |`,
    ...Array.from({ length: bodyRows }, () => blank),
  ].join('\n');
  const cell = headers[0] ?? '';
  return insertBlock(text, start, end, block, { start: 2, end: 2 + cell.length });
}

const MERMAID_TEMPLATES = {
  flowchart: (direction) => [
    `flowchart ${direction}`,
    '  A[Start] --> B{Decide}',
    '  B -->|Yes| C[Do this]',
    '  B -->|No| D[Do that]',
  ].join('\n'),
  sequence: () => [
    'sequenceDiagram',
    '  participant Reader',
    '  participant Vault',
    '  Reader->>Vault: request',
    '  Vault-->>Reader: response',
  ].join('\n'),
  class: () => [
    'classDiagram',
    '  class Vessel {',
    '    +String name',
    '    +sample()',
    '  }',
    '  Vessel <|-- Crucible',
  ].join('\n'),
  state: () => [
    'stateDiagram-v2',
    '  [*] --> Idle',
    '  Idle --> Running: start',
    '  Running --> [*]: stop',
  ].join('\n'),
  er: () => 'erDiagram\n  SAMPLE ||--o{ MEASUREMENT : has',
  gantt: () => [
    'gantt',
    '  title Schedule',
    '  dateFormat YYYY-MM-DD',
    '  section First',
    '  Task :a1, 2026-01-01, 7d',
  ].join('\n'),
  pie: () => 'pie title Shares\n  "A" : 60\n  "B" : 40',
  journey: () => 'journey\n  title A day\n  section Morning\n    Wake: 5: Me',
  mindmap: () => 'mindmap\n  root((Vault))\n    Chambers\n    Veins',
};

export const MERMAID_KINDS = Object.keys(MERMAID_TEMPLATES);
export const MERMAID_DIRECTIONS = ['TD', 'LR', 'BT', 'RL'];

/** The diagram source for one kind, without its fence. */
export function mermaidSnippet(kind = 'flowchart', direction = 'TD') {
  const build = MERMAID_TEMPLATES[kind] ?? MERMAID_TEMPLATES.flowchart;
  const dir = MERMAID_DIRECTIONS.includes(direction) ? direction : 'TD';
  return build(dir);
}

/** Insert a Mermaid diagram in a fenced `mermaid` block. */
export function insertMermaid(text, start, end, { kind = 'flowchart', direction = 'TD' } = {}) {
  const body = mermaidSnippet(kind, direction);
  const block = `${FENCE}mermaid\n${body}\n${FENCE}`;
  const offset = `${FENCE}mermaid`.length + 1;
  return insertBlock(text, start, end, block, { start: offset, end: offset });
}

/** True for anything with a URL scheme: https:, mailto:, obsidian:, … */
export function isWebLink(value) {
  return /^[a-z][a-z0-9+.-]*:/i.test(String(value ?? '').trim());
}

/** `[[Chambers/Lab/Methods]]` bodies drop the extension and the brackets. */
export function wikiTarget(value) {
  return String(value ?? '')
    .trim()
    .replace(/^\[\[/, '')
    .replace(/\]\]$/, '')
    .replace(/\.(md|markdown|mdx)$/i, '')
    .trim();
}

/** The markdown for one link: `[[Vein]]`, `[[Vein|Label]]` or `[Label](target)`. */
export function linkSnippet({ target, label = '', format = 'wiki' } = {}) {
  const raw = String(target ?? '').trim();
  if (!raw) return '';
  const name = String(label ?? '').trim();
  if (format === 'markdown') {
    return `[${name || raw}](${raw})`;
  }
  const body = wikiTarget(raw);
  return name && name !== body ? `[[${body}|${name}]]` : `[[${body}]]`;
}

/** Replace a range with text, placing the caret `selection` characters in. */
export function insertInline(text, start, end, snippet, selection = {}) {
  if (!snippet) return { text, start, end };
  const from = clampIndex(text, start);
  const to = Math.max(from, clampIndex(text, end));
  return {
    text: text.slice(0, from) + snippet + text.slice(to),
    start: from + (selection.start ?? snippet.length),
    end: from + (selection.end ?? selection.start ?? snippet.length),
  };
}
