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
    body: `Macusanite is a viewer for a **vault**, which is a folder tree of markdown that behaves like a wiki. Folders are **chambers**, markdown files are **veins**, and a **concept graph** shows how a document is structured and where it sits within the vault.

The application requires no database server and no account. A vault is a folder, and everything the viewer needs is stored in a \`.macusanite\` folder at its root, where every file is plain text that can be read, diffed and versioned.

* **The window** renders plain ES modules from [src/](../../src) through the platform webview, while the shell uses Rust and Tauri, so the shipped artefact is one small native binary.
* **The headless side** exposes the same vault operations to scripts and AI agents through a **CLI** and an **MCP server**, both of which run on Node and neither of which requires a window.`,
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

* Folders whose names begin with \`.\` are never indexed, which keeps \`.macusanite\` and \`.git\` out of the tree and the graph. Veins may use the \`.md\`, \`.markdown\` or \`.mdx\` extension.
* An empty chamber remains visible through a \`.keep\` marker file.
* \`vault.json\` is written on the first open with the folder's name, so every vault has an identity.
* Deleting \`index.json\` is safe, because the next open reads the vault and writes the file again.
* \`settings.json\` and \`colors.json\` are the two files that users are expected to edit by hand, so the open window follows both of them: when either file is saved, the change takes effect immediately, as described in [Following the vault](#following-the-vault). The remaining files are the viewer's own bookkeeping, and the watcher ignores them.`,
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
| **Right** | the concept graph, which shows sections, linked veins, unwritten "ghost" pages and tags, and which provides pan, zoom, drag and depth controls; it can fold to a vertical rail, and clicking that rail unfolds it |

Reading:

