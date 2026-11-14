/**
 * Procedural animated demos for the manual, baked into the help window.
 *
 * Every feature section in [helpDoc.js](helpDoc.js) names a `demo` kind, and
 * this module turns that name into one self-contained HTML figure: inline
 * SVG/HTML animated with the CSS keyframes in `src/styles.css` (`.help-demo*`).
 * Nothing here is hand-placed markup per section — the figures are generated
 * from the same declarations the manual is generated from, so a feature added
 * to the manual gets its animation by naming a kind, and the tests can check
 * that every section's demo exists and actually animates.
 *
 * The animations are pure CSS (no JS timers, no video): each figure loops on
 * its own, and `@media (prefers-reduced-motion: reduce)` in the stylesheet
 * stills them. Screen readers get the caption, which says what the animation
 * shows.
 */

const esc = (value) => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** One labelled node in a demo diagram. `d` is the animation delay (seconds). */
const node = (x, y, label, { r = 7, fill = 'var(--accent)', labelDy = 16, d = 0 } = {}) => (
  `<g class="help-demo-node" style="animation-delay:${d}s">`
  + `<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}"/>`
  + `<text x="${x}" y="${y + labelDy}" text-anchor="middle">${esc(label)}</text></g>`
);

/** A dashed-stroke connector between two points. */
const edge = (x1, y1, x2, y2, d = 0) => (
  `<line class="help-demo-edge" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" style="animation-delay:${d}s"/>`
);

/** A small card, for the canvas/worldbuilding demos. */
const card = (x, y, w, label, d = 0) => (
  `<g class="help-demo-card" style="animation-delay:${d}s">`
  + `<rect x="${x}" y="${y}" width="${w}" height="26" rx="5"/>`
  + `<text x="${x + 8}" y="${y + 17}">${esc(label)}</text></g>`
);

const svg = (body, viewBox = '0 0 320 120') => (
  `<svg class="help-demo-svg" viewBox="${viewBox}" role="img" aria-hidden="true"><title>animation</title>${body}</svg>`
);

/** Wrap a demo body in its figure, with the caption that explains it. */
function figure(kind, body, caption) {
  return `<figure class="help-demo" data-demo="${esc(kind)}">${body}`
    + `<figcaption class="help-demo-caption">${esc(caption)}</figcaption></figure>`;
}

