/**
 * Button iconography.
 *
 * Most controls use a unicode symbol or emoji that already says what they do
 * (↶, 🗑️, 📌). Where the app's vocabulary has no good glyph — a new folder, a
 * new vein, a card — a small inline SVG is generated here instead, drawn in
 * `currentColor` so it inherits the button's text colour in both themes.
 *
 * Icons are decoration: every one is `aria-hidden`, and every button keeps its
 * text label. `Settings → Button icons` toggles the `data-icons` attribute on
 * the app root; styles.css hides `.ui-icon` when it is off, which turns the
 * whole window text-only without rebuilding it.
 */

/** Unicode and emoji glyphs, by semantic name. */
const GLYPHS = {
  menu: '☰',
  jump: '⌕',
  graph: '🕸️',
  help: '❓',
  settings: '⚙️',
  back: '←',
  forward: '→',
  undo: '↶',
  redo: '↷',
  save: '💾',
  new: '➕',
  vault: '🏛️',
  chamber: '🗂️',
  vein: '📄',
  note: '📝',
  open: '📂',
  export: '📤',
  import: '📥',
  backup: '☁️',
  history: '🕘',
  search: '🔍',
  edit: '✏️',
  preview: '👁️',
  revert: '↩️',
  delete: '🗑️',
  close: '✕',
  check: '✓',
  download: '⬇️',
  later: '⏳',
  reload: '🔄',
  fit: '⤢',
  hide: '⇥',
  previous: '‹',
  next: '›',
  clear: '✕',
  selectAll: '▣',
  isolate: '◎',
  elbow: '⤵',
  curve: '⤳',
  arrows: '→',
  trim: '✂️',
  upstream: '⬅️',
  downstream: '➡️',
  more: '⋯',
  arrange: '▦',
  overview: '🗺️',
  cards: '▭',
  annotation: '💬',
  world: '🌍',
  legend: '🗺️',
  gestures: '🖱️',
  health: '🩺',
  group: '🧩',
  ungroup: '⧉',
  pin: '📌',
  lock: '🔒',
  unlock: '🔓',
  image: '🖼️',
  attachment: '📎',
  link: '🔗',
  colour: '🎨',
  type: '🔠',
  field: '📋',
  fold: '▸',
  unfold: '▾',
  reset: '↺',
  thumbnail: '🖼️',
  compact: '▤',
  full: '▥',
  grid: '▦',
  rows: '☰',
  columns: '▥',
  cascade: '▚',
  layers: '≣',
  progression: '⇉',
  height: '↕',
  align: '⊞',
  distribute: '⇔',
  zoom: '🔍',
  duplicate: '⧉',
  tag: '🏷️',
  ghosts: '👻',
  context: '🌐',
  folder: '📁',
  exit: '🚪',
  update: '⬆️',
  merge: '🔀',
  keep: '💾',
  disk: '💽',
  importReplace: '📥',
  arrowUp: '↑',
  arrowDown: '↓',
};

/**
 * Generated icons, for ideas with no settled glyph. They share one drawing
 * style: 24×24, round caps, no fill, currentColor.
 */
const SVGS = {
  'folder-plus': '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.2l1.8 2h8A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5z"/><path d="M12 11v5M9.5 13.5h5"/></svg>',
  'file-plus': '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 3.5h7L18 8v12.5H6.5z"/><path d="M13.5 3.5V8H18"/><path d="M12 11.5v5M9.5 14h5"/></svg>',
  card: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9.5h18"/></svg>',
  group: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/><path d="M10.5 7h1.5a3 3 0 0 1 3 3v3.5"/></svg>',
  select: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h6M4 4v6M20 4h-6M20 4v6M4 20h6M4 20v-6M20 20h-6M20 20v-6"/><path d="M9 9h6v6H9z"/></svg>',
  // A panel leaving its dock: the box the pane sat in, open at one corner, and
  // an arrow going out of it — not the two-corner spread of “fit”.
  popout: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18.5 13.5v5a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2h5"/><path d="M14.5 3.5h6v6"/><path d="M20.5 3.5 12 12"/></svg>',
};

const norm = (value) => String(value ?? '')
  .replace(/\u2026/g, '')
  .replace(/\s*[▾▸]/g, '')
  .replace(/\s*—\s*.*$/, '')
  .replace(/\s*\(\d+\)\s*$/, '')
  .replace(/\s*\(\d+\s+\w+\)\s*$/, '')
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase();

