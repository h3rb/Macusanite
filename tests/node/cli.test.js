/**
 * The CLI, driven the way a person (or an agent) drives it: as a process.
 *
 * Every assertion here goes through `node cli/macusanite.mjs …` and reads the
 * exit code, stdout and stderr — the actual interface. The vault is a real
 * temporary folder, so writing a vein through the CLI is checked by reading the
 * file it wrote.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', '..', 'cli', 'macusanite.mjs');

let counter = 0;
function tempDir(name = 'cli') {
  const dir = path.join(os.tmpdir(), `macusanite-${name}-${process.pid}-${counter++}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Run the CLI and hand back everything a shell would see. */
function run(args, { input = undefined, cwd = undefined } = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    input,
    cwd,
    env: { ...process.env, NO_COLOR: '1' },
  });
  return {
    code: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    json: () => JSON.parse(result.stdout),
  };
}

const readVaultFile = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');

/* ── help ──────────────────────────────────────────────────────────────── */

test('the CLI explains itself without a vault open', () => {
  const version = run(['--version']);
  assert.equal(version.code, 0);
  assert.match(version.stdout, /macusanite \d+\.\d+\.\d+/);

  const listing = run([]);
  assert.equal(listing.code, 0);
  assert.match(listing.stdout, /usage:/);
  assert.match(listing.stdout, /vault info/);
  assert.match(listing.stdout, /vein write/);
  assert.match(listing.stdout, /mcp serve/);

  const page = run(['help', 'vein.write']);
  assert.equal(page.code, 0);
  assert.match(page.stdout, /### `vein\.write`/);
  assert.match(page.stdout, /\| `text` \| string \| no \|/);
  assert.match(page.stdout, /MCP tool `vein_write`/);

  const commandHelp = run(['vein', 'write', '--help']);
  assert.equal(commandHelp.code, 0);
  assert.match(commandHelp.stdout, /usage: macusanite vein write <path>/);
});

test('a wrong command line is a usage error, not a crash', () => {
  const unknown = run(['vein', 'explode']);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /unknown command: vein explode/);

  const badOption = run(['vein', 'read', 'Home.md', '--bogus']);
  assert.equal(badOption.code, 2);
  assert.match(badOption.stderr, /unknown option: --bogus/);

  const missing = run(['vein', 'read']);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /missing required argument: path/);

  const noVault = run(['vault', 'stats']);
  assert.equal(noVault.code, 2);
  assert.match(noVault.stderr, /no vault is open/);

  const missingFolder = run(['--vault', path.join(os.tmpdir(), 'macusanite-not-here-xyz'), 'vault', 'stats']);
  assert.equal(missingFolder.code, 1);
  assert.match(missingFolder.stderr, /not a folder/);
});

/* ── a whole session against a real folder ─────────────────────────────── */