* Clicking a **wiki link** opens its vein and scrolls to the named section when the link includes one. A link to a vein that does not exist yet appears as a **ghost**, which has a dotted underline and a \`＋\` badge, and clicking it creates the vein in the current chamber and opens it.
* \`Ctrl+K\` opens **quick jump**, where typing any part of a path scores every vein by name, path and subsequence, so \`fm\` can find \`Fieldwork/Macusanite\`.
* The **backlinks** list at the foot of a document names every vein that links to it, together with the section that contains the link.
* Web links open in the system browser and never inside the vault window.

Editing:

* **Edit** turns the reader into an editor for one vein. \`Ctrl+S\` saves the vein, while autosave writes \`autosaveDelayMs\` after typing stops (800 ms by default, and the delay can be disabled in Settings).
* Leaving edit mode with unsaved text asks whether to keep or discard the draft, and that draft is what the search pane and graph use until it is saved.
* Markdown support includes headings, tables, task lists, callouts, fenced code and **mermaid** diagrams such as flowcharts, sequence diagrams, class diagrams, state diagrams, pie charts, gantt charts and journey diagrams. If a diagram fails to parse, the page shows its error and source inline instead of failing.
* If another program saves a vein while unsaved text exists, the warning offers a line-by-line merge of the disk changes, the draft and every conflict, rather than only preserving the draft. See [Following the vault](#following-the-vault).`,
  },
  {
    slug: 'search',
    title: 'Search',
    demo: 'search-type',
    body: `\`Ctrl+F\` opens the search pane, and typing searches every vein as the query changes across titles, section headings, tags and body text, ranked in that order:

* a vein whose **title** matches the query comes first;
* veins with a **heading** match follow, and shallower headings outrank deeper ones;
* **tags** come next;
* **body** text comes last, and a match near the top of a vein outranks one buried in a footnote.

Every term in the query must appear somewhere before a vein becomes a result. Two unquoted words may match anywhere and in any order, while quoting them as \`"sieve series"\` requires the phrase, and \`#fieldwork\` matches the tag.

Each result explains why it matched by reporting a \`title\`, a \`§ Sieve series\`, a \`tag\` or a count such as \`2 in text\`, and it includes a snippet with the terms already marked. Clicking a result opens the vein and marks **every** occurrence in the page while ringing the current one; \`F3\` and \`Shift+F3\` move through the occurrences, and the counter above the results reports the position. \`Esc\` clears the query, and a second \`Esc\` restores the tree.

Because a vault is indexed lazily, a search on a cold vault answers in two stages. Titles, sections and tags are ranked directly from the index cache, while body text is read in the background and the results grow as it arrives, with the status row showing progress such as \`reading 240/5001…\`.`,
  },
  {
    slug: 'colours',
    title: 'Colours',
    demo: 'colours',
    body: `Every **page**, every **link** and every **section** begins at the vault default, which is white until it is changed in **Settings → Default colours**, and each element can be recoloured by clicking its swatch. The picker offers a common palette, a searchable selection of X11 colours, a \`#hex\` field and red, green and blue sliders that remain synchronized.

Colours resolve from most specific to least specific:

1. an explicit selection in the picker, which takes precedence so that a selection always has a visible effect;
2. front matter \`color:\`, \`link-color:\` or \`section-color:\`;
3. inheritance, where a section inherits from its page and a link inherits from the page on which it starts;
4. the vault default.

In the graph, an edge leaves the **source** in the link colour and arrives at the **target** in the target page's colour, fading across the line. On the command line, the same assignments are available through \`color set\`, \`color clear\`, \`color reset\` and \`color resolve\`.`,
  },
  {
    slug: 'graph',
    title: 'The concept graph',
    demo: 'graph-orbits',
    body: `The right-hand pane answers two questions: what the current note contains, and where that note sits within the vault.

| Node | Meaning |
| --- | --- |
| Large circle | the vein you are reading |
| Small ring | a section of that vein |
| Filled circle | another vein — one it links to, or one that links here |
| Dashed circle | a **ghost** — a page that does not exist yet |
| \`#\` circle | a tag |

Solid edges represent wiki links, dotted edges represent containment between a page and its sections, and faint edges represent tags. The toggles at the bottom of the pane control depth, sections, tags, ghost pages and vault context. A node can be dragged to rearrange the graph, the background can be dragged to pan, the wheel zooms, and clicking a node navigates to it. The \`graph\` command returns the same structure as data.

The **hide** button folds the pane into a narrow vertical rail on the right, and the centre then expands into the available space. Clicking the rail or the **Graph** button in the top bar unfolds the pane again, and the folded state is stored with the rest of the vault's layout.`,
  },
  {
    slug: 'undo',
    title: 'Undo and redo',
    demo: 'undo-flip',
    body: `Every mutation is recorded as a before-and-after snapshot of one file, so undo restores the affected file exactly, whether the change was a vein edit, a new vein or chamber, a colour assignment, a settings change or an edit to vault details. The stack is stored in \`.macusanite/history.json\`, holds 400 entries and is shared, so a vein changed from the CLI can be undone with \`Ctrl+Z\` in the window and a change made in the window can be undone from the CLI.

Pure viewer state, including the open page, expanded chambers and panel widths, is written to \`state.json\` and deliberately excluded from the stack. Log lines and the index cache are excluded as well, and a save that changes nothing is not recorded.

The undo and redo buttons show only the top of each stack, while **History log…** in the burger menu opens the entire history as a list of time, change and file, newest first, with the current state marked. Selecting any row jumps directly to that state, which undoes or redoes all the steps between the current state and the selected row in one move, and the list can be filtered to the open file.

One documented asymmetry affects deletion: removing a vein records \`after: ""\`, because the window reads the stack with a non-optional \`after\` field. Undo therefore restores the text, while redo recreates the file empty.`,
  },
  {
    slug: 'watching',
    title: 'Following the vault',
    demo: 'watching',
    body: `The desktop shell watches the vault while it is open, so a vein that another program creates, edits or deletes appears in the tree, the index, the graph and the reader without a reload, provided that the affected vein is open and no unsaved text exists.

Bursts of events are combined into one refresh, the viewer's own writes never echo back, and a change that a subsequent walk shows to have had no effect, such as one caused by the viewer's own bookkeeping or another window's ping, is ignored. Unsaved text takes precedence, and an external edit to the file being typed into produces a warning instead of replacing the caret. The \`◈\` beside the vault name turns green while the vault is being followed.

Unsaved text still takes precedence, but the viewer no longer resolves the conflict silently. A warning that a vein changed under the draft includes a **Merge…** button, and the dialog shows both versions line by line, identifying the lines from disk, the lines from the draft and every disagreement with \`<<<<<<<\`, \`=======\` and \`>>>>>>>\` markers. The dialog offers **Merge into my draft**, **Use the disk version** and **Keep my draft**. Autosave pauses while the question is open and remains paused while merge markers are present, so the timer cannot write a half-resolved conflict into a vein; \`Ctrl+S\` saves such a file deliberately.

Two files inside \`.macusanite\` are followed for a different reason: \`settings.json\` and \`colors.json\` are the two files that users are expected to edit by hand. When a theme, font size, panel width or colour is changed and saved, the open window applies the change immediately, re-rendering the document and updating the graph and settings dialog; nothing is written back, because reading a file is not an edit and never enters the undo stack. A file that cannot be parsed is refused with a warning, and the current settings are retained. The remaining files in the folder, including \`index.json\`, \`state.json\`, the undo stacks, the session log and \`vault.json\`, are the viewer's own bookkeeping and are ignored.`,
  },
  {
    slug: 'lazy-index',
    title: 'Opening a large vault',
    demo: 'lazy-index',
    body: `A vault opens by being described rather than by being read in full. Opening walks the folder once to determine which veins exist and when each one last changed, and it then reads \`.macusanite/index.json\`, which records what each vein contained the last time it was read: its title, aliases, headings, links, tags and front-matter colours. When a vein's modification time and size still match the cache entry, the viewer uses the cached description, so reopening a vault that has not changed reads no files.

The viewer reads in the background, a few dozen files at a time, whatever the cache cannot describe, including a new vein, an edited vein or a vault opened for the first time. The window is usable from the first walk, because the tree, graph, wiki links and search all work while the index fills in, and the sidebar footer reports progress such as \`indexing 420/5001\` before reporting how many veins are described.

Freshness is determined by modification time and size. The one case this check cannot detect is a file that is rewritten within the same clock tick without a change in size; the watcher covers edits made while the vault is open, and a vein saved by the viewer refreshes its own entry immediately. \`vault index\` reports the state of the cache, while \`vault index rebuild\` rewrites it.`,
  },
  {
    slug: 'backups',
    title: 'Backing up to S3',
    demo: 'backup-upload',
    body: `Because a vault is a folder, its backup is a single timestamped \`.tar.gz\` containing every vein, chamber and \`.macusanite\` file, uploaded as one object. A backup run never changes the vault.

| Where | How |
| --- | --- |
| The window | **☰ → Back up to S3…** — bucket, region, prefix, endpoint, and credentials or an SSH host |
| The CLI | \`macusanite vault backup <bucket>\` — same options as flags |
| An MCP client | the \`vault_backup\` tool |

The object key is \`<prefix><vault>/<YYYYMMDDTHHMMSSZ>.tar.gz\`, and the prefix defaults to \`macusanite/\`, so one bucket can hold several vaults. Restoring consists of extracting an object and opening the folder it creates. The archive excludes \`.git\` and symbolic links but includes the viewer's metadata, so settings, colours and undo stacks return with the notes.

The other route is SSH. \`--ssh-host user@backup-host\` streams the archive over the connection, and \`--ssh-key ~/keys/backup.pem\` supplies a PEM private key, while \`--ssh-port\` handles a port other than 22. The host writes the archive to a temporary file, uploads it with its own \`aws\` CLI and deletes the file. The local machine therefore needs no AWS credential, and the command reads none, while \`--region\`, \`--profile\` and \`--endpoint\` describe settings on the remote host. The window's dialog offers the same choice. The remote host needs an OpenSSH server, a POSIX shell, the AWS CLI and a working identity of its own. The connection uses \`BatchMode=yes\`, so a passphrase-protected key or a password prompt fails immediately instead of waiting.

**☰ → Back up to S3…** also edits the vault's automatic-backup setting. Selecting *Upload automatically after each save* writes \`.macusanite/backup.json\`, which is the same file read by the CLI and MCP server. The window then waits five seconds after saving stops and uploads with those settings. Only one upload runs at a time, so a save made during an upload queues another, and a failed run pauses automatic uploads for five minutes to prevent a misconfiguration from filling the session log.

The file stores every non-secret field but never a credential. A hand-typed AWS secret lasts until the window closes, after which the environment or \`~/.aws/credentials\` supplies credentials, while SSH needs no local secret at all. Because the setting belongs to the vault rather than the window, a vault armed in the window is armed for the headless side as well, and that side needs neither a window nor a repeated invocation:

\`\`\`bash
macusanite --vault ./notes vault autobackup --bucket my-notes-backups --region eu-west-1 --on
macusanite --vault ./notes vault autobackup --bucket my-notes-backups --ssh-host backup@notes.example --on
macusanite --vault ./notes vault autobackup --off
\`\`\`

Once the vault is armed, every write uploads a timestamped archive. Such writes include a window save after the pause described above and every CLI or MCP command that changes the vault, including \`vein write\`, \`vein create\`, \`append\`, \`section\`, \`rename\`, \`delete\`, a chamber operation, colours, settings, vault details, \`undo\` and \`redo\`. A CLI command uploads once before it exits and prints the report after its normal output, under \`autoBackup\` in \`--json\` mode. A long-lived MCP server coalesces uploads instead: it waits a couple of seconds after the last write and uploads one archive for the whole burst, so an agent that writes forty veins creates one object rather than forty. That outcome is written to the session log, because no single tool call owns it, and a pending upload is flushed when the server stops so that the final write is not lost. Reads never upload, and neither do the viewer's bookkeeping commands, log lines, state, the index cache or \`vault backup\` itself. A failed upload does not fail the write, because the edit has already landed; the failure is reported or logged, and the command still exits 0. Running \`vault autobackup\` without flags reports the current setting.

Credentials are resolved in the same order used by AWS's own tools. The access key and secret come from the command's flags or the dialog, otherwise from \`AWS_ACCESS_KEY_ID\`, \`AWS_SECRET_ACCESS_KEY\` and \`AWS_SESSION_TOKEN\`, and otherwise from \`~/.aws/credentials\` and \`~/.aws/config\`, with \`--profile\` selecting a profile. \`--secret-key-file\` reads the secret from a file, which keeps it out of shell history and process lists. A region comes from \`--region\`, \`AWS_REGION\`, \`AWS_DEFAULT_REGION\` or the profile, and it defaults to \`us-east-1\`. \`--endpoint\` sends the upload to an S3-compatible service such as MinIO, R2 or a gateway using path-style addressing, while AWS itself is addressed by virtual host. \`--dry-run\` builds the archive and prints the destination without uploading it. The secret is never written to the vault or the session log.

A folder can also be exported without a bucket. **☰ → Export vault…** writes one \`.tar.gz\` of the vault and its undo stacks, and **☰ → Import vault…** previews and merges one back. The CLI equivalents are \`macusanite vault export\` and \`vault import\`, with \`vault import plan\` performing a dry run, and \`--replace\` also deletes local files that the archive does not contain. The window exports the whole folder, including every hidden folder, and it imports without recording the imported files as changes. The desktop application carries binary files byte-for-byte, and its Replace checkbox lists the local files that the archive does not contain before deleting them. The browser fallback stores text only, so it refuses a binary archive with \`binary-unsupported\` rather than corrupting it; images and other non-text files therefore require the desktop application or the CLI.`,
  },

  {
    slug: 'keyboard',
    title: 'Keyboard',
    demo: 'keyboard-keys',
    body: `The window and the editor provide the following shortcuts:

| Keys | Action |
| --- | --- |
| \`Ctrl+S\` | save the open vein |
| \`Ctrl+Z\` / \`Ctrl+Shift+Z\` | undo / redo (file-level, vault-wide) |
| \`Ctrl+K\` | quick jump to a vein by name |
| \`Ctrl+F\` | search the whole vault |
| \`F3\` / \`Shift+F3\` | next / previous search hit in the open vein |
| \`Shift+F10\` / Menu key | open the focused card or group's canvas menu; arrows move through it and \`→\` / \`←\` open or leave a submenu |
| \`Alt+←\` / \`Alt+→\` | back / forward through navigation history |
| \`Esc\` | clear the search, close the search pane, or leave edit mode |`,
  },
  {
    slug: 'agents',
    title: 'Driving Macusanite without a window',
    demo: 'agents-terminal',
    body: `The CLI and the MCP server expose the same API over the same vault. Both are Node programs that require no build step, and both access a vault through [src/lib/vaultStore.js](../../src/lib/vaultStore.js), which writes the same files as the window, so a vault can be passed freely between the window and the headless tools.

### The CLI

\`\`\`bash
npm run cli -- vault info                       # or: node cli/macusanite.mjs vault info
node cli/macusanite.mjs --vault ./notes search "sieve series" --json
node cli/macusanite.mjs vein write Home.md --text - < new-home.md
\`\`\`

Every command accepts \`--json\` for machine-readable output, \`--vault <folder>\` or \`MACUSANITE_VAULT\` to select a vault, and \`--help\` for its documentation. Output goes to stdout, diagnostics go to stderr, and a command that fails returns a non-zero exit code, so the CLI composes in a shell pipeline. Commands that write record an undo step unless \`--no-undo\` is passed.

### MCP over stdio

\`\`\`bash
node cli/macusanite.mjs mcp stdio --vault ./notes
\`\`\`

The server reads one JSON-RPC message per line from stdin and writes one message per line to stdout, while logs go to stderr. This is the interface an MCP client expects when it is configured with a local command.

### MCP over HTTP, headless

\`\`\`bash
node cli/macusanite.mjs mcp serve --vault ./notes --port 8765
\`\`\`

The server binds to \`127.0.0.1\` by default and speaks JSON-RPC 2.0 at one endpoint, \`POST http://127.0.0.1:8765/mcp\`, with \`GET /health\` available for readiness checks. It supports both protocol eras: the legacy \`initialize\` handshake through \`2025-11-25\`, which Claude Desktop, VS Code and Cursor use, and the newer \`server/discover\` handshake from the 2026-07-28 revision. \`--host 0.0.0.0\` exposes the server to the network, which should be done only on a trusted machine because the port is intentionally unauthenticated.

### MCP through a file intake

\`\`\`bash
node cli/macusanite.mjs mcp intake --dir ./spool --watch
\`\`\`

This mode serves agents that cannot open a socket. A JSON-RPC request is written to \`./spool/<name>.request.json\`, the CLI reads and executes it, writes the reply to \`./spool/<name>.response.json\`, and moves the request aside to \`<name>.done\`. One file may contain a single request or an array of requests. The response file can be polled or the directory can be watched. \`--once\` processes whatever is pending and exits, which is sufficient for a cron job or a single tool call.`,
  },
  {
    slug: 'worldbuilding',
    title: 'The Worldbuilding canvas',
    demo: 'worldbuild-canvas',
    body: `A vein marked as **Worldbuilding**, either with the switch at the top right of the centre pane or with **More ▾ → Mark as Worldbuilding** in the canvas toolbar, opens as cards on a canvas instead of as lines. Each card corresponds to one heading and edits the same markdown that the reader displays. Switching to **Markdown** preserves the layout, and unmarking a vein keeps every card's position and bonds until the vein is marked again.

The canvas represents the vein itself. Typing in a card writes the prose under that heading, **+ Note** adds a section, and **✕** deletes one after a first click arms the control and a second click confirms the action; autosave and markdown undo behave exactly as they do in the editor. Because the layout is stored in \`.macusanite/state.json\` while the prose remains plain markdown, the same vein still reads correctly in the reader, on GitHub, through the CLI and over MCP.

### Gestures

* **Drag** a card by its grip to move it, and snap guides align it with neighbouring cards. Dragging the background pans the canvas, the wheel zooms around the pointer, and a small badge reports the zoom percentage while it changes.
* **Overlaps** produce a dashed warning outline and a small count while a drag covers another card. **Push aside** in the toolbar or **More ▾ → Push overlaps aside** moves free cards out of the way during a drag, while pinned and locked cards remain fixed. To resolve an overlap that already exists, select the affected cards and use **Resolve overlaps** in the inspector, which moves selected free cards clear while leaving pinned or locked cards in place.
* **Zooming out from 1:1** preserves full cards for the first two wheel notches. At approximately 55%, which is the third notch, cards become semantic summaries in which the type, title, link count and word count remain at a readable screen size while full prose and fields step aside. Below 25%, the summary type and boxes continue to shrink with the canvas, and at 12.5% each card becomes its type icon. Further zooming, or **⤢ Fit**, frames the entire graph regardless of its size, and a collapsed group shows its name and card count. Card controls remain inert below 1:1, while dragging, folding, resizing, selection and connector selection continue to work, and editing resumes when the view returns to 1:1 or closer.
* **Right-click** a card to access every operation it supports, including linking, relating, colouring, assigning an image, choosing its type, folding, pinning and locking. Right-click a group for its own menu, or right-click a connector for its relationship and routing options.
* **Ctrl+click** adds cards to a set that then drags as one, while **Shift+drag** on the background box-selects the cards it touches. **More ▾ → Quick select** provides predefined selections, and the selection's menu aligns and distributes the selected cards.
* **Arrange ▾** lays out the selection, a group, a connected component, one type or the whole vein.
* **More ▾** contains the remaining tools: **Canvas gestures** opens a cheatsheet, **Legend** explains every wire and icon, and **Export** writes the canvas as SVG, PNG or Mermaid.

### Undoing canvas changes

The canvas maintains its own undo history, separate from the markdown editor's. The toolbar's **↶** and **↷** arrows undo and redo one step and name that step in their tooltip, while **Ctrl+Z** and **Ctrl+Shift+Z**, or **Ctrl+Y**, perform the same actions when the canvas has focus. **More ▾ → History** lists the whole stack, with redo above the current point and undo below it, and selecting a row jumps to that point. Each vein keeps its own stack, which is saved with its canvas record so that the steps remain available after the vault is closed and reopened. A step represents one canvas change, such as a move, a group, a bond, a fold, a type, a colour or an arrangement. Typing is not a canvas step, because a card's title, prose, fields and tag box retain their own undo while the cursor is inside them, and the prose's markdown undo belongs to the editor. [Canvas history](#canvas-history-exports-and-health) explains what a step restores.

### Deeper sections

The remaining topics cover [cards and their heights](#cards-prose-and-heights), [types, fields, colours and images](#types-fields-colours-and-images), [bonds, groups and annotations](#bonds-groups-and-annotations), [arranging and navigating](#arranging-and-navigating), and [history, exports and health](#canvas-history-exports-and-health).`,
  },
  {
    slug: 'worldbuilding-cards',
    title: 'Cards, prose and heights',
    demo: 'worldbuild-cards',
    body: `Every card corresponds to a heading of the vein. Its title is the heading text, its prose is the text beneath that heading, and the card before the first heading is the **intro** card, titled "Before the first heading". Clicking a card's rendered prose replaces it with the source textarea, and leaving the textarea renders the markdown again, including tables, task lists, callouts and mermaid diagrams.

### Modes

**Cards ▾** on the toolbar or **Card mode** in a card's right-click menu applies one of three modes to every card in the current selection:

* **Full**, which shows prose, fields and links and is the normal card.
* **Compact**, which shows only the title, type, link count and word count for a dense overview.
* **Thumbnail**, which shows the node's image or its initial at 128 × 128 for a face-only map.

### Height

A full card either uses a fixed 260 px box with scrolling prose or **fits to content**, in which case the card grows to show the whole note without an inner scrollbar and the editing textarea grows as the user types. The choice is available per node under **Card height** in the right-click menu and for the selection in **Cards ▾**. The vault default is set in **Settings → Worldbuilding → Card height**, and a node's own choice overrides that default in either direction and is saved with the vein. Content height applies only to full cards, because compact and thumbnail cards retain their designed boxes. Every canvas measurement uses the real height, so connectors, group boxes, arrangement, untangle scoring and exports account for a taller card.

### Folding, tags and locks

* The **▾ Fold** chevron collapses a card to its header, folded cards stack above the card they link to, and **Overview** folds every card at once.
* **Tags** beneath a card act as links, because clicking a tag that names another card moves the camera to that card. The tag remains part of the note's markdown either way, and a tag that names no card remains plain text.
* Editing a **title** renames the heading, and every canvas property follows the new name, including position, folds, type, fields, colour, image, pin, lock, mode and height. Bonds that name the old title are removed because the link target no longer resolves.
* A **content lock** or a locked group disables the textarea, type, fields, colour, image and delete button. Clicking the padlock on a card, a group tab or a collapsed group summary unlocks it.`,
  },
  {
    slug: 'worldbuilding-types',
    title: 'Types, fields, colours and images',
    demo: 'worldbuild-types',
    body: `The drop-down in a card's header determines what the node **is**. A type supplies the card's icon and colour and, for the game-like types, its structured fields:

| Type | Fields |
| --- | --- |
| **Stat** | a free-text value |
| **Skill** | a level, 0–10 |
| **Ability** | a minimum and maximum, unbounded |
| **Attribute** | key, value and unit — the unit box autocompletes from units used or typed earlier in the vault |
| **Property** | key and value |
| **Table** | an editable spreadsheet grid with named columns and rows |
| **Rating** | one value, 0–10 |
| **Note, Place, Person, Thing, Location, Locale, Biome, Scene, Perk, Effect, Condition** | prose, like a note |

### Fields

Fields are stored with the vein's canvas record rather than written into the prose, and a numeric field is clamped to its range when it is entered. A type change is one undo step that rewrites the card's fields row in place while retaining the values already stored for the new type. **Tables are the exception**, because their content is the markdown table itself, so the reader, CLI and MCP never work against a second saved copy.

A **Table** opens as a grid. A column heading or cell can be clicked to type, **+ Row** and **+ Column** add rows and columns, and the small **×** controls remove them. **Enter** moves down one row and adds a row at the bottom when necessary, while the table scrolls when it exceeds the card. The grid is read from the GitHub-flavoured markdown table in that section on every build, so an edit made in the reader, by the CLI or through MCP appears here instead of being overwritten by a stale canvas copy. A section with several tables provides a selector, and every table keeps its place, while captions remain in the reader so that prose between tables is not moved accidentally. Changing a **Note** to a **Table** reads the existing markdown, and changing it back requires no write because markdown was always the source.

Fast entry supports pasting a TSV or CSV block directly into a cell, with rows and columns growing to fit; dragging a row number reorders the actual markdown rows; and the small arrow in a column heading cycles its alignment, which is written into the markdown delimiter row. The filter and sort controls are **views only**, so they never rewrite row order, and **Clear view** restores the markdown order. Canvas undo carries the markdown that it changed, so a table edit and its grid return together.

### Colour and image

* **Node colour** in the right-click menu overrides the type's colour for one card, and **Use the type colour** removes that override.
* **Node image** attaches a picture as the node's header icon and as its face in thumbnail mode. Images are copied into \`.macusanite/node-images/\`, and replacing or removing an image deletes the old file once no card and no undo snapshot still refers to it.

### Pins and locks

* **Pin node** makes Arrange work around the card without preventing manual dragging, and **Pin group** does the same for a whole group.
* **Lock node content** makes the card read-only while leaving it movable, linkable and exportable. Locking a **group** is stronger, because its cards cannot move, be regrouped, edited or removed, although relationships into and out of the group still work. Clicking the padlock on a card, group tab or collapsed summary unlocks it.
* **Freeze** in a card's or group's right-click menu turns the object **Static**, which behaves as locked but displays a blue snowflake instead of the gold padlock, and a frozen card is also immovable as well as read-only. The snowflake is not an unlock button, because only **Unfreeze** in the same menu clears Static.

A **tag** is never a canvas-only annotation, because it is parsed from the note's markdown. The canvas makes it clickable, counts it in the stats bar and offers to open the card that it names.`,
  },
  {
    slug: 'worldbuilding-bonds',
    title: 'Bonds, groups and annotations',
    demo: 'worldbuild-bonds',
    body: `**Wires originate in the prose.** A dotted wire represents the vein's own outline, in which each card is nested under its nearest shallower heading. A solid wire represents a \`[[#Heading]]\` link written in a note, and a faint green wire represents a mention of another vein through \`[[Another note]]\`. A bond asserted on the canvas is a **dashed canvas bond**, which is created from a link dot in a card's head, a group's tab or a collapsed group's summary by dragging it to another card or group and choosing the relationship on release. Neither kind of canvas bond writes a markdown link into a note. A wire to a group is dashed at twice the weight, and a pair already joined by a prose link uses that wire instead. If removing a bond would leave a prose link drawing the same line, the notice offers to remove that markdown link as a normal prose edit.

### Wires and relationships

Every wire can carry a **relationship**: associate, references/referenced by, member of, template, parent/child, contains/contained by, controls/controlled by, affects/affected by, ally or foe. The wire thickens as the relationship strengthens, and clicking the word on the wire advances to the next kind. Right-clicking a connector provides **Cycle relationship**, **Reverse relationship**, **Remove asserted relationship**, curve style, end selection and **Trace upstream/downstream**. Dragging from a selected set's menu, using **Relate to…** in a card's menu, or dragging a **link dot** asserts a bond between cards or a group endpoint. A link dot is refused for a pair that a prose link already joins, so dashed and solid wires never duplicate each other.

### Groups

**Groups** gather cards into one coloured box:

* Selecting two or more cards and choosing **Group** creates a group. A whole group inside the selection is nested rather than dissolved, dragging a card into a group's box adds it, and dragging the card out removes it.
* Dragging a group's tab moves every member. **Collapse** turns the group into one summary card with a member count and link total, while **Collapse all groups** does the same for the whole vein.
* **Split into progression columns** turns a group into lanes, with the group's top cards on the left, their subsections one tier to the right and each lane headed by its **Tier**.
* **Group colour** and **Group icon** appear at the top of the group's right-click menu. **Rename group**, **Split into progression columns**, **Collapse/Expand**, **Lock group**, **Pin group**, **Ungroup** (which keeps the cards) and **Remove from group** are grouped under the **Group** submenu. **Freeze/Unfreeze** appears directly on a group's right-click menu, while on a card's menu it appears in the **Group** submenu with the other group state controls.

### Annotations

**Annotations** are free-floating margin notes that are independent of every heading, and they are created with **+ Annotation** or by double-clicking empty canvas. They drag, scroll and export with the canvas, and they are deleted from their **✕** without changing the vein's markdown. The text is editable at 62% zoom and above; below 62%, the whole note, including its head and text, becomes one grab target so that dragging never selects text, and its fold and delete controls become available again at 62%. The head's fold toggle collapses the note to its title bar.`,
  },
  {
    slug: 'worldbuilding-arrange',
    title: 'Arranging and navigating',
    demo: 'worldbuild-arrange',
    body: `### Selecting

Clicking a card selects it, **Ctrl+click** toggles it in the set, and a picked set drags as one. **Shift+drag** on the background box-selects everything it touches. With connectors already selected, a **Shift+drag** marquee also adds every wire its rectangle crosses. **Select ▾** adds quick selections such as connected cards, ancestors, descendants, cards of the same type or colour, group members, pinned cards, locked cards, untyped cards and cards without images, while the selection's right-click menu aligns and distributes the selection. **Fit selection** zooms to the selected cards.

### Layouts

**Arrange ▾** requests a scope, which may be **Selection**, **Group**, **Connected component** or **One type**, and then one of six layouts:

* **Grid**, which arranges cards in rows within a near-square block.
* **Rows** and **Columns**, which place cards on one horizontal or vertical line.
* **Cascade**, which offsets each card down and to the right from the previous card.
* **Layered**, which uses relationship depth as rows and places roots at the top.
* **Progression columns**, which uses heading-tree tiers as columns, with top items on the left and deeper tiers to the right.

Pinned and locked cards remain in place as obstacles, collapsed groups are laid out as their summaries, and the untangler accepts only a swap that reduces the number of connectors passing behind cards. **Whole vein (grid)** performs the original one-click tidy, and Arrange fits its result into view.

### Getting around

Dragging the background pans the canvas, and the wheel zooms around the pointer. **⤢ Fit** frames every card at whatever scale the canvas requires, **Overview** folds every card and then fits the result, and double-clicking a card's header centres that card. Zoom and pan are view operations rather than canvas changes, so they never create an undo step.

### Routing

**Elbow routing** switches selected connectors or the whole vein between curves and right-angle bends, **Arrowheads** adds arrowheads, and **Trim long wires** ends a wire longer than one screen in a diamond facing the far card. All three options appear under **More ▾**, and the connector bar offers them for a selection directly. Clicking a trimmed wire reveals the far card when it is inside a collapsed group and then centres the view on it; otherwise the view centres directly on the card. A connector's right-click menu can override routing for that wire alone or restore the vein default.

### Finding things

**Search** filters the canvas live across titles, types, fields, colours and group names, with previous and next jumps, **Select all** and **Isolate**, which dims everything outside the connected subgraph of the matches. **More ▾ → Health** lists orphans and groups that contain fewer than two cards, and clicking a row selects and centres it. **More ▾** also contains **Legend** and **Canvas gestures**, which explain the remaining controls in place.`,
  },
  {
    slug: 'worldbuilding-history',
    title: 'Canvas history, exports and health',
    demo: 'worldbuild-history',
    body: `The canvas maintains its **own undo history**, separate from the markdown editor's. A drag, a layout, a type, a colour, a bond, a fold, a card's mode or its height each forms one named step, and **Undo** and **Redo** name the change they would make. The shortcuts are \`Ctrl+Z\`, \`Ctrl+Shift+Z\` and \`Ctrl+Y\` while the canvas has focus. **History** opens the stack as a list with redo above the current point and undo below it, each row can be selected, and the stack is capped at 60 steps per vein.

### What a step restores

A step restores the whole canvas state, including positions, groups, bonds, folds, types, fields, colours, images, pins, locks, display modes, heights and the camera, because those values are stored together in the vein's record. History survives closing and reopening the vault. Renaming or deleting a card prunes dead anchors from every stored step, and deleting a node removes image files that no step still references.

### Exports

**Export ▾** writes the canvas for use in other tools:

* **SVG — vector file** produces a standalone drawing of every visible card, wire, group box and annotation, with text preserved as text.
* **SVG — Inkscape layers** produces the same drawing in four named layers (Groups, Connectors, Cards and Annotations), so each layer can be selected, reordered or hidden in Inkscape.
* **PNG — image file** renders the whole canvas at up to twice its size for slides and print.
* **Mermaid — markdown file** converts headings into nodes and canvas links into edges in a \`flowchart\` that is ready for a markdown file.

SVG and PNG draw what is visible on screen, so a collapsed group exports as its summary and a folded card as its header, while the Mermaid export lists every note and relationship regardless of the current view. Exported files are named after the vein, as \`<vein>-canvas.svg\` or \`<vein>-canvas.png\`, so they are easy to locate again.

### Health

**Health** is the lint pass for the canvas. Orphans, which have no wire in or out, and thin groups, which contain fewer than two cards, appear as jumpable rows with counts beside the button. The vault-wide default for card height is set in **Settings → Worldbuilding**, and every node can override it from its own menu.`,
  },
  {
    slug: 'updates',
    title: 'Signed self-updates',
    demo: 'update-flow',
    body: `The desktop application updates itself from signed GitHub releases. A few seconds after a vault opens, and unless automatic checks have been disabled in **Settings → Updates**, the application fetches the release's static \`latest.json\`; if that file names a newer version, a dialog offers the update together with its release notes. Nothing is installed without confirmation, because **Download & restart** starts the download with progress, verifies the installer against the public key embedded in the application, installs the verified package and restarts into the new version.

On Windows the installed version is the NSIS setup executable, which installs per user into \`%LOCALAPPDATA%\\Macusanite\`, under AppData rather than Program Files, and requires no administrator rights. An update replaces \`macusanite.exe\` in that folder in the same way that it replaces a portable executable. Signing keys are kept outside the repository at \`~/.tauri/macusanite.key\`; \`docs/Updates.md\` documents the publication process.`,
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
  body: `This document is generated from the same declarations that the program uses, so it cannot diverge from the implementation: the commands come from \`src/lib/catalogue.js\`, and the prose comes from \`src/lib/helpDoc.js\`. It has three homes, and each serves the same text:

| Where | How to open it |
| --- | --- |
| The **help window** | the **?** button in the top bar, the **☰ → Help and manual** menu item, or \`F1\`. The manual opens in a separate window so that the current vein stays open. Its search box requires every typed word to appear, requires \`"a quoted phrase"\` to appear whole, hides sections that do not match and steps through hits with \`Enter\` while ringing the current hit |
| The **CLI** | \`macusanite docs\` prints the manual, \`macusanite docs <section>\` prints one section, \`macusanite docs --sections\` lists the slugs, and \`macusanite docs --out docs/Help.md\` writes it to a file, which is the operation performed by \`npm run docs\` |
| An **MCP client** | the \`docs\` tool, or the \`macusanite://manual\` resource, which every agent should read before guessing how an operation works |

The sections form the manual's structure, and the help window groups them by topic. The structure includes \`worldbuilding\` and its five deeper sections, \`search\`, \`colours\`, \`graph\`, \`undo\`, \`watching\`, \`lazy-index\`, \`backups\`, \`updates\`, \`keyboard\`, \`agents\`, \`commands\`, \`limitations\` and the remaining topics. Each feature section also carries a small animated figure generated from the same declarations, as described in \`src/lib/helpDemos.js\`.`,
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

* **Matching is literal.** Search does not stem or fuzz, so \`sieving\` does not find \`sieve\`, and the only operators are a quoted phrase and \`#tag\`.
* **Index freshness depends on modification time and size.** A vein that is rewritten within the same clock tick with an identical byte count can appear unchanged until it is opened or touched.
* **Search holds plain text.** Ranking bodies and quoting snippets require the words themselves, so a search on a large vault reads the vault because the cache covers metadata rather than prose.
* **Deleting a vein is asymmetric.** Undo restores the text, while redo recreates the file empty; see [Undo and redo](#undo-and-redo).
* **Embeds** such as \`![[Note]]\` render as reference cards rather than transcluded content.
* **The undo stack stores snapshots rather than diffs**, and it is capped at 400 entries.
* **A backup is assembled in memory and uploaded as one object.** A markdown vault is small, while a vault containing large binaries is read whole into memory, and every run creates a fresh full copy rather than performing an incremental synchronization.
* **MCP over HTTP is unauthenticated.** It binds to loopback by default, and exposing it with \`--host\` is the operator's decision.
* **A merge can compare only lines.** When both sides insert at the same point, such as both appending to the end of a vein, the result is marked as a conflict rather than guessed, and a vein whose entire body changed on both sides becomes one region to resolve.
* **The merge offer suspends autosave for 15 seconds.** Answering the offer resolves the conflict, while allowing the period to expire causes the timer to save the draft as usual and records the unanswered offer in the session log.
* **A hand-edit to \`settings.json\` or \`colors.json\` made within the few hundred milliseconds after the viewer saves the same file** is interpreted as the echo of that save and remains quiet until the next open. This is the one moment at which a hand-edit to either file does not take effect live.
* **The manual is generated.** Edit \`src/lib/helpDoc.js\` or \`src/lib/catalogue.js\` and run \`npm run docs\`, because edits to \`docs/Help.md\` are overwritten.`;

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
    `This manual covers the window, the vault format, the CLI, the API and the MCP server.`,
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