/** Exact labels that the keyword rules would get wrong. */
const EXACT = new Map(Object.entries({
  'back': 'back',
  'forward': 'forward',
  'previous match': 'previous',
  'next match': 'next',
  'previous hit': 'previous',
  'next hit': 'next',
  'back to the arrange scopes': 'back',
  'clear': 'clear',
  'clear selection': 'clear',
  'select all': 'selectAll',
  'isolate': 'isolate',
  'fit': 'fit',
  'fit selection': 'fit',
  'fit to content': 'fit',
  'overview': 'overview',
  'cards': 'cards',
  'arrange': 'arrange',
  'more': 'more',
  'save': 'save',
  'close': 'close',
  'cancel': 'close',
  'apply': 'check',
  'done': 'check',
  'delete': 'delete',
  'rename': 'edit',
  'fold': 'fold',
  'unfold': 'unfold',
  'pin': 'pin',
  'unpin': 'pin',
  'lock': 'lock',
  'unlock': 'unlock',
  'group': 'group',
  'ungroup': 'ungroup',
  'elbow': 'elbow',
  'rows': 'rows',
  'columns': 'columns',
  'cascade': 'cascade',
  'layered': 'layers',
  'grid': 'grid',
  'progression': 'progression',
  'progression columns': 'progression',
  'whole vein (grid)': 'grid',
  'thumbnail': 'thumbnail',
  'compact': 'compact',
  'full': 'full',
  'full card': 'full',
  'compact card': 'compact',
  'fixed height': 'height',
  'reset size': 'reset',
  'clear colour': 'colour',
  'clear color': 'colour',
  'add note': 'note',
  'add annotation': 'annotation',
  'new note': 'note',
  '+ note': 'note',
  '+ first note': 'note',
  'edit': 'edit',
  'preview': 'preview',
  'revert': 'revert',
  'visual editing': 'preview',
  'code editing': 'edit',
  'open': 'open',
  'choose': 'open',
  'open vault': 'open',
  'create vault': 'vault',
  'new vault': 'vault',
  'new chamber': 'chamber',
  'new vein': 'vein',
  'reload': 'reload',
  'chambers': 'chamber',
  'search': 'search',
  'select all matches': 'selectAll',
  'import': 'import',
  'later': 'later',
  'keep my draft': 'keep',
  'use the disk version': 'disk',
  'download & restart': 'download',
}));

/** Ordered keyword rules; the first match wins. */
const RULES = [
  [/\bnew (vault|chamber|vein|note|folder)\b/, null], // handled below by the noun
  [/\bundo\b/, 'undo'],
  [/\bredo\b/, 'redo'],
  [/\bback ?up\b|\bs3\b|backup/, 'backup'],
  [/\bexport\b/, 'export'],
  [/\bimport\b/, 'import'],
  [/\bhistory\b/, 'history'],
  [/\b(quick )?jump\b/, 'jump'],
  [/\bsearch\b|\bfind\b/, 'search'],
  [/\bgraph\b/, 'graph'],
  [/\bsettings\b|\bpreferences\b/, 'settings'],
  [/\bhelp\b|\bmanual\b|\bgestures?\b/, 'help'],
  [/\bwiki\b|\bmarkdown source\b|\bsource\b/, 'edit'],
  [/\bexit\b|\bquit\b/, 'exit'],
  [/\breload\b|\brefresh\b/, 'reload'],
  [/\bcheck for updates\b|\bupdate\b/, 'update'],
  [/\bdownload\b|\binstall\b/, 'download'],
  [/\bmerge\b/, 'merge'],
  [/\bdiscard\b|\brevert\b/, 'revert'],
  [/\bdelete\b|\bremove\b|\btrash\b/, 'delete'],
  [/\brename\b|\bedit\b/, 'edit'],
  [/\bduplicate\b|\bcopy\b/, 'duplicate'],
  [/\bcolou?rs?\b|\bpalette\b/, 'colour'],
  [/^(svg|png|mermaid)\b/, 'export'],
  [/\bimage\b|\bthumbnail\b|\bphoto\b/, 'image'],
  [/\battach|\bfile\b|\bresource\b/, 'attachment'],
  [/\bwiki link\b|\blink\b|\bbond\b|\bconnect/, 'link'],
  [/\brelationship\b|\brelate to\b|\bweb url\b|\burl\b/, 'link'],
  [/\bsmooth curve\b/, 'curve'],
  [/\brouting\b/, 'elbow'],
  [/\bcentre\b|\bcenter\b|\bleft\b|\bright\b|\balign/, 'align'],
  [/\btag\b/, 'tag'],
  [/\btype\b/, 'type'],
  [/\bfield\b/, 'field'],
  [/\bgroup\b/, 'group'],
  [/\bpin(ned)?\b/, 'pin'],
  [/\block(ed)?\b/, 'lock'],
  [/\bfold\b|\bcollapse\b/, 'fold'],
  [/\bunfold\b|\bexpand\b/, 'unfold'],
  [/\bfit\b|\bzoom\b/, 'fit'],
  [/\bgrid\b/, 'grid'],
  [/\brow(s)?\b/, 'rows'],
  [/\bcolumn(s)?\b/, 'columns'],
  [/\bcascade\b/, 'cascade'],
  [/\blayer(s|ed)?\b/, 'layers'],
  [/\bprogression\b/, 'progression'],
  [/\balign\b/, 'align'],
  [/\bdistribute\b/, 'distribute'],
  [/\bselect all\b/, 'selectAll'],
  [/\bisolate\b/, 'isolate'],
  [/\bclear\b/, 'clear'],
  [/\belbow\b/, 'elbow'],
  [/\barrow/, 'arrows'],
  [/\btrim\b|\bcut\b/, 'trim'],
  [/\bupstream\b|\bbackwards\b/, 'upstream'],
  [/\bdownstream\b|\bforwards\b/, 'downstream'],
  [/\bhealth\b/, 'health'],
  [/\blegend\b|\bwhat the lines\b/, 'legend'],
  [/\bannotation\b|\bcomment\b/, 'annotation'],
  [/\bworldbuilding\b/, 'world'],
  [/\boverview\b/, 'overview'],
  [/\bcard(s)?\b/, 'cards'],
  [/\bnote\b/, 'note'],
  [/\barrange\b|\blayout\b/, 'arrange'],
  [/\bmore\b/, 'more'],
  [/\bnew\b/, 'new'],
  [/\bopen\b|\bload\b/, 'open'],
  [/\bback\b|\bprevious\b/, 'back'],
  [/\bnext\b|\bforward\b/, 'forward'],
  [/\bsave\b/, 'save'],
  [/\bclose\b|\bcancel\b/, 'close'],
  [/\bapply\b|\bdone\b|\bconfirm\b|\bmerge into\b/, 'check'],
  [/\bselect\b/, 'selectAll'],
];

