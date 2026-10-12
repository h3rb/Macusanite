import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseWikiLinks, parseLinkBody, outgoingLinks, resolveTarget, parseTags, maskCode,
} from '../../src/lib/wikilinks.js';
import { buildDocumentIndex } from '../../src/lib/graph.js';

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

test('parseTags finds tags in prose but ignores headings and code', () => {
  const tags = parseTags('# Heading\n\nabout #petrology and #geochemistry/lab\n\n`#notatag`\n');
  assert.deepEqual(tags.sort(), ['geochemistry/lab', 'petrology']);
});
