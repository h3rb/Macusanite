import test from 'node:test';
import assert from 'node:assert/strict';
import {
  tokenize, matchText, findMatches, plainText, buildSearchCorpus,
  scoreDocument, buildSnippet, searchVault,
} from '../../src/lib/search.js';

/** A tiny vault: one vein whose *body* mentions sieves, one that is about them. */
const VAULT = {
  'Chambers/Lab/Analytical Methods.md': [
    '---',
    'title: Analytical Methods',
    'tags: [lab, procedure]',
    '---',
    '# Analytical Methods',
    '',
    'Every sample is sieved before it is weighed.',
    '',
    '## Sieve series',
    '',
    'The sieve series runs 63 µm to 2 mm. The sieve series is logged per sample.',
    '',
    '## Weighing',
    '',
    'A balance is used after sieving.',
  ].join('\n'),
  'Chambers/Fieldwork/Sampling Plan.md': [
    '---',
    'title: Sampling Plan',
    '---',
    '# Sampling Plan',
    '',
    'Collect a sieve series from every lens.',
  ].join('\n'),
  'Chambers/Mineralogy/Fluid Inclusions.md': [
    '# Fluid Inclusions',
    '',
    'Bubbles in the glass. Nothing about screens or granulometry here.',
  ].join('\n'),
  'Home.md': [
    '---',
    'title: Macusanite',
    '---',
    '# Welcome',
    '',
    'Start at [[Analytical Methods|the methods]], then the [[Sampling Plan]].',
  ].join('\n'),
};

const INDEX = Object.keys(VAULT).map((path) => ({
  path,
  title: path === 'Home.md'
    ? 'Macusanite'
    : path.split('/').pop().replace(/\.md$/, ''),
  tags: path.includes('Analytical') ? ['lab', 'procedure'] : [],
  headings: path.includes('Analytical')
    ? [
      { level: 1, text: 'Analytical Methods', anchor: 'analytical-methods' },
      { level: 2, text: 'Sieve series', anchor: 'sieve-series' },
      { level: 2, text: 'Weighing', anchor: 'weighing' },
    ]
    : [],
}));

const CORPUS = buildSearchCorpus({ index: INDEX, bodies: VAULT });
const search = (query) => searchVault({ docs: CORPUS, query });

test('tokenize keeps quoted runs together and lowercases terms', () => {
  assert.deepEqual(tokenize('Sieve series').map((t) => t.lower), ['sieve', 'series']);
  assert.deepEqual(tokenize('"sieve series" µm').map((t) => [t.lower, t.phrase]), [
    ['sieve series', true],
    ['µm', false],
  ]);
  assert.deepEqual(tokenize('   '), []);
  assert.deepEqual(tokenize(''), []);
});

test('matchText reports count, first index and how good the hit is', () => {
  const hit = matchText('The sieve series is logged', { lower: 'sieve' });
  assert.equal(hit.count, 1);
  assert.equal(hit.first, 4);
  assert.equal(matchText('nothing here', { lower: 'sieve' }), null);
  assert.equal(matchText('', { lower: 'sieve' }), null);
  // exact and prefix hits outrank a hit buried in a longer word
  assert.ok(matchText('Sieve', { lower: 'sieve' }).quality > matchText('sieve series', { lower: 'sieve' }).quality);
  assert.ok(matchText('sieve series', { lower: 'sieve' }).quality > matchText('sieves', { lower: 'sieve' }).quality);
});

test('findMatches sorts, merges overlaps and stays case-insensitive', () => {
  const terms = tokenize('sieve series');
  assert.deepEqual(findMatches('a sieve series here', terms), [[2, 7], [8, 14]]);
  // a term inside a previous match does not produce a second, overlapping mark
  assert.deepEqual(findMatches('sieve', tokenize('"sieve" ieve')), [[0, 5]]);
  assert.deepEqual(findMatches('nothing', terms), []);
  assert.deepEqual(findMatches('', terms), []);
});

test('plainText strips the markdown a reader never sees', () => {
  const text = plainText([
    '---',
    'title: Hidden',
    '---',
    '# Heading',
    '',
    '> quoted',
    '',
    '* item one',
    '',
    'A `code` span and **bold** text with [[Analytical Methods|the methods]] and [a link](http://x/y).',
    '',
    '```js',
    'const fenced = true;',
    '```',
  ].join('\n'));
  assert.ok(!text.includes('title: Hidden'));
  assert.ok(!text.includes('const fenced'));
  assert.ok(text.includes('the methods'));
  assert.ok(text.includes('A code span and bold text'));
  assert.ok(!text.includes('**'));
  assert.ok(!text.includes('http://x/y'));
});