const DEMOS = {
  // A vein in the middle, its sections and neighbours around it.
  'vault-graph': () => figure('vault-graph', svg(
    edge(160, 60, 70, 30) + edge(160, 60, 250, 30) + edge(160, 60, 70, 92) + edge(160, 60, 250, 92)
    + node(160, 60, 'Home.md', { r: 12, d: 0 })
    + node(70, 30, '§ Sections', { fill: 'var(--warn)', d: 0.2 })
    + node(250, 30, 'Fieldwork', { d: 0.4 })
    + node(70, 92, 'Ghost ＋', { fill: 'none', d: 0.6 })
    + node(250, 92, '#fieldwork', { fill: 'var(--ok)', d: 0.8 }),
  ), 'The concept graph: one large vein, its sections, neighbours, ghosts and tags.'),

  // The vault folder, its .macusanite files appearing one by one.
  'vault-disk': () => figure('vault-disk', (
    '<div class="help-demo-tree">'
    + ['My Vault/', 'Home.md', 'Chambers/', '.macusanite/vault.json', '.macusanite/settings.json',
      '.macusanite/history.json', '.macusanite/index.json']
      .map((name, i) => `<span class="help-demo-line" style="animation-delay:${i * 0.35}s">${esc(name)}</span>`).join('')
    + '</div>'
  ), 'A vault is a folder: veins, chambers and the .macusanite bookkeeping.'),

  // The three panes light up in turn.
  'window-tour': () => figure('window-tour', (
    '<div class="help-demo-panes">'
    + '<span class="help-demo-pane" style="animation-delay:0s">Chambers</span>'
    + '<span class="help-demo-pane" style="animation-delay:1.2s">The vein</span>'
    + '<span class="help-demo-pane" style="animation-delay:2.4s">Concept graph</span>'
    + '</div>'
  ), 'The window: tree on the left, the vein in the centre, the graph on the right.'),

  // A query being typed, results arriving, a hit ringed.
  'search-type': () => figure('search-type', (
    '<div class="help-demo-search">'
    + '<span class="help-demo-query">sieve series<span class="help-demo-caret"></span></span>'
    + '<span class="help-demo-result" style="animation-delay:0.4s">title · <b>Sieve series</b></span>'
    + '<span class="help-demo-result" style="animation-delay:0.8s">§ Sieve series · <mark class="help-demo-hit">sieve</mark> series</span>'
    + '<span class="help-demo-result" style="animation-delay:1.2s">2 in text · standard half-phi <mark class="help-demo-hit is-current">sieve</mark>s</span>'
    + '</div>'
  ), 'Search ranks title, then heading, then tag, then body — and rings the hit you are on.'),

  // A swatch cycling through colours while an edge fades between two of them.
  'colours': () => figure('colours', svg(
    '<defs><linearGradient id="help-demo-fade" x1="0" x2="1">'
    + '<stop offset="0" stop-color="#58a6ff"/><stop offset="1" stop-color="#da70d6"/></linearGradient></defs>'
    + '<line class="help-demo-edge" x1="90" y1="60" x2="230" y2="60" style="stroke:url(#help-demo-fade)"/>'
    + node(80, 60, 'source', { d: 0 }) + node(240, 60, 'target', { fill: '#da70d6', d: 0.3 })
    + '<circle class="help-demo-swatch" cx="160" cy="22" r="10"/>'
    + '<text x="160" y="48" text-anchor="middle">click the swatch</text>',
  ), 'Colours resolve most-specific-first, and graph edges fade from link colour to target colour.'),

  // Nodes slowly orbiting the vein, edges following.
  'graph-orbits': () => figure('graph-orbits', svg(
    '<g class="help-demo-orbit">'
    + edge(160, 60, 70, 30) + edge(160, 60, 250, 30) + edge(160, 60, 70, 92) + edge(160, 60, 250, 92)
    + node(70, 30, 'A', { d: 0 }) + node(250, 30, 'B', { d: 0.2 })
    + node(70, 92, 'C', { d: 0.4 }) + node(250, 92, 'D', { d: 0.6 })
    + '</g>' + node(160, 60, 'Vein', { r: 12, d: 0 }),
  ), 'Drag a node to rearrange, the background to pan, scroll to zoom.'),

  // Text changes, then an undo arrow reverts it.
  'undo-flip': () => figure('undo-flip', (
    '<div class="help-demo-undo">'
    + '<span class="help-demo-undo-after">“sieve series”</span>'
    + '<span class="help-demo-undo-arrow">↩ Ctrl+Z</span>'
    + '<span class="help-demo-undo-before">“sieve sizes”</span>'
    + '</div>'
  ), 'Every write records a before/after snapshot — undo restores exactly what changed.'),

  // An external edit lands and the live dot turns green.
  'watching': () => figure('watching', (
    '<div class="help-demo-watch">'
    + '<span class="help-demo-live">◈ following</span>'
    + '<span class="help-demo-watch-line">Home.md <em>edited by another program…</em></span>'
    + '<span class="help-demo-watch-line is-new">…and it is in the tree, the graph and the reader, no reload</span>'
    + '</div>'
  ), 'The vault is watched: external changes appear without a reload, unsaved drafts always win.'),

  // The index filling in behind an already-usable window.
  'lazy-index': () => figure('lazy-index', (
    '<div class="help-demo-index">'
    + '<span class="help-demo-index-bar"><span class="help-demo-index-fill"></span></span>'
    + '<span class="help-demo-index-label">indexing 420/5001 → 5001/5001 — the window works throughout</span>'
    + '</div>'
  ), 'A vault opens by describing it: the index cache answers first, the rest is read in the background.'),

  // The folder becomes one archive and travels to the cloud.
  'backup-upload': () => figure('backup-upload', (
    '<div class="help-demo-backup">'
    + '<span class="help-demo-box">vault/</span><span class="help-demo-arrow">→</span>'
    + '<span class="help-demo-box">notes.tar.gz</span><span class="help-demo-arrow">→</span>'
    + '<span class="help-demo-box is-cloud">☁ bucket</span>'
    + '</div>'
  ), 'A backup is the whole folder as one timestamped .tar.gz — direct, over SSH, or automatic.'),

  // Shortcut keys lighting up in sequence.
  'keyboard-keys': () => figure('keyboard-keys', (
    '<div class="help-demo-keys">'
    + ['Ctrl+S', 'Ctrl+Z', 'Ctrl+K', 'Ctrl+F', 'F3', 'F1']
      .map((key, i) => `<span class="help-demo-key" style="animation-delay:${i * 0.5}s">${esc(key)}</span>`).join('')
    + '</div>'
  ), 'The whole window is keyboard-first: save, undo, jump, search, step hits, help.'),

  // A terminal session: CLI command, then the MCP handshake.
  'agents-terminal': () => figure('agents-terminal', (
    '<div class="help-demo-term">'
    + '<span class="help-demo-term-line is-cmd">$ macusanite --vault ./notes search "sieve" --json</span>'
    + '<span class="help-demo-term-line" style="animation-delay:0.8s">→ [{ "path": "Chambers/Lab/…" }]</span>'
    + '<span class="help-demo-term-line is-cmd" style="animation-delay:1.6s">$ macusanite mcp serve --port 8765</span>'
    + '<span class="help-demo-term-line" style="animation-delay:2.4s">→ POST /mcp · GET /health · same API, no window</span>'
    + '</div>'
  ), 'CLI and MCP are the same API as the window — Node programs, no build step.'),

  // Cards sliding from a pile into progression columns by heading tier.
  'worldbuild-arrange': () => figure('worldbuild-arrange', svg(
    '<rect class="help-demo-lane" x="18" y="10" width="84" height="100" rx="6"/>'
    + '<rect class="help-demo-lane is-alt" x="118" y="10" width="84" height="100" rx="6"/>'
    + '<rect class="help-demo-lane" x="218" y="10" width="84" height="100" rx="6"/>'
    + '<text class="help-demo-lane-label" x="26" y="22">Tier 1</text>'
    + '<text class="help-demo-lane-label" x="126" y="22">Tier 2</text>'
    + '<text class="help-demo-lane-label" x="226" y="22">Tier 3</text>'
    + card(24, 28, 72, 'Welcome', 0)
    + card(124, 28, 72, 'Diagramming', 0.35)
    + card(124, 62, 72, 'Reference', 0.55)
    + card(224, 28, 72, 'Flowchart', 0.7)
    + card(224, 62, 72, 'Sequence', 0.9),
    '0 0 320 120',
  ), 'Split a group into progression columns: top cards left, each heading tier one column right.'),

  // A vein as a canvas: cards, the outline and a prose link.
  'worldbuild-canvas': () => figure('worldbuild-canvas', svg(
    '<rect class="help-demo-lane" x="8" y="8" width="304" height="104" rx="8"/>'
    + card(24, 20, 82, 'Home', 0)
    + card(132, 48, 92, 'Fieldwork', 0.35)
    + card(234, 20, 68, 'Lab', 0.7)
    + '<line class="help-demo-edge" x1="106" y1="33" x2="132" y2="61" style="animation-delay:0.25s"/>'
    + '<line class="help-demo-edge" x1="224" y1="61" x2="252" y2="33" style="animation-delay:0.55s"/>'
    + '<text x="160" y="102" text-anchor="middle" fill="var(--text-faint)" font-size="9">dotted outline · solid prose link</text>',
    '0 0 320 120',
  ), 'A worldbuilding vein as cards: headings, groups of cards, and the links its prose already makes.'),

  // Fixed-height card beside a card grown to its prose.
  'worldbuild-cards': () => figure('worldbuild-cards', svg(
    '<g class="help-demo-card" style="animation-delay:0s"><rect x="18" y="18" width="118" height="52" rx="5"/><text x="26" y="34">Fixed height</text><text x="26" y="50">prose scrolls</text><text x="26" y="64">260 px</text></g>'
    + '<g class="help-demo-card" style="animation-delay:0.6s"><rect x="184" y="14" width="118" height="96" rx="5"/><text x="192" y="30">Fit to content</text><text x="192" y="46">the whole note shows</text><text x="192" y="62">and the card grows</text><text x="192" y="78">to hold it</text><text x="192" y="94">no inner scrollbar</text></g>'
    + '<text x="160" y="118" text-anchor="middle" fill="var(--text-faint)" font-size="9">per node · default in Settings → Worldbuilding</text>',
    '0 0 320 126',
  ), 'Card height: a fixed box with scrolling prose, or a card fitted to its content.'),

  // The same node with different types, each bringing its fields.
  'worldbuild-types': () => figure('worldbuild-types', (
    '<div class="help-demo-tree">'
    + '<span class="help-demo-line" style="animation-delay:0s">⌂ <b>Place</b> — prose, like a note</span>'
    + '<span class="help-demo-line" style="animation-delay:0.4s">Σ <b>Stat</b> — value: 42</span>'
    + '<span class="help-demo-line" style="animation-delay:0.8s">◆ <b>Skill</b> — level 0–10</span>'
    + '<span class="help-demo-line" style="animation-delay:1.2s">≡ <b>Attribute</b> — sieve mesh · 0.5 mm</span>'
    + '</div>'
  ), 'A node’s type gives it an icon, a colour and, for game-like types, its own fields.'),

  // A group box, a bond with a word, and a second weight for group bonds.
  'worldbuild-bonds': () => figure('worldbuild-bonds', svg(
    '<rect x="10" y="10" width="150" height="100" rx="8" fill="rgba(88,166,255,0.06)" stroke="var(--border-strong)" stroke-dasharray="6 4"/>'
    + '<text class="help-demo-lane-label" x="18" y="24">Group · Caldera</text>'
    + card(20, 32, 72, 'Vent', 0)
    + card(20, 74, 72, 'Deposit', 0.4)
    + card(202, 44, 84, 'Assay', 0.7)
    + '<line class="help-demo-edge" x1="164" y1="53" x2="202" y2="55" style="animation-delay:0.25s"/>'
    + '<text x="168" y="46" fill="var(--ok)" font-size="9">ally</text>'
    + '<text x="164" y="98" fill="var(--text-faint)" font-size="9">group bond · twice the weight</text>',
    '0 0 320 120',
  ), 'Groups box cards that move together; every wire carries a relationship you can step or reverse.'),

  // One canvas step swapped: a card's height, named in the history.
  'worldbuild-history': () => figure('worldbuild-history', (
    '<div class="help-demo-undo">'
    + '<span class="help-demo-undo-after">Fixed height · “Field notes”</span>'
    + '<span class="help-demo-undo-arrow">↶</span>'
    + '<span class="help-demo-undo-before">Fit to content · “Field notes”</span>'
    + '</div>'
  ), 'Canvas undo is its own named history: every drag, layout and setting is one step you can jump back to.'),

  // Version pill, download bar, restart into the new version.
  'update-flow': () => figure('update-flow', (
    '<div class="help-demo-update">'
    + '<span class="help-demo-version">0.1.0</span><span class="help-demo-arrow">→</span>'
    + '<span class="help-demo-version is-new">0.1.1</span>'
    + '<span class="help-demo-download"><span class="help-demo-download-fill"></span></span>'
    + '<span class="help-demo-update-note">signed · verified · installed in place · restarted</span>'
    + '</div>'
  ), 'Signed self-update: check latest.json, verify, download, install in place, restart.'),
};

/** Every demo kind the generator knows, in manual order. */
export const DEMO_KINDS = Object.keys(DEMOS);

/**
 * The animated figure for a demo kind, or '' for an unknown kind.
 * The same kind always produces the same HTML (the demos are baked in).
 */
export function demoHtml(kind) {
  return DEMOS[kind]?.() ?? '';
}
