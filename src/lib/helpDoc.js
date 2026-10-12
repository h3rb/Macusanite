/**
 * The Macusanite manual, generated from the source of truth.
 *
 * The feature prose below and the command reference (built from
 * [src/lib/catalogue.js](catalogue.js)) are combined into one markdown document
 * that has three homes and no copies:
 *
 *   * `macusanite docs` prints it, `--out FILE` writes it (that is how
 *     `docs/Help.md` is produced by `npm run docs`);
 *   * the help window renders the same string, with a search box over it;
 *   * every MCP tool description is the matching page from the same generator.
 *
 * Nothing in here is hand-maintained twice: adding a command to the catalogue
 * adds it to the manual and to every agent's tool list.
 */
import { COMMANDS, GROUPS, commandsByGroup, commandNames, toolName, isMutating, isUndoable, inputSchema } from './catalogue.js';

export const DOC_TITLE = 'Macusanite Help';

/**
 * The manual's feature sections, in order. `body` is markdown; the command
 * reference is appended from the catalogue, so it is not listed here.
 */
export const FEATURES = [
  {
    slug: 'what-macusanite-is',
    title: 'What Macusanite is',
    body: `Macusanite is a viewer for a **vault**: a folder tree of markdown that behaves like a
wiki. Folders are **chambers**, markdown files are **veins**, and a **concept graph** shows how a
document is built and where it sits in the vault.

There is no database server and no account. A vault is a folder; everything the viewer needs lives in
a \`.macusanite\` folder at its root, and every file in it is plain text you can read, diff and
version.

* **The window** — [src/](../../src) is plain ES modules rendered by the platform webview; the shell
  is Rust with Tauri, so the shipped artefact is one small native binary.
* **The headless side** — the same vault operations are available to scripts and AI agents through a
  **CLI** and an **MCP server**; both run on Node and neither needs a window.`,
  },
  {
    slug: 'vault-on-disk',
    title: 'The vault on disk',
    body: `\`\`\`
My Vault/
├── .macusanite/                   # everything Macusanite manages
│   ├── vault.json                 # name, description, created
│   ├── settings.json              # viewer settings + default colours
│   ├── colors.json                # every colour you picked
│   ├── history.json               # the undo and redo stacks
│   ├── state.json                 # last vein read, expanded chambers, panel widths
│   ├── index.json                 # headings, links and tags per vein (a cache)
│   └── logs/session-YYYYMMDD.log  # one JSON-lines log per day
├── Home.md
└── Chambers/
    ├── Fieldwork/
    │   └── Macusanite Occurrence.md
    └── Lab/
        └── Analytical Methods.md
\`\`\`

* Folders whose name starts with \`.\` are never indexed, so \`.macusanite\` and \`.git\` stay out of
  the tree and the graph. Vein extensions are \`.md\`, \`.markdown\` and \`.mdx\`.
* Venom files (a chamber with nothing in it) are kept visible by a \`.keep\` marker file.
* \`vault.json\` is written on first open with the folder's name, so a vault always has an identity.
* Deleting \`index.json\` is safe: the next open reads the vault and writes it again.
* \`settings.json\` and \`colors.json\` are the two files you are meant to edit by hand, so the open window
  follows them: save one and the change lands at once — see [Following the vault](#following-the-vault).
  Everything else in the folder is the viewer's own bookkeeping, and the watcher ignores it.`,
  },
  {
    slug: 'window',
    title: 'The window',
    body: `| Region | What it does |
| --- | --- |
| **Top bar** | the menu (new, open, save, undo, redo, settings, help, wiki, exit), the vault name and description, and wiki breadcrumbs that fill in as you follow links |
| **Second bar** | back and forward, the current file location, chips for recently visited veins, and undo/redo buttons that name what they would change |
| **Left** | two panes behind tabs: **Chambers** (the vault tree, chambers fold open, a filter box narrows it) and **Search** |
| **Centre** | the rendered vein: a colour swatch beside the page title, every heading and every wiki link, edit mode with autosave, and backlinks at the bottom |
| **Right** | the concept graph — sections, linked veins, unwritten "ghost" pages and tags, with pan, zoom, drag and depth toggles |

Reading:

* Clicking a **wiki link** opens its vein, scrolled to the section when the link names one. A link to
  a vein that does not exist yet renders as a **ghost**: dotted underline, a \`＋\` badge, and clicking
  it creates the vein in the current chamber and opens it.
* \`Ctrl+K\` opens **quick jump**: type any part of a path to score every vein by name, path and
  subsequence (\`fm\` finds \`Fieldwork/Macusanite\`).
* The **backlinks** list at the foot of a document names every vein that links to it, with the section
  that did the linking.
* Web links open in your browser, never inside the vault window.

Editing:

* **Edit** turns the reader into an editor for one vein. \`Ctrl+S\` saves; autosave writes for you
  \`autosaveDelayMs\` after you stop typing (800 ms by default; turn it off in Settings).
* Leaving edit mode with unsaved text asks the editor to keep or discard the draft — the draft is what
  the search pane and the graph see while it is unsaved.
* Markdown support: headings, tables, task lists, callouts, fenced code, and **mermaid** diagrams
  (flowcharts, sequence, class, state, pie, gantt, journey). A diagram that fails to parse shows its
  error and source inline instead of breaking the page.
* If the same vein is saved by another program while you have unsaved text, the warning offers a
  line-by-line merge — the disk's changes, yours, and any conflict marked in the editor — instead of
  only keeping your draft. See [Following the vault](#following-the-vault).`,
  },
  {
    slug: 'search',
    title: 'Search',
    body: `\`Ctrl+F\` opens the search pane. Typing searches every vein as you go — titles, section
headings, tags and body text, ranked in that order:

* a vein whose **title** is exactly what you typed comes first;
* then veins with a **heading** match, shallower headings first;
* then **tags**;
* then **body** text, and a match near the top of a vein outranks one buried in a footnote.

Every term you type has to appear somewhere for a vein to be a result. Two words match anywhere and in
any order; quoting them — \`"sieve series"\` — requires the phrase. \`#fieldwork\` matches the tag.

Each result says *why* it matched (\`title\`, \`§ Sieve series\`, \`tag\`, \`2 in text\`) and shows a
snippet with the terms already marked. Clicking a result opens the vein and marks **every** hit in the
page, with the current one ringed; \`F3\` and \`Shift+F3\` step through them, and the counter above the
results says where you are. \`Esc\` clears the query, \`Esc\` again puts the tree back.

Because a vault is indexed lazily, a search on a cold vault answers in two stages: titles, sections and
tags are ranked straight from the index cache, while the body text behind them is read in the
background and the results grow as it arrives (the status row shows \`reading 240/5001…\`).`,
  },
  {
    slug: 'colours',
    title: 'Colours',
    body: `Every **page**, every **link** and every **section** starts at the vault default —
white until you change it in **Settings → Default colours** — and can be recoloured by clicking its
swatch. The picker offers a common palette, a searchable selection of X11 colours, a \`#hex\` field and
red/green/blue sliders that stay in sync.

Colours resolve most-specific-first:

1. an explicit pick in the picker (this wins, so picking always has a visible effect);
2. front-matter \`color:\`, \`link-color:\` or \`section-color:\`;
3. inheritance — a section from its page, a link from the page it starts on;
4. the vault default.

In the graph, an edge leaves the **source** in the link colour and arrives at the **target** in the
target page's colour, fading across the line. On the command line the same assignments are
\`color set\`, \`color clear\`, \`color reset\` and \`color resolve\`.`,
  },
  {
    slug: 'graph',
    title: 'The concept graph',
    body: `The right-hand pane answers two questions at once: *what is this note made of*, and *where
does it sit in the vault*.

| Node | Meaning |
| --- | --- |
| Large circle | the vein you are reading |
| Small ring | a section of that vein |
| Filled circle | another vein — one it links to, or one that links here |
| Dashed circle | a **ghost** — a page that does not exist yet |
| \`#\` circle | a tag |

Edge kinds: solid = a wiki link, dotted = *contains* (a page and its sections), faint = a tag. Depth,
sections, tags, ghost pages and vault context are toggles at the bottom of the pane. Drag a node to
rearrange, drag the background to pan, scroll to zoom, click a node to navigate. \`graph\` returns the
same structure as data.`,
  },
  {
    slug: 'undo',
    title: 'Undo and redo',
    body: `Every mutation is recorded as a before/after snapshot of a single file, so undo restores
**exactly** what changed: vein edits, new veins and chambers, colour assignments, settings changes and
vault details. The stack lives in \`.macusanite/history.json\`, holds 400 entries and is shared — a vein
you change from the CLI can be undone with \`Ctrl+Z\` in the window and vice versa.

Pure viewer state (which page was open, what was expanded, panel widths) is written to \`state.json\`
and deliberately stays out of the stack, as do log lines and the index cache. A save that changes
nothing is not recorded.

One documented asymmetry: deleting a vein records \`after: ""\`, because the window reads the stack with
a non-optional \`after\` field. Undo brings the text back; redo re-creates the file empty.`,
  },
  {
    slug: 'watching',
    title: 'Following the vault',
    body: `The vault is watched while it is open, in the window *and* by nothing else — the watcher
lives in the desktop shell. A vein created, edited or deleted by another program appears in the tree,
the index, the graph and — when it is the open vein and nothing is unsaved — in the reader itself,
without a reload.

Bursts of events are coalesced into one refresh, the viewer's own writes never echo back, and a change
that a walk says has not moved anything (the viewer's own bookkeeping, another window's ping) is
recognised as nothing at all. Unsaved text always wins: an external edit to the file you are typing
into warns instead of replacing your caret. The \`◈\` beside the vault name turns green while the vault
is being followed.

Unsaved text still wins, but it no longer wins by itself: a warning that a vein changed under your
draft comes with a **Merge…** button, and the dialog shows the two versions line by line — which
lines came from disk, which are yours, and every place they disagree, marked with \`<<<<<<<\`, \`=======\` and \`>>>>>>>\` the way a merge tool does. From there: **Merge into my draft**, **Use the disk
version**, or **Keep my draft**. Autosave holds back while that question is open, and it stays out of
the way while merge markers are still in the text, so the clock can never write a half-resolved
conflict into a vein — \`Ctrl+S\` saves one deliberately.

Two files inside \`.macusanite\` are followed for a different reason: \`settings.json\` and
\`colors.json\` are the two you are meant to edit by hand. Change the theme, a font size, a panel width
or a colour and save, and the window that is already open takes it at once — the document is
re-rendered, the graph and the settings dialog follow, and nothing is written back, because reading a
file is not an edit and never enters the undo stack. A file that cannot be parsed is refused with a
warning and your current settings are kept. Everything else in the folder (\`index.json\`, \`state.json\`,
the undo stacks, the session log, \`vault.json\`) is the viewer's own bookkeeping and stays quiet.`,
  },
  {
    slug: 'lazy-index',
    title: 'Opening a large vault',
    body: `A vault is opened by *describing* it, not by reading it. Opening walks the folder once —
which veins exist, when each last changed — and reads \`.macusanite/index.json\`, which holds what each
vein contained the last time it was read: its title, aliases, headings, links, tags and front-matter
colours. Anything whose modification time and size still match is taken from the cache, so reopening a
vault you have not touched reads no files at all.

Whatever the cache cannot describe — a new vein, an edited one, a vault opened for the first time — is
read afterwards, in the background, a couple of dozen files at a time. The window is usable from the
first walk: the tree, the graph, wiki links and search all work while the index fills in, and the
sidebar footer shows the progress (\`indexing 420/5001\`) and then how many veins are described.

Freshness is modification time **plus** size. A file rewritten inside the same clock tick without
changing size is the one blind spot: the watcher covers edits made while the vault is open, and a vein
saved by the viewer refreshes its own entry immediately. \`vault index\` reports the cache's state and
\`vault index rebuild\` rewrites it.`,
  },
  {
    slug: 'keyboard',
    title: 'Keyboard',
    body: `| Keys | Action |
| --- | --- |
| \`Ctrl+S\` | save the open vein |
| \`Ctrl+Z\` / \`Ctrl+Shift+Z\` | undo / redo (file-level, vault-wide) |
| \`Ctrl+K\` | quick jump to a vein by name |
| \`Ctrl+F\` | search the whole vault |
| \`F3\` / \`Shift+F3\` | next / previous search hit in the open vein |
| \`Alt+←\` / \`Alt+→\` | back / forward through navigation history |
| \`Esc\` | clear the search, close the search pane, or leave edit mode |`,
  },
  {
    slug: 'agents',
    title: 'Driving Macusanite without a window',
    body: `The CLI and the MCP server are the same API over the same vault. Both are Node
programs and need no build step; both speak to a vault through
[src/lib/vaultStore.js](../../src/lib/vaultStore.js), which writes the same files the window writes,
so a vault can be passed back and forth freely.

### The CLI

\`\`\`bash
npm run cli -- vault info                       # or: node cli/macusanite.mjs vault info
node cli/macusanite.mjs --vault ./notes search "sieve series" --json
node cli/macusanite.mjs vein write Home.md --text - < new-home.md
\`\`\`

Every command takes \`--json\` for machine-readable output, \`--vault <folder>\` (or
\`MACUSANITE_VAULT\`) to pick a vault, and \`--help\` for its own documentation. Output goes to stdout,
diagnostics to stderr, and the exit code is non-zero when a command fails, so it composes in a shell
pipeline. Commands that write record an undo step unless you pass \`--no-undo\`.

### MCP over stdio

\`\`\`bash
node cli/macusanite.mjs mcp stdio --vault ./notes
\`\`\`

One JSON-RPC message per line on stdin, one per line on stdout, logs on stderr. This is what an MCP
client configured as a *local command* expects.

### MCP over HTTP, headless

\`\`\`bash
node cli/macusanite.mjs mcp serve --vault ./notes --port 8765
\`\`\`

The server binds \`127.0.0.1\` by default and speaks JSON-RPC 2.0 on one endpoint (\`POST
http://127.0.0.1:8765/mcp\`), with \`GET /health\` for readiness. It answers both protocol eras: the
legacy \`initialize\` handshake (up to \`2025-11-25\`) that Claude Desktop, VS Code and Cursor use, and
the newer \`server/discover\` handshake of the 2026-07-28 revision. \`--host 0.0.0.0\` exposes it to the
network — only do that on a machine you trust, since the port is unauthenticated by design.

### MCP through a file intake

\`\`\`bash
node cli/macusanite.mjs mcp intake --dir ./spool --watch
\`\`\`

For agents that cannot open a socket. Write a JSON-RPC request to \`./spool/<name>.request.json\`; the
CLI picks it up, runs it, writes \`./spool/<name>.response.json\` with the reply, and moves the request
aside to \`<name>.done\`. One file may hold a single request or an array of them. Poll the response
file, or watch the directory. \`--once\` processes whatever is pending and exits, which is all a cron
job or a tool call needs.`,
  },
];

