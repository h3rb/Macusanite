/**
 * Colour maths plus the palettes Macusanite offers in its picker.
 *
 * Colours are stored as `#rrggbb` strings. `#rgb`, `rgb(r,g,b)` and X11 names are
 * accepted as *input* and normalised on the way in.
 */

/** Common UI palette — the row of swatches at the top of the picker. */
export const PALETTE = [
  '#ffffff', '#f5f5f5', '#d9d9d9', '#a6a6a6', '#737373', '#404040', '#1a1a1a', '#000000',
  '#fff1f0', '#ffccc7', '#ff7875', '#f5222d', '#a8071a', '#fff7e6', '#ffd591', '#fa8c16',
  '#d46b08', '#873800', '#feffe6', '#eaff8f', '#a0d911', '#7cb305', '#3f6600', '#f6ffed',
  '#b7eb8f', '#52c41a', '#237804', '#135200', '#e6fffb', '#87e8de', '#13c2c2', '#005c5c',
  '#e6f4ff', '#a0c4ff', '#4096ff', '#1677ff', '#003eb3', '#f9f0ff', '#d3adf7', '#9254de',
  '#722ed1', '#391085', '#fff0f6', '#ffadd2', '#eb2f96', '#9e1068', '#f0f5ff', '#adc6ff',
];

/**
 * Curated X11 colour selection (names as defined by `X11/rgb.txt`).
 * Not the full 550-entry list — this is the "precomputed selection" the picker
 * shows as a quick picker grid, chosen so every hue family is represented.
 */
export const X11_COLORS = {
  AliceBlue: '#f0f8ff', AntiqueWhite: '#faebd7', Aquamarine: '#7fffd4', Azure: '#f0ffff',
  Beige: '#f5f5dc', Bisque: '#ffe4c4', BlanchedAlmond: '#ffebcd', BlueViolet: '#8a2be2',
  BurlyWood: '#deb887', CadetBlue: '#5f9ea0', Chartreuse: '#7fff00', Chocolate: '#d2691e',
  Coral: '#ff7f50', CornflowerBlue: '#6495ed', Cornsilk: '#fff8dc', Crimson: '#dc143c',
  Cyan: '#00ffff', DarkBlue: '#00008b', DarkCyan: '#008b8b', DarkGoldenrod: '#b8860b',
  DarkGray: '#a9a9a9', DarkGreen: '#006400', DarkKhaki: '#bdb76b', DarkMagenta: '#8b008b',
  DarkOliveGreen: '#556b2f', DarkOrange: '#ff8c00', DarkOrchid: '#9932cc', DarkRed: '#8b0000',
  DarkSalmon: '#e9967a', DarkSeaGreen: '#8fbc8f', DarkSlateBlue: '#483d8b',
  DarkSlateGray: '#2f4f4f', DarkTurquoise: '#00ced1', DarkViolet: '#9400d3', DeepPink: '#ff1493',
  DeepSkyBlue: '#00bfff', DimGray: '#696969', DodgerBlue: '#1e90ff', Firebrick: '#b22222',
  FloralWhite: '#fffaf0', ForestGreen: '#228b22', Gainsboro: '#dcdcdc', GhostWhite: '#f8f8ff',
  Gold: '#ffd700', Goldenrod: '#daa520', GreenYellow: '#adff2f', Honeydew: '#f0fff0',
  HotPink: '#ff69b4', IndianRed: '#cd5c5c', Indigo: '#4b0082', Ivory: '#fffff0',
  Khaki: '#f0e68c', Lavender: '#e6e6fa', LavenderBlush: '#fff0f5', LawnGreen: '#7cfc00',
  LemonChiffon: '#fffacd', LightBlue: '#add8e6', LightCoral: '#f08080', LightCyan: '#e0ffff',
  LightGoldenrod: '#eedd82', LightGray: '#d3d3d3', LightGreen: '#90ee90', LightPink: '#ffb6c1',
  LightSalmon: '#ffa07a', LightSeaGreen: '#20b2aa', LightSkyBlue: '#87cefa',
  LightSlateGray: '#778899', LightSteelBlue: '#b0c4de', LightYellow: '#ffffe0',
  LimeGreen: '#32cd32', Linen: '#faf0e6', Magenta: '#ff00ff', Maroon: '#800000',
  MediumAquamarine: '#66cdaa', MediumBlue: '#0000cd', MediumOrchid: '#ba55d3',
  MediumPurple: '#9370db', MediumSeaGreen: '#3cb371', MediumSlateBlue: '#7b68ee',
  MediumSpringGreen: '#00fa9a', MediumTurquoise: '#48d1cc', MediumVioletRed: '#c71585',
  MidnightBlue: '#191970', MintCream: '#f5fffa', MistyRose: '#ffe4e1', Moccasin: '#ffe4b5',
  NavajoWhite: '#ffdead', Navy: '#000080', OldLace: '#fdf5e6', OliveDrab: '#6b8e23',
  OrangeRed: '#ff4500', Orchid: '#da70d6', PaleGoldenrod: '#eee8aa', PaleGreen: '#98fb98',
  PaleTurquoise: '#afeeee', PaleVioletRed: '#db7093', PapayaWhip: '#ffefd5', PeachPuff: '#ffdab9',
  Peru: '#cd853f', Pink: '#ffc0cb', Plum: '#dda0dd', PowderBlue: '#b0e0e6',
  RosyBrown: '#bc8f8f', RoyalBlue: '#4169e1', SaddleBrown: '#8b4513', Salmon: '#fa8072',
  SandyBrown: '#f4a460', SeaGreen: '#2e8b57', Seashell: '#fff5ee', Sienna: '#a0522d',
  SkyBlue: '#87ceeb', SlateBlue: '#6a5acd', SlateGray: '#708090', Snow: '#fffafa',
  SpringGreen: '#00ff7f', SteelBlue: '#4682b4', Tan: '#d2b48c', Thistle: '#d8bfd8',
  Tomato: '#ff6347', Turquoise: '#40e0d0', Violet: '#ee82ee', Wheat: '#f5deb3',
  WhiteSmoke: '#f5f5f5', YellowGreen: '#9acd32', RebeccaPurple: '#663399', Teal: '#008080',
};

