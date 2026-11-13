/**
 * The sample vault.
 *
 * Single source of truth for two consumers:
 *   * the browser fallback filesystem (so the UI is testable without Tauri)
 *   * `scripts/make-reference-vault.mjs`, which writes it to disk as
 *     `reference-vault/` for the desktop build to open.
 *
 * Content is deliberately varied: front-matter colours, section links, an
 * unresolved link (which the UI offers to create), tags and mermaid diagrams.
 * Home also carries a Worldbuilding canvas record (in `.macusanite/state.json`)
 * demonstrating locking, pinning, routing, annotations, node types and named
 * canvas history, and Vault Notes tours every recent canvas feature.
 */
import { DEFAULT_SETTINGS } from './settings.js';
import { canvasSnapshot } from './worldbuild.js';

const HOME = `---
title: Macusanite
color: '#ffd700'
link-color: Coral
tags: [guide, vault]
---
# Welcome to your vault

Macusanite reads a **vault**: a folder tree full of markdown. Folders are
*chambers*, and every \`.md\` file inside them is a *vein*.

> [!TIP] Everything below is a live document — click a link, then watch the graph
> on the right recolour and the breadcrumbs at the top fill in.

## The three panes

| Pane | What it does |
| --- | --- |
| Left | Vault tree — click a chamber to fold it open, click a vein to read it |
| Centre | The rendered vein, with colour swatches beside pages, links and sections |
| Right | Concept graph of this note and its context in the wider vault |

## Where to go next

* [[Chambers/Fieldwork/Macusanite Occurrence]] — where the glass is found
* [[Chambers/Mineralogy/Cesium Enrichment]] — why this rock matters
* [[Chambers/Lab/Analytical Methods]] — how we measure it
* [[Chambers/Fieldwork/Sampling Plan|the sampling plan]] — aliased links work too
* [[Glossary]] — not written yet, so this one is a ghost you can create

## Diagramming

Mermaid fences are rendered in place:

\`\`\`mermaid
flowchart LR
  Field[Field sampling] --> Prep[Sample prep]
  Prep --> Analysis[Analysis]
  Analysis --> Model[Petrogenetic model]
  Field --> Log[Field log]
\`\`\`

## Reference cards and hand-written links

A reference card points at another vein without leaving this one:
![[Chambers/Fieldwork/Sampling Plan]]

Ordinary markdown links work as well — [the sieve series](Chambers/Lab/Analytical%20Methods.md#Sieve%20series),
a hand-written one with spaces in the name, [analytical methods](Chambers/Lab/Analytical Methods.md), and web
links such as [mermaid docs](https://mermaid.js.org/) open in your browser instead of the vault window.

- [x] open a vault
- [ ] colour a section
- [ ] create a vein from a ghost link

## Colour, everywhere

Every page, every link and every section can carry a colour. Click the little
swatch next to a heading or a link and pick one — link colours fade along the
line in the graph towards the colour of their target.

## Try the Worldbuilding canvas

This page opens as a Worldbuilding canvas (the switch at the top right of the
centre pane). Everything new lives here:

* **Overview** folds every card and link section, then fits the whole graph to
  the screen — a bird's-eye table of contents. **Fit**, **Fit selection** and
  **Centre** find far-apart cards without panning.
* Cards snap to guides while dragging; a Ctrl+click selection drags as a unit,
  then **Align** and **Distribute** tidy the set.
* The red group is **locked**: its cards cannot move or be removed, but links
  can still be added. The blue group and the pinned card stay put while
  **Arrange** works around them.
* Connectors run as **elbow** wires with **arrowheads**, and the yellow notes
  are free-floating **annotations**. The health panel (⚠ in the toolbar) lists
  orphans and thin groups.
* Canvas undo steps are **named** — use the history browser beside the undo
  button to jump between them, and the file-history log to see the vault's
  whole story.

For the full tour, see [[Chambers/Vault Notes#Worldbuilding canvas tour]].
`;