const slugify = (text) => String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Where the manual itself lives — appended to the feature prose below. */
const THIS_MANUAL = {
  slug: 'this-manual',
  title: 'This manual',
  body: `This document is generated from the same declarations the program runs on, so
it cannot drift: the commands come from \`src/lib/catalogue.js\` and the prose here from
\`src/lib/helpDoc.js\`. It has three homes, and they are the same text:

| Where | How to open it |
| --- | --- |
| The **help window** | the **?** button in the top bar, the **☰ → Help and manual** menu item, or \`F1\` — a separate window, so your vein stays open. It has a search box: every word you type has to appear, \`"a quoted phrase"\` has to appear whole, sections that match stay and the rest are hidden, and \`Enter\` steps through the hits with the current one ringed |
| The **CLI** | \`macusanite docs\` prints it, \`macusanite docs <section>\` prints one section, \`macusanite docs --sections\` lists the slugs, and \`macusanite docs --out docs/Help.md\` writes it to a file (that is exactly what \`npm run docs\` does) |
| An **MCP client** | the \`docs\` tool, or the \`macusanite://manual\` resource, which every agent should read before guessing how something works |

The sections below are the windows into the manual's own structure: \`search\`, \`colours\`,
\`graph\`, \`undo\`, \`watching\`, \`lazy-index\`, \`keyboard\`, \`agents\`, \`commands\`,
\`limitations\`.`,
};

