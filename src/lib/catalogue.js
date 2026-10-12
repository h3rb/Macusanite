/**
 * The Macusanite command catalogue: every vault operation, described once.
 *
 * Three consumers read this file and none of them keeps its own copy:
 *
 *   * the **CLI** (`cli/macusanite.mjs`) turns each command into a subcommand,
 *     a `--help` page and an argument parser;
 *   * the **MCP server** (`cli/mcp.js`) turns each command into a tool with a
 *     JSON Schema, and into the text an agent sees in the tool description;
 *   * the **help document** (`src/lib/helpDoc.js`) turns the whole catalogue —
 *     with the prose in `FEATURES` — into the manual the help window shows.
 *
 * `src/lib/api.js` implements the commands and validates arguments against the
 * `params` declared here, so a parameter that is not written down is a parameter
 * that cannot be passed.
 *
 * ## Anatomy of an entry
 *
 * ```js
 * 'vein.write': {
 *   group: 'Documents',
 *   summary: 'Write a vein, recording an undo step.',
 *   description: 'longer markdown, shown by `--help` and to agents',
 *   params: [ { name: 'path', type: 'string', required: true, positional: true, description: '…' } ],
 *   returns: 'markdown description of the result',
 *   examples: ['macusanite vein write Home.md --text -'],
 *   mutates: true,        // writes to the vault
 *   undoable: true,       // appears in the undo stack (so `undo` reverses it)
 *   mcp: true,            // exposed as an MCP tool (default true)
 * }
 * ```
 */

/** Param types and the JSON Schema fragment each one becomes. */
export const PARAM_SCHEMA = {
  string: { type: 'string' },
  number: { type: 'number' },
  integer: { type: 'integer' },
  boolean: { type: 'boolean' },
  json: {},
  'string[]': { type: 'array', items: { type: 'string' } },
};

/** Parameter types that take a list of values on the command line. */
export const LIST_TYPES = new Set(['string[]', 'number[]']);

/**
 * @typedef {object} CommandParam
 * @property {string} name
 * @property {keyof typeof PARAM_SCHEMA} type
 * @property {boolean} [required]
 * @property {boolean} [positional] filled from the command line positionally
 * @property {string} description
 * @property {*} [default]
 * @property {string[]} [values] allowed values, for enums
 */

/** Ordered groups, for help output and the manual's contents. */
export const GROUPS = [
  'Vault',
  'Documents',
  'Chambers',
  'Search and graph',
  'Colours',
  'History',
  'Help',
];

/**
 * @type {Record<string, {
 *   group: string, summary: string, description?: string,
 *   params?: CommandParam[], returns?: string, examples?: string[],
 *   mutates?: boolean, undoable?: boolean, mcp?: boolean, hidden?: boolean,
 * }>}
 */
