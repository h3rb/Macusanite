import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseWikiLinks, parseLinkBody, outgoingLinks, resolveTarget, parseTags, maskCode,
  linksToHeading, retitleSectionLinks, linksToFiles, retargetFileLinks,
} from '../../src/lib/wikilinks.js';
import { buildDocumentIndex } from '../../src/lib/graph.js';
import { indexBeforeMoves } from '../../src/lib/retitles.js';

const index = buildDocumentIndex({
  'Home.md': '# Home\n',
  'Chambers/Fieldwork/Macusanite Occurrence.md': '# Macusanite Occurrence\n',
  'Chambers/Fieldwork/Sampling Plan.md': '# Sampling Plan\n',
  'Chambers/Lab/Analytical Methods.md': '# Analytical Methods\n## Sieve series\n',
  'Chambers/Mineralogy/Fluid Inclusions.md': '---\naliases: [FI, bubble notes]\n---\n# Fluid Inclusions\n',
});

test('maskCode blanks fenced blocks and inline code but keeps offsets', () => {
  const source = 'a `[[x]]` b\n\n```\n[[y]]\n```\n\n[[z]]';
  const masked = maskCode(source);
  assert.equal(masked.length, source.length);
  assert.equal(masked.includes('[[x]]'), false);
  assert.equal(masked.includes('[[y]]'), false);
  assert.equal(masked.includes('[[z]]'), true);
});

test('links inside code never become wiki links', () => {
  const links = parseWikiLinks('`[[not a link]]`\n\n```md\n[[also not]]\n```\n\n[[real]]');
  assert.deepEqual(links.map((l) => l.target), ['real']);
});

test('parseLinkBody understands aliases, sections and same-page links', () => {
  assert.deepEqual(
    { ...parseLinkBody('Analytical Methods|the methods'), raw: undefined },
    { target: 'Analytical Methods', section: '', alias: 'the methods', raw: undefined, samePage: false, anchor: '' },
  );
  const sectioned = parseLinkBody('Fluid Inclusions#What they record');
  assert.equal(sectioned.target, 'Fluid Inclusions');
  assert.equal(sectioned.section, 'What they record');
  assert.equal(sectioned.anchor, 'what-they-record');

  const local = parseLinkBody('#Field checklist');
  assert.equal(local.samePage, true);
  assert.equal(local.anchor, 'field-checklist');
});

test('embeds are flagged', () => {
  const [embed] = parseWikiLinks('![[Sampling Plan]]');
  assert.equal(embed.embed, true);
  assert.equal(embed.target, 'Sampling Plan');
});

test('outgoingLinks de-duplicates repeated targets', () => {
  const links = outgoingLinks('[[A]] and [[A]] then [[B#two]]');
  assert.deepEqual(links.map((l) => `${l.target}#${l.section}`), ['A#', 'B#two']);
});

test('resolution prefers the same chamber, then the shallowest match', () => {
  const fromFieldwork = resolveTarget(
    { target: 'Sampling Plan', section: '', samePage: false, anchor: '' },
    'Chambers/Fieldwork/Macusanite Occurrence.md',
    index,
  );
  assert.equal(fromFieldwork.ok, true);
  assert.equal(fromFieldwork.path, 'Chambers/Fieldwork/Sampling Plan.md');

  const byPath = resolveTarget(
    { target: 'Chambers/Lab/Analytical Methods', section: '', samePage: false, anchor: '' },
    'Home.md',
    index,
  );
  assert.equal(byPath.path, 'Chambers/Lab/Analytical Methods.md');

  const byStem = resolveTarget(
    { target: 'Analytical Methods.md', section: '', samePage: false, anchor: '' },
    'Home.md',
    index,
  );
  assert.equal(byStem.path, 'Chambers/Lab/Analytical Methods.md');
});

test('resolution falls back to front-matter aliases', () => {
  const viaAlias = resolveTarget(
    { target: 'bubble notes', section: '', samePage: false, anchor: '' },
    'Home.md',
    index,
  );
  assert.equal(viaAlias.ok, true);
  assert.equal(viaAlias.path, 'Chambers/Mineralogy/Fluid Inclusions.md');
});

test('an unwritten target is a ghost with a suggested path', () => {
  const ghost = resolveTarget(
    { target: 'Glossary', section: '', samePage: false, anchor: '' },
    'Chambers/Lab/Analytical Methods.md',
    index,
  );
  assert.equal(ghost.ok, false);
  assert.equal(ghost.ghost, true);
  assert.equal(ghost.suggestedPath, 'Chambers/Lab/Glossary.md');
});