/** Section slugs a caller can ask `docs` for, in order. */
export function helpSections() {
  return [...FEATURES.map((section) => ({ slug: section.slug, title: section.title })),
    { slug: THIS_MANUAL.slug, title: THIS_MANUAL.title },
    { slug: 'commands', title: 'Command reference' },
    { slug: 'limitations', title: 'Limitations' }];
}

export const DEFAULT_DOC_SECTIONS = helpSections().map((section) => section.slug);

/** One command's page, as markdown. `long: false` trims it for a tool description. */
export function commandPage(name, { long = true } = {}) {
  const entry = COMMANDS[name];
  if (!entry) return null;
  const lines = [`### \`${name}\``, '', entry.summary, ''];
  if (long && entry.description) lines.push(entry.description, '');
  else if (entry.description) lines.push(entry.description.split('\n')[0], '');

  const params = entry.params ?? [];
  if (params.length) {
    lines.push('| Argument | Type | Required | Description |', '| --- | --- | --- | --- |');
    for (const param of params) {
      const fallback = param.default === undefined || param.default === null ? '' : ` Default \`${JSON.stringify(param.default)}\`.`;
      const values = param.values ? ` One of ${param.values.map((v) => `\`${v}\``).join(', ')}.` : '';
      lines.push(`| \`${param.name}\` | ${param.type} | ${param.required ? 'yes' : 'no'} | ${param.description}${values}${fallback} |`);
    }
    lines.push('');
  }
  if (entry.returns) lines.push(`**Returns** ${entry.returns}`, '');
  const flags = [!isMutating(name) ? 'reads only' : 'writes to the vault',
    isUndoable(name) ? 'records an undo step' : null,
    entry.mcp === false ? 'CLI only, not exposed over MCP' : `MCP tool \`${toolName(name)}\``,
  ].filter(Boolean);
  lines.push(`**Kind** ${flags.join(' · ')}`, '');
  if ((entry.examples ?? []).length) {
    lines.push('```bash', ...entry.examples, '```', '');
  }
  return lines.join('\n');
}

