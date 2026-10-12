/**
 * The help window's entry point.
 *
 * Small on purpose: the manual is generated ([src/lib/helpDoc.js](lib/helpDoc.js))
 * and the window is built by [src/ui/helpWindow.js](ui/helpWindow.js). All this
 * file does is pick the theme and mount it.
 *
 * The window has no vault, so it has no settings to read: the theme arrives in
 * the query string (the viewer passes its own) and falls back to the operating
 * system's preference.
 */
import './styles.css';
import { createHelpWindow } from './ui/helpWindow.js';

const params = new URLSearchParams(globalThis.location?.search ?? '');
const asked = params.get('theme');
const prefersLight = globalThis.matchMedia?.('(prefers-color-scheme: light)').matches === true;
document.documentElement.dataset.theme = asked === 'light' || asked === 'dark'
  ? asked
  : (prefersLight ? 'light' : 'dark');

const root = document.getElementById('help-root');
if (root) {
  root.dataset.booting = 'false';
  createHelpWindow({ root });
}
