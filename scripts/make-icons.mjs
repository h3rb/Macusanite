#!/usr/bin/env node
/**
 * Generates `assets/icon-source.png` (1024×1024) and lets the Tauri CLI derive
 * every platform icon from it.
 *
 * The PNG is written by hand — zlib for the pixel data, a CRC table for the
 * chunks — so icon generation needs no image library and works offline.
 *
 *   node scripts/make-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE = 1024;
const SS = 3; // supersampling factor for antialiased edges

/* ── a minimal PNG encoder ─────────────────────────────────────────────── */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour + alpha
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0; // filter: none
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ── the artwork: a faceted macusanite crystal ─────────────────────────── */

const hex = (value) => [
  parseInt(value.slice(1, 3), 16),
  parseInt(value.slice(3, 5), 16),
  parseInt(value.slice(5, 7), 16),
];

const BG_TOP = hex('#182029');
const BG_BOTTOM = hex('#0b1016');
const FACET_MAIN = hex('#ffd166');
const FACET_LIGHT = hex('#fff2c4');
const FACET_DARK = hex('#d99a20');
const FACET_DEEP = hex('#8c6410');
const RIM = hex('#4c8fd6');

const mixRgb = (a, b, t) => a.map((c, i) => c + (b[i] - c) * t);

/** Points of the gem, in 0..1 space, then scaled by SIZE. */
const TOP_Y = 0.3;
const SHOULDER_Y = 0.42;
const BOTTOM_Y = 0.78;
const LEFT_X = 0.24;
const RIGHT_X = 0.76;
const TABLE_LEFT = 0.38;
const TABLE_RIGHT = 0.62;

function pixelColor(x, y) {
  // Background: rounded square with a vertical gradient.
  const inset = 0.055;
  const radius = 0.19;
  const inRounded = (() => {
    const min = inset;
    const max = 1 - inset;
    if (x < min || x > max || y < min || y > max) return false;
    const cx = Math.min(Math.max(x, min + radius), max - radius);
    const cy = Math.min(Math.max(y, min + radius), max - radius);
    return Math.hypot(x - cx, y - cy) <= radius;
  })();
  if (!inRounded) return [0, 0, 0, 0];

  let color = mixRgb(BG_TOP, BG_BOTTOM, (y - inset) / (1 - 2 * inset));

  // Gem shape: crown (trapezoid) + pavilion (triangle).
  const inCrown = y >= TOP_Y && y <= SHOULDER_Y && x >= LEFT_X && x <= RIGHT_X;
  const pavilionT = (y - SHOULDER_Y) / (BOTTOM_Y - SHOULDER_Y);
  const inPavilion = y > SHOULDER_Y && y <= BOTTOM_Y && pavilionT >= 0 && Math.abs(x - 0.5) <= 0.26 * (1 - pavilionT);

  if (inCrown || inPavilion) {
    const upperTable = y <= TOP_Y + 0.055 && x >= TABLE_LEFT && x <= TABLE_RIGHT;
    let facet;
    if (upperTable) facet = FACET_LIGHT;
    else if (y <= SHOULDER_Y) facet = x < 0.5 ? FACET_MAIN : mixRgb(FACET_MAIN, FACET_DARK, 0.55);
    else facet = x < 0.5 ? mixRgb(FACET_MAIN, FACET_DARK, 0.35) : FACET_DEEP;

    // Soft inner shading so the facets read as planes, not flat paint.
    const shade = 1 - Math.abs(x - 0.5) * 0.35 - Math.max(0, y - SHOULDER_Y) * 0.22;
    color = facet.map((c) => c * shade);
  } else {
    // Thin rim highlight around the gem silhouette at 1px-ish scale.
    const nearCrown = y > TOP_Y - 0.02 && y < SHOULDER_Y + 0.02 && x > LEFT_X - 0.02 && x < RIGHT_X + 0.02;
    const pavT = (y - SHOULDER_Y) / (BOTTOM_Y - SHOULDER_Y);
    const nearPavilion = y > SHOULDER_Y - 0.02 && y < BOTTOM_Y + 0.02 && Math.abs(x - 0.5) < 0.26 * (1 - Math.min(pavT, 1)) + 0.02;
    if (nearCrown || nearPavilion) color = mixRgb(color, RIM, 0.55);
  }

  // Vignette: darken towards the corners of the rounded square.
  const vignette = 1 - 0.28 * Math.hypot(x - 0.5, y - 0.5);
  color = color.map((c) => c * vignette);

  return [color[0], color[1], color[2], 255];
}

function render() {
  const rgba = Buffer.alloc(SIZE * SIZE * 4);
  for (let py = 0; py < SIZE; py += 1) {
    for (let px = 0; px < SIZE; px += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const sample = pixelColor((px + (sx + 0.5) / SS) / SIZE, (py + (sy + 0.5) / SS) / SIZE);
          r += sample[0];
          g += sample[1];
          b += sample[2];
          a += sample[3];
        }
      }
      const n = SS * SS;
      const i = (py * SIZE + px) * 4;
      rgba[i] = Math.round(r / n);
      rgba[i + 1] = Math.round(g / n);
      rgba[i + 2] = Math.round(b / n);
      rgba[i + 3] = Math.round(a / n);
    }
  }
  return encodePng(SIZE, SIZE, rgba);
}

/* ── main ──────────────────────────────────────────────────────────────── */

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');
const assetsDir = resolve(projectRoot, 'assets');
const sourcePng = resolve(assetsDir, 'icon-source.png');

mkdirSync(assetsDir, { recursive: true });
const png = render();
writeFileSync(sourcePng, png);
console.log(`wrote ${sourcePng} (${(png.length / 1024).toFixed(1)} KiB, ${SIZE}×${SIZE})`);

const tauri = spawnSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['--no-install', 'tauri', 'icon', sourcePng, '--output', resolve(projectRoot, 'src-tauri/icons')],
  { stdio: 'inherit', cwd: projectRoot, shell: process.platform === 'win32' },
);

if (tauri.status !== 0) {
  console.error('tauri icon failed — run `npm install` first');
  process.exit(tauri.status ?? 1);
}
console.log('icons generated in src-tauri/icons');
