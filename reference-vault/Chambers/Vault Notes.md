---
title: Vault Notes
color: '#a6a6a6'
tags: [guide]
---
# Vault notes

## What lives in .macusanite

| File | Purpose |
| --- | --- |
| `vault.json` | name, description, created |
| `settings.json` | colours, graph options, layout |
| `colors.json` | every page/link/section colour you have picked |
| `history.json` | the undo and redo stacks |
| `logs/` | one JSONL session log per day |

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

```sh
macusanite --vault MyVault vault export my-vault.tar.gz
macusanite --vault OtherFolder vault import my-vault.tar.gz
```

Import updates the open vault in place. If existing files would change, it
refuses and names them until you confirm with `--overwrite`. Share the
`.tar.gz` with anyone; they import it the same way.

## Keyboard

| Keys | Action |
| --- | --- |
| `Ctrl+S` | save the open vein |
| `Ctrl+Z` / `Ctrl+Shift+Z` | undo / redo |
| `Ctrl+K` | jump to a vein by name |
| `Alt+Left` / `Alt+Right` | navigate back / forward |