export const COMMANDS = {
  /* ── Vault ───────────────────────────────────────────────────────────── */

  'vault.open': {
    group: 'Vault',
    summary: 'Point this session at a vault folder, creating `.macusanite` if it is not there yet.',
    description:
      'The session every other command runs in. `--vault <folder>` on the command line does the same '
      + 'thing before the command runs, so this is mainly for a long-lived MCP server that is asked to '
      + 'work on a second vault. With `--create` a missing folder is made instead of refused, which is '
      + 'also how an agent boots a fresh vault.',
    params: [
      { name: 'path', type: 'string', required: true, positional: true, description: 'Folder to open.' },
      { name: 'create', type: 'boolean', description: 'Create the folder when it does not exist.' },
      { name: 'name', type: 'string', description: 'Vault name, when creating.' },
      { name: 'description', type: 'string', description: 'One line describing the vault, when creating.' },
    ],
    returns: '`{ path, name, description, created, veins, chambers }`',
    examples: ['macusanite vault open ./notes', 'macusanite vault open ./notes --create --name "Field Notes"'],
    mutates: true,
  },

  'vault.info': {
    group: 'Vault',
    summary: 'Identity of the open vault, with its settings and colour count.',
    description:
      'The same payload the window reads when it opens a folder: the vault\'s name, description and '
      + 'creation time from `.macusanite/vault.json`, the merged viewer settings and the raw colour '
      + 'assignments. Missing meta files are created first, so this is also the safe "is this a vault?" '
      + 'probe — it never fails on a folder that exists.',
    returns: '`{ path, name, description, created, settings, colors }`',
    examples: ['macusanite vault info', 'macusanite --vault ./notes vault info --json'],
  },

  'vault.create': {
    group: 'Vault',
    summary: 'Create a vault folder (and its `.macusanite`), optionally seeded with the sample vault.',
    description:
      'Creates the folder if needed, writes `.macusanite/vault.json` with the given name and '
      + 'description, and fills in `settings.json`, `colors.json` and `history.json` when they are '
      + 'absent. With `--sample` the bundled reference vault (seven veins about the Macusani glass '
      + 'project) is written first, and its identity wins — the sample vault keeps its own name.',
    params: [
      { name: 'path', type: 'string', required: true, positional: true, description: 'Folder to create or adopt.' },
      { name: 'name', type: 'string', description: 'Vault name; defaults to the folder name.' },
      { name: 'description', type: 'string', description: 'One line describing the vault.', default: '' },
      { name: 'sample', type: 'boolean', description: 'Seed the bundled sample vault first.' },
    ],
    returns: '`{ path, name, description, created, veins, seeded[] }`',
    examples: ['macusanite vault create ./notes --name "Field Notes"', 'macusanite vault create ./demo --sample'],
    mutates: true,
  },

  'vault.update': {
    group: 'Vault',
    summary: 'Change the vault name or description.',
    params: [
      { name: 'name', type: 'string', description: 'New name.' },
      { name: 'description', type: 'string', description: 'New description.' },
      { name: 'no-undo', type: 'boolean', description: 'Do not record an undo step.' },
    ],
    returns: '`{ name, description, created }`',
    examples: ['macusanite vault update --description "Macusani 2026 fieldwork"'],
    mutates: true,
    undoable: true,
  },

  'vault.stats': {
    group: 'Vault',
    summary: 'Numbers that describe the vault: veins, chambers, links, tags, ghosts, orphans, bytes.',
    description:
      'The orientation call for an agent that has just been pointed at a vault. `ghosts` counts wiki '
      + 'links that point at nothing, `orphans` counts veins with neither inbound nor outbound links, '
      + 'and `newest` names the vein that most recently changed.',
    returns: '`{ path, veins, chambers, headings, links, tags, ghosts, orphans, bytes, newest }`',
    examples: ['macusanite vault stats', 'macusanite vault stats --json'],
  },

  'vault.tree': {
    group: 'Vault',
    summary: 'The chamber/vein tree exactly as the sidebar draws it.',
    returns: 'nested `[{ kind: "chamber"|"vein", name, path, children }]`',
    examples: ['macusanite vault tree', 'macusanite vault tree --json'],
  },

  'vault.veins': {
    group: 'Vault',
    summary: 'Every vein in the vault, as vault-relative paths.',
    params: [
      { name: 'under', type: 'string', description: 'Only veins inside this chamber.' },
      { name: 'query', type: 'string', description: 'Only veins whose path contains this text.' },
    ],
    returns: '`string[]` (sorted)',
    examples: ['macusanite vault veins', 'macusanite vault veins --under Chambers/Lab'],
  },

  'vault.chambers': {
    group: 'Vault',
    summary: 'Every chamber (folder) in the vault, outermost first.',
    returns: '`string[]` (sorted)',
    examples: ['macusanite vault chambers'],
  },

  'vault.settings': {
    group: 'Vault',
    summary: 'Read the viewer settings, merged over the defaults.',
    description:
      'The settings the window writes to `.macusanite/settings.json`: theme, font size, line width, '
      + 'default colours, the palette, recent colours, graph options, layout widths and editor flags.',
    returns: 'the merged settings object',
    examples: ['macusanite vault settings --json'],
  },

  'vault.settings.set': {
    group: 'Vault',
    summary: 'Change viewer settings.',
    description:
      'Merges a patch over the current settings and writes them back. Unknown keys are dropped and '
      + 'out-of-range numbers are clamped, exactly as the settings dialog does. Use `--set key=value` '
      + 'for one value or `--patch \'{...}\'` for a whole object; `-` reads the JSON from stdin.',
    params: [
      { name: 'set', type: 'string[]', description: 'One or more `key=value` assignments, dotted for nested keys (`graph.depth=3`).' },
      { name: 'patch', type: 'json', description: 'A settings object merged over the current one.' },
      { name: 'no-undo', type: 'boolean', description: 'Do not record an undo step.' },
    ],
    returns: 'the merged settings object',
    examples: [
      'macusanite vault settings set --set theme=light --set fontSize=18',
      'macusanite vault settings set --patch \'{"graph":{"depth":3}}\'',
    ],
    mutates: true,
    undoable: true,
  },

  'vault.state': {
    group: 'Vault',
    summary: 'Read the viewer state: the last vein read, expanded chambers, panel widths.',
    description:
      'Pure bookkeeping in `.macusanite/state.json`. It is deliberately not undoable, and the window '
      + 'rewrites it as you browse, so treat it as a hint rather than a source of truth.',
    returns: 'the stored state object (may be empty)',
    examples: ['macusanite vault state --json'],
  },

  'vault.state.set': {
    group: 'Vault',
    summary: 'Write viewer state.',
    params: [
      { name: 'state', type: 'json', required: true, positional: true, description: 'The state object to store.' },
    ],
    returns: '`{ path }`',
    examples: ['macusanite vault state set \'{"lastPath":"Home.md"}\''],
    mutates: true,
  },

  'vault.log': {
    group: 'Vault',
    summary: 'Append a line to the session log.',
    description:
      'Logs live in `.macusanite/logs/session-YYYYMMDD.log` as JSON lines, the same file the window '
      + 'writes to. Logging never touches the undo stack.',
    params: [
      { name: 'message', type: 'string', required: true, positional: true, description: 'What happened.' },
      { name: 'level', type: 'string', description: '`info`, `warn` or `error`.', default: 'info', values: ['info', 'warn', 'error'] },
    ],
    returns: '`{ level, message, file }`',
    examples: ['macusanite vault log "imported 40 veins from the field notebook"'],
    mutates: true,
  },

  'vault.logs': {
    group: 'Vault',
    summary: 'Read the session log.',
    params: [
      { name: 'limit', type: 'integer', description: 'How many of the newest lines to return.', default: 50 },
      { name: 'day', type: 'string', description: 'Only this day (`YYYYMMDD`).' },
    ],
    returns: '`[{ ts, level, message, file }]` oldest first',
    examples: ['macusanite vault logs', 'macusanite vault logs --limit 200'],
  },

  'vault.index': {
    group: 'Vault',
    summary: 'Report the state of `.macusanite/index.json`, the document index cache.',
    description:
      'The cache holds each vein\'s title, aliases, headings, links, tags and front-matter colours, '
      + 'keyed by modification time and size. `fresh` entries are reused when the window — or this CLI '
      + '— opens the vault; `stale` ones have to be read again.',
    returns: '`{ path, bytes, version, entries, veins, fresh, stale, present }`',
    examples: ['macusanite vault index'],
  },

  'vault.index.rebuild': {
    group: 'Vault',
    summary: 'Read every vein again and rewrite the index cache.',
    description:
      'Use it after bulk edits made outside Macusanite (a script, a git checkout, an editor that does '
      + 'not update modification times). It is never required for correctness — a stale entry is '
      + 'detected and re-read — but it makes the next open warm.',
    returns: '`{ index }` describing every vein',
    examples: ['macusanite vault index rebuild'],
    mutates: true,
  },

  'vault.index.drop': {
    group: 'Vault',
    summary: 'Delete the index cache.',
    description: 'The next open (window or CLI) reads the whole vault once and writes it again.',
    returns: '`{ path, dropped }`',
    examples: ['macusanite vault index drop'],
    mutates: true,
  },

  'vault.doctor': {
    group: 'Vault',
    summary: 'Check the vault for things that are probably wrong.',
    description:
      'Reports missing or unreadable `.macusanite` files, wiki links that point at nothing, veins that '
      + 'nothing links to and nothing links out of, tag counts, and whether the index cache covers the '
      + 'veins it claims to. Exit code is 1 when any check fails, which makes it usable in a pipeline.',
    returns: '`{ ok, checks: [{ name, ok, detail }], ghosts, orphans }`',
    examples: ['macusanite vault doctor', 'macusanite vault doctor --json'],
  },

  /* ── Documents ───────────────────────────────────────────────────────── */

  'vein.read': {
    group: 'Documents',
    summary: 'Read one vein as plain text.',
    description:
      'Prints the markdown source, front matter included — exactly the bytes on disk. With `--json` '
      + 'you get the same text plus its metadata in one payload.',
    params: [
      { name: 'path', type: 'string', required: true, positional: true, description: 'Vault-relative path, with or without `.md`.' },
      { name: 'with-meta', type: 'boolean', description: 'Return `{ path, text, ...metadata }` instead of the bare text.' },
    ],
    returns: 'the markdown source, or an object with `--with-meta`',
    examples: ['macusanite vein read Home.md', 'macusanite vein read Chambers/Lab/Analytical Methods --json'],
  },

  'vein.info': {
    group: 'Documents',
    summary: 'Metadata of one vein: title, aliases, tags, headings, links, colours, word count.',
    description:
      'The document as the window understands it — front matter parsed, headings given their anchor '
      + 'ids, wiki links extracted with their targets and sections, and the page/link/section colours '
      + 'from front matter.',
    params: [
      { name: 'path', type: 'string', required: true, positional: true, description: 'Vault-relative path.' },
    ],
    returns: '`{ path, title, aliases, tags, headings, links, words, color, linkColor, sectionColor, frontmatter }`',
    examples: ['macusanite vein info Chambers/Mineralogy/Fluid Inclusions.md --json'],
  },

  'vein.write': {
    group: 'Documents',
    summary: 'Replace the contents of a vein, recording an undo step.',
    description:
      'Line endings are preserved as given. Write `--text -` to read the new contents from stdin, '
      + 'which is how an agent should send a long document. A write that changes nothing is not '
      + 'recorded, so an idle save cannot pollute the undo stack.',
    params: [
      { name: 'path', type: 'string', required: true, positional: true, description: 'Vault-relative path.' },
      { name: 'text', type: 'string', description: 'New contents; `-` reads stdin.', default: '' },
      { name: 'label', type: 'string', description: 'Undo label, e.g. `edit Home.md`.', default: null },
      { name: 'no-undo', type: 'boolean', description: 'Do not record an undo step.' },
    ],
    returns: '`{ path, bytes }`',
    examples: ['macusanite vein write Home.md --text - < new-home.md', 'macusanite vein write Notes.md --text "# Notes"'],
    mutates: true,
    undoable: true,
  },

  'vein.create': {
    group: 'Documents',
    summary: 'Create a vein, with front matter and a title heading unless you provide the text.',
    description:
      '`.md` is appended when the path has no markdown extension. Creating a vein that already exists '
      + 'is not an error: the result says `created: false` and the existing text is untouched.',
    params: [
      { name: 'path', type: 'string', required: true, positional: true, description: 'Vault-relative path of the new vein.' },
      { name: 'text', type: 'string', description: 'Contents; defaults to `---title---# Title`, `-` reads stdin.' },
      { name: 'chamber', type: 'string', description: 'Create the vein inside this chamber instead.' },
    ],
    returns: '`{ path, created }`',
    examples: ['macusanite vein create "Chambers/Lab/New Method"', 'macusanite vein create Notes.md --text "# Notes\\n"'],
    mutates: true,
    undoable: true,
  },

  'vein.append': {
    group: 'Documents',
    summary: 'Append text to the end of a vein.',
    description: 'A newline is inserted first unless the file already ends with one.',
    params: [
      { name: 'path', type: 'string', required: true, positional: true, description: 'Vault-relative path.' },
      { name: 'text', type: 'string', required: true, positional: true, description: 'Text to append; `-` reads stdin.' },
      { name: 'label', type: 'string', description: 'Undo label.' },
    ],
    returns: '`{ path, bytes }`',
    examples: ['macusanite vein append Home.md "\\n## 2026 fieldwork\\n"'],
    mutates: true,
    undoable: true,
  },

  'vein.section': {
    group: 'Documents',
    summary: 'Replace a section\'s body, or add the section when it is not there yet.',
    description:
      'The heading is matched by level and text, case-insensitively. Replacing keeps everything before '
      + 'the heading and everything from the next heading of the same or a higher level, so a document '
      + 'never grows a duplicate section.',
    params: [
      { name: 'path', type: 'string', required: true, positional: true, description: 'Vault-relative path.' },
      { name: 'heading', type: 'string', required: true, positional: true, description: 'Heading text, without the `#` marks.' },
      { name: 'text', type: 'string', positional: true, description: 'New body; `-` reads stdin.' },
      { name: 'level', type: 'integer', description: 'Heading level (1-6).', default: 2 },
    ],
    returns: '`{ path, heading, replaced }`',
    examples: ['macusanite vein section Home.md "Where to go next" "Start with [[Fluid Inclusions]]."'],
    mutates: true,
    undoable: true,
  },

  'vein.rename': {
    group: 'Documents',
    summary: 'Move or rename a vein.',
    description:
      'Two undo steps are recorded (the new file and the old one), so `undo` twice restores the '
      + 'original exactly. Renaming onto an existing vein is refused.',
    params: [
      { name: 'from', type: 'string', required: true, positional: true, description: 'Current path.' },
      { name: 'to', type: 'string', required: true, positional: true, description: 'New path.' },
    ],
    returns: '`{ path, from, moved }`',
    examples: ['macusanite vein rename "Chambers/Lab/Methods.md" "Chambers/Lab/Sieve Methods.md"'],
    mutates: true,
    undoable: true,
  },

  'vein.delete': {
    group: 'Documents',
    summary: 'Delete a vein.',
    description:
      'Undo restores the text. Redo re-creates the file **empty**: a history entry stores `after: ""`, '
      + 'because the window reads the stack with a non-optional `after` field and would treat a null '
      + 'there as a corrupt file. Pass `--no-undo` to delete without an undo step at all.',
    params: [
      { name: 'path', type: 'string', required: true, positional: true, description: 'Vault-relative path.' },
      { name: 'no-undo', type: 'boolean', description: 'Delete without recording an undo step.' },
    ],
    returns: '`{ path, deleted }`',
    examples: ['macusanite vein delete "Chambers/Lab/Draft.md"'],
    mutates: true,
    undoable: true,
  },

  'vein.links': {
    group: 'Documents',
    summary: 'The wiki links a vein contains, in source order.',
    returns: '`[{ target, section, alias, embed, samePage }]`',
    examples: ['macusanite vein links Home.md --json'],
  },

  'vein.headings': {
    group: 'Documents',
    summary: 'A vein\'s outline, with the anchor id each heading can be linked by.',
    returns: '`[{ level, text, anchor }]`',
    examples: ['macusanite vein headings Wiki.md --json'],
  },

  'vein.backlinks': {
    group: 'Documents',
    summary: 'Veins that link to this one.',
    returns: '`[{ path, title, context }]` sorted by title',
    examples: ['macusanite vein backlinks "Chambers/Lab/Analytical Methods.md" --json'],
  },

  'vein.resolve': {
    group: 'Documents',
    summary: 'Resolve a wiki target the way the viewer would.',
    description:
      'Resolution order: an explicit path, a vein in the same chamber, the shallowest vein with that '
      + 'name, a front-matter title or alias, then a case-insensitive name match. A miss comes back '
      + 'with `ghost: true` and the path a new vein would be created at.',
    params: [
      { name: 'target', type: 'string', required: true, positional: true, description: 'Link target, e.g. `Fluid Inclusions`.' },
      { name: 'from', type: 'string', description: 'The vein the link appears in, for same-chamber resolution.' },
    ],
    returns: '`{ ok, path, anchor, candidates, ghost?, suggestedPath? }`',
    examples: ['macusanite vein resolve "Analytical Methods" --from Home.md --json'],
  },

  /* ── Chambers ────────────────────────────────────────────────────────── */

  'chamber.create': {
    group: 'Chambers',
    summary: 'Create a chamber (folder) inside the vault.',
    description:
      'An empty chamber is kept visible by a `.keep` marker file, so it shows up in the tree before it '
      + 'holds anything — the same convention the window uses.',
    params: [
      { name: 'path', type: 'string', required: true, positional: true, description: 'Vault-relative folder path.' },
    ],
    returns: '`{ path, created }`',
    examples: ['macusanite chamber create Chambers/Lab'],
    mutates: true,
  },

  /* ── Search and graph ────────────────────────────────────────────────── */

  'search': {
    group: 'Search and graph',
    summary: 'Search every vein: titles, headings, tags and body text, ranked in that order.',
    description:
      'The same ranking the search pane uses. Two words match anywhere and in any order; quote them '
      + '(`"sieve series"`) to require the phrase. Every term has to appear somewhere in a vein for it '
      + 'to be a result, and each result carries why it matched plus a snippet with the hits. The index '
      + 'cache is used for veined metadata and every vein is read for body text.',
    params: [
      { name: 'query', type: 'string', required: true, positional: true, description: 'Words, `"a quoted phrase"`, or `#tag`.' },
      { name: 'limit', type: 'integer', description: 'Maximum results.', default: 20 },
      { name: 'refresh', type: 'boolean', description: 'Ignore the index cache and read every vein.' },
    ],
    returns: '`{ query, terms, total, results: [{ path, title, score, snippet, headings, bodyHits }] }`',
    examples: ['macusanite search "sieve series"', 'macusanite search fluid --limit 5 --json'],
  },

  'tags': {
    group: 'Search and graph',
    summary: 'Every tag in the vault, with how many veins carry it.',
    returns: '`[{ tag, count, veins }]` busiest first',
    examples: ['macusanite tags --json'],
  },

  'ghosts': {
    group: 'Search and graph',
    summary: 'Wiki links that point at veins which do not exist yet.',
    description:
      'Each entry names the linking vein, the target text and the path a new vein would be created at. '
      + 'Creating those veins is the single most common repair an agent makes on a vault.',
    returns: '`[{ from, target, section, suggestedPath }]`',
    examples: ['macusanite ghosts --json', 'macusanite ghosts'],
  },

  'graph': {
    group: 'Search and graph',
    summary: 'The concept graph as data: document, section and tag nodes with their edges.',
    description:
      'The window lays this out for the graph pane; an agent can read the same structure to find what '
      + 'a vein is made of and what sits around it. `focus` narrows the graph to that vein and its '
      + 'neighbourhood within `depth` steps.',
    params: [
      { name: 'focus', type: 'string', description: 'Vein to centre on.' },
      { name: 'depth', type: 'integer', description: 'How many steps out from `focus` to include.', default: null },
    ],
    returns: '`{ focus, stats, nodes, edges }`',
    examples: ['macusanite graph --focus Home.md --json'],
  },

  /* ── Colours ─────────────────────────────────────────────────────────── */

  'color.set': {
    group: 'Colours',
    summary: 'Assign a colour to a page, section, link or concept.',
    description:
      'Colours are stored in `.macusanite/colors.json` and resolve most-specific-first: an explicit '
      + 'pick, then front-matter `color:`, then inheritance (a section from its page, a link from its '
      + 'source page), then the vault default. Any CSS colour name or `#rrggbb` value is accepted and '
      + 'normalised to `#rrggbb`.',
    params: [
      { name: 'kind', type: 'string', required: true, positional: true, description: 'What is being coloured.', values: ['page', 'section', 'link', 'concept'] },
      { name: 'color', type: 'string', required: true, positional: true, description: 'A colour name or `#rrggbb`.' },
      { name: 'path', type: 'string', description: 'Vein path, for `page` and `section`.' },
      { name: 'anchor', type: 'string', description: 'Heading anchor, for `section`.' },
      { name: 'from', type: 'string', description: 'Source vein, for `link`.' },
      { name: 'to', type: 'string', description: 'Target vein, for `link`.' },
      { name: 'name', type: 'string', description: 'Concept name, for `concept`.' },
      { name: 'no-undo', type: 'boolean', description: 'Do not record an undo step.' },
    ],
    returns: '`{ kind, key, color }`',
    examples: [
      'macusanite color set page gold --path Home.md',
      'macusanite color set section \'#52c41a\' --path "Chambers/Lab/Analytical Methods.md" --anchor sieve-series',
    ],
    mutates: true,
    undoable: true,
  },

  'color.clear': {
    group: 'Colours',
    summary: 'Remove a colour assignment, so the target inherits again.',
    params: [
      { name: 'kind', type: 'string', required: true, positional: true, description: 'What is being reset.', values: ['page', 'section', 'link', 'concept'] },
      { name: 'path', type: 'string', description: 'Vein path, for `page` and `section`.' },
      { name: 'anchor', type: 'string', description: 'Heading anchor, for `section`.' },
      { name: 'from', type: 'string', description: 'Source vein, for `link`.' },
      { name: 'to', type: 'string', description: 'Target vein, for `link`.' },
      { name: 'name', type: 'string', description: 'Concept name, for `concept`.' },
    ],
    returns: '`{ kind, key, colors }`',
    examples: ['macusanite color clear page --path Home.md'],
    mutates: true,
    undoable: true,
  },

  'color.reset': {
    group: 'Colours',
    summary: 'Clear every colour assignment in the vault.',
    returns: 'the empty colour set',
    examples: ['macusanite color reset'],
    mutates: true,
    undoable: true,
  },

  'color.resolve': {
    group: 'Colours',
    summary: 'The colour a target would actually be painted.',
    description:
      'Answers with the colour *after* the whole resolution order has been applied — an explicit '
      + 'pick, then front-matter, then inheritance, then the vault default — which is the question '
      + 'worth asking, since an assignment on its own does not decide what is painted.',
    params: [
      { name: 'kind', type: 'string', required: true, positional: true, description: 'What is being painted.', values: ['page', 'section', 'link', 'concept'] },
      { name: 'path', type: 'string', description: 'Vein path, for `page` and `section`.' },
      { name: 'anchor', type: 'string', description: 'Heading anchor, for `section`.' },
      { name: 'from', type: 'string', description: 'Source vein, for `link`.' },
      { name: 'to', type: 'string', description: 'Target vein, for `link`.' },
      { name: 'name', type: 'string', description: 'Concept name, for `concept`.' },
    ],
    returns: '`{ kind, color }`',
    examples: ['macusanite color resolve page --path Home.md'],
  },

  /* ── History ─────────────────────────────────────────────────────────── */

  'history': {
    group: 'History',
    summary: 'The undo and redo stacks, newest first.',
    description:
      'Every mutation is a before/after snapshot of one file, so undo is exact. The stack is capped at '
      + '400 entries and lives in `.macusanite/history.json`; the window shows the same list in its '
      + 'second bar.',
    returns: '`{ undo: [{ path, label, ts }], redo: [...] }`',
    examples: ['macusanite history --json'],
  },

  'undo': {
    group: 'History',
    summary: 'Undo the most recent recorded change.',
    description: 'Same stack as the window\'s Ctrl+Z, so the two can be interleaved safely.',
    returns: '`{ applied, path, label, stacks }`',
    examples: ['macusanite undo'],
    mutates: true,
  },

  'redo': {
    group: 'History',
    summary: 'Redo the last undone change.',
    returns: '`{ applied, path, label, stacks }`',
    examples: ['macusanite redo'],
    mutates: true,
  },

  /* ── Help ────────────────────────────────────────────────────────────── */

  'help': {
    group: 'Help',
    summary: 'The command reference: every command, its parameters and examples.',
    description:
      'With no argument it lists the commands by group. With a command name it prints that command\'s '
      + 'full page — the same text the MCP server sends to an agent as the tool description, and the '
      + 'same text the help window renders.',
    params: [
      { name: 'command', type: 'string', positional: true, description: 'Command to describe, e.g. `vein.write`.' },
      { name: 'markdown', type: 'boolean', description: 'Print markdown instead of terminal text.' },
    ],
    returns: 'the reference, or one command\'s page',
    examples: ['macusanite help', 'macusanite help vein.write'],
  },

  'docs': {
    group: 'Help',
    summary: 'The whole manual, as markdown: every feature of Macusanite, then every command.',
    description:
      'This is what the help window shows, and what `--out FILE` writes to disk. It is generated from '
      + 'the source of truth in `src/lib/catalogue.js` (commands) and `src/lib/helpDoc.js` (features), '
      + 'so it cannot drift from the implementation.',
    params: [
      { name: 'section', type: 'string', positional: true, description: 'Print only this section (a slug such as `search`).' },
      { name: 'out', type: 'string', description: 'Write the document to this file instead of stdout.' },
      { name: 'sections', type: 'boolean', description: 'List the section slugs instead of the document.' },
    ],
    returns: 'markdown',
    examples: ['macusanite docs --out docs/Help.md', 'macusanite docs search', 'macusanite docs --sections'],
  },
};