/** Canonical `#rrggbb` from any accepted input, or null when unparseable. */
export function normalizeColor(input) {
  if (typeof input !== 'string') return null;
  const value = input.trim();
  if (!value) return null;

  const name = X11_COLORS[value] || X11_COLORS[value.toLowerCase()] ||
    Object.entries(X11_COLORS).find(([k]) => k.toLowerCase() === value.toLowerCase())?.[1];
  if (name) return name;
  if (value.toLowerCase() === 'white') return '#ffffff';
  if (value.toLowerCase() === 'black') return '#000000';

  const rgbMatch = /^rgba?\(\s*([0-9.]+)\s*[, ]\s*([0-9.]+)\s*[, ]\s*([0-9.]+)/i.exec(value);
  if (rgbMatch) {
    return rgbToHex(Number(rgbMatch[1]), Number(rgbMatch[2]), Number(rgbMatch[3]));
  }

  const hex = value.startsWith('#') ? value.slice(1) : value;
  if (/^[0-9a-f]{3}$/i.test(hex)) {
    return `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`.toLowerCase();
  }
  if (/^[0-9a-f]{6}$/i.test(hex)) return `#${hex.toLowerCase()}`;
  return null;
}

export function isValidColor(input) {
  return normalizeColor(input) !== null;
}

export function hexToRgb(input) {
  const hex = normalizeColor(input) || '#000000';
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
}

const clampByte = (n) => Math.max(0, Math.min(255, Math.round(Number.isFinite(n) ? n : 0)));

export function rgbToHex(r, g, b) {
  return `#${[r, g, b].map((c) => clampByte(c).toString(16).padStart(2, '0')).join('')}`;
}

/** Linear interpolation; `t=0` yields `a`, `t=1` yields `b`. */
export function mix(a, b, t) {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  const k = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0));
  return rgbToHex(
    ca.r + (cb.r - ca.r) * k,
    ca.g + (cb.g - ca.g) * k,
    ca.b + (cb.b - ca.b) * k,
  );
}

export function withAlpha(color, alpha) {
  const { r, g, b } = hexToRgb(color);
  const a = Math.max(0, Math.min(1, Number.isFinite(alpha) ? alpha : 1));
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/** Perceived luminance (WCAG). */
export function luminance(color) {
  const { r, g, b } = hexToRgb(color);
  const channel = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Readable foreground for text drawn on top of `color`. */
export function contrastColor(color) {
  return luminance(color) > 0.45 ? '#101418' : '#f2f5f8';
}

export function isLight(color) {
  return luminance(color) > 0.45;
}

/** Nearest X11 name for a colour, useful for the picker's tooltip. */
export function nearestX11Name(color) {
  const { r, g, b } = hexToRgb(color);
  let best = null;
  let bestDist = Infinity;
  for (const [name, hex] of Object.entries(X11_COLORS)) {
    const c = hexToRgb(hex);
    const dist = (c.r - r) ** 2 + (c.g - g) ** 2 + (c.b - b) ** 2;
    if (dist < bestDist) {
      bestDist = dist;
      best = name;
    }
  }
  return best;
}

/**
 * Gradient stops that fade a link's colour into its target's colour. Drives both
 * the SVG graph edges and the little swatch under a rendered wiki link.
 */
export function linkGradient(fromColor, toColor, steps = 5) {
  const stops = [];
  for (let i = 0; i < steps; i += 1) {
    stops.push(mix(fromColor, toColor, steps === 1 ? 0 : i / (steps - 1)));
  }
  return stops;
}
