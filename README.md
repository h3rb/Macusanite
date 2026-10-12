# Macusanite

![Logo](docs/Macusanite.jpg)

A viewer for a **vault**: a folder tree of markdown that behaves like a wiki.
Folders are **chambers**, markdown files are **veins**, and concepts are graphed
both inside a document and across the vault. No database server, no accounts —
a vault is just a folder, and everything the viewer knows lives in a
`.macusanite` folder at its root.

* **Shell:** Rust + [Tauri 2](https://tauri.app) (one small native binary per platform)
* **Logic:** plain ES modules — wiki-link resolution, colour store, concept graph, undo/redo mirror
* **Rendering:** [marked](https://marked.js.org) for markdown, [mermaid](https://mermaid.js.org) for diagrams
* **Graph:** hand-built SVG, so every link edge can fade from its own colour into its target's
* **Headless:** the same vault operations as a **CLI** and an **MCP server**, so an
  AI agent can do everything the window does — no dependencies beyond Node

The shipped syntax reference is [Wiki.md](Wiki.md) — the same file the app shows
under **☰ → Vault Wiki.md**. The program's own manual is generated
([docs/Help.md](docs/Help.md)) and appears in three interchangeable places: the
**Help** window, `macusanite docs`, and the MCP `docs` tool.

---

## Quick start

```bash
npm run setup        # per-user Node LTS + Rust (no administrator rights needed)
npm install
npm run tauri:dev    # launch the desktop app against ./dist
```

Setting the toolchain up from scratch — the MSVC build tools and WebView2 on
Windows, Xcode's command line tools on macOS, WebKitGTK 4.1 on Linux — is
[Building.md](Building.md), which covers each platform's prerequisites, its build
commands, its artefact paths and the failures people actually hit.

Building release artefacts (portable binary + installer):

```bash
npm run icons        # regenerate src-tauri/icons from assets/icon-source.png
npm run tauri:build
```

| Platform | Artefact |
| --- | --- |
| Windows | `src-tauri/target/release/macusanite.exe` (portable) and `*.msi`/`*-setup.exe` in `src-tauri/target/release/bundle/nsis/` |
| macOS | `Macusanite.app` plus a `.dmg` (arm64/x86_64 built on the same host) |
| Linux | AppImage/deb in `src-tauri/target/release/bundle/` |

Windows and Linux builds rely on the system webview (WebView2 / WebKitGTK); it is
the only external runtime the portable binary needs.

### Running it against a vault

```bash
macusanite                     # opens the empty state; use ☰ → Load Vault…
macusanite path/to/reference-vault
```

`npm run vault:sample` writes the bundled sample vault to
[reference-vault/](reference-vault) so there is always something to open.

---

## A vault on disk

```
My Vault/
├── .macusanite/                 # everything the viewer manages
│   ├── vault.json               # name, description, created
│   ├── settings.json            # viewer settings + default colours
│   ├── colors.json              # page/section/link/concept colour assignments
│   ├── history.json             # undo and redo stacks
│   ├── state.json               # last open vein, breadcrumbs, expanded chambers
│   ├── index.json               # what each vein contains, keyed by its stat
│   └── logs/session-YYYYMMDD.log  # JSON-lines session log
├── Home.md
└── Chambers/
    ├── Fieldwork/
    │   └── Macusanite Occurrence.md
    └── Lab/
        └── Analytical Methods.md
```

Folders starting with `.` are never indexed. `vault.json` is created on first
open with the folder's name, so a vault always has an identity.

### Opening a large vault

A vault is opened by *describing* it, not by reading it. Opening walks the folder
once — which veins exist, when each last changed — and then reads
`.macusanite/index.json`, which holds what each vein contained the last time it
was read: its title, aliases, headings, links, tags and front-matter colours.
Anything whose modification time and size still match the cache is taken from it,
so reopening a vault you have not touched reads no files at all.

Whatever the cache cannot describe — a new vein, an edited one, a vault opened
for the first time — is read afterwards, in the background, a couple of dozen
files at a time. The window is usable from the first walk: the tree, the graph,
wiki links and search all work while the index fills in, and the sidebar footer
says what is still being read (`indexing 420/5001`).

Freshness is modification time **plus** size, which is what makes the check
cheap, and its one blind spot is a file rewritten within the same clock tick
without changing size. The watcher covers edits made while the vault is open;
a vein saved by the viewer refreshes its own cache entry immediately.

The index is not the text. Bodies are read when they are needed — the vein you
open, the veins search actually searches — so a large vault costs the memory of
its index rather than the memory of every file.

## What the window shows

| Region | Behaviour |
| --- | --- |
| Top bar | burger menu (**New / Load / Save / Undo / Redo / Settings / Exit**), vault name and description, wiki breadcrumbs that fill in as you follow links |
| Second bar | back and forward arrows, the current file location, chips for recently visited veins, undo/redo with the label of what would change |
| Left | two panes behind tabs: the vault tree (chambers fold open, veins open in the centre, a filter box narrows the tree) and **search** |
| Centre | the rendered vein: colour swatches beside the page title, every heading and every wiki link; edit mode with autosave; backlinks at the bottom |
| Right | the concept graph — sections, linked veins, unwritten "ghost" pages and tags, with pan, zoom, drag and depth/toggle controls |

### Following the vault

The vault is watched while it is open, so the viewer is not the only way in. A
vein created, edited or deleted by another program appears in the tree, the
index, the graph and — when it is the open vein and nothing is unsaved — in the
reader itself, without a reload. Bursts of events are coalesced into one
refresh, a change that a walk says moved nothing is recognised as nothing at
all, and unsaved text in the editor always wins — but not by itself: an external
edit to the file you are typing into warns instead of replacing your caret, and
the warning comes with a **Merge…** button. The `◈` beside the vault name turns
green while the vault is being followed.

**Merge…** opens a dialog showing what a line-by-line merge of the two versions
would make: the lines that came from disk, the lines you typed, and every place
the two disagree, marked `<<<<<<<` / `=======` / `>>>>>>>`. From there: merge into
your draft, take the disk version, or keep your draft as it was. Autosave holds
back while that question is open — and whenever merge markers are still in the
text — so the clock cannot answer it for you by writing your draft over the
version on disk; `Ctrl+S` saves a marked draft deliberately, and says so.

Two files in `.macusanite` are followed as well, because they are the ones you
are meant to edit by hand: `settings.json` and `colors.json`. Save a theme, a
font size, a panel width or a colour and the window that is already open takes it
at once — the document is re-rendered, the graph and the settings dialog follow,
and nothing is written back (reading a file is not an edit, so it never enters
the undo stack). A file that cannot be parsed is refused with a warning, keeping
the settings you already had. The rest of the folder — the index cache,
`state.json`, the undo stacks, the session log — is the viewer's own bookkeeping
and is ignored, and the writes the viewer makes to those two files are silenced
so a save of its own can never come back as a change to react to.

### Search

`Ctrl+F` opens the search pane: type once and the whole vault is searched as you
go — titles, section headings, tags and body text, ranked in that order, with a
snippet per result and the matched words already marked. A vein whose title is
exactly what you typed comes first, two loose words can match in any order, and
quoting them — `"sieve series"` — requires the phrase. Every result says *why* it
matched: `title`, `§ section`, `tag`, or how many times the words appear in the
text.

Clicking a result opens the vein and marks every hit inside the page, with the
current one ringed; `F3` / `Shift+F3` step through them and the counter over the
results says where you are. `Esc` clears the query and `Esc` again brings the
tree back. Because the vault is watched ([below](#following-the-vault)), veins
another program adds or edits are searchable immediately — and so is text you
have typed into the editor but not yet saved.

On a lazily indexed vault the answer arrives in two stages, both live: titles,
sections and tags are ranked from the index cache the instant you type, while the
body text behind them is read in the background and the results grow as it lands
(the status row says `reading 240/5001…`). Type a title you know and it is the
first result before anything has been read.

### Colours

Every page, link and section starts at the vault default (**white**) and can be
recoloured by clicking its swatch. The picker offers a common palette, a
searchable X11 selection, a `#hex` field and synced RGB sliders. Colours resolve
most-specific-first: an explicit pick, then front-matter `color:`, then
inheritance (sections from their page, links from their source page), then the
default. A link's colour is the *source* end of its graph edge; the line fades
towards the target page's colour.

### Undo and redo

Every mutation is recorded as a before/after snapshot of one file, so **Ctrl+Z**
restores exactly what changed: vein edits, new veins and chambers, colour
assignments, settings and vault details. Pure viewer state (last page, expanded
chambers, panel widths, recent colours) is written to `state.json` and stays out
of the undo stack.

## Keyboard

| Keys | Action |
| --- | --- |
| `Ctrl+S` | save the open vein |
| `Ctrl+Z` / `Ctrl+Shift+Z` | undo / redo |
| `Ctrl+K` | quick jump to a vein |
| `Ctrl+F` | search the whole vault |
| `F3` / `Shift+F3` | next / previous search hit in the open vein |
| `F1` | the **Help** window: the manual, in its own window, searchable |
| `Alt+←` / `Alt+→` | back / forward |
| `Esc` | clear the search, close the search pane, or leave edit mode |

Full syntax details — wiki links, aliases, section anchors, mermaid, tags,
callouts — are in [Wiki.md](Wiki.md).

---

## Driving Macusanite without a window

The window is not the only way in. One API ([src/lib/api.js](src/lib/api.js))
implements every vault operation, one catalogue ([src/lib/catalogue.js](src/lib/catalogue.js))
declares them, and two front ends consume it: a CLI and an MCP server. Both are
plain Node with no dependencies — no Rust, no webview, no build step — and both
run on the same vault the window opens, so a vault can be passed back and forth
freely. The window's **Help** button (`F1`) documents all of it, as does
[docs/Help.md](docs/Help.md).

### The CLI

```bash
npm run cli -- vault info                      # or: node cli/macusanite.mjs vault info
node cli/macusanite.mjs --vault ./notes vault stats
node cli/macusanite.mjs --vault ./notes search "sieve series" --json
node cli/macusanite.mjs --vault ./notes vein write Home.md --text - < new-home.md
node cli/macusanite.mjs help vein.write        # one command's full documentation
```

44 commands, in seven groups: identity and settings, documents, chambers, search
and the graph, colours, history, help. Everything takes `--json` for
machine-readable output and `--vault <folder>` (or `MACUSANITE_VAULT`) to choose a
vault; results go to stdout, diagnostics to stderr, and the exit code is non-zero
when a command fails — so it composes in a pipeline. `vault doctor` exits 1 when
it finds something, which is what makes it usable as a check.

### MCP over stdio

```bash
node cli/macusanite.mjs --vault ./notes mcp stdio
```

One JSON-RPC message per line on stdin, one per line on stdout, logs on stderr —
what an MCP client configured as a local command expects.

### MCP over HTTP, headless

```bash
node cli/macusanite.mjs --vault ./notes mcp serve --port 8765
curl -s http://127.0.0.1:8765/health
```

The server binds `127.0.0.1` (the default port is 8765) and speaks JSON-RPC 2.0 on
one endpoint, `POST /mcp`, with `GET /health` for readiness. It answers both
protocol eras: the legacy `initialize` handshake (through revision `2025-11-25`)
that today's clients send, and the newer `server/discover` handshake, where every
request carries its revision and an unsupported one is refused with `-32022` and
the list of versions that would work. `--host 0.0.0.0` exposes it to the network —
the port is deliberately unauthenticated, so do that only on a machine you trust.

What an agent gets:

* **tools** — every command in the catalogue (as `vein_write`, `vault_stats`, …)
  with the JSON Schema the catalogue declares, so the tool list cannot drift from
  the implementation, and annotations saying which tools write;
* **resources** — `macusanite://manual`, `macusanite://vault`, and every vein as
  `macusanite://vein/<path>`, paginated;
* **prompts** — a few starting points (`orient`, `repair-ghosts`, `summarize-vein`,
  `manual`).

### MCP through a file intake

```bash
node cli/macusanite.mjs --vault ./notes mcp intake --dir ./spool --watch
```

For agents that cannot open a socket. Write a JSON-RPC request to
`./spool/<name>.request.json` — one message or an array of them — and the CLI runs
it and writes `./spool/<name>.response.json`, moving the request aside to
`<name>.done` so nothing is ever processed twice. `--once` handles whatever is
pending and exits, which is all a cron job or a single tool call needs.

### The manual

```bash
docs/Help.md        # generated: every feature, then every command
npm run docs         # regenerate it
npm run docs:check   # fail if it is out of date (the test suite runs this)
```

It is one document rendered three ways — the Help window, `macusanite docs`, and
the MCP `docs` tool — built from the same catalogue the CLI parses and the MCP
server exposes. Nothing in it is written twice, so it cannot describe something
the program does not do.

---

## Development

```bash
npm run dev           # browser fallback: the sample vault, no Tauri needed
npm test              # unit tests (node:test) for the pure logic
npm run tauri:dev     # real desktop shell against the dev server
npm run cli -- help   # the CLI, straight from the working tree
npm run docs          # regenerate docs/Help.md from the catalogue
```

Per-platform prerequisites and artefact paths: [Building.md](Building.md).

`npm run dev` accepts `?novault=1`, which skips the automatic sample vault and
shows the empty state instead.

The frontend talks to the filesystem through [src/backend.js](src/backend.js).
Inside Tauri that is a set of Rust commands; in a plain browser it is an
in-memory vault backed by `localStorage` implementing the same command surface —
which is what makes `npm run dev` and the tests useful without a build.

### Layout

```
src/
  lib/          pure, testable logic (path, wikilinks, colors, colorStore,
                graph, tree, settings, frontmatter, history, watch, search,
                indexCache, fixtures)
  ui/           rendering + DOM (markdown, viewer, sidebar, searchPanel, chrome,
                graphPanel, colorpicker, settingsDialog, resizer, helpWindow, dom)
  lib/          also: api.js (every vault operation), catalogue.js (their
                declaration), helpDoc.js (the manual), helpSearch.js,
                vaultStore.js (the shared vault store), indexCache.js
  backend.js    vault bridge: Tauri commands or the browser fallback
  main.js       application controller and state
  styles.css
cli/
  macusanite.mjs  the CLI: catalogue commands, argument parsing, help output
  mcp.js          the MCP server: tools, resources, prompts, stdio/HTTP/intake
  vaultFs.js      the vault adapter over node:fs
  format.js       human-readable output for every command
docs/Help.md      the generated manual (the Help window shows this text)
help.html         the manual's own page — the second window in the desktop app
src-tauri/src/
  lib.rs        the command surface (open/create, tree, read/write, meta,
                logs, undo/redo, dialogs, external links, the help window)
  watch.rs      the live watcher: path filtering (with settings.json and
                colors.json as the two exceptions), debouncing, self-write
                suppression for veins and for those two files
  vault.rs      path safety, scanning (each vein's stat), tree building, atomic
                writes, slug parity
  meta.rs       .macusanite files, ISO timestamps, session logs
  history.rs    the undo/redo stacks
tests/node/     unit tests for everything under src/lib plus the renderers
```

### Tests

```bash
npm test                                  # 170 JS tests
cargo test --manifest-path src-tauri/Cargo.toml   # 30 Rust tests
```

The Rust suite covers path traversal refusal, vault scanning (including the
per-vein stat the index cache is keyed on — including the exact JSON field names
that key uses), tree shape, atomic writes, undo/redo
semantics, `.macusanite` creation, log lines and the `slugify` parity that keeps
`[[Note#Heading]]` anchors working on both sides. It also watches a real
temporary folder: external creates, edits and deletes must arrive as one batch
each, a hand-edit to `settings.json` comes through, and the application's own
writes stay quiet — including its own metadata, which is echoed back by nothing
and is still heard when a person edits it a moment later. The JS suite covers the
same contracts plus the rendered HTML (swatches, anchors, ghosts, mermaid
capture, code masking), the browser fallback's behaviour, the refresh planner
that decides what an external change means, the index cache — which entries a
walk can reuse, which have to be read, and that a 5,000-vein vault is planned
without opening anything — and search: which field outranks which, that a phrase
beats the same words scattered, that every term has to appear, and that snippets
and highlights mark the right characters.

The headless half is tested through its real interfaces: the CLI by running it as
a process and reading its exit codes and output, the MCP server by driving the
protocol (tool schemas derived from the catalogue, argument validation, error
shapes, both protocol eras, resource paging, prompts) plus a real HTTP listener on
an ephemeral port and a real spool directory, and the manual by checking that
every command is documented, every declared parameter has a row, the MCP schema
matches the declaration, and `docs/Help.md` equals what the generator produces
right now.

## Limitations (v0.1)

* Index freshness is modification time plus size. A vein rewritten inside the
  same clock tick with an identical byte count can look unchanged until it is
  opened or touched (see [Opening a large vault](#opening-a-large-vault)).
* `.macusanite/index.json` repeats each vein's metadata — roughly 650 bytes per
  vein on the reference vault. It is a cache: deleting it costs one slow open
  and nothing else.
* Search holds the plain text of veins it has read for the session, because
  ranking body text and quoting a snippet need the words themselves.
* Watching uses the platform's own notifications (ReadDirectoryChangesW, inotify,
  FSEvents). A folder that cannot be watched — some network shares — still opens;
  the session log records that, and a reload picks the changes up.
* Embeds (`![[Note]]`) render as reference cards, not as transcluded content.
* Undo history stores whole-file snapshots rather than diffs; the stack is
  capped at 400 entries.
* MCP over HTTP is unauthenticated by design: it binds loopback and it is your
  decision (`--host`) to expose it further.
* The manual is generated. Edit [src/lib/helpDoc.js](src/lib/helpDoc.js) (prose)
  or [src/lib/catalogue.js](src/lib/catalogue.js) (commands) and run
  `npm run docs`; edits to `docs/Help.md` are overwritten.