/** A compact description for an MCP tool: enough for an agent to choose well. */
export function commandSummary(name) {
  const entry = COMMANDS[name];
  if (!entry) return '';
  const params = (entry.params ?? []).map((param) => `${param.name}${param.required ? '' : '?'}:${param.type}`);
  const parts = [entry.summary];
  if (params.length) parts.push(`Arguments: ${params.join(', ')}.`);
  if (isMutating(name)) parts.push(isUndoable(name) ? 'Writes to the vault; undoable.' : 'Writes to the vault.');
  return parts.join(' ');
}

/** The command reference section, grouped exactly like the CLI's help. */
export function commandReference({ commandsOnly = false } = {}) {
  const lines = [commandsOnly ? '## Commands' : '## Command reference', ''];
  for (const [group, entries] of commandsByGroup()) {
    if (!entries.length) continue;
    lines.push(`### ${group}`, '');
    lines.push('| Command | What it does | Writes |', '| --- | --- | --- |');
    for (const entry of entries) {
      lines.push(`| [\`${entry.name}\`](#${slugify(entry.name)}) | ${entry.summary} | ${isMutating(entry.name) ? (isUndoable(entry.name) ? 'undoable' : 'yes') : 'no'} |`);
    }
    lines.push('');
    for (const entry of entries) lines.push(commandPage(entry.name), '');
  }
  return lines.join('\n');
}

