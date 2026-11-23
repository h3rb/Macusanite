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

test('vault doctor and ghosts report a link to a heading that is gone', () => {
  const root = tempDir('doctor-section');
  assert.equal(run(['vault', 'create', root, '--sample']).code, 0);

  // A heading renamed without its links following: the links still open the
  // vein, so nothing looks broken until the section is checked.
  const methods = path.join(root, 'Chambers/Lab/Analytical Methods.md');
  fs.writeFileSync(methods, fs.readFileSync(methods, 'utf8').replace('## Sieve series', '## Sieve ladder'));

  const ghosts = run(['--vault', root, 'ghosts', '--json']).json();
  const broken = ghosts.filter((ghost) => ghost.kind === 'section');
  assert.equal(broken.length, 1);
  assert.equal(broken[0].section, 'Sieve series');
  assert.equal(broken[0].path, 'Chambers/Lab/Analytical Methods.md');
  assert.equal(broken[0].suggestedPath, null, 'there is no file to create');

  const doctor = run(['--vault', root, 'vault', 'doctor', '--json']);
  assert.equal(doctor.code, 1);
  const check = doctor.json().checks.find((entry) => entry.name === 'wiki links');
  assert.equal(check.ok, false);
  assert.match(check.detail, /#Sieve series/);
  // The human list names the missing section beside the link.
  assert.match(run(['--vault', root, 'ghosts']).stdout, /Sieve series/);

  // Resolving the link keeps the vein it found and says the section is gone.
  const resolved = run(['--vault', root, 'vein', 'resolve', 'Chambers/Lab/Analytical Methods#Sieve series', '--json']).json();
  assert.equal(resolved.ok, true);
  assert.equal(resolved.path, 'Chambers/Lab/Analytical Methods.md');
  assert.equal(resolved.ghost, false);
  assert.equal(resolved.sectionMissing, true);
  assert.match(run(['--vault', root, 'vein', 'resolve', 'Chambers/Lab/Analytical Methods#Sieve series']).stdout, /no section #sieve-series/);

  // Put the heading back: the section link is healthy again (the sample's
  // unwritten Glossary is still a ghost, so the whole check stays red).
  fs.writeFileSync(methods, fs.readFileSync(methods, 'utf8').replace('## Sieve ladder', '## Sieve series'));
  const healed = run(['--vault', root, 'vault', 'doctor', '--json']).json().checks.find((entry) => entry.name === 'wiki links');
  assert.doesNotMatch(healed.detail, /Sieve series/);

  fs.rmSync(root, { recursive: true, force: true });
});

test('the CLI reads and edits a worldbuilding canvas, and its checkpoints', () => {
  const root = tempDir('world');
  assert.equal(run(['vault', 'create', root, '--sample']).code, 0);

  const shown = run(['--vault', root, 'world', 'show', 'Home.md', '--json']);
  assert.equal(shown.code, 0, shown.stderr);
  const canvas = shown.json();
  assert.equal(canvas.marked, true);
  assert.ok(canvas.cards.length > 5, 'the seeded board has its cards');
  assert.ok(canvas.groups.length > 0 && canvas.bonds.length > 0);
  assert.ok(canvas.checkpoints.undo >= 3, 'the seeded board keeps its tour checkpoints');
  const [first, second] = canvas.cards;

  const moved = run(['--vault', root, 'world', 'set', 'Home.md', '--patch', JSON.stringify({
    positions: {
      [first.anchor]: { x: 40, y: 20 },
      [second.anchor]: { x: 300, y: 20 },
    },
  })]);
  assert.equal(moved.code, 0, moved.stderr);
  assert.match(moved.stdout, /Moved 2 cards/);

  const after = run(['--vault', root, 'world', 'show', 'Home.md', '--json']).json();
  assert.deepEqual(after.cards.find((card) => card.anchor === first.anchor).position, { x: 40, y: 20 });
  // A patch merges: the cards it did not name keep the places they had.
  const untouched = after.cards.find((card) => (
    card.anchor !== first.anchor && card.anchor !== second.anchor && card.position
  ));
  assert.deepEqual(untouched.position, canvas.cards.find((card) => card.anchor === untouched.anchor).position);

  const checkpoints = run(['--vault', root, 'world', 'checkpoints', 'Home.md', '--json']).json();
  assert.deepEqual(checkpoints.past[0], { name: 'Moved 2 cards', stepsBack: 1 });

  const back = run(['--vault', root, 'world', 'jump', 'Home.md', '--back', '1', '--json']);
  assert.equal(back.code, 0, back.stderr);
  assert.equal(back.json().checkpoint, 'Moved 2 cards');
  const undone = run(['--vault', root, 'world', 'show', 'Home.md', '--json']).json();
  assert.notDeepEqual(undone.cards.find((card) => card.anchor === first.anchor).position, { x: 40, y: 20 });
  assert.equal(undone.checkpoints.redo, 1);

  assert.equal(run(['--vault', root, 'world', 'jump', 'Home.md', '--forward', '1']).code, 0);
  const redone = run(['--vault', root, 'world', 'show', 'Home.md', '--json']).json();
  assert.deepEqual(redone.cards.find((card) => card.anchor === first.anchor).position, { x: 40, y: 20 });

  // A patch is validated before anything is written.
  const badAnchor = run(['--vault', root, 'world', 'set', 'Home.md', '--patch', '{"positions":{"nope":{"x":0,"y":0}}}']);
  assert.equal(badAnchor.code, 1);
  assert.match(badAnchor.stderr, /no heading for: nope/);
  const badKind = run(['--vault', root, 'world', 'set', 'Home.md', '--patch', JSON.stringify({
    relations: { [`${first.anchor}->${second.anchor}`]: 'friendly' },
  })]);
  assert.equal(badKind.code, 1);
  assert.match(badKind.stderr, /unknown relationship kind/);
  const beyond = run(['--vault', root, 'world', 'jump', 'Home.md', '--back', '999']);
  assert.equal(beyond.code, 1);
  assert.match(beyond.stderr, /only 4 steps behind/);

  const list = run(['--vault', root, 'world', 'list', '--json']).json();
  assert.equal(list.boards.length, 1);
  assert.equal(list.boards[0].path, 'Home.md');

  // Viewer state is a merge, so setting lastPath cannot erase the canvases.
  assert.equal(run(['--vault', root, 'vault', 'state', 'set', '{"lastPath":"Home.md"}']).code, 0);
  const merged = run(['--vault', root, 'world', 'show', 'Home.md', '--json']).json();
  assert.equal(merged.cards.length, canvas.cards.length);
  assert.equal(run(['--vault', root, 'vault', 'state', '--json']).json().lastPath, 'Home.md');

  // Unmarking keeps the canvas, so marking it again restores the graph.
  assert.equal(run(['--vault', root, 'world', 'mark', 'Home.md', '--off', '--json']).json().marked, false);
  const kept = run(['--vault', root, 'world', 'show', 'Home.md', '--json']).json();
  assert.equal(kept.cards.length, canvas.cards.length);
  assert.equal(kept.marked, false);

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
