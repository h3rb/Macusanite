import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CACHE_VERSION, stubEntry, isStub, parseCache, serializeCache, cacheRecord,
  planIndex, assembleIndex, createIndex,
} from '../../src/lib/indexCache.js';

/** A cached entry, as `buildDocumentIndex` would have produced it. */
const entryFor = (path, extra = {}) => ({
  path,
  stem: path.split('/').pop().replace(/\.(md|markdown|mdx)$/i, ''),
  title: 'Notes',
  aliases: ['Notes'],
  tags: ['field'],
  headings: [{ level: 1, text: 'Notes', anchor: 'notes' }],
  links: [{ target: 'Home', section: '', alias: null, embed: false, start: 0 }],
  color: '#ffd700',
  linkColor: null,
  sectionColor: null,
  depth: path.split('/').length - 1,
  chamber: path.split('/').slice(0, -1).join('/'),
  indexed: true,
  ...extra,
});

const statFor = (path, mtime = 1000, size = 40) => ({ path, mtime, size });

test('a stub carries only what the path alone can say', () => {
  const stub = stubEntry('Chambers/Fieldwork/Field Notes.md');
  assert.equal(stub.title, 'Field Notes');
  assert.equal(stub.stem, 'Field Notes');
  assert.deepEqual(stub.aliases, ['Field Notes']);
  assert.equal(stub.chamber, 'Chambers/Fieldwork');
  assert.equal(stub.depth, 2);
  // Nothing that only the file could tell us.
  assert.deepEqual(stub.headings, []);
  assert.deepEqual(stub.links, []);
  assert.deepEqual(stub.tags, []);
  assert.equal(stub.color, null);
  assert.equal(stub.indexed, false);
  assert.equal(isStub(stub), true);
  assert.equal(isStub(entryFor('Home.md')), false);
});

test('the cache round-trips, and forgets anything it does not recognise', () => {
  const records = { 'Home.md': cacheRecord(statFor('Home.md'), entryFor('Home.md')) };
  const parsed = parseCache(serializeCache(records, { generated: '2026-10-11T00:00:00.000Z' }));
  assert.equal(parsed.version, CACHE_VERSION);
  assert.deepEqual(Object.keys(parsed.entries), ['Home.md']);
  assert.equal(parsed.entries['Home.md'].mtime, 1000);
  assert.equal(parsed.entries['Home.md'].entry.title, 'Notes');

  // A missing file, a different version and a truncated write all mean "no cache".
  assert.deepEqual(parseCache(null).entries, {});
  assert.deepEqual(parseCache('').entries, {});
  assert.deepEqual(parseCache('{ not json').entries, {});
  assert.deepEqual(parseCache(JSON.stringify({ version: 99, entries: { 'Home.md': {} } })).entries, {});
  assert.deepEqual(parseCache(JSON.stringify({ version: CACHE_VERSION })).entries, {});
  assert.deepEqual(parseCache(JSON.stringify({ version: CACHE_VERSION, entries: null })).entries, {});
});

test('a vein that has not moved comes straight from the cache', () => {
  const stats = [statFor('Chambers/Lab/Methods.md', 555, 120), statFor('Home.md', 1000, 40)];
  const cache = {
    entries: {
      'Chambers/Lab/Methods.md': cacheRecord(statFor('Chambers/Lab/Methods.md', 555, 120), entryFor('Chambers/Lab/Methods.md')),
      'Home.md': cacheRecord(statFor('Home.md'), entryFor('Home.md')),
    },
  };
  const plan = planIndex({ stats, cache });

  assert.deepEqual(plan.toRead, [], 'nothing has to be opened');
  assert.deepEqual(plan.removed, []);
  assert.equal(plan.clean, true);
  assert.equal(plan.index.length, 2);
  assert.deepEqual(plan.index.map((doc) => doc.path), ['Chambers/Lab/Methods.md', 'Home.md']);
  // The cached entry keeps its headings, links and tags — that is the point.
  assert.equal(plan.index[0].headings.length, 1);
  assert.equal(plan.index[0].links.length, 1);
  assert.deepEqual(plan.index[0].tags, ['field']);
  assert.equal(plan.index[0].indexed, true);
});