const LIMITATIONS = `## Limitations

* **Matching is literal.** Search does not stem or fuzz: \`sieving\` does not find \`sieve\`. There are
  no operators beyond a quoted phrase and \`#tag\`.
* **Index freshness is modification time plus size.** A vein rewritten inside the same clock tick with
  an identical byte count can look unchanged until it is opened or touched.
* **Search holds plain text.** Ranking bodies and quoting snippets need the words themselves, so a
  search on a huge vault reads it (the cache covers the metadata, not the prose).
* **Deleting a vein is asymmetric.** Undo restores the text; redo re-creates the file empty — see
  [Undo and redo](#undo-and-redo).
* **Embeds** (\`![[Note]]\`) render as reference cards, not as transcluded content.
* **The undo stack is snapshots, not diffs**, capped at 400 entries.
* **MCP over HTTP is unauthenticated.** It binds loopback by default; \`--host\` is your decision.
* **A merge can only see lines.** Two sides that insert at the same point — both appending to the end
  of a vein, say — are marked as a conflict rather than guessed at, and a vein whose whole body changed
  on both sides is one region to resolve.
* **The merge offer holds autosave back for 15 seconds.** Answer it, or the clock saves the draft as
  usual; the session log records that the offer went unanswered.
* **A hand-edit to \`settings.json\` or \`colors.json\` made in the few hundred milliseconds after the
  viewer saves the same file** is taken for the echo of that save and stays quiet until the next open
  — the one moment where editing either by hand does not land live.
* **The manual is generated.** Edit \`src/lib/helpDoc.js\` or \`src/lib/catalogue.js\` and run
  \`npm run docs\`; edits to \`docs/Help.md\` are overwritten.`;

