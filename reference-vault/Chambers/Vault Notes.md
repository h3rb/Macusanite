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
**Ctrl+Shift+Z** restore the vault exactly — colours included.

## Keyboard

| Keys | Action |
| --- | --- |
| `Ctrl+S` | save the open vein |
| `Ctrl+Z` / `Ctrl+Shift+Z` | undo / redo |
| `Ctrl+K` | jump to a vein by name |
| `Alt+Left` / `Alt+Right` | navigate back / forward |
