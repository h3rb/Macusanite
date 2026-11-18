# Macusanite

![Logo](docs/Macusanite.jpg)

Macusanite is a viewer for a **vault**, which is a folder tree of markdown that behaves like a wiki. Folders are **chambers**, markdown files are **veins**, and concepts are graphed both inside a document and across the vault. The application requires no database server and no account, because a vault is a folder and everything the viewer knows lives in a `.macusanite` folder at its root.

* **Shell:** Rust + [Tauri 2](https://tauri.app) (one small native binary per platform)
* **Logic:** plain ES modules — wiki-link resolution, colour store, concept graph, undo/redo mirror
* **Rendering:** [marked](https://marked.js.org) for markdown, [mermaid](https://mermaid.js.org) for diagrams
* **Graph:** hand-built SVG, so every link edge can fade from its own colour into its target's
* **Headless:** the same vault operations as a **CLI** and an **MCP server**, so an AI agent can perform every action available in the window without dependencies beyond Node

The shipped syntax reference is [Wiki.md](Wiki.md), which is the same file that the application shows under **☰ → Vault Wiki.md**. The program's manual is generated as [docs/Help.md](docs/Help.md) and appears in three interchangeable forms: the **Help** window, the `macusanite docs` command and the MCP `docs` tool.

---

## Quick start

```bash
npm run setup        # per-user Node LTS + Rust (no administrator rights needed)
npm install
npm run tauri:dev    # launch the desktop app against ./dist
```

[Building.md](Building.md) explains how to prepare the toolchain from scratch, including the MSVC build tools and WebView2 on Windows, the Xcode command-line tools on macOS and WebKitGTK 4.1 on Linux. It also covers each platform's prerequisites, build commands, artefact paths and common failures.

To build release artefacts, which include a portable binary and an installer, run:

```bash
npm run icons        # regenerate src-tauri/icons from assets/icon-source.png
npm run tauri:build
```

| Platform | Artefact |
| --- | --- |
| Windows | `release/macusanite.exe` (portable) and `release/Macusanite_*-setup.exe` |
| macOS | `release/Macusanite.app` plus a `.dmg` (arm64/x86_64 built on the same host) |
| Linux | AppImage/deb in `release/` |

`npm run tauri:build` collects the finished files into `release/` at the project root, while Cargo's own cache remains under `src-tauri/target/release/`.

Windows and Linux builds rely on the system webview, which is WebView2 on Windows and WebKitGTK on Linux, and that webview is the only external runtime required by the portable binary.

### Running it against a vault

```bash
macusanite                     # opens the empty state; use ☰ → Load Vault…
macusanite path/to/reference-vault
```

`npm run vault:sample` writes the bundled sample vault to [reference-vault/](reference-vault), so a vault is always available for testing. `npm run vault:sample-archive` writes the same fixture as `reference-vault.tar.gz`, which is the portable archive read by the import tests. Run the archive command once on a fresh checkout before `npm test`, and use the resulting file as a ready-made `vault import` target.

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

Folders whose names begin with `.` are never indexed. The viewer creates `vault.json` on the first open with the folder's name, so every vault has an identity.

### Opening a large vault

A vault opens by being described rather than by being read in full. The viewer walks the folder once to determine which veins exist and when each one last changed, and it then reads `.macusanite/index.json`, which records what each vein contained the last time it was read: its title, aliases, headings, links, tags and front-matter colours. When a vein's modification time and size still match the cache entry, the viewer uses the cached description, so reopening a vault that has not changed reads no files.

The viewer reads in the background, a few dozen files at a time, whatever the cache cannot describe, including a new vein, an edited vein or a vault opened for the first time. The window is usable from the first walk, because the tree, the graph, wiki links and search all work while the index fills in, and the sidebar footer reports what is still being read with text such as `indexing 420/5001`.

Freshness is determined by modification time together with size, which keeps the check inexpensive. The one case this check cannot detect is a file that is rewritten within the same clock tick without a change in size. The watcher covers edits made while the vault is open, and a vein saved by the viewer refreshes its own cache entry immediately.

The index does not contain the text itself. Bodies are read when they are needed, which means when a vein is opened or when search needs them, so a large vault consumes the memory required by its index rather than the memory required by every file.

## What the window shows

| Region | Behaviour |
| --- | --- |
| Top bar | burger menu (**New / Load / Save / Undo / Redo / Settings / Exit**), vault name and description, wiki breadcrumbs that fill in as you follow links |
| Second bar | back and forward arrows, the current file location, chips for recently visited veins, undo/redo with the label of what would change |
| Left | two panes behind tabs: the vault tree (chambers fold open, veins open in the centre, a filter box narrows the tree) and **search** |
| Centre | the rendered vein: colour swatches beside the page title, every heading and every wiki link; edit mode with autosave; backlinks at the bottom |
| Right | the concept graph — sections, linked veins, unwritten "ghost" pages and tags, with pan, zoom, drag and depth/toggle controls |

### Following the vault

The viewer watches the vault while it is open, so changes made by other programs appear without a reload. When another program creates, edits or deletes a vein, the change appears in the tree, the index, the graph and the reader, provided that the affected vein is open and no unsaved text exists. Bursts of events are combined into a single refresh, and a change that a subsequent walk shows to have had no effect is ignored. Unsaved text in the editor always takes precedence, although the viewer does not discard an external edit silently: when the file being typed into is changed elsewhere, the viewer warns instead of replacing the caret and offers a **Merge…** button. The `◈` beside the vault name turns green while the vault is being followed.

**Merge…** opens a dialog that previews the result of a line-by-line merge between the two versions. It shows the lines that came from disk, the lines in the draft and every place where the two disagree, marked with `<<<<<<<`, `=======` and `>>>>>>>`. The dialog allows the merge to be applied to the draft, the disk version to be taken, or the draft to be kept unchanged. Autosave pauses while the question is open and whenever merge markers remain in the text, so the timer cannot resolve the conflict by writing the draft over the disk version. `Ctrl+S` saves a marked draft intentionally and reports that it has done so.

The viewer also follows two files in `.macusanite`, because users are expected to edit them by hand: `settings.json` and `colors.json`. When a theme, font size, panel width or colour is saved into either file, the open window applies the change immediately: the document is re-rendered, and the graph and settings dialog follow. The viewer writes nothing back, because reading a file is not an edit and therefore does not enter the undo stack. If a file cannot be parsed, the viewer rejects it with a warning and retains the settings that were already in use. The remaining contents of the folder, including the index cache, `state.json`, the undo stacks and the session log, are the viewer's own bookkeeping and are ignored. Writes that the viewer makes to the two followed files are suppressed, so its own save cannot return as an external change.

### Search

`Ctrl+F` opens the search pane, and each keystroke searches the entire vault for titles, section headings, tags and body text, ranked in that order, with a snippet for each result and the matched words already marked. A vein whose title exactly matches the query is placed first, two unquoted words may match in any order, and quoting them as `"sieve series"` requires the phrase. Every result explains why it matched by reporting a `title`, a `§ section`, a `tag` or the number of occurrences in the text.

Clicking a result opens the vein and marks every occurrence in the page while ringing the current one. `F3` and `Shift+F3` move between occurrences, and the counter above the results reports the current position. `Esc` clears the query, and a second `Esc` restores the tree. Because the viewer watches the vault, as described in [Following the vault](#following-the-vault), a vein that another program adds or edits becomes searchable immediately, and text that has been typed into the editor but not yet saved is searchable as well.

On a lazily indexed vault, search answers in two live stages. Titles, sections and tags are ranked from the index cache as soon as a query is typed, while the viewer reads body text in the background and adds matching results as that text arrives; the status row reports progress such as `reading 240/5001…`. A known title therefore appears as the first result before any file has been read.

### Colours

Every page, link and section begins at the vault default, which is **white**, and can be recoloured by clicking its swatch. The picker offers a common palette, a searchable X11 selection, a `#hex` field and synchronized RGB sliders. Colours resolve from most specific to least specific: an explicit selection takes precedence, then front-matter `color:`, then inheritance from the page for sections or from the source page for links, and finally the default. A link's colour supplies the source end of its graph edge, and the line fades toward the target page's colour.

### Undo and redo

Every mutation is recorded as a before-and-after snapshot of one file, so **Ctrl+Z** restores the recorded state, including vein edits, new veins and chambers, colour assignments, settings and vault details. Pure viewer state, such as the last page, expanded chambers, panel widths and recent colours, is written to `state.json` and excluded from the undo stack.

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

[Wiki.md](Wiki.md) provides the full syntax details for wiki links, aliases, section anchors, mermaid, tags and callouts.

### Backups

Because a vault is a folder, a backup is a copy of that folder. **☰ → Back up to S3…** writes one timestamped `.tar.gz` containing every vein, chamber and `.macusanite` file and uploads it to a bucket. The archive excludes `.git` and symbolic links, and restoring it consists of extracting the archive and opening the folder.

The CLI performs the same operation, which makes it suitable for a cron job or an agent:

```bash
node cli/macusanite.mjs --vault ./notes vault backup my-notes-backups --region eu-west-1
node cli/macusanite.mjs --vault ./notes vault backup my-notes-backups \
  --access-key AKIA… --secret-key-file ~/.aws/vault-secret --prefix fieldwork/
node cli/macusanite.mjs --vault ./notes vault backup my-notes-backups \
  --endpoint https://minio.local:9000 --dry-run
node cli/macusanite.mjs --vault ./notes vault backup my-notes-backups \
  --ssh-host backup@notes.example --ssh-key ~/.ssh/backup.pem
```

Credentials come from the flags, from `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `AWS_SESSION_TOKEN`, or from `~/.aws/credentials` with `--profile`. Objects are named `<prefix><vault>/<YYYYMMDDTHHMMSSZ>.tar.gz` under `macusanite/` by default, so several vaults can share a bucket. `--endpoint` targets an S3-compatible service using path-style addressing, and `--dry-run` builds the archive without sending it. The secret is never written into the vault or the session log.

`--ssh-host user@host` selects the other route, in which the archive is streamed over SSH and uploaded by the host's own `aws` CLI, so the local machine needs no AWS credential. `--ssh-key` names the private key, and a `.pem` file works. `--region`, `--profile` and `--endpoint` then describe the remote host's settings. The dialog offers the same choice, and the remote host needs the AWS CLI and working credentials of its own.

Selecting *Upload automatically after each save* in that dialog arms the vault itself. The setting is stored in `.macusanite/backup.json`, which is the same file read by the CLI and the MCP server, so a vault armed in one place is armed in the others. The window waits five seconds after saving stops, runs one upload at a time, and pauses for five minutes after a failure. Only non-secret fields are stored, and the AWS environment or `~/.aws/credentials` supplies credentials after a restart.

The CLI and MCP server use the same setting and do not require a window:

```bash
node cli/macusanite.mjs --vault ./notes vault autobackup \
  --bucket my-notes-backups --region eu-west-1 --on
node cli/macusanite.mjs --vault ./notes vault autobackup \
  --bucket my-notes-backups --ssh-host backup@notes.example --on
node cli/macusanite.mjs --vault ./notes vault autobackup --off
```

Once the vault is armed, every write uploads a timestamped archive, including window saves after the five-second pause. A CLI command uploads once before it exits and reports the result as `autoBackup`. A long-lived MCP server instead waits a couple of seconds after the last write and uploads one archive for the entire burst, so an agent that writes forty veins creates one object rather than forty; it records the outcome in the session log and flushes any pending upload when it stops. A failed upload never causes the write to fail, because the failure is reported or logged instead. Reads, log lines, viewer state and the index cache are never uploaded.

---

## Driving Macusanite without a window

The window is one of three ways to operate a vault. A single API ([src/lib/api.js](src/lib/api.js)) implements every vault operation, and a single catalogue ([src/lib/catalogue.js](src/lib/catalogue.js)) declares those operations for two front ends: a CLI and an MCP server. Both front ends are plain Node programs with no dependencies, so they require neither Rust nor a webview nor a build step, and both operate on the same vault that the window opens. A vault can therefore be passed freely between them. The window's **Help** button (`F1`) documents all of it, as does [docs/Help.md](docs/Help.md).

### The CLI

```bash
npm run cli -- vault info                      # or: node cli/macusanite.mjs vault info
node cli/macusanite.mjs --vault ./notes vault stats
node cli/macusanite.mjs --vault ./notes search "sieve series" --json
node cli/macusanite.mjs --vault ./notes vein write Home.md --text - < new-home.md
node cli/macusanite.mjs help vein.write        # one command's full documentation
```

The CLI provides 49 commands in seven groups: identity and settings, documents, chambers, search and the graph, colours, history, and help. Every command accepts `--json` for machine-readable output and `--vault <folder>` or `MACUSANITE_VAULT` to select a vault. Results go to stdout, diagnostics go to stderr, and a command that fails returns a non-zero exit code, so the CLI composes in a pipeline. `vault doctor` exits 1 when it finds a problem, which allows it to be used as a check.

### MCP over stdio

```bash
node cli/macusanite.mjs --vault ./notes mcp stdio
```

The server reads one JSON-RPC message per line from stdin and writes one message per line to stdout, while logs go to stderr. This is the interface an MCP client expects when it is configured with a local command.

### MCP over HTTP, headless

```bash
node cli/macusanite.mjs --vault ./notes mcp serve --port 8765
curl -s http://127.0.0.1:8765/health
```

The server binds to `127.0.0.1` on port 8765 by default and speaks JSON-RPC 2.0 at one endpoint, `POST /mcp`, with `GET /health` available for readiness checks. It supports both protocol eras: the legacy `initialize` handshake through revision `2025-11-25`, which current clients send, and the newer `server/discover` handshake, in which every request carries its revision and an unsupported revision is refused with `-32022` and the list of supported versions. `--host 0.0.0.0` exposes the server to the network, and because the port is intentionally unauthenticated, that option should be used only on a trusted machine.

An agent receives the following capabilities:

* **tools** — every command in the catalogue, exposed as `vein_write`, `vault_stats` and similar names, with the JSON Schema declared by the catalogue, so the tool list cannot diverge from the implementation, and annotations that identify tools which write;
* **resources** — `macusanite://manual`, `macusanite://vault`, and every vein as `macusanite://vein/<path>`, paginated;
* **prompts** — a few starting points (`orient`, `repair-ghosts`, `summarize-vein`, `manual`).

### MCP through a file intake

```bash
node cli/macusanite.mjs --vault ./notes mcp intake --dir ./spool --watch
```

This mode serves agents that cannot open a socket. A JSON-RPC request is written to `./spool/<name>.request.json`, either as one message or as an array of messages, and the CLI executes it and writes `./spool/<name>.response.json`. The request is moved aside to `<name>.done`, so no request is processed twice. `--once` handles whatever is pending and exits, which is sufficient for a cron job or a single tool call.

### The manual

```bash
docs/Help.md        # generated: every feature, then every command
npm run docs         # regenerate it
npm run docs:check   # fail if it is out of date (the test suite runs this)
```

The manual is one document rendered in three ways: the Help window, `macusanite docs` and the MCP `docs` tool. It is built from the same catalogue that the CLI parses and the MCP server exposes, so no part of it is written twice and it cannot describe behavior that the program does not implement.

---

## Development

```bash
npm run dev           # browser fallback: the sample vault, no Tauri needed
npm test              # unit tests (node:test) for the pure logic
npm run tauri:dev     # real desktop shell against the dev server
npm run cli -- help   # the CLI, straight from the working tree
npm run docs          # regenerate docs/Help.md from the catalogue
```

[Building.md](Building.md) describes the per-platform prerequisites and artefact paths.

`npm run dev` accepts `?novault=1`, which skips the automatic sample vault and shows the empty state instead.

The frontend accesses the filesystem through [src/backend.js](src/backend.js). Inside Tauri that bridge consists of a set of Rust commands, while in a plain browser it is an in-memory vault backed by `localStorage` that implements the same command surface, which is what makes `npm run dev` and the tests useful without a build.

### Layout

```
src/
  lib/          pure, testable logic (path, wikilinks, colors, colorStore,
                graph, tree, settings, frontmatter, history, watch, search,
                indexCache, fixtures, sigv4, tar, backup)
  ui/           rendering + DOM (markdown, viewer, sidebar, searchPanel, chrome,
                graphPanel, colorpicker, settingsDialog, backupDialog, resizer,
                helpWindow, dom)
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
  s3Backup.js     the CLI's S3 upload: walk, tar, sign, PUT, or stream over SSH
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
  s3.rs         S3 backups: SigV4, the vault tarball, direct and SSH uploads
tests/node/     unit tests for everything under src/lib plus the renderers
```

### Tests

```bash
npm test                                  # 451 JS tests
cargo test --manifest-path src-tauri/Cargo.toml   # 44 Rust tests
```

The Rust suite covers refusal of path traversal, vault scanning (including the per-vein stat used as the index-cache key and the exact JSON field names in that key), tree shape, atomic writes, undo/redo semantics, `.macusanite` creation, log lines, and the `slugify` parity that keeps `[[Note#Heading]]` anchors working on both sides. It also watches a real temporary folder and verifies that external creates, edits and deletes each arrive as one batch, that a hand-edit to `settings.json` is delivered, and that the application's own writes remain quiet. That last check includes its own metadata, which is not echoed back and is still detected when a person edits it a moment later. The JavaScript suite covers the same contracts as well as rendered HTML (swatches, anchors, ghosts, mermaid capture and code masking), the browser fallback's behavior, the refresh planner that determines the meaning of an external change, and the index cache, including which entries a walk can reuse, which entries must be read, and whether a 5,000-vein vault can be planned without opening anything. It also covers search: which field outranks another, that a phrase beats the same words scattered, that every term must appear, and that snippets and highlights mark the correct characters.

The headless half is tested through its real interfaces. The CLI is run as a process and checked through its exit codes and output. The MCP server is tested by driving the protocol, including tool schemas derived from the catalogue, argument validation, error shapes, both protocol eras, resource paging and prompts, as well as through a real HTTP listener on an ephemeral port and a real spool directory. The manual is tested by checking that every command is documented, every declared parameter has a row, the MCP schema matches the declaration, and `docs/Help.md` equals the current output of the generator.

## Limitations (v0.1)

* Index freshness is determined by modification time and size. A vein that is rewritten within the same clock tick with an identical byte count can appear unchanged until it is opened or touched (see [Opening a large vault](#opening-a-large-vault)).
* `.macusanite/index.json` repeats each vein's metadata, at roughly 650 bytes per vein on the reference vault. Because it is a cache, deleting it costs one slow open and has no other consequence.
* Search retains the plain text of veins that it has read for the duration of the session, because ranking body text and quoting a snippet require the words themselves.
* Watching uses the platform's own notifications: ReadDirectoryChangesW, inotify or FSEvents. A folder that cannot be watched, such as some network shares, still opens; the session log records the limitation, and a reload picks up the changes.
* Embeds (`![[Note]]`) render as reference cards rather than as transcluded content.
* Undo history stores whole-file snapshots rather than diffs, and the stack is capped at 400 entries.
* MCP over HTTP is unauthenticated by design. It binds to loopback, and exposing it further through `--host` is the operator's decision.
* The manual is generated. To change prose, edit [src/lib/helpDoc.js](src/lib/helpDoc.js); to change command documentation, edit [src/lib/catalogue.js](src/lib/catalogue.js). Then run `npm run docs`, because edits to `docs/Help.md` are overwritten.