/** Buttons that already are icons (format bar) or are list rows, not actions. */
const SKIP = new Set([
  'fmt-btn', 'picker-cell', 'color-swatch', 'crumb', 'trail-chip',
  'jump-item', 'search-result', 'history-row', 'toast-action',
  'wb-search-result',
]);

/** Resolve a button's visible label to an icon name, or null. */
export function iconForLabel(label) {
  const text = norm(label);
  if (!text) return null;
  if (EXACT.has(text)) return EXACT.get(text);
  // "New chamber…" and friends: the noun is the subject, the plus is the action.
  const created = /^new (vault|chamber|vein|note|folder)\b/.exec(text);
  if (created) return created[1] === 'folder' ? 'folder' : created[1];
  for (const [pattern, name] of RULES) {
    if (!pattern.test(text)) continue;
    if (name === null) continue;
    return name;
  }
  return null;
}

/** A `.ui-icon` span: generated SVG where one exists, otherwise the glyph. */
export function makeIcon(name) {
  const span = document.createElement('span');
  span.className = 'ui-icon';
  span.setAttribute('aria-hidden', 'true');
  if (SVGS[name]) span.innerHTML = SVGS[name];
  else span.textContent = GLYPHS[name] ?? '•';
  return span;
}

/** The text half of an icon-only button, hidden while icons are on. */
export function makeLabel(text) {
  const span = document.createElement('span');
  span.className = 'ui-label';
  span.textContent = String(text ?? '');
  return span;
}

/**
 * Decorate a button built by `el()`.
 *
 * `icon` names an icon explicitly (or `false` to opt out); `iconLabel` adds the
 * text shown in its place when icons are turned off. Without either, the label
 * is resolved through {@link iconForLabel}, so ordinary labelled buttons need
 * no call-site changes.
 */
export function decorateButton(node, attrs = {}) {
  if (!node || attrs.icon === false) return;
  if (!attrs.icon && [...node.classList].some((name) => SKIP.has(name))) return;
  let name = typeof attrs.icon === 'string' ? attrs.icon : null;
  if (!name) {
    const text = (attrs.iconLabel ?? node.textContent ?? '').trim();
    if (text.length < 2 || !/[\p{L}\p{N}]/u.test(text)) return;
    name = iconForLabel(text);
  }
  if (!name) return;
  node.prepend(makeIcon(name));
  if (attrs.iconLabel && !node.querySelector('.ui-label')) node.append(makeLabel(attrs.iconLabel));
}
