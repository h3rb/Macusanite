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
 * laid out as a labelled feature gallery: progression columns, node and group
 * locks, frozen/Static state, pins, card modes and folds, nested groups, a
 * resized card, a collapsed group, a thin group for the health panel, routing,
 * coloured and folded annotations, node types and named canvas history. Vault
 * Notes tours every recent canvas feature.
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
> on the right recolour and the breadcrumbs at the top fill in. Home is also a
> canvas (switch at the top right): its cards are this page's headings, and the
> labelled clusters demonstrate the canvas features; unrelated cards and groups
> are spaced apart, while nested groups are contained by design.

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

### Flowchart

A flowchart lays a process out left to right — the same shape the
progression board on this canvas borrows: earlier steps on the left,
later ones towards the right.

### Sequence diagram

A sequence diagram names the actors and the order they speak in, top to
bottom. Both diagram kinds render in place, exactly where they are written.

\`\`\`mermaid
sequenceDiagram
  participant Reader
  participant Vault
  participant Graph
  Reader->>Vault: open a vein
  Vault-->>Reader: rendered markdown
  Vault->>Graph: index links and headings
  Graph-->>Reader: concept graph
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
centre pane). The canvas is a tour, not a pile: every feature has a labelled
cluster, and unrelated cards, group boxes, annotations and group tabs are
spaced so they do not cover one another. Nested groups are contained within
their parent group by design.

| Cluster | What to try |
| --- | --- |
| **Progression board** (amber, top) | Heading tiers become columns; drag the group tab or right-click it to split or collapse it |
| **Locked demo** (red) | Gold padlocks are clickable; one card is also node-locked, and the group is locked |
| **Frozen demo** (blue) | Blue snowflakes are **Static**: read-only and fixed; right-click and choose **Unfreeze** is the only exit |
| **Pinned demo** (green) | A pinned group and a pinned node; **Arrange** flows around both |
| **Nested groups** (teal, bottom right) | An outer group contains two child groups; drag a child tab to move its pair, or the outer tab to move the whole hierarchy |
| **Resized card** (inside Nested groups) | The field-notes card is 420 × 180; drag its bottom-right corner to resize it, or double-click that corner to reset it |
| **Annotations** (colour band above the groups) | Right-click a note to choose its colour, or click its chevron to fold it to the coloured header |
| **Card modes** (purple, right) | Full, compact, thumbnail and folded cards, with an image on the thumbnail |
| **Collapsed group** (right, below modes) | One summary card replaces two cards; double-click it to expand |
| **Thin group + orphan card** (bottom left) | Deliberate health warnings: ⚠ lists the one-card group and the unconnected card beside it |

* **Overview** folds every card, then fits the whole graph to the screen — a
  bird's-eye table of contents. **Fit**, **Fit selection** and
  **Centre** find far-apart cards without panning.
* Cards snap to guides while dragging; a Ctrl+click selection drags as a unit,
  then **Align** and **Distribute** tidy the set.
* Drag one free card over another to see the dashed **overlap** warning; use
  **Push aside** while dragging, or **Resolve overlaps** in the inspector.
* Connectors run as **elbow** wires with **arrowheads**, and the notes above
  the groups are free-floating **annotations** in several colours. Click a
  note's chevron to fold it, or right-click it to change its colour. The health
  panel (⚠ in the toolbar) lists orphans and thin groups.
* The **Progression board** group is split into Kanban-style columns by
  heading tier: the top card on the left, its subsections one tier to the
  right, and their own subsections to the right of those. Right-click a
  group to split it, or use **Arrange → Progression**.
* Canvas undo steps are **named** — use the history browser beside the undo
  button to jump between them, and the file-history log to see the vault's
  whole story.

## Freeze and Static

This card sits in the blue **Frozen demo** group. **Freeze** turns a card or a
group **Static**: it stays read-only and fixed in place, and wears a blue
snowflake instead of the gold padlock. A Static item is deliberately not
unlocked by its badge.

## Unfreeze from the menu

Clicking a blue snowflake explains the state; it never clears it. Right-click
the frozen card or group and choose **Unfreeze** — for a card inside a frozen
group, the command is under **Group**. The same menu is the only way out of
Static.

## Card display modes

This is a **Full** card. The **Card modes** group beside it also holds
**Compact**, **Thumbnail** and **Folded** cards. Right-click any card and use
**Card mode**, or choose **Cards ▾** in the toolbar to apply a mode to a whole
selection.

### Compact card

Compact keeps the type, title, link count and word count, then drops the prose
so a dense overview stays readable. This card is compact.

### Thumbnail card

Thumbnail is the node's image — or its initial when it has none — at 128 × 128.
This card uses the sample's node image.

### Folded card

The chevron in a card's head folds it to its header. Folded cards stack neatly
above the card they link to; **Overview** folds the whole canvas at once.

## Collapsible groups

**Collapse to summary** replaces a group's cards with one summary card showing
its name, icon, member count, types and link total. The **Collapsed group**
below starts collapsed; double-click its summary, or choose **Expand group**,
to bring the cards back.

## Collapsed group summary

This card is hidden behind the summary until the group expands. That is the
point: collapse is a view, and the markdown remains exactly as written.

## Health and orphans

This one-card group is deliberately thin. **Health** (⚠ in the toolbar) lists
thin groups and orphans so an unfinished corner is easy to find. This card is
also fitted to its content, showing the whole note without an inner scrollbar;
right-click it and choose **Card height → Fit to content** to do the same to
another full card.

## Nested groups

The **Nested groups** demo is one outer group containing two child groups.
Dragging a child tab moves that child's pair, while dragging the outer tab
moves the direct card and both child groups together.

### Nested group: field notes

This card is **resized** to 420 × 180 canvas pixels. Drag its bottom-right
corner to change that box, and double-click the corner to restore the designed
size.

### Nested group: lab notes

The outer group's tab sits above both child tabs, so the hierarchy is visible
without hiding either child group's own controls.

### Nested group: samples

A child group can hold its own cards while its parent holds another card and
the child group. This cluster shows that arrangement.

### Nested group: results

Select the outer group to move the whole hierarchy, or select either child to
move only that child's cards.

# Orphan card

This card has no group and no wires. Health lists it as an **orphan**, beside
the thin group next door; click either row to select and centre it.

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

## Formation

\`\`\`mermaid
stateDiagram-v2
  state "Ash flow" as AshFlow
  state "Macusanite glass" as Glass
  state "Weathering rind" as Rind
  state "Dense lens" as Lens
  [*] --> AshFlow
  AshFlow --> Glass: rapid quench
  Glass --> Rind: weathering
  Glass --> Lens: dense obsidian
  Rind --> [*]: sample lost
  Lens --> [*]: collected
\`\`\`

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

## Schedule

\`\`\`mermaid
gantt
  title Field season
  dateFormat YYYY-MM-DD
  axisFormat %b %d
  section Reconnaissance
  North ridge :done, t1, 2026-05-04, 5d
  Dry wash :active, t2, after t1, 4d
  section Collection
  Plateau :t3, after t2, 6d
  Lab handoff :milestone, m1, after t3, 0d
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

## Thermal path

\`\`\`mermaid
timeline
  title Cooling path recorded by the inclusions
  780 °C : Melt trapped
  500 °C : Bubble nucleates
  20 °C : Wafer measured
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

## Caesium budget

\`\`\`mermaid
pie showData
  title Where the caesium sits
  "Glass network" : 55
  "Vesicle rims" : 30
  "Phenocryst rims" : 15
\`\`\`

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

## Sample flow

\`\`\`mermaid
erDiagram
  BATCH ||--o{ SAMPLE : contains
  SAMPLE ||--o{ MEASUREMENT : yields
  BATCH {
    string id
    string prepared
  }
  SAMPLE {
    string id
    float mass
  }
  MEASUREMENT {
    string method
    float value
  }
\`\`\`

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
| Overlap warning, push aside, resolve | drag one free card over another, then try **Push aside** or **Resolve overlaps** |
| Progression columns | the amber **Progression board** on Home: heading tiers left to right, tier headers over each lane |
| Locked group + clickable padlock | the red **Locked demo** on Home: cards cannot move, edit or be removed, but links still work; click its gold padlock to unlock |
| Frozen / Static | the blue **Frozen demo**: a blue snowflake is read-only and fixed; only **Unfreeze** in the right-click menu clears it |
| Pinned group and node | the green **Pinned demo**: pinned cards and groups stay put while **Arrange** works around them |
| Card modes and folds | the purple **Card modes** group: full, compact, thumbnail and folded cards |
| Card height / fit to content | the **Thin group** card at the bottom uses **Fit to content**; right-click any card to choose **Card height** |
| Nested groups | the teal **Nested groups** cluster on Home: an outer group holding two child groups |
| Resized cards | drag a card's bottom-right corner; the field-notes card in **Nested groups** is 420 × 180 |
| Annotation colour and fold | the notes above the demo groups: right-click for a colour, or click the chevron to fold one |
| Collapsed group + summary | the **Collapsed group** on Home: one summary card replaces its cards; double-click to expand |
| Annotations | the coloured **Note** boxes above the demo groups; right-click to change colour, and drag, edit, fold or delete them |
| Health / orphans panel | the ⚠ chip in the toolbar; the bottom **Thin group** and **Orphan card** are deliberate warnings |
| Elbow connectors + arrowheads | the routing toggles in the toolbar (on for Home) |
| Node types, fields, colours, images | a card's type menu and the right-click menu (**Card mode**, **Card height**, **Set colour**, **Embed image**); the thumbnail card shows an image |
| Named canvas history | the history browser beside the canvas undo button, or **More ▾ → History** |

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
 * A small embedded illustration for the reference and thumbnail cards, so the
 * sample shows the node-image feature clearly without a binary asset. It lives
 * as a file under `.macusanite/node-images/`, referenced by path — the way
 * every node image is stored now.
 */
const DEMO_IMAGE = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180">
  <rect width="320" height="180" rx="18" fill="#1d2733"/>
  <path d="M18 138 C72 92 120 70 176 82 C228 94 270 120 302 142 L302 164 L18 164 Z" fill="#2d3b49"/>
  <ellipse cx="160" cy="92" rx="88" ry="38" fill="#ff8c00" fill-opacity="0.82" stroke="#ffd166" stroke-width="3"/>
  <ellipse cx="143" cy="82" rx="40" ry="15" fill="#fff3c4" fill-opacity="0.5"/>
  <path d="M66 130 L116 111 L177 120 L254 102" fill="none" stroke="#ffd166" stroke-width="2" stroke-dasharray="7 6" opacity="0.8"/>
  <text x="24" y="38" fill="#ffd166" font-family="system-ui, sans-serif" font-size="18" font-weight="700">MACUSANITE</text>
  <text x="24" y="57" fill="#c9d1d9" font-family="system-ui, sans-serif" font-size="11">obsidian lens in ash-flow tuff</text>
</svg>`)}`;
const DEMO_IMAGE_REF = '.macusanite/node-images/macusanite-lens.svg';

/**
 * Home's worldbuilding record: the canvas counterpart of the sample's tour.
 * It carries a locked group, a frozen/Static group, a pinned group and node,
 * card modes and a fold, nested groups, a resized card, a collapsed group, a
 * thin group for Health, elbow routing with arrowheads, coloured and folded
 * annotations, node types/fields/colours/images and a named canvas history —
 * every recent canvas feature, ready to poke at.
 */
function showcaseWorldRecord() {
  // The gallery is a four-column grid: 300px cards, 96px horizontal gaps and
  // 76px vertical gaps. The progression board fills the top three columns; the
  // card-mode stack fills the fourth. Below a clear annotation band, four demo
  // groups sit side by side, and the thin health group is alone at the bottom.
  // Every box is separated by at least 60px so no card, group box, tab or note
  // can cover another.
  const positions = {
    // Progression board: tier 0 at x=40, tier 1 at x=436, tier 2 at x=832.
    'welcome-to-your-vault': { x: 40, y: 40 },
    diagramming: { x: 436, y: 40 },
    'reference-cards-and-hand-written-links': { x: 436, y: 376 },
    flowchart: { x: 832, y: 40 },
    'sequence-diagram': { x: 832, y: 376 },
    // Card display modes, stacked in the fourth column.
    'card-display-modes': { x: 1228, y: 40 },
    'compact-card': { x: 1228, y: 376 },
    'thumbnail-card': { x: 1228, y: 712 },
    'folded-card': { x: 1228, y: 880 },
    // The four state demos, below the annotation band.
    'where-to-go-next': { x: 40, y: 1080 },
    'colour-everywhere': { x: 40, y: 1416 },
    'freeze-and-static': { x: 436, y: 1080 },
    'unfreeze-from-the-menu': { x: 436, y: 1416 },
    'try-the-worldbuilding-canvas': { x: 832, y: 1080 },
    'the-three-panes': { x: 832, y: 1416 },
    'collapsible-groups': { x: 1228, y: 1080 },
    'collapsed-group-summary': { x: 1228, y: 1416 },
    // One deliberate thin group for the health panel.
    'health-and-orphans': { x: 40, y: 1760 },
    'orphan-card': { x: 436, y: 1760 },
    // The nested-group cluster: one outer group holding a direct card and two
    // child groups. The field-notes card is deliberately resized; the outer
    // box and both child boxes are nested, not separate clusters.
    'nested-groups': { x: 832, y: 1760 },
    'nested-group-field-notes': { x: 832, y: 2096 },
    'nested-group-lab-notes': { x: 832, y: 2352 },
    'nested-group-samples': { x: 1324, y: 2096 },
    'nested-group-results': { x: 1324, y: 2432 },
  };
  const groups = {
    'g-progression': {
      id: 'g-progression', name: 'Progression board', color: '#d29922', icon: '▦', layout: 'progression',
      members: ['welcome-to-your-vault', 'diagramming', 'reference-cards-and-hand-written-links', 'flowchart', 'sequence-diagram'],
      children: [],
    },
    'g-locked': {
      id: 'g-locked', name: 'Locked demo — click the padlock', color: '#f97066', icon: '⚙', locked: true,
      members: ['where-to-go-next', 'colour-everywhere'], children: [],
    },
    'g-frozen': {
      id: 'g-frozen', name: 'Frozen demo — right-click Unfreeze', color: '#58a6ff', icon: '✦', locked: 'frozen',
      members: ['freeze-and-static', 'unfreeze-from-the-menu'], children: [],
    },
    'g-pinned': {
      id: 'g-pinned', name: 'Pinned demo', color: '#57d364', icon: '⌂', pinned: true,
      members: ['try-the-worldbuilding-canvas', 'the-three-panes'], children: [],
    },
    'g-modes': {
      id: 'g-modes', name: 'Card modes', color: '#bc8cff', icon: '▦',
      members: ['card-display-modes', 'compact-card', 'thumbnail-card', 'folded-card'], children: [],
    },
    'g-collapsed': {
      id: 'g-collapsed', name: 'Collapsed group', color: '#8d6e63', icon: '▣',
      members: ['collapsible-groups', 'collapsed-group-summary'], children: [],
    },
    'g-thin': {
      id: 'g-thin', name: 'Thin group — health warning', color: '#ffa657', icon: '⚠',
      members: ['health-and-orphans'], children: [],
    },
    'g-nested-outer': {
      id: 'g-nested-outer', name: 'Nested groups', color: '#45c4b0', icon: '⁂',
      members: ['nested-groups'], children: ['g-nested-field', 'g-nested-results'],
    },
    'g-nested-field': {
      id: 'g-nested-field', name: 'Nested group: field', color: '#57d364', icon: '⌂',
      members: ['nested-group-field-notes', 'nested-group-lab-notes'], children: [],
    },
    'g-nested-results': {
      id: 'g-nested-results', name: 'Nested group: results', color: '#da70d6', icon: '≡',
      members: ['nested-group-samples', 'nested-group-results'], children: [],
    },
  };
  const relations = {
    'welcome-to-your-vault->the-three-panes': 'contains',
    'try-the-worldbuilding-canvas->welcome-to-your-vault': 'controls',
    'diagramming->reference-cards-and-hand-written-links': 'affects',
    'diagramming->flowchart': 'contains',
    'group:g-locked->where-to-go-next': 'associate',
    'group:g-frozen->welcome-to-your-vault': 'controls',
    'card-display-modes->thumbnail-card': 'contains',
    'collapsible-groups->collapsed-group-summary': 'contains',
  };
  const types = {
    diagramming: 'stat',
    flowchart: 'stat',
    'colour-everywhere': 'skill',
    'where-to-go-next': 'place',
    'reference-cards-and-hand-written-links': 'thing',
    'try-the-worldbuilding-canvas': 'scene',
    'the-three-panes': 'table',
    'freeze-and-static': 'mode',
    'unfreeze-from-the-menu': 'condition',
    'card-display-modes': 'note',
    'compact-card': 'rating',
    'thumbnail-card': 'image',
    'folded-card': 'property',
    'collapsible-groups': 'attribute',
    'collapsed-group-summary': 'property',
    'health-and-orphans': 'condition',
    'orphan-card': 'note',
  };
  const fields = {
    diagramming: { value: '3 diagrams' },
    flowchart: { value: '1 flowchart' },
    'colour-everywhere': { level: 8 },
    'compact-card': { value: 8 },
    'folded-card': { key: 'view', value: 'folded' },
    'collapsible-groups': { key: 'group', value: 'collapsed' },
    'collapsed-group-summary': { key: 'summary', value: 'one card' },
  };
  const colors = {
    diagramming: '#57d364',
    'colour-everywhere': '#da70d6',
    'where-to-go-next': '#45c4b0',
    'reference-cards-and-hand-written-links': '#ffa657',
    'freeze-and-static': '#58a6ff',
    'unfreeze-from-the-menu': '#79c0ff',
    'card-display-modes': '#bc8cff',
    'compact-card': '#ffd166',
    'thumbnail-card': '#ff8c00',
    'folded-card': '#8b949e',
    'collapsible-groups': '#d2a8ff',
    'collapsed-group-summary': '#8d6e63',
    'health-and-orphans': '#ffa657',
    'orphan-card': '#8b949e',
  };
  const images = {
    'reference-cards-and-hand-written-links': DEMO_IMAGE_REF,
    'thumbnail-card': DEMO_IMAGE_REF,
  };
  const pinned = { 'the-three-panes': true };
  const locked = { 'where-to-go-next': true };
  const cardModes = { 'compact-card': 'compact', 'thumbnail-card': 'thumbnail' };
  const cardSizes = { 'health-and-orphans': 'content' };
  const collapsedGroups = { 'g-collapsed': true };
  const folded = { 'folded-card': { card: true } };
  const cardDims = {
    'nested-group-field-notes': { width: 420, height: 180 },
  };
  const annotations = {
    'ann-overview': { id: 'ann-overview', x: 40, y: 700, text: 'Overview folds every card, then fits the whole gallery.' },
    'ann-static': {
      id: 'ann-static', x: 316, y: 700, color: '#58a6ff', folded: true,
      text: 'Blue snowflake = Static. Right-click and choose Unfreeze.',
    },
    'ann-wires': {
      id: 'ann-wires', x: 592, y: 700, color: '#57d364',
      text: 'Elbow wires and arrowheads; drag a card to see overlap warnings.',
    },
    'ann-nested': {
      id: 'ann-nested', x: 868, y: 700, color: '#da70d6', folded: true,
      text: 'Nested groups: drag a child tab to move its pair, or the outer tab to move all five cards.',
    },
  };
  const view = { x: 0, y: 0, s: 1 };
  const current = {
    positions, groups, relations, folded, types, fields, colors, images, pinned, locked,
    cardModes, cardSizes, cardDims, collapsedGroups, annotations, view,
  };
  const tight = {
    ...current,
    positions: Object.fromEntries(Object.keys(positions).map((anchor, i) => [
      anchor,
      { x: 40 + (i % 3) * 396, y: 40 + Math.floor(i / 3) * 336 },
    ])),
    groups: {},
    relations: {},
    folded: {},
    types: {},
    fields: {},
    colors: {},
    images: {},
    pinned: {},
    locked: {},
    cardModes: {},
    cardSizes: {},
    cardDims: {},
    collapsedGroups: {},
    annotations: {},
  };
  const typed = { ...tight, positions, groups, relations, types, fields };
  const noted = {
    ...typed,
    folded,
    colors,
    images,
    pinned,
    locked,
    cardModes,
    cardSizes,
    cardDims,
    collapsedGroups,
    annotations,
  };
  return {
    marked: true,
    positions,
    groups,
    relations,
    folded,
    types,
    fields,
    colors,
    images,
    pinned,
    locked,
    cardModes,
    cardSizes,
    cardDims,
    collapsedGroups,
    annotations,
    routing: { elbow: true, arrows: true },
    view,
    history: {
      past: [
        { name: 'Place the feature gallery', snap: canvasSnapshot(tight) },
        { name: 'Add the tour groups and labels', snap: canvasSnapshot(typed) },
        { name: 'Freeze, pin, collapse and annotate', snap: canvasSnapshot(noted) },
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