test('a session: create a sample vault, read it, write it, undo it', () => {
  const root = tempDir('session');

  const created = run(['vault', 'create', root, '--sample', '--json']);
  assert.equal(created.code, 0, created.stderr);
  const info = created.json();
  assert.equal(info.veins, 7);
  assert.equal(info.name, 'Macusanite Sample Vault', 'the sample keeps its own identity');
  assert.ok(fs.existsSync(path.join(root, '.macusanite', 'vault.json')));
  assert.ok(fs.existsSync(path.join(root, 'Home.md')));

  const stats = run(['--vault', root, 'vault', 'stats', '--json']).json();
  assert.equal(stats.veins, 7);
  assert.equal(stats.chambers, 4);
  assert.ok(stats.links >= 15);

  const tree = run(['--vault', root, 'vault', 'tree']);
  assert.equal(tree.code, 0);
  assert.match(tree.stdout, /├── Chambers\//);
  assert.match(tree.stdout, /│   ├── Lab\/\n│   │   └── Analytical Methods\.md/);

  const veins = run(['--vault', root, 'vault', 'veins']);
  assert.match(veins.stdout, /^Chambers\/Lab\/Analytical Methods\.md$/m);

  const read = run(['--vault', root, 'vein', 'read', 'Home.md']);
  assert.equal(read.code, 0);
  assert.match(read.stdout, /title: Macusanite/);
  // Extension optional, and paths are vault-relative either way.
  const noExtension = run(['--vault', root, 'vein', 'read', 'Chambers/Lab/Analytical Methods']);
  assert.equal(noExtension.code, 0);
  assert.match(noExtension.stdout, /sieve/i);

  // `--text -` reads stdin: how an agent sends a document without quoting it.
  const written = run(['--vault', root, 'vein', 'write', 'Draft.md', '--text', '-'], {
    input: '---\ntitle: Draft\n---\n\n# Draft\n\nWritten through the CLI.\n',
  });
  assert.equal(written.code, 0, written.stderr);
  assert.match(readVaultFile(root, 'Draft.md'), /# Draft\n\nWritten through the CLI\./);

  const appended = run(['--vault', root, 'vein', 'append', 'Draft.md', 'More text.']);
  assert.equal(appended.code, 0, appended.stderr);
  assert.match(readVaultFile(root, 'Draft.md'), /Written through the CLI\.\nMore text\./);

  // Undo is the same stack the window's Ctrl+Z uses.
  const history = run(['--vault', root, 'history', '--json']).json();
  assert.ok(history.undo.length >= 2);
  assert.equal(run(['--vault', root, 'undo']).code, 0);
  assert.doesNotMatch(readVaultFile(root, 'Draft.md'), /More text\./);
  assert.equal(run(['--vault', root, 'redo']).code, 0);
  assert.match(readVaultFile(root, 'Draft.md'), /More text\./);

  // Search reads titles, headings, tags and text, and says why it matched.
  const search = run(['--vault', root, 'search', 'sieve', '--json']).json();
  assert.ok(search.total >= 1);
  assert.ok(search.results.some((hit) => hit.path.includes('Analytical Methods')));
  const humanSearch = run(['--vault', root, 'search', 'sieve']);
  assert.match(humanSearch.stdout, /result/);
  assert.match(humanSearch.stdout, /score \d+/);

  // Colours round-trip through the same store the window reads.
  assert.equal(run(['--vault', root, 'color', 'set', 'page', 'gold', '--path', 'Home.md']).code, 0);
  const resolved = run(['--vault', root, 'color', 'resolve', 'page', '--path', 'Home.md', '--json']).json();
  assert.equal(resolved.color, '#ffd700');
  assert.equal(run(['--vault', root, 'color', 'clear', 'page', '--path', 'Home.md']).code, 0);

  // The doctor reports through its exit code, which is what a pipeline needs.
  const doctor = run(['--vault', root, 'vault', 'doctor', '--json']);
  assert.equal(doctor.code, 1, 'the sample vault has a ghost link and an orphan');
  assert.equal(doctor.json().ok, false);
  const ghostCheck = doctor.json().checks.find((check) => check.name === 'wiki links');
  assert.equal(ghostCheck.ok, false);

  const healed = run(['--vault', root, 'vein', 'create', 'Chambers/Mineralogy/Glossary', '--text', '# Glossary\n']);
  assert.equal(healed.code, 0, healed.stderr);
  const after = run(['--vault', root, 'vault', 'doctor', '--json']).json();
  assert.equal(after.checks.find((check) => check.name === 'wiki links').ok, true, 'the ghost is gone');

  fs.rmSync(root, { recursive: true, force: true });
});

test('the index cache is inspectable, rebuildable and droppable', () => {
  const root = tempDir('index');
  assert.equal(run(['vault', 'create', root, '--sample']).code, 0);
  assert.equal(run(['--vault', root, 'vault', 'index', 'rebuild']).code, 0);

  const status = run(['--vault', root, 'vault', 'index', '--json']).json();
  assert.equal(status.present, true);
  assert.equal(status.veins, 7);
  assert.equal(status.stale, 0, 'everything was just read');
  assert.ok(status.bytes > 0);

  // A new vein is the only stale entry, which is what "lazy" buys.
  run(['--vault', root, 'vein', 'create', 'Fresh.md']);
  const after = run(['--vault', root, 'vault', 'index', '--json']).json();
  assert.equal(after.veins, 8);
  assert.equal(after.fresh, 7);
  assert.equal(after.stale, 1);

  assert.equal(run(['--vault', root, 'vault', 'index', 'drop']).code, 0);
  assert.equal(run(['--vault', root, 'vault', 'index', '--json']).json().present, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('the manual comes out of the CLI, whole and in pieces', () => {
  const root = tempDir('docs');
  const target = path.join(root, 'Help.md');

  const written = run(['docs', '--out', target]);
  assert.equal(written.code, 0, written.stderr);
  assert.match(written.stdout, /wrote \d+ bytes/);
  const text = fs.readFileSync(target, 'utf8');
  assert.match(text, /^# Macusanite Help/);
  assert.match(text, /## Driving Macusanite without a window/);
  assert.match(text, /### `vein\.write`/);

  const sections = run(['docs', '--sections', '--json']).json();
  assert.ok(sections.sections.some((section) => section.slug === 'agents'));

  const one = run(['docs', 'search']);
  assert.equal(one.code, 0);
  assert.match(one.stdout, /^## Search/);

  const missing = run(['docs', 'nope']);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /no such section/);

  fs.rmSync(root, { recursive: true, force: true });
});
