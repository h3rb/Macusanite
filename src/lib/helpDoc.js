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
    demo: 'vault-graph',
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
    demo: 'vault-disk',
    body: `\`\`\`
My Vault/
├── .macusanite/                   # everything Macusanite manages
│   ├── vault.json                 # name, description, created
│   ├── settings.json              # viewer settings + default colours
│   ├── colors.json                # every colour you picked
│   ├── history.json               # the undo and redo stacks
│   ├── backup.json                # automatic backups for window, CLI and MCP
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
    demo: 'window-tour',
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
    demo: 'search-type',
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
    demo: 'colours',
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
    demo: 'graph-orbits',
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
    demo: 'undo-flip',
    body: `Every mutation is recorded as a before/after snapshot of a single file, so undo restores
**exactly** what changed: vein edits, new veins and chambers, colour assignments, settings changes and
vault details. The stack lives in \`.macusanite/history.json\`, holds 400 entries and is shared — a vein
you change from the CLI can be undone with \`Ctrl+Z\` in the window and vice versa.

Pure viewer state (which page was open, what was expanded, panel widths) is written to \`state.json\`
and deliberately stays out of the stack, as do log lines and the index cache. A save that changes
nothing is not recorded.

The undo and redo buttons show only the top of each stack, but **History log…** in the burger menu
opens the whole thing as a list: time, change and file, newest first, with the current state marked.
Picking any row jumps straight to it — the steps in between are undone or redone in one move — and
the list can be narrowed to the file you have open.

One documented asymmetry: deleting a vein records \`after: ""\`, because the window reads the stack with
a non-optional \`after\` field. Undo brings the text back; redo re-creates the file empty.`,
  },
  {
    slug: 'watching',
    title: 'Following the vault',
    demo: 'watching',
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
    demo: 'lazy-index',
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
    slug: 'backups',
    title: 'Backing up to S3',
    demo: 'backup-upload',
    body: `A vault is a folder, so its backup is the folder: one timestamped \`.tar.gz\` of every vein,
chamber and \`.macusanite\` file, uploaded as a single object. A run never changes the vault.

| Where | How |
| --- | --- |
| The window | **☰ → Back up to S3…** — bucket, region, prefix, endpoint, and credentials or an SSH host |
| The CLI | \`macusanite vault backup <bucket>\` — same options as flags |
| An MCP client | the \`vault_backup\` tool |

The key is \`<prefix><vault>/<YYYYMMDDTHHMMSSZ>.tar.gz\`; the prefix defaults to \`macusanite/\`, so one
bucket can hold several vaults, and restoring means untarring an object and opening the folder it made.
The archive skips \`.git\` and symlinks, and includes the viewer's metadata, so settings, colours and the
undo stacks come back with the notes.

The other route is SSH. \`--ssh-host user@backup-host\` streams the archive over the connection
(\`--ssh-key ~/keys/backup.pem\` for a PEM private key, \`--ssh-port\` when it is not 22); the host
writes it to a temporary file, uploads it with its own \`aws\` CLI, and deletes it. This machine then
needs no AWS credential at all — and the command reads none — while \`--region\`, \`--profile\` and
\`--endpoint\` name settings on the remote host. The window's dialog offers the same choice. The remote
host needs an OpenSSH server, a POSIX shell, the AWS CLI and its own working identity. The connection
runs with \`BatchMode=yes\`, so a passphrase-protected key or a password prompt fails at once instead of
waiting.

**☰ → Back up to S3…** also edits the vault’s automatic-backup setting. Ticking *Upload
automatically after each save* writes \`.macusanite/backup.json\` — the same file the CLI and MCP
server read — and the window then waits five seconds after saving stops and uploads with those
settings. One upload runs at a time — a save during an upload queues another — and a failed run
pauses automatic uploads for five minutes so a misconfiguration does not fill the session log.

The file holds every non-secret field, never a credential: a hand-typed AWS secret lasts until the
window closes, after which the environment or \`~/.aws/credentials\` supplies it (SSH needs no local
secret at all). Because the setting belongs to the vault rather than the window, a vault armed here
is armed in the other direction too, and the headless side needs no window and no repeated
invocation:

\`\`\`bash
macusanite --vault ./notes vault autobackup --bucket my-notes-backups --region eu-west-1 --on
macusanite --vault ./notes vault autobackup --bucket my-notes-backups --ssh-host backup@notes.example --on
macusanite --vault ./notes vault autobackup --off
\`\`\`

Once armed, every write uploads a timestamped archive: a save in the window after the pause above,
and from the CLI or MCP server every command that writes — \`vein write\`, \`vein create\`, \`append\`,
\`section\`, \`rename\`, \`delete\`, a chamber, colours, settings, vault details, \`undo\` and \`redo\`.
A CLI command uploads once, before it exits, and prints the report after its
normal output (\`autoBackup\` in \`--json\`). A long-lived MCP server coalesces instead: it waits a
couple of seconds after the last write and uploads one archive for the whole burst, so an agent
writing forty veins makes one object rather than forty. That outcome goes to the session log, because
no single tool call owns it, and a pending upload is flushed as the server stops, so the final write
is never lost. Reads never upload, and neither do the viewer's own bookkeeping commands (log lines,
state, the index cache) or \`vault backup\` itself. A failed upload does not fail the write — the edit
has landed — it is reported or logged, and the command still exits 0. \`vault autobackup\` with no flags
reports the current setting.

Credentials are resolved the way AWS's own tools resolve them: the access key and secret from the
command's flags (or the dialog), otherwise \`AWS_ACCESS_KEY_ID\` / \`AWS_SECRET_ACCESS_KEY\` /
\`AWS_SESSION_TOKEN\`, otherwise \`~/.aws/credentials\` and \`~/.aws/config\` — with \`--profile\` naming a
profile. \`--secret-key-file\` reads the secret from a file, which keeps it out of shell history and a
process list. A region comes from \`--region\`, \`AWS_REGION\`, \`AWS_DEFAULT_REGION\` or the profile and
defaults to \`us-east-1\`. \`--endpoint\` sends the upload to an S3-compatible service (MinIO, R2, a
gateway), addressed path-style; AWS itself is virtual-host addressed. \`--dry-run\` builds the archive
and prints where it would go, without uploading. The secret is never written to the vault or to the
session log.

The same folder can travel without a bucket: **☰ → Export vault…** writes one
\`.tar.gz\` of the vault and its undo stacks, and **☰ → Import vault…** previews and merges one back.
The CLI equivalents are \`macusanite vault export\` and \`vault import\` (\`vault import plan\` is the
dry run); with \`--replace\`, import also deletes local files the archive does not carry. The window
exports the same whole folder — every file, hidden folders included — and imports without recording
the files as changes. The desktop carries binary files byte-for-byte, and its Replace checkbox names
the local files the archive does not carry before deleting them. The browser fallback stores text
only, so it refuses a binary archive with \`binary-unsupported\` instead of corrupting it — use the
desktop app or the CLI for images and other non-text files.`,
  },

  {
    slug: 'keyboard',
    title: 'Keyboard',
    demo: 'keyboard-keys',
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
    demo: 'agents-terminal',
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
  {
    slug: 'worldbuilding',
    title: 'The Worldbuilding canvas',
    demo: 'worldbuild-canvas',
    body: `A vein marked as **Worldbuilding** (the switch at the top right of the centre pane, or the
**★ Mark** button on the canvas toolbar) opens not as lines but as cards on a canvas — one card
per heading of the vein, editing the same markdown the reader sees. Switching to **Markdown**
never loses the layout, and unmarking a vein keeps every card's place and bonds until it is marked
again.

The canvas *is* the vein: typing in a card writes that heading's prose, **+ Note** writes a new
section, **✕** deletes one (click once to arm, again to delete), and autosave and the markdown undo
apply exactly as they do in the editor. Because the layout lives in \`.macusanite/state.json\`
and the prose stays plain markdown, the same vein still reads correctly in the reader, on GitHub,
through the CLI and over MCP.

### Gestures

* **Drag** a card by its grip to move it; snap guides line it up with its neighbours. Dragging the
  background pans the canvas, and the wheel zooms around the pointer.
* **Right-click** a card for everything it can be: link it, relate it, colour it, give it an image,
  choose its type, fold it, pin it or lock it. Right-click a group for the group's own menu, and a
  connector for its relationship and routing.
* **Ctrl+click** picks cards into a set that drags as one; **Shift+drag** on the background
  box-selects. **Select ▾** offers quick picks, and the selection's menu aligns and distributes it.
* **Arrange ▾** lays out the selection, a group, a connected component, one type, or the whole vein.
* The **?** button opens the gesture cheatsheet, **Legend ▾** explains every wire and icon, and
  **Export ▾** writes the canvas out as SVG, PNG or Mermaid.

### Undoing canvas changes

The canvas keeps its own undo, separate from the markdown editor's. The toolbar's **↶** and **↷**
arrows undo and redo one step and name it in their tooltip; **Ctrl+Z** and **Ctrl+Shift+Z** (or
**Ctrl+Y**) do the same while the canvas has focus, and **History** beside the arrows lists the
whole stack — redo above the current point, undo below — with a click to jump anywhere in it. Each
vein keeps its own stack, saved with its canvas record, so the steps are still there when the vault
is closed and reopened. A step is one canvas change: a move, a group, a bond, a fold, a type, a
colour, an arrangement. Typing is not a canvas step — a card's title, prose, fields and tag box keep
their own undo while the cursor is in them, and the prose's markdown undo belongs to the editor.
[Canvas history](#canvas-history-exports-and-health) covers what a step restores.

### Deeper sections

The rest of this topic goes deeper: [cards and their heights](#cards-prose-and-heights), [types,
fields, colours and images](#types-fields-colours-and-images), [bonds, groups and
annotations](#bonds-groups-and-annotations), [arranging and
navigating](#arranging-and-navigating), and [history, exports and
health](#canvas-history-exports-and-health).`,
  },
  {
    slug: 'worldbuilding-cards',
    title: 'Cards, prose and heights',
    demo: 'worldbuild-cards',
    body: `Every card is a heading of the vein. Its title is the heading text, its prose is what sits
under that heading, and the card before the first heading is the **intro** card, titled “Before the
first heading”. Clicking a card's rendered prose swaps in the source textarea; leaving it renders
the markdown again — tables, task lists, callouts and mermaid diagrams included.

### Modes

**Cards ▾** on the toolbar, or **Card mode** in a card's right-click menu, sets
every card in the current selection:

* **Full** — prose, fields and links, the normal card.
* **Compact** — title, type, link and word counts only, for a dense overview.
* **Thumbnail** — just the node's image (or its initial), 128 × 128, for a face-only map.

### Height

A full card is either a fixed 260 px box whose prose scrolls, or **fit to content**,
where the card grows to show the whole note — no inner scrollbar, and the editing textarea grows
as you type. Choose per node under **Card height** in the right-click menu, or for the selection in
**Cards ▾**. The default for the vault lives in **Settings → Worldbuilding → Card height**; a
node's own choice overrides it either way, and overrides are saved with the vein. Content height
applies to full cards only — compact and thumbnail cards keep their designed boxes. Everything
that measures the canvas uses the real height, so connectors, group boxes, arrangement, untangle
scoring and exports follow a taller card.

### Folding, tags and locks

* The **▾ Fold** chevron collapses a card to its header; folded cards stack neatly above the card
they link to, and **Overview** folds every card at once.
* **Tags** under a card are doors: a tag naming another card flies the camera to it when clicked.
  The tag is still the note's own markdown either way; a tag that names no card stays plain text.
* Editing a **title** renames the heading, and every canvas extra — position, folds, type, fields,
  colour, image, pin, lock, mode, height — follows the new name. Bonds naming the old title drop,
  because the link target no longer resolves.
* A **content lock** (or a locked group) disables the textarea, type, fields, colour, image and
  delete button while leaving the card movable and linkable.`,
  },
  {
    slug: 'worldbuilding-types',
    title: 'Types, fields, colours and images',
    demo: 'worldbuild-types',
    body: `The drop-down in a card's header chooses what the node **is**. The type gives the card its
icon and colour and, for the game-like types, its structured fields:

| Type | Fields |
| --- | --- |
| **Stat** | a free-text value |
| **Skill** | a level, 0–10 |
| **Ability** | a minimum and maximum, unbounded |
| **Attribute** | key, value and unit — the unit box autocompletes from units used or typed earlier in the vault |
| **Property** | key and value |
| **Rating** | one value, 0–10 |
| **Note, Place, Person, Thing, Location, Locale, Biome, Scene, Perk, Effect, Condition** | prose, like a note |

### Fields

Fields are stored with the vein's canvas record, not written into the prose, and a numeric field
clamps to its range on the way in. A type change is one undo step and rewrites the card's fields
row in place; the values already stored for the new type are kept.

### Colour and image

* **Node colour** in the right-click menu overrides the type's colour for that card alone, and
  **Use the type colour** forgets the override.
* **Node image** attaches a picture as the node's icon in its header and as its face in thumbnail
  mode. Images are copied into \`.macusanite/node-images/\`; replacing or removing one deletes the
  old file once no card — and no undo snapshot — still names it.
### Pins and locks

* **Pin node** makes Arrange work around the card; the node can still be dragged by hand. **Pin
group** does the same for a whole group.
* **Lock node content** makes the card read-only while it stays movable, linkable and exportable.
  Locking a **group** is stronger: its cards cannot move, be regrouped, edited or removed, though
  relationships in and out still work. Both locks show a padlock on the card and are undone from
  the same menu.

A **tag** is never a canvas-only annotation: it is parsed from the note's markdown. The canvas just
makes it clickable, counts it in the stats bar, and offers to open the card it names.`,
  },
  {
    slug: 'worldbuilding-bonds',
    title: 'Bonds, groups and annotations',
    demo: 'worldbuild-bonds',
    body: `**Wires come from the prose first.** A dotted wire is the vein's own outline — each card
nested under its nearest shallower heading. A solid wire is a \`[[#Heading]]\` link written in a
note, and a faint green wire is a mention of another vein, \`[[Another note]]\`. A bond asserted on
the canvas itself is drawn like any other bond of its kind, and a wire to a group is drawn at twice
the weight. If removing a bond leaves its prose link drawing the same line, the notice offers to
remove that markdown link too, as a normal prose edit.

### Wires and relationships

Every wire can carry a **relationship**: associate, member of, template, parent/child,
contains/contained by, controls/controlled by, affects/affected by, ally and foe, thickening as it
strengthens. **Click the word on the wire** to step to the next kind. Right-click a connector for
**Cycle relationship**, **Reverse relationship**, **Remove asserted relationship**, curve style,
end selection and **Trace upstream/downstream**. Dragging from a selected set's menu, or
**Relate to…** in a card's menu, asserts a bond between cards or a group endpoint.

### Groups

**Groups** gather cards into one coloured box:

* Select two or more cards and choose **Group**. A whole group inside the selection is nested, not
dissolved; dragging a card into a group's box adds it, and dragging it out removes it.
* Drag a group's tab to move every member. **Collapse** turns the group into one summary card with
  a member count and link total; **Collapse all groups** does the whole vein.
* **Split into progression columns** turns a group into lanes — the group's top cards on the left,
  their subsections a tier to the right, and so on, each lane headed by its **Tier**.
* **Group colour**, **Group icon**, **Rename group**, **Pin group** and **Lock group** are in the
  group's right-click menu, beside **Ungroup** (keep the cards) and **Remove from group**.

### Annotations

**Annotations** are free-floating margin notes, independent of every heading: **+ Annotation**, or
double-click empty canvas. They drag, scroll with the canvas, export with it, and delete from their
**✕** — the vein's markdown never changes.`,
  },
  {
    slug: 'worldbuilding-arrange',
    title: 'Arranging and navigating',
    demo: 'worldbuild-arrange',
    body: `### Selecting

Click a card; **Ctrl+click** toggles it in the set and a picked set drags as
one; **Shift+drag** on the background box-selects everything it touches. **Select ▾** adds quick
picks — connected, ancestors, descendants, same type or colour, group members, pinned, locked,
untyped, imageless — and the selection's right-click menu aligns and distributes it. **Fit
selection** zooms to just those cards.

### Layouts

**Arrange ▾** asks for a scope — **Selection**, **Group**, **Connected component**, **One type** —
then one of six layouts:

* **Grid** — rows of cards in a near-square block.
* **Rows** and **Columns** — one line, horizontal or vertical.
* **Cascade** — each card offset down and right from the last.
* **Layered** — relationship depth as rows, roots on top.
* **Progression columns** — heading-tree tiers as columns, top items left, deeper tiers right.

Pinned and locked cards stay where they are and act as obstacles; collapsed groups are laid out as
their summary; and the untangler only accepts a swap that reduces how many connectors pass behind
cards. **Whole vein (grid)** is the original one-click tidy. Arrange fits its result into view.

### Getting around

Drag the background to pan and wheel to zoom around the pointer; **⤢ Fit**
frames every card, **Overview** folds every card and then fits, and double-clicking a
card's header centres it. Zoom and pan are a view, not a canvas change, so they never take an undo
step.

### Routing

**Elbow** switches selected connectors (or the whole vein) between curves and
right-angle bends; **Arrows** adds arrowheads; **Trim** ends a wire longer than a screen in a
diamond that faces the far card. Click it to reveal the far card if it is inside a collapsed group,
then centre the view on it; otherwise the view centres on the card directly. A connector's
right-click menu overrides routing for that wire alone or sends it back to the vein default.

### Finding things

**Search** filters the canvas live across titles, types, fields, colours and
group names, with previous/next jumps, **Select all** and **Isolate** (dim everything outside the
matches' connected subgraph). **Health** lists orphans and groups holding fewer than two cards,
and clicking a row selects and centres it. The **Legend ▾** and **?** popovers explain the rest in
place.`,
  },
  {
    slug: 'worldbuilding-history',
    title: 'Canvas history, exports and health',
    demo: 'worldbuild-history',
    body: `The canvas keeps its **own undo history**, separate from the markdown editor's. A drag, a
layout, a type, a colour, a bond, a fold, a card's mode or height — each is one named step, and
**Undo** and **Redo** name what they would change (\`Ctrl+Z\`, \`Ctrl+Shift+Z\` or \`Ctrl+Y\` while
the canvas has focus). **History** opens the stack as a list: redo above the current point, undo
below it, each row jumpable, capped at 60 steps per vein.

### What a step restores

A step restores the whole canvas state — positions, groups, bonds, folds, types, fields, colours,
images, pins, locks, display modes, heights and the camera — because they are saved together in
the vein's record. History survives closing and reopening the vault. Renaming or deleting a card
prunes dead anchors from every stored step, and deleting a node sweeps image files no step still
references.

### Exports

**Export ▾** writes the canvas out for other tools:

* **SVG — vector file** — a standalone drawing of every visible card, wire, group box and
  annotation, with text preserved as text.
* **SVG — Inkscape layers** — the same drawing in four named layers (Groups, Connectors, Cards,
  Annotations), so each can be selected, reordered or hidden in Inkscape.
* **PNG — image file** — the whole canvas rendered at up to twice its size, for slides and print.
* **Mermaid — markdown file** — headings become nodes and the canvas's links become edges in a
  \`flowchart\`, ready for a markdown file that renders it.

SVG and PNG draw what is on screen, so a collapsed group exports as its summary and a folded card
as its header; the Mermaid export lists every note and relationship regardless. Files are named
after the vein — \`<vein>-canvas.svg\`, \`<vein>-canvas.png\` — so an export is easy to find again.

### Health

**Health** is the lint pass for the canvas: orphans (no wire in or out) and thin groups (fewer
than two cards) appear as jumpable rows, with the counts beside the button. The vault-wide default
for card height sits in **Settings → Worldbuilding**, and every node can override it from its own
menu.`,
  },
  {
    slug: 'updates',
    title: 'Signed self-updates',
    demo: 'update-flow',
    body: `The desktop app updates itself from signed GitHub releases. A few seconds after a vault opens
— unless you turned it off in **Settings → Updates** — it fetches the release's static
\`latest.json\`, and if it names a newer version a dialog offers it with the release notes.
Nothing installs itself: **Download & restart** downloads with progress, verifies the installer
against the public key embedded in the app, installs it and restarts into the new version.

On Windows the installed version is the NSIS setup exe, installed per user into
\`%LOCALAPPDATA%\\Macusanite\` (AppData, never Program Files, no admin), and the update replaces
\`macusanite.exe\` in place in that same folder — the same way the portable exe is replaced.
Signing keys live outside the repo (\`~/.tauri/macusanite.key\`); see \`docs/Updates.md\` for the
publish flow.`,
  },
];