test('a title match beats a heading match, which beats body noise', () => {
  const results = search('sieve series');
  const paths = results.results.map((r) => r.path);
  // Both veins mention it; the one with it as a *heading* should come first.
  assert.deepEqual(paths, [
    'Chambers/Lab/Analytical Methods.md',
    'Chambers/Fieldwork/Sampling Plan.md',
  ]);
  const [top, next] = results.results;
  assert.ok(top.score > next.score);
  assert.equal(top.fields.heading, 2);
  assert.ok(top.headingMatches.some((h) => h.anchor === 'sieve-series'));
  assert.equal(next.fields.title, 0);
  assert.equal(next.fields.body, 2);
});

test('every term has to appear somewhere, and an exact title wins outright', () => {
  assert.equal(search('sieve granulometry').total, 0);
  assert.equal(search('sieve nonexistentword').total, 0);
  const exact = search('Analytical Methods');
  assert.equal(exact.results[0].path, 'Chambers/Lab/Analytical Methods.md');
  // both words landed in the title, and the exact-title bonus is in there
  assert.equal(exact.results[0].fields.title, 2);
  assert.ok(exact.results[0].score > 600);
});

test('only veins that match come back, ordered by score then path', () => {
  const results = search('sieve');
  assert.equal(results.total, 2);
  assert.equal(results.scanned, 4);
  assert.ok(!results.results.some((r) => r.path.includes('Fluid Inclusions')));
  assert.ok(!results.results.some((r) => r.path === 'Home.md'));
  // ties fall back to the path, so the order is stable
  const tied = searchVault({ docs: CORPUS, query: 'sieved' });
  assert.deepEqual(tied.results.map((r) => r.path), ['Chambers/Lab/Analytical Methods.md']);
});

test('a phrase beats the same words scattered, and quoting means adjacent', () => {
  const docs = [
    { path: 'Together.md', title: 'Together', headings: [], tags: [], text: 'A sieve series is logged per sample.', clean: 'A sieve series is logged per sample.' },
    { path: 'Scattered.md', title: 'Scattered', headings: [], tags: [], text: 'A series of samples, and much later, a sieve.', clean: 'A series of samples, and much later, a sieve.' },
  ];
  const loose = searchVault({ docs, query: 'sieve series' });
  assert.deepEqual(loose.results.map((r) => r.path), ['Together.md', 'Scattered.md']);
  // Quoting is stricter than two loose words: the words must be adjacent.
  const quoted = searchVault({ docs, query: '"sieve series"' });
  assert.deepEqual(quoted.results.map((r) => r.path), ['Together.md']);
});

test('tags are searchable but rank below a heading', () => {
  const results = search('procedure');
  assert.equal(results.total, 1);
  assert.equal(results.results[0].path, 'Chambers/Lab/Analytical Methods.md');
  assert.equal(results.results[0].fields.tag, 1);
  // …and the way tags are written on the page works too
  const hashed = search('#lab');
  assert.equal(hashed.total, 1);
  assert.equal(hashed.results[0].fields.tag, 1);
});

test('snippets carry the ranges to mark up', () => {
  const long = `${'Filler words. '.repeat(30)}the sieve series matters here. ${'More filler. '.repeat(30)}`;
  const snippet = buildSnippet(plainText(long), tokenize('sieve series'));
  assert.equal(snippet.truncated, true);
  assert.ok(snippet.text.startsWith('…'));
  assert.ok(snippet.text.includes('sieve series'));
  // Two loose words mark twice (adjacent marks read the same as one), so the
  // snippet shows exactly what the reader typed without merging their words.
  const marked = snippet.ranges.map(([s, e]) => snippet.text.slice(s, e));
  assert.deepEqual(marked, ['sieve', 'series']);
  const quoted = buildSnippet(plainText(long), tokenize('"sieve series"'));
  assert.deepEqual(quoted.ranges.map(([s, e]) => quoted.text.slice(s, e)), ['sieve series']);
  assert.equal(buildSnippet('nothing to see', tokenize('sieve')), null);
  assert.equal(buildSnippet('', tokenize('sieve')), null);
});

test('searchVault copes with an empty query and an empty vault', () => {
  const empty = search('');
  assert.deepEqual(empty.results, []);
  assert.equal(empty.total, 0);
  assert.equal(empty.scanned, 4);
  assert.deepEqual(searchVault({ docs: [], query: 'sieve' }).results, []);
  assert.equal(searchVault({ docs: [], query: 'sieve' }).scanned, 0);
});

test('the result list is capped but the total is not hidden', () => {
  const docs = Array.from({ length: 12 }, (_, i) => ({
    path: `Note ${i}.md`,
    title: `Note ${i}`,
    headings: [],
    tags: [],
    text: 'sieve',
    clean: 'sieve',
  }));
  const results = searchVault({ docs, query: 'sieve', limit: 5 });
  assert.equal(results.results.length, 5);
  assert.equal(results.total, 12);
});