test('slugified headings stay reachable through section links', () => {
  const doc = index.find((d) => d.path === 'Chambers/Lab/Analytical Methods.md');
  assert.deepEqual(doc.headings.map((h) => h.anchor), ['analytical-methods', 'sieve-series']);
});

test('linksToHeading finds the links that name one heading of one vein', () => {
  const text = [
    'See [[Analytical Methods#Sieve series]], [[Chambers/Lab/Analytical Methods#Sieve series|the sieves]]',
    'and ![[Analytical Methods#Sieve series|the embeds]].',
    '',
    'Elsewhere: [[Sampling Plan#Sieve series]], [[Analytical Methods#Other]], [[Analytical Methods#^block]]',
    'and [[#Sieve series]].',
  ].join('\n');
  const links = parseWikiLinks(text);
  const hits = linksToHeading(links, {
    fromPath: 'Home.md',
    index,
    path: 'Chambers/Lab/Analytical Methods.md',
    anchor: 'sieve-series',
  });
  // The plain link, the one written as a full path and the embed: all three name
  // the same heading. Another vein's heading, another heading of this one, a
  // block reference and a same-page link are not that heading.
  assert.deepEqual(hits.map((link) => link.target), [
    'Analytical Methods', 'Chambers/Lab/Analytical Methods', 'Analytical Methods',
  ]);
  assert.equal(linksToHeading(links, { fromPath: 'Home.md', index, path: '', anchor: 'sieve-series' }).length, 0);
  assert.equal(linksToHeading(links, { fromPath: 'Home.md', index, path: 'Chambers/Lab/Analytical Methods.md', anchor: '' }).length, 0);
});

test('retitleSectionLinks points the named links at a new title', () => {
  const text = [
    'See [[Analytical Methods#Sieve series]], [[Analytical Methods#Sieve series|the sieves]] and ![[Analytical Methods#Sieve series|the embeds]].',
    '',
    '```md',
    '[[Analytical Methods#Sieve series]]',
    '```',
  ].join('\n');
  const hits = linksToHeading(parseWikiLinks(text), {
    fromPath: 'Home.md',
    index,
    path: 'Chambers/Lab/Analytical Methods.md',
    anchor: 'sieve-series',
  });
  const retitled = retitleSectionLinks(text, hits, 'Sieve ladder');
  assert.equal(retitled.rewritten, 3);
  assert.equal(retitled.text, [
    'See [[Analytical Methods#Sieve ladder]], [[Analytical Methods#Sieve ladder|the sieves]] and ![[Analytical Methods#Sieve ladder|the embeds]].',
    '',
    '```md',
    '[[Analytical Methods#Sieve series]]',
    '```',
  ].join('\n'));
  // A title that cannot be written inside brackets leaves the prose alone rather
  // than writing markdown that would not read back.
  assert.deepEqual(retitleSectionLinks(text, hits, 'Sieve | ladder'), { text, rewritten: 0 });
  assert.deepEqual(retitleSectionLinks(text, [], 'Sieve ladder'), { text, rewritten: 0 });
});

test('a renamed vein takes the links that named it, however they were written', () => {
  const home = [
    'See [[Analytical Methods]], [[Chambers/Lab/Analytical Methods#Sieve series|the sieves]] and [[Sampling Plan]].',
    '',
    '```md',
    '[[Analytical Methods]]',
    '```',
  ].join('\n');
  const move = { from: 'Chambers/Lab/Analytical Methods.md', to: 'Chambers/Lab/Sieve Methods.md' };
  const after = buildDocumentIndex({
    'Home.md': home,
    'Chambers/Lab/Sieve Methods.md': '# Analytical Methods\n## Sieve series\n',
    'Chambers/Fieldwork/Sampling Plan.md': '# Sampling Plan\n',
  });
  const before = indexBeforeMoves(after, [move]);
  const hits = linksToFiles(parseWikiLinks(home), { fromPath: 'Home.md', index: before, moves: [move] });
  assert.deepEqual(hits.map((hit) => hit.target), [
    'Analytical Methods', 'Chambers/Lab/Analytical Methods',
  ]);
  assert.deepEqual(hits.map((hit) => hit.to), [move.to, move.to]);
  // The index's own link list carries the start offset but no end; it is enough
  // to decide whether a vein is worth reading, which is all the viewer asks it.
  assert.equal(
    linksToFiles(after.find((doc) => doc.path === 'Home.md').links, {
      fromPath: 'Home.md', index: before, moves: [move],
    }).length,
    2,
  );

  const retargeted = retargetFileLinks(home, hits, { index: after, fromPath: 'Home.md' });
  assert.equal(retargeted.rewritten, 2);
  assert.equal(retargeted.text, [
    'See [[Sieve Methods]], [[Chambers/Lab/Sieve Methods#Sieve series|the sieves]] and [[Sampling Plan]].',
    '',
    '```md',
    '[[Analytical Methods]]',
    '```',
  ].join('\n'));
});