/**
 * How the manual is organised for readers: the help window's sidebar is this
tree, three tiers deep — topic, section, and the section's own `###` headings.
 * The order is the reading order of the manual's topics; a section's position
 * inside a topic is its position here. Every section must appear in exactly
 * one topic (the help tests check this), and a section added without a home
 * still renders, under "More".
 */
export const HELP_TOPICS = [
  {
    id: 'start',
    title: 'Getting started',
    sections: ['what-macusanite-is', 'vault-on-disk', 'window'],
  },
  {
    id: 'reading',
    title: 'Reading and editing',
    sections: ['search', 'colours', 'graph', 'undo', 'watching'],
  },
  {
    id: 'worldbuilding',
    title: 'Worldbuilding',
    sections: [
      'worldbuilding',
      'worldbuilding-cards',
      'worldbuilding-types',
      'worldbuilding-bonds',
      'worldbuilding-arrange',
      'worldbuilding-history',
    ],
  },
  {
    id: 'care',
    title: 'Vault care',
    sections: ['lazy-index', 'backups', 'updates'],
  },
  {
    id: 'automation',
    title: 'Automation',
    sections: ['agents'],
  },
  {
    id: 'reference',
    title: 'Reference',
    sections: ['keyboard', 'this-manual', 'commands', 'limitations'],
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

The sections are the manual's own structure, grouped in the help window's sidebar by topic:
\`worldbuilding\` and its five deeper sections, \`search\`, \`colours\`, \`graph\`, \`undo\`,
\`watching\`, \`lazy-index\`, \`backups\`, \`updates\`, \`keyboard\`, \`agents\`, \`commands\`,
\`limitations\`, and the rest. Each feature section also carries a small animated figure,
generated from the same declarations — see \`src/lib/helpDemos.js\`.`,
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
  const flags = [entry.external ? 'uploads to a remote service' : (!isMutating(name) ? 'reads only' : 'writes to the vault'),
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
  else if (entry.external) parts.push('Uploads to a remote service; the vault is unchanged.');
  return parts.join(' ');
}

/** The command reference section, grouped exactly like the CLI's help. */
export function commandReference({ commandsOnly = false } = {}) {
  const lines = [commandsOnly ? '## Commands' : '## Command reference', ''];
  for (const [group, entries] of commandsByGroup()) {
    if (!entries.length) continue;
    lines.push(`### ${group}`, '');
    lines.push('| Command | What it does | Effect |', '| --- | --- | --- |');
    for (const entry of entries) {
      const effect = entry.external
        ? 'upload'
        : isMutating(entry.name) ? (isUndoable(entry.name) ? 'undoable' : 'write') : 'read';
      lines.push(`| [\`${entry.name}\`](#${slugify(entry.name)}) | ${entry.summary} | ${effect} |`);
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
* **A backup is assembled in memory and uploaded as one object.** A markdown vault is small; a vault
  holding large binaries is read whole into memory, and every run is a fresh full copy rather than an
  incremental sync.
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

/**
 * A manual with its generation date pinned, so two manuals can be compared.
 *
 * The date belongs in the file — it says when the text was built — but it also
 * changes at midnight, and a clean checkout must not fail `docs:check` because
 * the committed manual was generated on a different day.
 */
export function normalizeManual(markdown) {
  return String(markdown ?? '')
    // A Windows checkout may hold the file with CRLF line endings; the
    // generator always writes LF, and that difference is git's business.
    .replace(/\r\n/g, '\n')
    .replace(/generated \d{4}-\d{2}-\d{2}/, 'generated (date-pinned)');
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
