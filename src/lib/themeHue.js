/**
 * Theme hue shifts.
 *
 * The theme's greys are authored as hex in styles.css. A hue shift rotates each
 * group's hue around the colour wheel while keeping its saturation and
 * lightness, so contrast stays the same and the result still reads as the same
 * theme. 0° is the theme's own palette; lines and sliders inherit `accent` and
 * the borders, so they rotate together.
 */

export const THEME_HUE_KEYS = ['background', 'chrome', 'text'];

/** The custom properties each setting rotates. */
export const THEME_HUE_VARS = {
  background: ['--bg', '--bg-raised', '--bg-sunken', '--panel'],
  chrome: ['--border', '--border-strong', '--accent', '--accent-soft'],
  text: ['--text', '--text-dim', '--text-faint'],
};

export const DEFAULT_THEME_HUES = { background: 0, chrome: 0, text: 0 };

export const THEME_HUE_LIMIT = 180;

/** Merge and clamp saved hue shifts. */
export function cleanThemeHues(value) {
  const saved = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const out = { ...DEFAULT_THEME_HUES };
  for (const key of THEME_HUE_KEYS) {
    const degrees = Number(saved[key]);
    out[key] = Number.isFinite(degrees)
      ? Math.max(-THEME_HUE_LIMIT, Math.min(THEME_HUE_LIMIT, Math.round(degrees)))
      : 0;
  }
  return out;
}

/** Parse #rgb, #rrggbb, or rgb(...) into [r, g, b], or null. */
function parseColor(value) {
  const text = String(value ?? '').trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text);
  if (hex) {
    const digits = hex[1].length === 3
      ? hex[1].split('').map((d) => d + d).join('')
      : hex[1];
    return [0, 2, 4].map((at) => Number.parseInt(digits.slice(at, at + 2), 16));
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(text);
  if (rgb) {
    const parts = rgb[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    if (parts.length >= 3 && parts.slice(0, 3).every((n) => Number.isFinite(n))) return parts.slice(0, 3);
  }
  return null;
}

function rgbToHsl([r, g, b]) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return [h * 60, s, l];
}

function hslToHex(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let rgb;
  if (h < 60) rgb = [c, x, 0];
  else if (h < 120) rgb = [x, c, 0];
  else if (h < 180) rgb = [0, c, x];
  else if (h < 240) rgb = [0, x, c];
  else if (h < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return `#${rgb.map((channel) => {
    const byte = Math.round((channel + m) * 255);
    return Math.max(0, Math.min(255, byte)).toString(16).padStart(2, '0');
  }).join('')}`;
}

/** Rotate `hex` by `shift` degrees, preserving saturation and lightness. */
export function rotateHue(hex, shift) {
  const degrees = Number(shift);
  if (!Number.isFinite(degrees) || degrees === 0) return hex;
  const rgb = parseColor(hex);
  if (!rgb) return hex;
  const [h, s, l] = rgbToHsl(rgb);
  return hslToHex(((h + degrees) % 360 + 360) % 360, s, l);
}
