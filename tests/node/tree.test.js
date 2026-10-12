import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTree, sortNodes, findNode, flatten, veinPaths, ancestorPaths,
  filterTree, countVeins, chamberStats, pathBreadcrumbs, CHAMBER, VEIN,
} from '../../src/lib/tree.js';

const PATHS = [
  'Home.md',
  'Chambers/Fieldwork/Sampling Plan.md',
  'Chambers/Fieldwork/Macusanite Occurrence.md',
  'Chambers/Lab/Analytical Methods.md',
];

test('buildTree nests veins under their chambers', () => {
  const tree = buildTree(PATHS);
  assert.deepEqual(tree.map((n) => n.name), ['Chambers', 'Home.md']);
  assert.equal(tree[0].kind, CHAMBER);
  assert.equal(tree[1].kind, VEIN);
  assert.deepEqual(tree[0].children.map((n) => n.name), ['Fieldwork', 'Lab']);
  assert.deepEqual(tree[0].children[1].children.map((n) => n.path), ['Chambers/Lab/Analytical Methods.md']);
});

test('chambers sort before veins, alphabetically with numbers in order', () => {
  const tree = buildTree(['b.md', 'a.md', 'Zeta/x.md', 'alpha/y.md', 't10.md', 't2.md']);
  assert.deepEqual(tree.map((n) => n.name), ['alpha', 'Zeta', 'a.md', 'b.md', 't2.md', 't10.md']);
});

test('findNode, flatten and veinPaths walk the tree', () => {
  const tree = buildTree(PATHS);
  assert.equal(findNode(tree, 'Chambers/Lab').kind, CHAMBER);
  assert.equal(findNode(tree, 'Chambers/Lab/Analytical Methods.md').name, 'Analytical Methods.md');
  assert.equal(findNode(tree, 'nope'), null);
  // 2 chambers + Fieldwork + Lab + 4 veins
  assert.equal(flatten(tree).length, 7);
  assert.deepEqual(veinPaths(tree), [
    'Chambers/Fieldwork/Macusanite Occurrence.md',
    'Chambers/Fieldwork/Sampling Plan.md',
    'Chambers/Lab/Analytical Methods.md',
    'Home.md',
  ]);
});

test('filterTree keeps matches and their ancestors', () => {
  const tree = buildTree(PATHS);
  const filtered = filterTree(tree, 'sampling');
  assert.deepEqual(filtered.map((n) => n.name), ['Chambers']);
  assert.deepEqual(filtered[0].children.map((n) => n.name), ['Fieldwork']);
  assert.deepEqual(filtered[0].children[0].children.map((n) => n.name), ['Sampling Plan.md']);

  // A chamber-name match keeps the whole subtree.
  const byChamber = filterTree(tree, 'lab');
  assert.equal(byChamber[0].children.length, 1);
  assert.equal(byChamber[0].children[0].children.length, 1);

  assert.equal(filterTree(tree, ''), tree);
  assert.deepEqual(filterTree(tree, 'nothing-here'), []);
});

test('counts and per-chamber stats add up', () => {
  const tree = buildTree(PATHS);
  assert.equal(countVeins(tree), 4);
  assert.equal(countVeins([tree[0]]), 3, 'the vault root holds Home.md only');
  const stats = chamberStats(tree);
  assert.equal(stats.get('Chambers/Fieldwork'), 2);
  assert.equal(stats.get('Chambers/Lab'), 1);
});

test('ancestorPaths and breadcrumbs describe a location', () => {
  assert.deepEqual(ancestorPaths('a/b/c/Note.md'), ['a', 'a/b', 'a/b/c']);
  const crumbs = pathBreadcrumbs('Chambers/Lab/Analytical Methods.md');
  assert.deepEqual(crumbs.map((c) => c.label), ['Chambers', 'Lab', 'Analytical Methods.md']);
  assert.equal(crumbs[0].kind, CHAMBER);
  assert.equal(crumbs[2].kind, VEIN);
  assert.deepEqual(pathBreadcrumbs('Home.md').map((c) => c.path), ['Home.md']);
});

test('sortNodes is stable when called twice', () => {
  const tree = buildTree(PATHS);
  const once = JSON.stringify(sortNodes(tree));
  const twice = JSON.stringify(sortNodes(tree));
  assert.equal(once, twice);
});
