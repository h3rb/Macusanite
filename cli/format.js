/**
 * Human-readable output for every CLI command.
 *
 * `--json` is the machine path and needs nothing here: it prints the result of
 * [src/lib/api.js](../src/lib/api.js) verbatim. This module exists so the other
 * path — a person at a terminal, or an agent reading a tool result — gets
 * something shaped like the answer instead of a wall of JSON.
 *
 * Each formatter is a plain function of the result object, so a command added to
 * the catalogue without one still prints (falling back to JSON) rather than
 * crashing.
 */

const RESET = '\u001b[0m';
const DIM = '\u001b[2m';
const BOLD = '\u001b[1m';
const GREEN = '\u001b[32m';
const RED = '\u001b[31m';
const YELLOW = '\u001b[33m';
const CYAN = '\u001b[36m';

const decorate = (enabled) => ({
  dim: (text) => (enabled ? `${DIM}${text}${RESET}` : text),
  bold: (text) => (enabled ? `${BOLD}${text}${RESET}` : text),
  green: (text) => (enabled ? `${GREEN}${text}${RESET}` : text),
  red: (text) => (enabled ? `${RED}${text}${RESET}` : text),
  yellow: (text) => (enabled ? `${YELLOW}${text}${RESET}` : text),
  cyan: (text) => (enabled ? `${CYAN}${text}${RESET}` : text),
});

/** Aligned columns: `table(rows, ['path', 'bytes'])`. */
function table(rows, columns, paint) {
  if (!rows.length) return '';
  const cells = rows.map((row) => columns.map((column) => String(row[column] ?? '')));
  const widths = columns.map((_, i) => Math.max(column_header_length(columns[i]), ...cells.map((row) => row[i].length)));
  const header = columns.map((column, i) => paint.bold(column.toUpperCase().padEnd(widths[i]))).join('  ');
  const body = cells.map((row) => row.map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd());
  return [header, ...body].join('\n');
}

/** Length of a column header without any decoration. */
function column_header_length(header) {
  return String(header).length;
}

const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** Human size for the vault stats line. */
function bytes(value) {
  const size = Number(value) || 0;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/** A chamber/vein tree as box-drawing text. */
function drawTree(nodes, paint, prefix = '') {
  const lines = [];
  nodes.forEach((node, index) => {
    const last = index === nodes.length - 1;
    const elbow = last ? '└── ' : '├── ';
    const label = node.kind === 'chamber' ? `${node.name}/` : node.name;
    lines.push(`${prefix}${elbow}${node.kind === 'chamber' ? paint.cyan(label) : label}`);
    if (node.children?.length) {
      lines.push(...drawTree(node.children, paint, `${prefix}${last ? '    ' : '│   '}`));
    }
  });
  return lines;
}

/** `key: value` lines, skipping empty values. */
function fields(entries, paint, { align = 14 } = {}) {
  return entries
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([key, value]) => `${paint.dim(key.padEnd(align))}${value}`)
    .join('\n');
}

/** Where a `search` snippet's terms are, without the surrounding prose. */
const snippetOf = (text, limit = 96) => {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
};

/**
 * Render a command result for a terminal.
 * @param {string} command catalogue command name
 * @param {*} result  whatever `dispatch` returned
 * @param {{color?: boolean}} [options]
 */