test('a chamber move rewrites what broke and leaves every link that still opens', () => {
  const home = '[[Analytical Methods]], [[Chambers/Lab/Analytical Methods#Sieve series]] and ![[Chambers/Lab/Analytical Methods]]';
  const move = { from: 'Chambers/Lab/Analytical Methods.md', to: 'Chambers/Methods/Analytical Methods.md' };
  const after = buildDocumentIndex({
    'Home.md': home,
    'Chambers/Methods/Analytical Methods.md': '# Analytical Methods\n## Sieve series\n',
  });
  const before = indexBeforeMoves(after, [move]);
  const hits = linksToFiles(parseWikiLinks(home), { fromPath: 'Home.md', index: before, moves: [move] });
  assert.equal(hits.length, 3);
  const retargeted = retargetFileLinks(home, hits, { index: after, fromPath: 'Home.md' });
  // The bare name still finds the vein where it landed; the two full paths did not.
  assert.equal(retargeted.rewritten, 2);
  assert.equal(
    retargeted.text,
    '[[Analytical Methods]], [[Chambers/Methods/Analytical Methods#Sieve series]] and ![[Chambers/Methods/Analytical Methods]]',
  );

  // A link that still resolves through a front-matter alias is content the move
  // did not touch, and is left exactly as written.
  const aliased = buildDocumentIndex({
    'Home.md': '[[FI]] and [[Chambers/Mineralogy/Fluid Inclusions]]',
    'Chambers/Mineralogy/Fluid Traps.md': '---\naliases: [FI]\n---\n# Fluid Inclusions\n',
  });
  const fluid = { from: 'Chambers/Mineralogy/Fluid Inclusions.md', to: 'Chambers/Mineralogy/Fluid Traps.md' };
  const fluidBefore = indexBeforeMoves(aliased, [fluid]);
  const fluidHits = linksToFiles(parseWikiLinks('[[FI]] and [[Chambers/Mineralogy/Fluid Inclusions]]'), {
    fromPath: 'Home.md', index: fluidBefore, moves: [fluid],
  });
  const fluidRetargeted = retargetFileLinks('[[FI]] and [[Chambers/Mineralogy/Fluid Inclusions]]', fluidHits, {
    index: aliased, fromPath: 'Home.md',
  });
  assert.equal(fluidRetargeted.rewritten, 1);
  assert.equal(fluidRetargeted.text, '[[FI]] and [[Chambers/Mineralogy/Fluid Traps]]');
});

test('a bare new name that would resolve elsewhere falls back to the full path', () => {
  const home = 'See [[Analytical Methods]].';
  const move = { from: 'Chambers/Lab/Analytical Methods.md', to: 'Chambers/Lab/Methods.md' };
  const after = buildDocumentIndex({
    'Home.md': home,
    // A shallower vein of that name: `[[Methods]]` would stop finding the moved one.
    'Methods.md': '# Methods\n',
    'Chambers/Lab/Methods.md': '# Analytical Methods\n',
  });
  const hits = linksToFiles(parseWikiLinks(home), {
    fromPath: 'Home.md', index: indexBeforeMoves(after, [move]), moves: [move],
  });
  const retargeted = retargetFileLinks(home, hits, { index: after, fromPath: 'Home.md' });
  assert.equal(retargeted.text, 'See [[Chambers/Lab/Methods]].');
  // A name that cannot be written between brackets leaves the link alone.
  assert.deepEqual(
    retargetFileLinks('[[Old]]', [{ target: 'Old', start: 0, end: 7, to: 'New | Name.md' }], { index: after }),
    { text: '[[Old]]', rewritten: 0 },
  );
});

test('parseTags finds tags in prose but ignores headings and code', () => {
  const tags = parseTags('# Heading\n\nabout #petrology and #geochemistry/lab\n\n`#notatag`\n');
  assert.deepEqual(tags.sort(), ['geochemistry/lab', 'petrology']);
});