test('a vein that moved, changed size or just arrived has to be read', () => {
  const stats = [
    statFor('Home.md', 2000, 40),            // mtime moved
    statFor('Edited.md', 1000, 99),          // size changed
    statFor('New.md', 1000, 40),             // no cache entry at all
    statFor('Same.md', 1000, 40),
  ];
  const cache = {
    entries: {
      // A resize inside one clock tick still has to be noticed: size is the tell.
      'Home.md': cacheRecord(statFor('Home.md'), entryFor('Home.md')),
      'Edited.md': cacheRecord(statFor('Edited.md'), entryFor('Edited.md')),
      'Same.md': cacheRecord(statFor('Same.md'), entryFor('Same.md')),
      'Gone.md': cacheRecord(statFor('Gone.md'), entryFor('Gone.md')),
    },
  };
  const plan = planIndex({ stats, cache });

  assert.deepEqual(plan.toRead, ['Home.md', 'Edited.md', 'New.md']);
  assert.deepEqual(plan.removed, ['Gone.md']);
  assert.equal(plan.clean, false);
  // Whatever is not read yet is a stub: the tree and the graph still render.
  assert.deepEqual(plan.index.map((doc) => [doc.path, doc.indexed]), [
    ['Edited.md', false],
    ['Home.md', false],
    ['New.md', false],
    ['Same.md', true],
  ]);
  assert.equal(plan.stats.get('Home.md').size, 40);
});

test('the open vein is read first, and a vault of any size plans without reading', () => {
  const stats = [statFor('a.md'), statFor('b.md'), statFor('Chambers/Zed.md')];
  const plan = planIndex({ stats, cache: null, priority: 'Chambers/Zed.md' });
  assert.deepEqual(plan.toRead, ['Chambers/Zed.md', 'a.md', 'b.md']);
  // A priority that no longer exists is simply ignored.
  assert.deepEqual(planIndex({ stats, cache: null, priority: 'gone.md' }).toRead, ['a.md', 'b.md', 'Chambers/Zed.md']);

  // 5,000 veins, every one of them cached: opening reads nothing at all.
  const many = Array.from({ length: 5000 }, (_, i) => statFor(`Chambers/Note ${i}.md`, 1000 + i, 100 + i));
  const bigCache = { entries: Object.fromEntries(many.map((stat) => [stat.path, cacheRecord(stat, entryFor(stat.path))])) };
  const warm = planIndex({ stats: many, cache: bigCache });
  assert.deepEqual(warm.toRead, []);
  assert.equal(warm.clean, true);
  assert.equal(warm.index.length, 5000);

  // Drop the cache and the same vault is planned cold, still without reading.
  const cold = planIndex({ stats: many, cache: null });
  assert.equal(cold.toRead.length, 5000);
  assert.equal(cold.index.length, 5000);
  assert.equal(cold.index.every(isStub), true);
  assert.deepEqual(assembleIndex(many).length, 5000);
});

test('the live index stays path-sorted as entries arrive', () => {
  const index = createIndex([stubEntry('b.md'), stubEntry('d.md')]);
  assert.deepEqual(index.list.map((d) => d.path), ['b.md', 'd.md']);
  assert.equal(index.indexed, 0);
  assert.equal(index.total, 2);

  // Replacing a stub in place keeps the order and counts the vein as indexed.
  index.replace(entryFor('b.md'));
  assert.deepEqual(index.list.map((d) => d.path), ['b.md', 'd.md']);
  assert.equal(index.indexed, 1);

  // A vein discovered later lands in its sorted place.
  index.replace(stubEntry('c.md'));
  index.replace(entryFor('a.md'));
  assert.deepEqual(index.list.map((d) => d.path), ['a.md', 'b.md', 'c.md', 'd.md']);
  assert.equal(index.indexed, 2);
  assert.equal(index.find('c.md').indexed, false);
  assert.equal(index.find('nope.md'), null);

  // Re-reading a vein that is already indexed does not double-count it.
  index.replace(entryFor('b.md', { title: 'Again' }));
  assert.equal(index.indexed, 2);
  assert.equal(index.find('b.md').title, 'Again');

  // Removed veins leave the list.
  assert.equal(index.drop(['a.md', 'nope.md']), 1);
  assert.deepEqual(index.list.map((d) => d.path), ['b.md', 'c.md', 'd.md']);
  assert.equal(index.indexed, 1);
  assert.equal(index.drop([]), 0);
});
