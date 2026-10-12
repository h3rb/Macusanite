import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PALETTE, X11_COLORS, normalizeColor, isValidColor, hexToRgb, rgbToHex,
  mix, withAlpha, luminance, contrastColor, nearestX11Name, linkGradient,
} from '../../src/lib/colors.js';

test('normalizeColor accepts hex, rgb() and X11 names', () => {
  assert.equal(normalizeColor('#FFF'), '#ffffff');
  assert.equal(normalizeColor('#ff8c00'), '#ff8c00');
  assert.equal(normalizeColor('rgb(255, 140, 0)'), '#ff8c00');
  assert.equal(normalizeColor('Coral'), '#ff7f50');
  assert.equal(normalizeColor('coral'), '#ff7f50');
  assert.equal(normalizeColor('white'), '#ffffff');
  assert.equal(normalizeColor('not-a-colour'), null);
  assert.equal(normalizeColor(''), null);
  assert.equal(isValidColor('SlateBlue'), true);
  assert.equal(isValidColor('#12345'), false);
});

test('rgb round trips and channels clamp', () => {
  assert.deepEqual(hexToRgb('#ff8c00'), { r: 255, g: 140, b: 0 });
  assert.equal(rgbToHex(255, 140, 0), '#ff8c00');
  assert.equal(rgbToHex(300, -20, 12), '#ff000c');
});

test('mix interpolates and clamps its ratio', () => {
  assert.equal(mix('#000000', '#ffffff', 0), '#000000');
  assert.equal(mix('#000000', '#ffffff', 1), '#ffffff');
  assert.equal(mix('#000000', '#ffffff', 0.5), '#808080');
  assert.equal(mix('#000000', '#ffffff', 2), '#ffffff');
});

test('withAlpha emits rgba()', () => {
  assert.equal(withAlpha('#ff0000', 0.25), 'rgba(255, 0, 0, 0.25)');
});

test('contrast picks readable text for light and dark colours', () => {
  assert.equal(contrastColor('#ffffff'), '#101418');
  assert.equal(contrastColor('#000000'), '#f2f5f8');
  assert.ok(luminance('#ffffff') > luminance('#808080'));
});

test('nearestX11Name names a colour', () => {
  assert.equal(nearestX11Name('#ff7f50'), 'Coral');
  // Snow (#fffafa) is the closest X11 name to pure white, not AliceBlue.
  assert.equal(nearestX11Name('#ffffff'), 'Snow');
  assert.equal(nearestX11Name('#ffd700'), 'Gold');
});

test('linkGradient fades from source to target colour', () => {
  const stops = linkGradient('#000000', '#ffffff', 5);
  assert.equal(stops.length, 5);
  assert.deepEqual(stops, ['#000000', '#404040', '#808080', '#bfbfbf', '#ffffff']);
});

test('the palettes are well formed', () => {
  assert.ok(PALETTE.length >= 40);
  assert.ok(PALETTE.every((c) => isValidColor(c)));
  assert.ok(Object.keys(X11_COLORS).length >= 100);
  assert.ok(Object.values(X11_COLORS).every((c) => isValidColor(c)));
});