const OCCURRENCE = `---
title: Macusanite Occurrence
color: '#ff8c00'
link-color: '#ff8c00'
tags: [fieldwork, petrology]
---
# Macusanite Occurrence

Macusanite is a caesium-rich volcanic glass found near **Macusani, Peru**, in
Pliocene ignimbrites.

## Setting

The glass occurs as dense obsidian-like lenses inside ash-flow tuff. See
[[Chambers/Mineralogy/Fluid Inclusions]] for what the bubbles tell us, and
[[Chambers/Fieldwork/Sampling Plan]] for how we collect it.

### Structural control

Lenses sit along a NE-trending fault system. Weathering rinds are thin, which
means the glass is unusually fresh for its age.

## Mineralogy

* [[Chambers/Mineralogy/Cesium Enrichment]]
* [[Chambers/Lab/Analytical Methods]]
* [[#Field checklist]] — a link to a section of this very note

## Field checklist

1. Record GPS and lithology for every lens.
2. Wrap samples in foil before the rind dries out.
3. Log grain size on the [[Chambers/Lab/Analytical Methods#Sieve series|sieve series]].
`;

const SAMPLING = `---
title: Sampling Plan
color: '#87ceeb'
tags: [fieldwork, planning]
---
# Sampling Plan

## Objectives

Collect at least 12 fresh lenses per transect so that
[[Chambers/Lab/Analytical Methods]] has statistical weight.

## Transects

| Transect | Location | Target | Notes |
| --- | --- | --- | --- |
| T1 | North ridge | 12 lenses | fault-controlled |
| T2 | Dry wash | 8 lenses | reworked clasts |
| T3 | Plateau | 15 lenses | freshest glass |

## Sequence

\`\`\`mermaid
sequenceDiagram
  participant Field
  participant Lab
  Field->>Lab: deliver 35 wrapped samples
  Lab-->>Field: grain size + Cs assay
  Field->>Field: update [[Chambers/Fieldwork/Macusanite Occurrence]]
\`\`\`

## Risks

- Rind formation if samples stand wet overnight.
- Duplicate lenses: cross-check with [[Chambers/Mineralogy/Fluid Inclusions]].
`;

const INCLUSIONS = `---
title: Fluid Inclusions
color: '#98fb98'
tags: [mineralogy, methods]
---
# Fluid Inclusions

Heating and freezing stages on doubly polished wafers.

## What they record

Homogenisation temperatures cluster near 780 °C, which suggests a very hot,
dry melt — consistent with the caesium budget in
[[Chambers/Mineralogy/Cesium Enrichment]].

## Method

1. Prepare 150 µm wafers.
2. Freeze to -180 °C, then heat at 5 °C/min.
3. Tabulate with [[Chambers/Lab/Analytical Methods#Calibration]].

## Interpretation

\`\`\`mermaid
graph TD
  Glass --> Bubbles[Inclusion bubbles]
  Bubbles --> T[Th 780C]
  T --> Model[Dry hot melt]
  Model --> Cs[Cs retention]
\`\`\`
`;

const CESIUM = `---
title: Cesium Enrichment
color: '#da70d6'
link-color: Violet
tags: [petrology, geochemistry]
---
# Cesium Enrichment

Macusanite carries caesium at concentrations that are economically interesting
and petrologically awkward: Cs does not fit neatly into common phenocrysts.

## The problem

Where does the caesium sit? Two candidates:

- **Glass itself** — a network modifier, weakly bonded.
- **Vapour-phase deposits** — coating vesicle walls.

## Evidence

| Method | Result | Points to |
| --- | --- | --- |
| EMPA | Cs concentrated in glass | glass |
| LA-ICP-MS | Cs spikes on vesicle rims | vapour |
| [[Chambers/Mineralogy/Fluid Inclusions]] | hot, dry homogenisation | dry melt |

## Working model

An extremely fractionated, volatile-rich melt degassed while quenching. See
[[Glossary]] for the terms, and [[Chambers/Fieldwork/Macusanite Occurrence]] for
the field context.
`;

const METHODS = `---
title: Analytical Methods
color: '#a0d911'
tags: [lab, methods]
---
# Analytical Methods

## Sieve series

Standard half-phi sieves from 4 mm down to 32 µm.

## Calibration

Standards are re-measured every ten samples.

### Drift

Drift above 3 % invalidates the batch; the run is repeated. Related:
[[Chambers/Mineralogy/Fluid Inclusions#Method]].

## Instrument map

\`\`\`mermaid
classDiagram
  class Sample {
    +string id
    +float mass
    +assay()
  }
  class Batch {
    +list samples
    +driftCheck()
  }
  Batch --> Sample
\`\`\`
`;

