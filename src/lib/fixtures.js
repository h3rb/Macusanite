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
 */
import { DEFAULT_SETTINGS } from './settings.js';

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
**Ctrl+Shift+Z** restore the vault exactly — colours included.

## Keyboard

| Keys | Action |
| --- | --- |
| \`Ctrl+S\` | save the open vein |
| \`Ctrl+Z\` / \`Ctrl+Shift+Z\` | undo / redo |
| \`Ctrl+K\` | jump to a vein by name |
| \`Alt+Left\` / \`Alt+Right\` | navigate back / forward |
`;

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
  };
}

export const SAMPLE_VAULT_NAME = 'Macusanite Sample Vault';
