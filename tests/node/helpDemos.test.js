/**
 * The animated help demos: every feature section must declare a demo kind,
 * every kind must generate the same baked-in HTML figure, and every figure
 * must actually animate (and carry a caption for screen readers).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { FEATURES } from '../../src/lib/helpDoc.js';
import { DEMO_KINDS, demoHtml } from '../../src/lib/helpDemos.js';

test('every feature section declares a demo the generator knows', () => {
  for (const feature of FEATURES) {
    assert.ok(feature.demo, `${feature.slug} declares no demo`);
    assert.ok(DEMO_KINDS.includes(feature.demo), `${feature.slug} names unknown demo ${feature.demo}`);
    assert.ok(demoHtml(feature.demo), `${feature.slug} generates no figure`);
  }
});

test('every demo kind bakes in the same figure, animated, with a caption', () => {
  assert.ok(DEMO_KINDS.length >= FEATURES.length, 'more demos than features');
  for (const kind of DEMO_KINDS) {
    const html = demoHtml(kind);
    assert.equal(demoHtml(kind), html, `${kind} is not deterministic`);
    assert.match(html, /<figure class="help-demo" data-demo="/, `${kind} is not a help-demo figure`);
    assert.match(html, /<figcaption class="help-demo-caption">[^<]+<\/figcaption>/, `${kind} has no caption`);
    assert.match(html, /animation-delay|class="help-demo-(node|pane|line|edge|card|key|swatch|orbit|fill|index-fill|download-fill|undo-after|undo-before|live|watch-line|result|box|term-line)/, `${kind} does not animate`);
  }
  assert.equal(demoHtml('no-such-demo'), '', 'unknown kinds bake in nothing');
});