const LOG = `---
title: Vault Notes
color: '#a6a6a6'
tags: [guide]
---
# Vault notes

## What lives in .macusanite

| File | Purpose |
| --- | --- |
| \`vault.json\` | name, description, created |
| \`settings.json\` | colours, graph options, layout |
| \`colors.json\` | every page/link/section colour you have picked |
| \`history.json\` | the undo and redo stacks |
| \`logs/\` | one JSONL session log per day |

## Undo and redo

Edits are recorded as before/after snapshots of a single file, so **Ctrl+Z** and
**Ctrl+Shift+Z** restore the vault exactly — colours included. Canvas steps
carry names, and the history browser beside the canvas undo button jumps
between them; the file-history log shows the vault's whole undo/redo story.

## Worldbuilding canvas tour

Open [[Home]] — it is marked as Worldbuilding, so it opens as a canvas.

| Feature | Where to try it |
| --- | --- |
| Overview (fold-all + fit) | **Overview** in the canvas toolbar |
| Zoom to fit / fit selection / centre on card | **Fit**, **Fit selection**, **Centre** in the toolbar; double-click a card to centre it |
| Smart snap guides | drag any card near another card's edge or centreline |
| Drag a selection as a unit | Ctrl+click several cards, then drag one |
| Align / distribute a selection | right-click a selected card: **Align**, **Distribute** (three or more cards) |
| Locked group | the red group on Home: cards cannot move, edit or be removed, but links still work |
| Pinned group and node | the blue group and the pinned card: **Arrange** flows around them |
| Health / orphans panel | the ⚠ chip in the canvas toolbar |
| Elbow connectors + arrowheads | the routing toggles in the toolbar (on for Home) |
| Annotations | the **Note** button, or double-click empty canvas; drag, edit or delete them |
| Node types, fields, colours, images | a card's type menu and the right-click menu (**Set colour**, **Embed image**) — all undoable |

## Portable export and import

A whole vault — files and undo/redo history — fits in one compressed file:

\`\`\`sh
macusanite --vault MyVault vault export my-vault.tar.gz
macusanite --vault OtherFolder vault import my-vault.tar.gz
\`\`\`

Import updates the open vault in place. If existing files would change, it
refuses and names them until you confirm with \`--overwrite\`. Share the
\`.tar.gz\` with anyone; they import it the same way.

## Keyboard

| Keys | Action |
| --- | --- |
| \`Ctrl+S\` | save the open vein |
| \`Ctrl+Z\` / \`Ctrl+Shift+Z\` | undo / redo |
| \`Ctrl+K\` | jump to a vein by name |
| \`Alt+Left\` / \`Alt+Right\` | navigate back / forward |
`;

/**
 * A tiny embedded image for the reference-card node, so the sample shows the
 * node-image feature without a binary asset. It lives as a file under
 * `.macusanite/node-images/`, referenced by path — the way every node
 * image is stored now.
 */
const DEMO_IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAwMCAO+ip1sAAAAASUVORK5CYII=';
const DEMO_IMAGE_REF = '.macusanite/node-images/demo.png';

/**
 * Home's worldbuilding record: the canvas counterpart of the sample's tour.
 * It carries a locked group, a pinned group and node, elbow routing with
 * arrowheads, annotations, node types/fields/colours/images, folds, and a
 * named canvas history — every recent canvas feature, ready to poke at.
 */