/** Commands in catalogue order, grouped, for help output. */
export function commandsByGroup() {
  const out = new Map(GROUPS.map((group) => [group, []]));
  for (const [name, entry] of Object.entries(COMMANDS)) {
    if (entry.hidden) continue;
    if (!out.has(entry.group)) out.set(entry.group, []);
    out.get(entry.group).push({ name, ...entry });
  }
  return out;
}

/** Every command name, in catalogue order. */
export function commandNames() {
  return Object.keys(COMMANDS).filter((name) => !COMMANDS[name].hidden);
}

/**
 * The MCP tool name for a command: dots are not allowed in tool names, so
 * `vein.write` becomes `vein_write`.
 */
export function toolName(command) {
  return String(command).replace(/\./g, '_');
}

/** The command behind a tool name, or null. */
export function commandForTool(name) {
  return COMMANDS[name] ? name : (COMMANDS[String(name).replace(/_/g, '.')] ? String(name).replace(/_/g, '.') : null);
}

/** Commands exposed over MCP (`mcp !== false`). */
export function mcpCommands() {
  return Object.entries(COMMANDS)
    .filter(([, entry]) => entry.mcp !== false && !entry.hidden)
    .map(([name, entry]) => ({ name, ...entry }));
}

/** The JSON Schema for one command's arguments, for MCP and for validation. */
export function inputSchema(command) {
  const entry = COMMANDS[command];
  if (!entry) return { type: 'object', properties: {} };
  const properties = {};
  const required = [];
  for (const param of entry.params ?? []) {
    const schema = { ...(PARAM_SCHEMA[param.type] ?? { type: 'string' }), description: param.description };
    if (param.default !== undefined && param.default !== null) schema.default = param.default;
    if (param.values) schema.enum = param.values;
    properties[param.name] = schema;
    if (param.required) required.push(param.name);
  }
  return required.length ? { type: 'object', properties, required } : { type: 'object', properties };
}