export function formatResult(command, result, { color = false } = {}) {
  const paint = decorate(color);
  const lines = [];

  switch (command) {
    case 'vault.open':
    case 'vault.create': {
      lines.push(`${result.name} ${paint.dim(`(${result.path})`)}`);
      if (result.description) lines.push(result.description);
      lines.push(paint.dim(`${plural(result.veins ?? 0, 'vein')} · ${plural(result.chambers ?? 0, 'chamber')}${result.created ? ' · created' : ''}`));
      if (result.seeded?.length) lines.push(paint.dim(`seeded ${result.seeded.length} files`));
      break;
    }

    case 'vault.info': {
      lines.push(paint.bold(result.name ?? 'vault'));
      if (result.description) lines.push(result.description);
      lines.push(fields([
        ['path', result.path],
        ['created', result.created],
        ['colours', result.colorCount ? `${result.colorCount} assigned` : 'none assigned'],
      ], paint));
      break;
    }

    case 'vault.update':
      lines.push(`${result.name}${result.description ? ` — ${result.description}` : ''}`);
      break;

    case 'vault.stats':
      lines.push(fields([
        ['vault', result.path],
        ['veins', String(result.veins)],
        ['chambers', String(result.chambers)],
        ['headings', String(result.headings)],
        ['links', `${result.links} (${result.ghosts} ghost${result.ghosts === 1 ? '' : 's'})`],
        ['tags', String(result.tags)],
        ['orphans', String(result.orphans)],
        ['size', bytes(result.bytes)],
        ['newest', result.newest ? `${result.newest.path} (${new Date(result.newest.mtime).toISOString()})` : ''],
      ], paint, { align: 10 }));
      break;

    case 'vault.tree': {
      if (!result?.length) {
        lines.push(paint.dim('the vault is empty'));
        break;
      }
      lines.push('.');
      lines.push(...drawTree(result, paint));
      break;
    }

    case 'vault.veins':
    case 'vault.chambers':
      lines.push(...(result ?? []));
      break;

    case 'vault.settings':
      lines.push(JSON.stringify(result, null, 2));
      break;

    case 'vault.settings.set':
      lines.push(paint.green('settings updated'));
      lines.push(JSON.stringify(result, null, 2));
      break;

    case 'vault.state':
      lines.push(Object.keys(result ?? {}).length ? JSON.stringify(result, null, 2) : paint.dim('no state stored'));
      break;

    case 'vault.state.set':
      lines.push(paint.green(`state written to ${result.path}`));
      break;

    case 'vault.log':
      lines.push(`${paint.dim(result.level)} ${result.message}`);
      break;

    case 'vault.logs':
      lines.push(table(result ?? [], ['ts', 'level', 'message'], paint) || paint.dim('no log lines'));
      break;

    case 'vault.index':
      lines.push(fields([
        ['cache', result.path],
        ['present', result.present ? `yes (${bytes(result.bytes)})` : 'no'],
        ['entries', `${result.fresh} fresh / ${result.stale} stale of ${result.veins}`],
      ], paint, { align: 10 }));
      break;

    case 'vault.index.rebuild':
      lines.push(paint.green(`indexed ${plural(result.index?.length ?? 0, 'vein')}`));
      lines.push(table(result.index ?? [], ['path', 'title', 'headings', 'links'], paint));
      break;

    case 'vault.index.drop':
      lines.push(paint.green(`dropped ${result.path}`));
      break;

    case 'vault.doctor': {
      for (const check of result.checks ?? []) {
        lines.push(`${check.ok ? paint.green('✔') : paint.red('✘')} ${check.name.padEnd(12)} ${paint.dim(check.detail)}`);
      }
      lines.push(result.ok ? paint.green('every check passed') : paint.red('some checks failed'));
      break;
    }

    case 'vein.read':
      return result.text;

    case 'vein.info': {
      lines.push(paint.bold(result.path));
      lines.push(fields([
        ['title', result.title],
        ['aliases', (result.aliases ?? []).join(', ')],
        ['tags', (result.tags ?? []).join(', ')],
        ['words', String(result.words)],
        ['colour', result.color],
        ['link colour', result.linkColor],
        ['section colour', result.sectionColor],
      ], paint));
      if (result.headings?.length) {
        lines.push(paint.dim('headings'));
        for (const heading of result.headings) {
          lines.push(`  ${'  '.repeat(Math.max(0, heading.level - 1))}${heading.text} ${paint.dim(`#${heading.anchor}`)}`);
        }
      }
      if (result.links?.length) {
        lines.push(paint.dim('links'));
        for (const link of result.links) {
          lines.push(`  ${link.embed ? '!' : ''}[[${link.target}${link.section ? `#${link.section}` : ''}${link.alias ? `|${link.alias}` : ''}]]`);
        }
      }
      break;
    }

    case 'vein.write':
    case 'vein.append':
      lines.push(paint.green(`wrote ${result.path} (${bytes(result.bytes)})`));
      break;

    case 'vein.create':
      lines.push(result.created ? paint.green(`created ${result.path}`) : paint.yellow(`${result.path} already exists`));
      break;

    case 'vein.section':
      lines.push(`${result.replaced ? paint.green('replaced') : paint.green('added')} § ${result.heading} in ${result.path}`);
      break;

    case 'vein.rename':
      lines.push(`${result.moved ? paint.green('moved') : paint.yellow('unchanged')} ${result.from} → ${result.path}`);
      break;

    case 'vein.delete':
      lines.push(result.deleted ? paint.green(`deleted ${result.path}`) : paint.yellow(`${result.path} was not there`));
      break;

    case 'vein.links':
      lines.push(table(result ?? [], ['target', 'section', 'alias', 'embed', 'samePage'], paint) || paint.dim('no wiki links'));
      break;

    case 'vein.headings':
      lines.push((result ?? []).map((heading) => `${'  '.repeat(Math.max(0, heading.level - 1))}${heading.text} ${paint.dim(`#${heading.anchor}`)}`).join('\n') || paint.dim('no headings'));
      break;

    case 'vein.backlinks':
      lines.push(table(result ?? [], ['path', 'title', 'context'], paint) || paint.dim('nothing links here'));
      break;

    case 'vein.resolve':
      if (result.ok) lines.push(`${paint.green('→')} ${result.path}${result.anchor ? `#${result.anchor}` : ''}`);
      else {
        lines.push(`${paint.yellow('ghost')} — create it at ${result.suggestedPath}`);
        if (result.candidates?.length) lines.push(paint.dim(`candidates: ${result.candidates.join(', ')}`));
      }
      break;

    case 'chamber.create':
      lines.push(result.created ? paint.green(`created ${result.path}/`) : paint.yellow(`${result.path}/ already exists`));
      break;

    case 'search': {
      // Terms arrive tokenised from the search module: `{ text, lower, phrase }`.
      const terms = (result.terms ?? []).map((term) => (typeof term === 'string' ? term : term.text)).filter(Boolean);
      const heading = result.total === 0
        ? `no results for ${JSON.stringify(result.query)}`
        : `${plural(result.total, 'result')} for ${JSON.stringify(result.query)} ${paint.dim(`[${terms.join(' ')}]`)}`;
      lines.push(heading);
      for (const hit of result.results ?? []) {
        lines.push(`${paint.bold(hit.path)} ${paint.dim(`score ${hit.score}${hit.headings?.length ? ` · § ${hit.headings.join(', ')}` : ''}${hit.bodyHits ? ` · ${hit.bodyHits} in text` : ''}`)}`);
        if (hit.snippet) lines.push(`  ${paint.dim(snippetOf(hit.snippet))}`);
      }
      break;
    }

    case 'tags':
      lines.push(table((result ?? []).map((entry) => ({ tag: `#${entry.tag}`, count: entry.count, veins: entry.veins.length })), ['tag', 'count', 'veins'], paint) || paint.dim('no tags'));
      break;

    case 'ghosts':
      lines.push(table(result ?? [], ['from', 'target', 'suggestedPath'], paint) || paint.green('every wiki link resolves'));
      break;

    case 'graph': {
      const stats = result.stats ?? {};
      lines.push(fields([
        ['focus', result.focus],
        ['nodes', `${stats.nodes} (${stats.documents} documents, ${stats.sections} sections, ${stats.tags} tags)`],
        ['edges', `${stats.edges} (${stats.links} links, ${stats.contains} contains, ${stats.tagEdges} tags)`],
      ], paint, { align: 8 }));
      const interesting = (result.nodes ?? []).filter((node) => node.kind !== 'section').slice(0, 30);
      if (interesting.length) {
        lines.push(table(interesting.map((node) => ({
          kind: node.kind,
          label: node.label,
          path: node.path ?? '',
          color: node.color ?? '',
        })), ['kind', 'label', 'path', 'color'], paint));
      }
      break;
    }

    case 'color.set':
      lines.push(`${paint.green('colour set')} ${result.kind} ${paint.dim(result.key)} → ${result.color}`);
      break;

    case 'color.clear':
      lines.push(`${paint.green('colour cleared')} ${result.kind} ${paint.dim(result.key)} — it inherits again`);
      break;

    case 'color.reset':
      lines.push(paint.green('every colour assignment cleared'));
      break;

    case 'color.resolve':
      lines.push(`${result.kind} → ${result.color}`);
      break;

    case 'history': {
      const undo = result.undo ?? [];
      const redo = result.redo ?? [];
      lines.push(table(undo.map((entry) => ({ when: new Date(entry.ts).toISOString(), label: entry.label, path: entry.path })), ['when', 'label', 'path'], paint) || paint.dim('nothing to undo'));
      if (redo.length) {
        lines.push(paint.dim('redo'));
        lines.push(table(redo.map((entry) => ({ when: new Date(entry.ts).toISOString(), label: entry.label, path: entry.path })), ['when', 'label', 'path'], paint));
      }
      break;
    }

    case 'undo':
    case 'redo': {
      const verb = command === 'undo' ? 'undid' : 'redid';
      lines.push(result.applied
        ? `${paint.green(verb)} ${result.label} ${paint.dim(result.path)}`
        : paint.dim(`nothing to ${command}`));
      break;
    }

    case 'help':
    case 'docs':
      return result.markdown;

    default:
      return JSON.stringify(result, null, 2);
  }

  return lines.filter((line) => line !== null && line !== undefined).join('\n');
}

export { table, bytes, plural };