function showcaseWorldRecord() {
  const positions = {
    'welcome-to-your-vault': { x: 40, y: 40 },
    'the-three-panes': { x: 380, y: 40 },
    'where-to-go-next': { x: 720, y: 40 },
    diagramming: { x: 40, y: 360 },
    'reference-cards-and-hand-written-links': { x: 380, y: 360 },
    'colour-everywhere': { x: 720, y: 360 },
    'try-the-worldbuilding-canvas': { x: 380, y: 680 },
  };
  const groups = {
    'g-locked': {
      id: 'g-locked', name: 'Locked demo', color: '#f97066', locked: true,
      members: ['welcome-to-your-vault', 'the-three-panes'], children: [],
    },
    'g-pinned': {
      id: 'g-pinned', name: 'Pinned demo', color: '#58a6ff', pinned: true,
      members: ['diagramming', 'try-the-worldbuilding-canvas'], children: [],
    },
  };
  const relations = {
    'welcome-to-your-vault->the-three-panes': 'contains',
    'try-the-worldbuilding-canvas->welcome-to-your-vault': 'controls',
    'diagramming->reference-cards-and-hand-written-links': 'affects',
    'group:g-locked->where-to-go-next': 'associate',
  };
  const types = {
    diagramming: 'stat',
    'colour-everywhere': 'skill',
    'where-to-go-next': 'place',
    'reference-cards-and-hand-written-links': 'thing',
    'try-the-worldbuilding-canvas': 'scene',
  };
  const fields = {
    diagramming: { value: '3 diagrams' },
    'colour-everywhere': { level: 8 },
  };
  const colors = {
    diagramming: '#57d364',
    'colour-everywhere': '#da70d6',
    'where-to-go-next': '#45c4b0',
    'reference-cards-and-hand-written-links': '#ffa657',
  };
  const images = { 'reference-cards-and-hand-written-links': DEMO_IMAGE_REF };
  const pinned = { 'colour-everywhere': true };
  const locked = { 'where-to-go-next': true };
  const annotations = {
    'ann-tour-1': { id: 'ann-tour-1', x: 760, y: 40, text: 'Start here: Overview folds everything, then fits.' },
    'ann-tour-2': { id: 'ann-tour-2', x: 40, y: 660, text: 'Elbow wires + arrowheads are on for this canvas.' },
  };
  const folded = { 'the-three-panes': { links: true } };
  const view = { x: 0, y: 0, s: 1 };
  const current = { positions, groups, relations, folded, types, fields, colors, images, pinned, locked, annotations, view };
  const tight = {
    ...current,
    positions: Object.fromEntries(Object.keys(positions).map((anchor, i) => [anchor, { x: 40 + (i % 2) * 340, y: 40 + Math.floor(i / 2) * 300 }])),
    groups: {}, relations: {}, folded: {}, types: {}, fields: {}, colors: {}, images: {}, pinned: {}, locked: {}, annotations: {},
  };
  const typed = { ...tight, positions, groups, relations, types, fields };
  const noted = { ...typed, folded, annotations };
  return {
    marked: true,
    positions, groups, relations, folded, types, fields, colors, images, pinned, locked, annotations,
    routing: { elbow: true, arrows: true },
    view,
    history: {
      past: [
        { name: 'Group the welcome cards', snap: canvasSnapshot(tight) },
        { name: 'Set diagramming to a Stat', snap: canvasSnapshot(typed) },
        { name: 'Add demo annotations', snap: canvasSnapshot(noted) },
      ],
      future: [],
    },
  };
}

/** @returns {Record<string, string>} vault path -> file contents */
export function sampleVaultFiles() {
  return {
    'Home.md': HOME,
    'Chambers/Fieldwork/Macusanite Occurrence.md': OCCURRENCE,
    'Chambers/Fieldwork/Sampling Plan.md': SAMPLING,
    'Chambers/Mineralogy/Fluid Inclusions.md': INCLUSIONS,
    'Chambers/Mineralogy/Cesium Enrichment.md': CESIUM,
    'Chambers/Lab/Analytical Methods.md': METHODS,
    'Chambers/Vault Notes.md': LOG,
    '.macusanite/vault.json': JSON.stringify(
      {
        version: 1,
        kind: 'macusanite-vault',
        name: 'Macusanite Sample Vault',
        description: 'Field and laboratory notes for the Macusani glass project.',
        created: '2026-10-11T00:00:00.000Z',
      },
      null,
      2,
    ),
    '.macusanite/settings.json': JSON.stringify(DEFAULT_SETTINGS, null, 2),
    '.macusanite/colors.json': JSON.stringify({ pages: {}, links: {}, sections: {}, concepts: {} }, null, 2),
    [DEMO_IMAGE_REF]: DEMO_IMAGE,
    '.macusanite/state.json': `${JSON.stringify({
      lastPath: 'Home.md',
      nav: {
        entries: [{ path: 'Home.md', section: '', title: 'Macusanite', via: null, ts: 0 }],
        index: 0,
        limit: 200,
      },
      world: { 'Home.md': showcaseWorldRecord() },
      ui: { expanded: { Chambers: true }, mode: 'read', pane: 'tree' },
      savedAt: '2026-10-11T00:00:00.000Z',
    }, null, 2)}\n`,
  };
}

export const SAMPLE_VAULT_NAME = 'Macusanite Sample Vault';
