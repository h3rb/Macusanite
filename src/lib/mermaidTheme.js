/**
 * Mermaid theme variables derived from the viewer palette.
 *
 * Mermaid's own `dark` and `default` themes use fixed blues, so the app renders
 * with `theme: 'base'` and passes these values instead. Every value comes from
 * a CSS custom property, which means theme hues and the dark/light switch flow
 * straight into diagrams.
 */
export function mermaidThemeVariables({
  dark = true,
  background,
  raised,
  sunken,
  panel,
  border,
  borderStrong,
  text,
  textDim,
  accent,
}) {
  const pie = piePalette({ borderStrong, accent: accent || borderStrong, dark });
  return {
    darkMode: dark,
    background,
    primaryColor: panel,
    primaryTextColor: text,
    primaryBorderColor: borderStrong,
    secondaryColor: raised,
    tertiaryColor: sunken,
    lineColor: borderStrong,
    textColor: text,
    mainBkg: panel,
    nodeBorder: borderStrong,
    nodeTextColor: text,
    clusterBkg: raised,
    clusterBorder: border,
    titleColor: text,
    edgeLabelBackground: background,
    noteBkgColor: raised,
    noteTextColor: text,
    noteBorderColor: borderStrong,
    actorBkg: panel,
    actorBorder: borderStrong,
    actorTextColor: text,
    actorLineColor: border,
    signalColor: textDim,
    signalTextColor: text,
    labelBoxBkgColor: raised,
    labelBoxBorderColor: border,
    labelTextColor: text,
    loopTextColor: text,
    activationBkgColor: raised,
    activationBorderColor: borderStrong,
    sequenceNumberColor: text,
    // Mermaid's base theme paints done Gantt bars lightgrey while using the
    // theme's light text on them, which is unreadable in dark mode. Tinted
    // raised surfaces keep labels legible in both palettes; Mermaid's own
    // active bar is lightened from the panel and can lose contrast under a
    // strong background hue (e.g. green), so give it its own tint and border.
    doneTaskBkgColor: mixHex(raised, accent || borderStrong, 0.28),
    doneTaskBorderColor: borderStrong,
    activeTaskBkgColor: mixHex(raised, accent || borderStrong, 0.2),
    activeTaskBorderColor: accent || borderStrong,
    // Mermaid's pie defaults are all derived from `primaryColor` (the panel),
    // which leaves every slice the same near-white/near-black shade. Use a
    // themed hue wheel instead so slices and legend swatches stay distinguishable.
    ...Object.fromEntries(pie.map((color, index) => [`pie${index + 1}`, color])),
    pieSectionTextColor: text,
    pieTitleTextColor: text,
    pieLegendTextColor: text,
    pieStrokeColor: textDim,
    pieOuterStrokeColor: textDim,
    pieOpacity: 1,
  };
}

/** Blend two hex colours, `amount` 0 = from, 1 = to. */
function mixHex(from, to, amount) {
  const a = parseHex(from);
  const b = parseHex(to);
  if (!a || !b) return from;
  const channel = (index) => Math.round(a[index] + (b[index] - a[index]) * amount);
  return `#${[0, 1, 2].map((index) => channel(index).toString(16).padStart(2, '0')).join('')}`;
}

function parseHex(value) {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(value).trim());
  if (!match) return null;
  const hex = match[1].length === 3 ? [...match[1]].map((digit) => digit + digit).join('') : match[1];
  return [0, 2, 4].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
}

/**
 * Twelve pie fills on controlled dark/light lightness bands.
 *
 * A single panel→accent ramp compresses each six-colour family into nearly
 * identical shades and can lose contrast when a large hue shift makes the
 * accent bright. Spreading twelve hues around the wheel gives every slice and
 * legend swatch its own colour, while both lightness bands keep every label
 * at 4.5:1 or better against its fill.
 */
const PIE_HUES = [0, 150, 300, 90, 240, 30, 180, 330, 120, 270, 60, 210];

function piePalette({ borderStrong, accent, dark }) {
  const base = hexHue(accent || borderStrong);
  return PIE_HUES.map((offset, index) => {
    const high = index % 2 === 0;
    return hslToHex(
      base + offset,
      high ? 0.66 : 0.52,
      dark ? (high ? 0.25 : 0.2) : (high ? 0.78 : 0.7),
    );
  });
}

/** Hue in degrees for a hex colour. Greys fall back to red (0). */
function hexHue(value) {
  const rgb = parseHex(value);
  if (!rgb) return 0;
  const [r, g, b] = rgb.map((channel) => channel / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const delta = max - min;
  let hue;
  if (max === r) hue = (g - b) / delta + (g < b ? 6 : 0);
  else if (max === g) hue = (b - r) / delta + 2;
  else hue = (r - g) / delta + 4;
  return hue * 60;
}

/** HSL converted to the same #rrggbb form as the theme's CSS colours. */
function hslToHex(hue, saturation, lightness) {
  const h = ((hue % 360) + 360) % 360;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = chroma * (1 - Math.abs((h / 60) % 2 - 1));
  const m = lightness - chroma / 2;
  let rgb;
  if (h < 60) rgb = [chroma, x, 0];
  else if (h < 120) rgb = [x, chroma, 0];
  else if (h < 180) rgb = [0, chroma, x];
  else if (h < 240) rgb = [0, x, chroma];
  else if (h < 300) rgb = [x, 0, chroma];
  else rgb = [chroma, 0, x];
  return `#${rgb.map((channel) => {
    const byte = Math.round((channel + m) * 255);
    return Math.max(0, Math.min(255, byte)).toString(16).padStart(2, '0');
  }).join('')}`;
}