/** True when a command writes to the vault. */
export function isMutating(command) {
  return COMMANDS[command]?.mutates === true;
}

/** True when a command records an undoable step. */
export function isUndoable(command) {
  return COMMANDS[command]?.undoable === true;
}

/** MCP annotations for a command, derived from the same flags the CLI documents. */
export function annotations(command) {
  const mutates = isMutating(command);
  const undoable = isUndoable(command);
  return {
    readOnlyHint: !mutates,
    destructiveHint: command === 'vein.delete' || command === 'vault.index.drop',
    idempotentHint: !mutates || undoable,
    openWorldHint: false,
  };
}

/**
 * Coerce a raw value (a CLI string, an MCP JSON value) to the declared type.
 * Throws on anything that cannot be coerced, so a bad argument never reaches a
 * half-written vault.
 */
export function coerceParam(param, value) {
  if (value === undefined || value === null) return undefined;
  switch (param.type) {
    case 'boolean':
      if (typeof value === 'boolean') return value;
      if (value === 'true' || value === '' || value === 1 || value === '1') return true;
      if (value === 'false' || value === 0 || value === '0') return false;
      throw new Error(`--${param.name} expects true or false, got ${JSON.stringify(value)}`);
    case 'number':
    case 'integer': {
      const num = typeof value === 'number' ? value : Number(String(value).trim());
      if (!Number.isFinite(num)) throw new Error(`--${param.name} expects a number, got ${JSON.stringify(value)}`);
      return param.type === 'integer' ? Math.trunc(num) : num;
    }
    case 'json':
      if (typeof value !== 'string') return value;
      try {
        return JSON.parse(value);
      } catch (error) {
        throw new Error(`--${param.name} expects JSON: ${error.message}`);
      }
    case 'string[]': {
      const list = Array.isArray(value) ? value : [value];
      return list.map((item) => String(item));
    }
    default: {
      if (param.values && !param.values.includes(String(value))) {
        throw new Error(`--${param.name} must be one of ${param.values.join(', ')}`);
      }
      return String(value);
    }
  }
}

