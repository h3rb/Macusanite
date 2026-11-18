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
 *   external: true,       // reaches a remote service (an upload), vault untouched
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
  'Worldbuilding',
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
    summary: 'Open a vault folder for this session, creating its `.macusanite` metadata when necessary.',
    description: `This command opens the vault in which every other command runs. Passing \`--vault <folder>\` on the command line performs the same operation before the command runs, so this command is mainly useful to a long-lived MCP server that is asked to work on a second vault. With \`--create\`, a missing folder is created instead of refused, which is also how an agent initialises a new vault.`,
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
    summary: 'Report the vault\'s identity, settings and colour assignments.',
    description: `This command returns the payload that the window reads when it opens a folder: the vault's name, description and creation time from \`.macusanite/vault.json\`, the merged viewer settings and the raw colour assignments. Missing metadata files are created first, so the command also serves as a safe check that an existing folder is a vault.`,
    returns: '`{ path, name, description, created, settings, colors }`',
    examples: ['macusanite vault info', 'macusanite --vault ./notes vault info --json'],
  },

  'vault.create': {
    group: 'Vault',
    summary: 'Create a vault folder and its `.macusanite` metadata, optionally seeding the sample vault.',
    description: `The command creates the folder when necessary, writes \`.macusanite/vault.json\` with the supplied name and description, and fills in \`settings.json\`, \`colors.json\` and \`history.json\` when those files are absent. With \`--sample\`, it first writes the bundled reference vault of seven veins about the Macusani glass project; the sample vault keeps its own identity, so its name and description replace the supplied values.`,
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
    summary: 'Report counts for veins, chambers, links, tags, ghosts, orphans and bytes.',
    description: `This command gives an agent an orientation to a vault. The \`ghosts\` count covers wiki links that point at nothing, the \`orphans\` count covers veins with neither inbound nor outbound links, and \`newest\` identifies the vein that changed most recently.`,
    returns: '`{ path, veins, chambers, headings, links, tags, ghosts, orphans, bytes, newest }`',
    examples: ['macusanite vault stats', 'macusanite vault stats --json'],
  },

  'vault.tree': {
    group: 'Vault',
    summary: 'Return the chamber and vein tree in the same shape as the sidebar.',
    returns: 'nested `[{ kind: "chamber"|"vein", name, path, children }]`',
    examples: ['macusanite vault tree', 'macusanite vault tree --json'],
  },

  'vault.veins': {
    group: 'Vault',
    summary: 'List every vein in the vault as a vault-relative path.',
    params: [
      { name: 'under', type: 'string', description: 'Only veins inside this chamber.' },
      { name: 'query', type: 'string', description: 'Only veins whose path contains this text.' },
    ],
    returns: '`string[]` (sorted)',
    examples: ['macusanite vault veins', 'macusanite vault veins --under Chambers/Lab'],
  },

  'vault.chambers': {
    group: 'Vault',
    summary: 'List every chamber in the vault, outermost first.',
    returns: '`string[]` (sorted)',
    examples: ['macusanite vault chambers'],
  },

  'vault.settings': {
    group: 'Vault',
    summary: 'Read the viewer settings after merging them over the defaults.',
    description: `The result contains the settings that the window writes to \`.macusanite/settings.json\`, including the theme, font size, line width, default colours, palette, recent colours, graph options, layout widths and editor flags.`,
    returns: 'the merged settings object',
    examples: ['macusanite vault settings --json'],
  },

  'vault.settings.set': {
    group: 'Vault',
    summary: 'Update viewer settings with a patch.',
    description: `The command merges a patch over the current settings and writes the result back. Unknown keys are dropped, and out-of-range numbers are clamped in the same way as in the settings dialog. Use \`--set key=value\` for one value or \`--patch '{...}'\` for a whole object, and use \`-\` to read the JSON from stdin.`,
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

  'vault.backup': {
    group: 'Vault',
    summary: 'Upload the entire vault to an S3 bucket as one timestamped tar.gz, either directly or over SSH.',
    description: `Each run uploads one object at \`<prefix><vault>/<YYYYMMDDTHHMMSSZ>.tar.gz\`, normally through a signed \`PutObject\` request. The archive contains every file in the vault, including veins, chambers and \`.macusanite\`, so restoring consists of extracting the archive and opening the resulting folder. A vault that is also a git repository does not include \`.git\`, and symbolic links are omitted.

Credentials come from \`--access-key\` and \`--secret-key\`, from \`--secret-key-file\` when the secret is stored in a file, from \`AWS_ACCESS_KEY_ID\`, \`AWS_SECRET_ACCESS_KEY\` and \`AWS_SESSION_TOKEN\`, or from \`~/.aws/credentials\` or a named \`--profile\`. The region comes from \`--region\`, \`AWS_REGION\`, \`AWS_DEFAULT_REGION\` or the profile and defaults to \`us-east-1\`. \`--endpoint\` targets an S3-compatible service using path-style addressing, and \`--dry-run\` assembles the archive and reports its key and size without sending it. The command does not change anything in the vault.

With \`--ssh-host user@host\`, the archive travels over SSH instead. It is streamed to the remote machine, uploaded there by that host's own \`aws\` CLI from a temporary file, and the temporary file is removed afterwards. The local machine needs no AWS credential and the command reads none, while \`--ssh-key\` names the private key, \`--ssh-port\` changes the port, and \`--region\`, \`--profile\` and \`--endpoint\` are passed to the remote \`aws\` command rather than resolved locally. The remote host requires the AWS CLI and working credentials of its own.`,
    external: true,
    params: [
      { name: 'bucket', type: 'string', required: true, positional: true, description: 'Destination bucket.' },
      { name: 'region', type: 'string', description: 'Bucket region; defaults to the environment or profile; with `--ssh-host`, the remote region.' },
      { name: 'prefix', type: 'string', description: 'Key prefix, so several vaults can share a bucket.', default: 'macusanite/' },
      { name: 'endpoint', type: 'string', description: 'S3-compatible endpoint, e.g. `https://minio.example:9000` (path-style).' },
      { name: 'access-key', type: 'string', description: 'AWS access key id.' },
      { name: 'secret-key', type: 'string', description: 'AWS secret access key. Prefer `--secret-key-file` or the environment.' },
      { name: 'secret-key-file', type: 'string', description: 'Read the secret access key from this file instead (direct uploads only).' },
      { name: 'session-token', type: 'string', description: 'Session token, for temporary credentials.' },
      { name: 'profile', type: 'string', description: 'Profile in `~/.aws/credentials` (the remote host’s, with `--ssh-host`).' },
      { name: 'ssh-host', type: 'string', description: 'Upload over SSH from this host (`user@host`), with its credentials instead of this machine’s.' },
      { name: 'ssh-key', type: 'string', description: 'Private key for the SSH connection, e.g. a `.pem` file.' },
      { name: 'ssh-port', type: 'integer', description: 'SSH port; defaults to the client\'s own configuration.' },
      { name: 'dry-run', type: 'boolean', description: 'Build the archive and report where it would go, without uploading.' },
    ],
    returns: '`{ ok, transport, sshHost, bucket, key, region, endpoint, files, bytes, url, credentials, dryRun }`',
    examples: [
      'macusanite vault backup my-notes-backups --region eu-west-1',
      'macusanite vault backup my-notes-backups --secret-key-file ~/.aws/vault-secret --prefix fieldwork/',
      'macusanite vault backup my-notes-backups --endpoint https://minio.local:9000 --dry-run',
      'macusanite vault backup my-notes-backups --ssh-host backup@notes.example --ssh-key ~/.ssh/backup.pem',
    ],
  },

  'vault.export': {
    group: 'Vault',
    summary: 'Export the open vault to one portable compressed archive.',
    description: `The command writes one \`.tar.gz\` archive containing every vault file, including \`.macusanite/history.json\`, so the vault and its undo/redo history can be shared and imported elsewhere. A manifest named \`macusanite-archive.json\` lists every file in the archive. \`.git\` internals and symbolic links are omitted, as they are for \`vault backup\`, while non-text files are carried byte-for-byte so that images and other binary files survive the round trip unchanged.`,
    params: [
      { name: 'path', type: 'string', required: true, positional: true, description: 'Where to write the archive, for example `notes.tar.gz`. Relative to the working directory.' },
    ],
    returns: '`{ path, files, bytes, history: { undo, redo } }`',
    examples: ['macusanite vault export notes.tar.gz'],
    external: true,
    mcp: false,
  },

  'vault.import': {
    group: 'Vault',
    summary: 'Import a portable vault archive into the open vault.',
    description: `The command reads a \`.tar.gz\` archive written by \`vault.export\` and updates the open vault with its files and undo/redo history. Files carried by the archive are overwritten in place, while files that it does not carry remain untouched unless \`--replace\` is supplied; that option also deletes local files missing from the archive, except \`.git\`, so the vault becomes an exact copy of the archive. If existing files would change or be deleted, the command refuses with an \`overwrite-required\` error that names them until \`--overwrite\` confirms the operation. A malformed archive, an archive whose manifest does not match its contents, or an archive without history is refused before anything is written. Files are compared and written as bytes, so non-text files survive unchanged. A session that can write only text, such as the desktop window or the browser, refuses an archive containing non-text files with a \`binary-unsupported\` error that names them, rather than importing them as corrupted text; the CLI should be used for such archives.`,
    params: [
      { name: 'path', type: 'string', required: true, positional: true, description: 'The archive to read, for example `notes.tar.gz`. Relative to the working directory.' },
      { name: 'overwrite', type: 'boolean', description: 'Confirm overwriting existing files whose contents would change, and deleting the files `--replace` would drop. Required when the import conflicts or deletes.' },
      { name: 'replace', type: 'boolean', description: 'Also delete local files missing from the archive (except `.git`), so the vault fully becomes the archive\'s copy. Off by default: update-only.' },
    ],
    returns: '`{ path, files, written, added, updated, unchanged, conflicts, deletions, deleted, history: { undo, redo } }`',
    examples: ['macusanite vault import notes.tar.gz', 'macusanite vault import notes.tar.gz --overwrite', 'macusanite vault import notes.tar.gz --replace --overwrite'],
    mutates: true,
    mcp: false,
  },

  'vault.import.plan': {
    group: 'Vault',
    summary: 'Preview an archive import without writing any files.',
    description: `This read-only preflight for \`vault.import\` validates the \`.tar.gz\` and lists the files that would be added, the existing files that would be overwritten, the files that would remain unchanged, and, with \`--replace\`, the local files that would be deleted, except \`.git\`. The window's Import vault dialog shows this list before it writes anything, and a CLI caller can use it to determine whether \`--overwrite\` is required.`,
    params: [
      { name: 'path', type: 'string', required: true, positional: true, description: 'The archive to read, for example `notes.tar.gz`. Relative to the working directory.' },
      { name: 'replace', type: 'boolean', description: 'Also list the local files missing from the archive (except `.git`) that the import would delete.' },
    ],
    returns: '`{ path, vaultName, files, added[], conflicts[], unchanged[], deletions[], history: { undo, redo } }`',
    examples: ['macusanite vault import plan notes.tar.gz'],
    mcp: false,
  },

  'vault.autobackup': {
    group: 'Vault',
    summary: 'Arm the vault to upload after every write from the window, CLI and MCP, or change its upload settings.',
    description: `The setting is stored in \`.macusanite/backup.json\` inside the vault, so it travels with the folder and is read by every CLI invocation and MCP server that opens that vault. With no arguments the command reports the current setting, \`--on\` and \`--off\` arm and disarm automatic uploads, and any supplied connection fields are saved as given.

Once the vault is armed, writes upload a timestamped archive. A window save uploads after five seconds of quiet, a CLI command uploads once before it exits and reports the result under \`autoBackup\`, and a long-lived MCP server uploads one archive for an entire burst after waiting a couple of seconds from the last write, so an agent that writes forty veins creates one object rather than forty. The server records that outcome in the session log and flushes any pending upload when it stops. Reads never upload, and neither do the viewer's bookkeeping commands, log entries, state, the index cache or \`vault backup\` itself. A failed upload does not fail the write, because the edit has already been recorded; the failure is reported, or logged when it occurs in the background.

Credentials are never stored in the setting. A direct upload reads \`AWS_ACCESS_KEY_ID\`, \`AWS_SECRET_ACCESS_KEY\` and \`AWS_SESSION_TOKEN\`, or \`~/.aws/credentials\` with \`--profile\`, while \`--ssh-host\` uploads with the remote host's own identity. The window's **Back up to S3…** dialog edits the same setting, so arming a vault there also covers uploads from the headless tools.`,
    params: [
      { name: 'bucket', type: 'string', description: 'Destination bucket.' },
      { name: 'region', type: 'string', description: 'Bucket region; defaults to the environment or profile; with `--ssh-host`, the remote region.' },
      { name: 'prefix', type: 'string', description: 'Key prefix, so several vaults can share a bucket; `macusanite/` when unset.' },
      { name: 'endpoint', type: 'string', description: 'S3-compatible endpoint, e.g. `https://minio.example:9000` (path-style).' },
      { name: 'profile', type: 'string', description: 'Profile in `~/.aws/credentials` (the remote host’s, with `--ssh-host`).' },
      { name: 'ssh-host', type: 'string', description: 'Upload over SSH from this host (`user@host`), with its credentials instead of this machine’s.' },
      { name: 'ssh-key', type: 'string', description: 'Private key for the SSH connection, e.g. a `.pem` file.' },
      { name: 'ssh-port', type: 'integer', description: 'SSH port; defaults to the client\'s own configuration.' },
      { name: 'on', type: 'boolean', description: 'Arm automatic uploads.' },
      { name: 'off', type: 'boolean', description: 'Disarm automatic uploads, keeping the saved settings.' },
    ],
    returns: '`{ path, enabled, bucket, region, prefix, endpoint, profile, sshHost, sshKey, sshPort }`',
    examples: [
      'macusanite vault autobackup --bucket my-notes-backups --region eu-west-1 --on',
      'macusanite vault autobackup --bucket my-notes-backups --ssh-host backup@notes.example --ssh-key ~/.ssh/backup.pem --on',
      'macusanite vault autobackup --off',
    ],
    mutates: true,
  },

  'vault.state': {
    group: 'Vault',
    summary: 'Read the viewer state, including the last vein read, expanded chambers and panel widths.',
    description: `The state is bookkeeping stored in \`.macusanite/state.json\`. It is deliberately excluded from undo, and the window rewrites it as the user browses, so callers should treat it as a hint rather than as an authoritative record.`,
    returns: 'the stored state object (may be empty)',
    examples: ['macusanite vault state --json'],
  },

  'vault.state.set': {
    group: 'Vault',
    summary: 'Merge viewer state, keeping the canvas records the patch does not name.',
    description: `The state is bookkeeping stored in \`.macusanite/state.json\`. It also holds every vein's worldbuilding canvas under \`world\`, so the supplied object is merged over the current state rather than replacing it: setting \`lastPath\` or a panel width leaves the canvases alone, while naming \`world\` replaces that slice (the \`world\` commands edit one canvas safely). It is deliberately excluded from undo, and the window rewrites it as the user browses, so callers should treat it as a hint rather than as an authoritative record.`,
    params: [
      { name: 'state', type: 'json', required: true, positional: true, description: 'The state keys to merge into the stored state.' },
    ],
    returns: '`{ path }`',
    examples: ['macusanite vault state set \'{"lastPath":"Home.md"}\''],
    mutates: true,
  },

  'vault.log': {
    group: 'Vault',
    summary: 'Append one line to the session log.',
    description: `Logs are stored as JSON lines in \`.macusanite/logs/session-YYYYMMDD.log\`, which is the same file that the window writes. Logging never changes the undo stack.`,
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
    summary: 'Report the state of the document index cache in `.macusanite/index.json`.',
    description: `The cache stores each vein's title, aliases, headings, links, tags and front-matter colours, keyed by modification time and size. The window and the CLI reuse \`fresh\` entries when they open the vault, while \`stale\` entries must be read again.`,
    returns: '`{ path, bytes, version, entries, veins, fresh, stale, present }`',
    examples: ['macusanite vault index'],
  },

  'vault.index.rebuild': {
    group: 'Vault',
    summary: 'Read every vein again and rewrite the index cache.',
    description: `This command is useful after bulk edits made outside Macusanite, such as edits from a script, a git checkout or an editor that does not update modification times. Correctness never depends on it, because a stale entry is detected and re-read, but rebuilding the cache makes the next open faster.`,
    returns: '`{ index }` describing every vein',
    examples: ['macusanite vault index rebuild'],
    mutates: true,
  },

  'vault.index.drop': {
    group: 'Vault',
    summary: 'Delete the index cache.',
    description: `The next open, whether from the window or the CLI, reads the whole vault once and writes the cache again.`,
    returns: '`{ path, dropped }`',
    examples: ['macusanite vault index drop'],
    mutates: true,
  },

  'vault.doctor': {
    group: 'Vault',
    summary: 'Check the vault for inconsistencies and report each result.',
    description: `The check reports missing or unreadable \`.macusanite\` files, wiki links that point at nothing, veins with no inbound or outbound links, tag counts, and whether the index cache covers the veins it claims to describe. The command exits with code 1 when any check fails, which makes it usable in a pipeline.`,
    returns: '`{ ok, checks: [{ name, ok, detail }], ghosts, orphans }`',
    examples: ['macusanite vault doctor', 'macusanite vault doctor --json'],
  },

  /* ── Documents ───────────────────────────────────────────────────────── */

  'vein.read': {
    group: 'Documents',
    summary: 'Read one vein as plain markdown.',
    description: `The command prints the markdown source, including front matter, exactly as it appears on disk. With \`--json\`, it returns the same text together with the vein's metadata in one payload.`,
    params: [
      { name: 'path', type: 'string', required: true, positional: true, description: 'Vault-relative path, with or without `.md`.' },
      { name: 'with-meta', type: 'boolean', description: 'Return `{ path, text, ...metadata }` instead of the bare text.' },
    ],
    returns: 'the markdown source, or an object with `--with-meta`',
    examples: ['macusanite vein read Home.md', 'macusanite vein read Chambers/Lab/Analytical Methods --json'],
  },

  'vein.info': {
    group: 'Documents',
    summary: 'Report one vein\'s title, aliases, tags, headings, links, colours and word count.',
    description: `The result describes the document as the window understands it: front matter is parsed, headings receive anchor ids, wiki links are extracted with their targets and sections, and the page, link and section colours are read from front matter.`,
    params: [
      { name: 'path', type: 'string', required: true, positional: true, description: 'Vault-relative path.' },
    ],
    returns: '`{ path, title, aliases, tags, headings, links, words, color, linkColor, sectionColor, frontmatter }`',
    examples: ['macusanite vein info Chambers/Mineralogy/Fluid Inclusions.md --json'],
  },

  'vein.write': {
    group: 'Documents',
    summary: 'Replace a vein\'s contents and record an undo step.',
    description: `The command preserves line endings as supplied. Use \`--text -\` to read the new contents from stdin, which is the appropriate method for an agent that sends a long document. A write that changes nothing is not recorded, so an idle save cannot add noise to the undo stack.`,
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
    summary: 'Create a vein with front matter and a title heading, unless text is supplied.',
    description: `The command appends \`.md\` when the path has no markdown extension. Creating a vein that already exists is not an error, because the result reports \`created: false\` and the existing text remains untouched.`,
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
    description: `The command inserts a newline before the appended text unless the file already ends with one.`,
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
    summary: 'Replace a section\'s body or add the section when it is absent.',
    description: `The command matches the heading by level and text, case-insensitively. A replacement keeps everything before the heading and everything from the next heading of the same or a higher level, so the document does not acquire a duplicate section.`,
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
    description: `The command records two undo steps, one for the new file and one for the old file, so running \`undo\` twice restores the original state. Renaming onto an existing vein is refused.`,
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
    description: `Undo restores the text, while redo recreates the file **empty**. A history entry stores \`after: ""\` because the window reads the stack with a non-optional \`after\` field and would treat a null value as a corrupt file. Pass \`--no-undo\` to delete the vein without recording an undo step.`,
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
    summary: 'List the wiki links in a vein in source order.',
    returns: '`[{ target, section, alias, embed, samePage }]`',
    examples: ['macusanite vein links Home.md --json'],
  },

  'vein.headings': {
    group: 'Documents',
    summary: 'Return a vein\'s outline with the anchor id that each heading can be linked by.',
    returns: '`[{ level, text, anchor }]`',
    examples: ['macusanite vein headings Wiki.md --json'],
  },

  'vein.backlinks': {
    group: 'Documents',
    summary: 'List the veins that link to this one.',
    returns: '`[{ path, title, context }]` sorted by title',
    examples: ['macusanite vein backlinks "Chambers/Lab/Analytical Methods.md" --json'],
  },

  'vein.resolve': {
    group: 'Documents',
    summary: 'Resolve a wiki target using the viewer\'s resolution order.',
    description: `Resolution proceeds through an explicit path, a vein in the same chamber, the shallowest vein with that name, a front-matter title or alias, and finally a case-insensitive name match. A miss returns \`ghost: true\` together with the path at which a new vein would be created.`,
    params: [
      { name: 'target', type: 'string', required: true, positional: true, description: 'Link target, e.g. `Fluid Inclusions`.' },
      { name: 'from', type: 'string', description: 'The vein the link appears in, for same-chamber resolution.' },
    ],
    returns: '`{ ok, path, anchor, candidates, ghost?, suggestedPath? }`',
    examples: ['macusanite vein resolve "Analytical Methods" --from Home.md --json'],
  },

  /* ── Worldbuilding ───────────────────────────────────────────────────── */

  'world.list': {
    group: 'Worldbuilding',
    summary: 'List the veins that carry a worldbuilding canvas, with their cards, groups, bonds and checkpoints.',
    description: `A vein opens as a canvas when it is marked for Worldbuilding or when it has been arranged on one. The layout, groups, bonds, annotations and canvas history live in \`.macusanite/state.json\` under \`world\`, beside the plain markdown the cards edit, so the same vault reads in the window, the CLI and over MCP. This command reports one row per canvas vein with the counts an agent needs to decide what to open; \`--all\` includes veins that have no canvas record yet.`,
    params: [
      { name: 'all', type: 'boolean', description: 'Include veins that have no canvas record.' },
    ],
    returns: '`{ boards: [{ path, exists, marked, cards, groups, bonds, annotations, steps }] }`',
    examples: ['macusanite world list', 'macusanite world list --all --json'],
  },

  'world.show': {
    group: 'Worldbuilding',
    summary: 'Show one vein\'s canvas: its cards, groups, bonds, annotations, saved views and checkpoints.',
    description: `The result is the canvas record as the window reads it, brought up to the current schema: every card with its anchor, title, type, structured fields, position, fold, pin, lock, display mode, height, colour and image; every group with its members and children; every asserted bond with its kind and note; the annotations, saved views, camera and connector routing; and the undo and redo checkpoints by name. A card's prose stays in the markdown, so \`vein read\` and \`vein section\` edit it and this command edits the canvas around it.`,
    params: [
      { name: 'path', type: 'string', required: true, positional: true, description: 'Vault-relative path of the vein.' },
    ],
    returns: '`{ path, marked, schema, cards, groups, bonds, annotations, views, checkpoints, view, routing, pushAside }`',
    examples: ['macusanite world show Home.md', 'macusanite world show "Chambers/Lab/Analytical Methods" --json'],
  },

  'world.mark': {
    group: 'Worldbuilding',
    summary: 'Mark a vein as Worldbuilding, or stop it opening as a canvas while keeping its layout.',
    description: `The mark is what makes a vein open as cards instead of as lines; the canvas itself is kept either way, so unmarking is not a loss and marking again restores the graph. With neither flag the vein is marked, which is the common case; \`--off\` unmarks it and leaves the record in place as long as it holds positions, groups, bonds or any other canvas work.`,
    params: [
      { name: 'path', type: 'string', required: true, positional: true, description: 'Vault-relative path of the vein.' },
      { name: 'on', type: 'boolean', description: 'Mark the vein for Worldbuilding (the default).' },
      { name: 'off', type: 'boolean', description: 'Unmark it, keeping its canvas record.' },
    ],
    returns: '`{ path, marked }`',
    examples: ['macusanite world mark Home.md', 'macusanite world mark Home.md --off'],
    mutates: true,
  },

  'world.set': {
    group: 'Worldbuilding',
    summary: 'Change a canvas record with a JSON patch and record one named canvas step.',
    description: `The patch may name any of \`positions\`, \`groups\`, \`relations\`, \`bondNotes\`, \`folded\`, \`types\`, \`fields\`, \`colors\`, \`images\`, \`resources\`, \`pinned\`, \`locked\`, \`cardModes\`, \`cardSizes\`, \`cardDims\`, \`stack\`, \`collapsedGroups\`, \`annotations\`, \`savedViews\`, \`view\`, \`routing\` and \`pushAside\`. Maps merge by card anchor (groups by id, bonds by \`from->to\`), so naming one card never disturbs the others; a \`null\` value removes that entry, and a \`null\` slice clears the whole slice. Arrays — stack order and saved views — replace, because their order is the value; \`view\`, \`routing\` and \`pushAside\` are preferences that merge or replace as one. Anchors must be headings that exist, types, fields and relationship kinds are checked against the same tables the canvas uses, and positions and sizes are rounded and clamped as a drag would be. The change lands on the canvas's own undo stack as one named step — the same stack the toolbar's undo and the checkpoints use, never the markdown undo — unless \`--no-history\` is passed. The step's name is derived from the patch (\`Moved 3 cards\`, \`Changed 2 bonds\`) or supplied with \`--label\`. An empty patch is refused, and a patch that changes nothing records no step.`,
    params: [
      { name: 'path', type: 'string', required: true, positional: true, description: 'Vault-relative path of the vein.' },
      { name: 'patch', type: 'json', required: true, description: 'An object of canvas slices to replace, e.g. `{"positions":{"intro":{"x":40,"y":20}}}`.' },
      { name: 'label', type: 'string', description: 'Name for the canvas step; derived from the patch when omitted.' },
      { name: 'no-history', type: 'boolean', description: 'Do not add the change to the canvas undo stack.' },
    ],
    returns: '`{ path, changed, label, cards, groups, bonds, annotations, checkpoints }`',
    examples: [
      'macusanite world set Home.md --patch \'{"positions":{"intro":{"x":40,"y":20}}}\'',
      'macusanite world set Home.md --patch \'{"relations":{"intro->progression":"parent"}}\' --label "Bonded the intro"',
      'macusanite world set Home.md --patch \'{"types":{"intro":"person"},"fields":{"intro":{"level":"3"}}}\'',
    ],
    mutates: true,
  },

  'world.checkpoints': {
    group: 'Worldbuilding',
    summary: 'List a canvas\'s undo and redo checkpoints, nearest first, without their snapshots.',
    description: `Every canvas change is one named checkpoint: a drag, a resize, a group, a bond, a type, a layout. This is the same stack the toolbar's \`▾\` opens, with each row reporting how many steps away it is; the snapshot behind a checkpoint stays in the vault, and \`world jump\` returns to it.`,
    params: [
      { name: 'path', type: 'string', required: true, positional: true, description: 'Vault-relative path of the vein.' },
    ],
    returns: '`{ path, past: [{ name, stepsBack }], future: [{ name, stepsForward }], undo, redo }`',
    examples: ['macusanite world checkpoints Home.md', 'macusanite world checkpoints Home.md --json'],
  },

  'world.jump': {
    group: 'Worldbuilding',
    summary: 'Return a canvas to a checkpoint, N steps back or forward, in one restore.',
    description: `This is the headless equivalent of picking a row in the checkpoints popover: the whole canvas state of that step is put back — positions, groups, bonds, folds, types, fields, colours, images, pins, locks, display modes, heights and the camera — and the steps it leaps over move to the other stack with their names intact, so single-stepping still works from either end. A checkpoint that carried a table edit also restores the markdown table it changed. Pass exactly one of \`--back\` or \`--forward\`; asking for more steps than the stack holds is an error, not a silent clamp.`,
    params: [
      { name: 'path', type: 'string', required: true, positional: true, description: 'Vault-relative path of the vein.' },
      { name: 'back', type: 'integer', description: 'How many steps back to go (undo).' },
      { name: 'forward', type: 'integer', description: 'How many steps forward to go (redo).' },
    ],
    returns: '`{ path, direction, steps, checkpoint, tables, checkpoints }`',
    examples: ['macusanite world jump Home.md --back 1', 'macusanite world jump Home.md --forward 3 --json'],
    mutates: true,
  },

  /* ── Chambers ────────────────────────────────────────────────────────── */

  'chamber.create': {
    group: 'Chambers',
    summary: 'Create a chamber (folder) inside the vault.',
    description: `The command keeps an empty chamber visible through a \`.keep\` marker file, so the chamber appears in the tree before it contains anything, which is the same convention used by the window.`,
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
    summary: 'Search every vein by title, heading, tag and body text, in that order of rank.',
    description: `The command applies the same ranking as the search pane. Two unquoted words may match anywhere and in any order, while quoting them as \`"sieve series"\` requires the phrase. Every term must appear somewhere in a vein for that vein to be a result, and each result reports why it matched together with a snippet containing the hits. The index cache supplies vein metadata, while every vein is read for body text.`,
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
    summary: 'List every tag in the vault and the number of veins that carry it.',
    returns: '`[{ tag, count, veins }]` busiest first',
    examples: ['macusanite tags --json'],
  },

  'ghosts': {
    group: 'Search and graph',
    summary: 'List wiki links whose target veins do not exist.',
    description: `Each entry names the linking vein, the target text and the path at which a new vein would be created. Creating those veins is the most common repair that an agent performs on a vault.`,
    returns: '`[{ from, target, section, suggestedPath }]`',
    examples: ['macusanite ghosts --json', 'macusanite ghosts'],
  },

  'graph': {
    group: 'Search and graph',
    summary: 'Return the concept graph as document, section and tag nodes with their edges.',
    description: `The window lays out this structure for the graph pane, and an agent can read the same structure to determine what a vein contains and which documents surround it. \`focus\` narrows the graph to one vein and its neighbourhood within \`depth\` steps.`,
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
    description: `Colours are stored in \`.macusanite/colors.json\` and resolve from most specific to least specific: an explicit selection, front-matter \`color:\`, inheritance from a page for sections or from a source page for links, and finally the vault default. Any CSS colour name or \`#rrggbb\` value is accepted and normalized to \`#rrggbb\`.`,
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
    summary: 'Remove a colour assignment so that the target inherits again.',
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
    summary: 'Report the colour that a target would receive after colour resolution.',
    description: `The result reflects the complete resolution order: an explicit selection, front matter, inheritance and the vault default. An assignment alone does not determine the painted colour, so this command reports the effective result.`,
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
    summary: 'List the undo and redo stacks, newest first.',
    description: `Every mutation is recorded as a before-and-after snapshot of one file, so undo restores the recorded state. The stack is capped at 400 entries and stored in \`.macusanite/history.json\`, and the window shows the same list in its second bar.`,
    returns: '`{ undo: [{ path, label, ts }], redo: [...] }`',
    examples: ['macusanite history --json'],
  },

  'undo': {
    group: 'History',
    summary: 'Undo the most recent recorded change.',
    description: `The command uses the same stack as the window's Ctrl+Z, so the two interfaces can be interleaved safely.`,
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
    summary: 'Document every command with its parameters and examples.',
    description: `With no argument, the command lists the commands by group. With a command name, it prints that command's full page, which is the same text that the MCP server sends to an agent as the tool description and the same text that the help window renders.`,
    params: [
      { name: 'command', type: 'string', positional: true, description: 'Command to describe, e.g. `vein.write`.' },
      { name: 'markdown', type: 'boolean', description: 'Print markdown instead of terminal text.' },
    ],
    returns: 'the reference, or one command\'s page',
    examples: ['macusanite help', 'macusanite help vein.write'],
  },

  'docs': {
    group: 'Help',
    summary: 'Return the whole manual in markdown, with every feature followed by every command.',
    description: `This is the document that the help window displays and that \`--out FILE\` writes to disk. It is generated from the source of truth in \`src/lib/catalogue.js\` for commands and \`src/lib/helpDoc.js\` for features, so it cannot diverge from the implementation.`,
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
  const entry = COMMANDS[command] ?? {};
  const mutates = isMutating(command);
  const undoable = isUndoable(command);
  return {
    readOnlyHint: !mutates && entry.external !== true,
    destructiveHint: command === 'vein.delete' || command === 'vault.index.drop',
    idempotentHint: !mutates || undoable,
    // An upload leaves the machine; everything else here is local.
    openWorldHint: entry.external === true,
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
