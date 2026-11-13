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
| Locked group | the red group on Home: cards cannot move, edit or be removed, but links still work |
| Pinned group and node | the blue group and the pinned card: **Arrange** flows around them |
| Health / orphans panel | the ⚠ chip in the canvas toolbar |
| Elbow connectors + arrowheads | the routing toggles in the toolbar (on for Home) |
| Annotations | the **Note** button, or double-click empty canvas; drag, edit or delete them |
| Node types, fields, colours, images | a card's type menu and the right-click menu (**Set colour**, **Embed image**) — all undoable |

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