/**
 * The whole manual as one markdown string.
 * @param {{section?: string|null, commandsOnly?: boolean}} [options]
 */
export function buildHelpMarkdown({ section = null, commandsOnly = false } = {}) {
  if (commandsOnly) return `${commandReference({ commandsOnly: true })}\n`;

  if (section) {
    const wanted = [...FEATURES, THIS_MANUAL].find((entry) => entry.slug === section);
    if (wanted) return `## ${wanted.title}\n\n${wanted.body}\n`;
    if (section === 'commands') return `${commandReference()}\n`;
    if (section === 'limitations') return `${LIMITATIONS}\n`;
    return null;
  }

  const lines = [
    `# ${DOC_TITLE}`,
    '',
    `Everything Macusanite does — the window, the vault format, the CLI, the API and the MCP server.`,
    '',
    '> Generated by `npm run docs` from `src/lib/catalogue.js` and `src/lib/helpDoc.js`.',
    '> This document is what the **Help** window shows, and what `macusanite docs` prints.',
    '',
    '## Contents',
    '',
  ];
  for (const entry of helpSections()) {
    lines.push(`* [${entry.title}](#${entry.slug})`);
  }
  lines.push('');
  for (const entry of FEATURES) {
    lines.push(`## ${entry.title}`, '', entry.body, '');
  }
  lines.push(`## ${THIS_MANUAL.title}`, '', THIS_MANUAL.body, '');
  lines.push(commandReference(), '');
  lines.push(LIMITATIONS, '');
  lines.push('---', '', `${commandNames().length} commands · generated ${new Date().toISOString().slice(0, 10)}`, '');
  return lines.join('\n');
}

/** Machine-readable index of everything the manual documents (handy for tests). */
export function helpIndex() {
  return {
    title: DOC_TITLE,
    sections: helpSections(),
    groups: GROUPS,
    commands: Object.fromEntries(commandNames().map((name) => [name, {
      group: COMMANDS[name].group,
      tool: toolName(name),
      schema: inputSchema(name),
      mutates: isMutating(name),
      undoable: isUndoable(name),
    }])),
  };
}
