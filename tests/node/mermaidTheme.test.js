import test from 'node:test';
import assert from 'node:assert/strict';

import { mermaidThemeVariables } from '../../src/lib/mermaidTheme.js';
import { rotateHue } from '../../src/lib/themeHue.js';
import { luminance } from '../../src/lib/colors.js';

const THEMES = {
  dark: {
    dark: true,
    colors: {
      background: '#0d1117',
      raised: '#131a22',
      sunken: '#090c11',
      panel: '#111823',
      border: '#223040',
      borderStrong: '#2f4257',
      text: '#e6edf3',
      textDim: '#9fb0c0',
      accent: '#58a6ff',
    },
  },
  light: {
    dark: false,
    colors: {
      background: '#f6f7f9',
      raised: '#ffffff',
      sunken: '#eceff3',
      panel: '#ffffff',
      border: '#d6dce4',
      borderStrong: '#bcc6d2',
      text: '#16202b',
      textDim: '#4d5b6a',
      accent: '#0b62d0',
    },
  },
};

const SHIFTS = [
  { background: 0, chrome: 0, text: 0 },
  { background: -150, chrome: -150, text: 150 },
  { background: 150, chrome: -120, text: 180 },
];

const rgb = (hex) => [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));

const distance = (a, b) => {
  const ca = rgb(a);
  const cb = rgb(b);
  return Math.hypot(...ca.map((channel, index) => channel - cb[index]));
};

const contrast = (a, b) => {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

function variablesFor(theme, shift) {
  return Object.fromEntries(
    Object.entries(theme.colors).map(([key, color]) => {
      const group = key === 'text' || key === 'textDim'
        ? 'text'
        : key === 'panel' || key === 'background' || key === 'raised' || key === 'sunken'
          ? 'background'
          : 'chrome';
      return [key, rotateHue(color, shift[group])];
    }),
  );
}

for (const [name, theme] of Object.entries(THEMES)) {
  for (const shift of SHIFTS) {
    test(`${name} pie keeps twelve distinct, legible fills at hue shift ${JSON.stringify(shift)}`, () => {
      const variables = variablesFor(theme, shift);
      const pie = mermaidThemeVariables({ dark: theme.dark, ...variables });
      const fills = Array.from({ length: 12 }, (_, index) => pie[`pie${index + 1}`]);

      assert.equal(new Set(fills).size, 12, 'all pie and legend swatches are unique');
      for (const fill of fills) {
        assert.ok(contrast(fill, variables.text) >= 4.5, `${fill} labels are legible`);
      }
      for (let index = 0; index < fills.length - 1; index += 1) {
        assert.ok(distance(fills[index], fills[index + 1]) >= 75, 'adjacent slices stay distinct');
      }
      for (let a = 0; a < fills.length; a += 1) {
        for (let b = a + 1; b < fills.length; b += 1) {
          assert.ok(distance(fills[a], fills[b]) >= 30, 'every pair of swatches stays distinct');
        }
      }
      assert.equal(pie.pieSectionTextColor, variables.text);
      assert.equal(pie.pieLegendTextColor, variables.text);
      assert.ok(contrast(pie.pieLegendTextColor, variables.background) >= 4.5);
    });
  }
}

const GANTT_CASES = [
  ...Object.entries(THEMES).flatMap(([name, theme]) =>
    SHIFTS.map((shift) => ({ name, theme, shift, label: `hue shift ${JSON.stringify(shift)}` })),
  ),
  {
    name: 'dark',
    theme: THEMES.dark,
    shift: { background: -150, chrome: 0, text: 0 },
    // This makes the dark palette green. Before the custom active-bar tint,
    // Mermaid's lightened panel left the active task label at 4.35:1 here.
    label: 'green background (formerly a 4.35:1 active label)',
  },
];

for (const { name, theme, shift, label } of GANTT_CASES) {
  test(`${name} Gantt task labels keep 4.5:1 contrast with ${label}`, () => {
    const variables = mermaidThemeVariables({ dark: theme.dark, ...variablesFor(theme, shift) });
    const tasks = [
      ['active', variables.activeTaskBkgColor, variables.taskTextDarkColor ?? variables.textColor],
      ['done', variables.doneTaskBkgColor, variables.taskTextColor ?? variables.textColor],
    ];

    for (const [state, background, foreground] of tasks) {
      assert.match(background, /^#[0-9a-f]{6}$/i, `${state} task background is a themed hex colour`);
      const ratio = contrast(foreground, background);
      assert.ok(ratio >= 4.5, `${state} labels stay legible against ${background} (${ratio.toFixed(2)}:1)`);
    }
  });
}
