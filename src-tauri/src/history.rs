//! Undo/redo stacks.
//!
//! Every mutation is recorded as a before/after snapshot of a *single* file, so
//! undo is exact and needs no model of what changed: colours, settings, page
//! edits and page creation all reduce to "put this text back".
//!
//! Stored in `<vault>/.macusanite/history.json` with vault-relative paths, so a
//! vault folder stays portable.

use crate::meta;
use crate::vault;
use serde::{Deserialize, Serialize};
use std::path::Path;

pub const HISTORY_FILE: &str = "history.json";
const MAX_ENTRIES: usize = 400;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Entry {
    /// Vault-relative path of the file that changed.
    pub path: String,
    pub label: String,
    /// `None` means the file did not exist before the change.
    pub before: Option<String>,
    pub after: String,
    pub ts: u128,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Stacks {
    pub version: u32,
    pub undo: Vec<Entry>,
    pub redo: Vec<Entry>,
}

impl Default for Stacks {
    fn default() -> Self {
        Stacks { version: 1, undo: Vec::new(), redo: Vec::new() }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Brief {
    pub path: String,
    pub label: String,
    pub ts: u128,
}

#[derive(Debug, Clone, Serialize)]
pub struct HistoryState {
    pub undo: Vec<Brief>,
    pub redo: Vec<Brief>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MoveResult {
    pub applied: bool,
    pub path: Option<String>,
    pub label: Option<String>,
    pub stacks: HistoryState,
}

pub fn load(root: &Path) -> Stacks {
    meta::read_meta(root, HISTORY_FILE)
        .and_then(|raw| serde_json::from_str::<Stacks>(&raw).ok())
        .unwrap_or_default()
}

pub fn save(root: &Path, stacks: &Stacks) -> Result<(), String> {
    let json = serde_json::to_string_pretty(stacks).map_err(|e| e.to_string())?;
    meta::write_meta_raw(root, HISTORY_FILE, &format!("{json}\n"))
}

pub fn briefs(stacks: &Stacks) -> HistoryState {
    let to_brief = |entries: &Vec<Entry>| {
        entries
            .iter()
            .rev()
            .map(|e| Brief { path: e.path.clone(), label: e.label.clone(), ts: e.ts })
            .collect()
    };
    HistoryState { undo: to_brief(&stacks.undo), redo: to_brief(&stacks.redo) }
}

/// Record a change. `before == after` is ignored so no-op saves stay out of the stack.
pub fn record(root: &Path, path: &str, label: &str, before: Option<String>, after: &str) -> Result<(), String> {
    if before.as_deref() == Some(after) {
        return Ok(());
    }
    let mut stacks = load(root);
    stacks.undo.push(Entry {
        path: path.to_string(),
        label: label.to_string(),
        before,
        after: after.to_string(),
        ts: meta::now_millis(),
    });
    if stacks.undo.len() > MAX_ENTRIES {
        let excess = stacks.undo.len() - MAX_ENTRIES;
        stacks.undo.drain(0..excess);
    }
    stacks.redo.clear();
    save(root, &stacks)
}

pub fn undo(root: &Path) -> Result<MoveResult, String> {
    let mut stacks = load(root);
    let Some(entry) = stacks.undo.pop() else {
        return Ok(MoveResult { applied: false, path: None, label: None, stacks: briefs(&stacks) });
    };
    apply(root, &entry.path, entry.before.as_deref())?;
    stacks.redo.push(entry.clone());
    save(root, &stacks)?;
    Ok(MoveResult {
        applied: true,
        path: Some(entry.path),
        label: Some(entry.label),
        stacks: briefs(&stacks),
    })
}

pub fn redo(root: &Path) -> Result<MoveResult, String> {
    let mut stacks = load(root);
    let Some(entry) = stacks.redo.pop() else {
        return Ok(MoveResult { applied: false, path: None, label: None, stacks: briefs(&stacks) });
    };
    apply(root, &entry.path, Some(entry.after.as_str()))?;
    stacks.undo.push(entry.clone());
    save(root, &stacks)?;
    Ok(MoveResult {
        applied: true,
        path: Some(entry.path),
        label: Some(entry.label),
        stacks: briefs(&stacks),
    })
}

fn apply(root: &Path, path: &str, contents: Option<&str>) -> Result<(), String> {
    match contents {
        Some(text) => vault::write_text(root, path, text),
        None => vault::delete_file(root, path),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_vault(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("macusanite-history-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn undo_and_redo_restore_file_contents() {
        let root = temp_vault("restore");
        vault::write_text(&root, "Notes.md", "first").unwrap();
        record(&root, "Notes.md", "edit Notes.md", Some("first".into()), "second").unwrap();
        vault::write_text(&root, "Notes.md", "second").unwrap();

        let undone = undo(&root).unwrap();
        assert!(undone.applied);
        assert_eq!(vault::read_text(&root, "Notes.md").unwrap(), "first");
        assert_eq!(undone.stacks.redo.len(), 1);

        let redone = redo(&root).unwrap();
        assert!(redone.applied);
        assert_eq!(vault::read_text(&root, "Notes.md").unwrap(), "second");
    }

    #[test]
    fn undoing_a_creation_deletes_the_file() {
        let root = temp_vault("create");
        vault::write_text(&root, "Fresh.md", "hello").unwrap();
        record(&root, "Fresh.md", "create vein", None, "hello").unwrap();

        assert!(undo(&root).unwrap().applied);
        assert!(!vault::exists(&root, "Fresh.md"));

        assert!(redo(&root).unwrap().applied);
        assert_eq!(vault::read_text(&root, "Fresh.md").unwrap(), "hello");
    }

    #[test]
    fn a_new_change_clears_the_redo_branch() {
        let root = temp_vault("branch");
        vault::write_text(&root, "A.md", "1").unwrap();
        record(&root, "A.md", "edit", Some("0".into()), "1").unwrap();
        assert!(undo(&root).unwrap().applied);
        assert_eq!(load(&root).redo.len(), 1);

        vault::write_text(&root, "B.md", "x").unwrap();
        record(&root, "B.md", "create", None, "x").unwrap();
        let stacks = load(&root);
        assert!(stacks.redo.is_empty());
        assert_eq!(stacks.undo.len(), 1);
    }

    #[test]
    fn no_op_writes_are_not_recorded() {
        let root = temp_vault("noop");
        vault::write_text(&root, "A.md", "same").unwrap();
        record(&root, "A.md", "edit", Some("same".into()), "same").unwrap();
        assert!(load(&root).undo.is_empty());
        assert!(!undo(&root).unwrap().applied);
    }
}