/**
 * Validate and coerce a whole argument object for a command.
 * @returns {{ok: true, args: object}|{ok: false, error: string}}
 */
export function prepareArgs(command, raw = {}) {
  const entry = COMMANDS[command];
  if (!entry) return { ok: false, error: `unknown command: ${command}` };
  const args = {};
  const known = new Set();
  for (const param of entry.params ?? []) {
    known.add(param.name);
    const value = raw[param.name];
    let coerced;
    try {
      coerced = coerceParam(param, value);
    } catch (error) {
      return { ok: false, error: error.message };
    }
    if (coerced === undefined) {
      if (param.required) return { ok: false, error: `missing required argument: ${param.name}` };
      if (param.default !== undefined) args[param.name] = param.default;
      continue;
    }
    args[param.name] = coerced;
  }
  for (const key of Object.keys(raw)) {
    if (!known.has(key) && raw[key] !== undefined) {
      return { ok: false, error: `unknown argument for ${command}: ${key}` };
    }
  }
  return { ok: true, args };
}

/** Parameters a CLI invocation may give positionally, in the order they appear. */
export function positionalParams(command) {
  return (COMMANDS[command]?.params ?? []).filter((param) => param.positional);
}

/** Merge `{set: ['a=1']}`-style assignments into an object, dotted keys included. */
export function applyAssignments(target, assignments = []) {
  const out = { ...target };
  for (const assignment of assignments) {
    const at = String(assignment).indexOf('=');
    if (at === -1) throw new Error(`--set expects key=value, got ${JSON.stringify(assignment)}`);
    const key = String(assignment).slice(0, at).trim();
    const rawValue = String(assignment).slice(at + 1);
    if (!key) throw new Error('--set needs a key');
    const value = /^-?\d+(\.\d+)?$/.test(rawValue) ? Number(rawValue)
      : rawValue === 'true' ? true
        : rawValue === 'false' ? false
          : rawValue;
    const parts = key.split('.');
    let cursor = out;
    for (const part of parts.slice(0, -1)) {
      if (typeof cursor[part] !== 'object' || cursor[part] === null) cursor[part] = {};
      cursor = cursor[part];
    }
    cursor[parts[parts.length - 1]] = value;
  }
  return out;
}
