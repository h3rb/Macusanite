//! Macusanite's Rust core.
//!
//! The webview owns all application logic; these commands are a thin, safe
//! filesystem layer over the currently open vault: scan, read, write, undo,
//! log and the native folder picker.

mod history;
mod meta;
mod vault;
mod watch;

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

/// The vault the window is currently looking at.
#[derive(Default)]
pub struct VaultState(Mutex<Option<PathBuf>>);

impl VaultState {
    fn root(&self) -> Result<PathBuf, String> {
        self.0
            .lock()
            .map_err(|_| "vault state is poisoned".to_string())?
            .clone()
            .ok_or_else(|| "no vault is open".to_string())
    }

    fn set(&self, path: PathBuf) -> Result<(), String> {
        let mut guard = self.0.lock().map_err(|_| "vault state is poisoned".to_string())?;
        *guard = Some(path);
        Ok(())
    }
}

/// The live watcher, if one is running. Replacing the handle stops the previous
/// watch, which is exactly what switching vaults wants; re-opening the vault
/// that is already being watched changes nothing.
#[derive(Default)]
pub struct WatcherState(Mutex<Option<(PathBuf, watch::Handle)>>);

impl WatcherState {
    /// Watch `root`, reporting whether a new watch had to be started.
    fn arm(&self, app: &AppHandle, root: &Path) -> Result<bool, String> {
        if let Some((watching, _)) = self.0.lock().map_err(|_| "watcher state is poisoned".to_string())?.as_ref() {
            if watching.as_path() == root {
                return Ok(false);
            }
        }

        let self_writes = Arc::clone(app.state::<Arc<watch::SelfWrites>>().inner());
        let emitter = app.clone();
        let handle = watch::start(root, self_writes, move |batch| {
            if batch.is_empty() {
                return;
            }
            // The frontend reads the paths and re-reads what it needs; a failed
            // emit only means the window is gone.
            let _ = emitter.emit(watch::EVENT, batch);
        })?;

        let mut guard = self.0.lock().map_err(|_| "watcher state is poisoned".to_string())?;
        *guard = Some((root.to_path_buf(), handle));
        Ok(true)
    }
}

/// Watching is an enhancement: a vault that cannot be watched still opens, with
/// a note in the session log instead.
fn arm_watcher(app: &AppHandle, root: &Path) {
    let state = app.state::<WatcherState>();
    match state.arm(app, root) {
        Ok(true) => meta::append_log(root, "info", "watching the vault for external changes"),
        Ok(false) => {}
        Err(error) => meta::append_log(root, "warn", &format!("filesystem watching unavailable: {error}")),
    }
}

/// Tell the watcher about a write of ours, so it does not report it back.
fn remember_write(app: &AppHandle, rel: &str) {
    let writes = app.state::<Arc<watch::SelfWrites>>();
    // Undo can move a metadata file as easily as a vein, and those two are on the
    // short silence — see `watch::META_WRITE_WINDOW`.
    if watch::is_live_meta(rel) {
        writes.record_meta(rel);
    } else {
        writes.record(rel);
    }
}

/// Remember a `.macusanite` file we are about to write.
///
/// `settings.json` and `colors.json` are followed live, so a save of ours would
/// otherwise come straight back as an external change and undo the edit the
/// moment it landed. The viewer's own metadata never echoes back.
fn remember_meta_write(app: &AppHandle, name: &str) {
    watch::record_meta_write(app.state::<Arc<watch::SelfWrites>>().inner(), name);
}

#[derive(Debug, Serialize)]
struct PathResult {
    path: String,
}

#[derive(Debug, Serialize)]
struct CreateResult {
    path: String,
    created: bool,
}

/* ── vault lifecycle ───────────────────────────────────────────────────── */

#[tauri::command]
fn open_vault(app: AppHandle, vault: String, state: State<'_, VaultState>) -> Result<meta::VaultInfo, String> {
    let candidate = PathBuf::from(&vault);
    if !candidate.is_dir() {
        return Err(format!("not a folder: {vault}"));
    }
    let root = candidate.canonicalize().map_err(|e| format!("{vault}: {e}"))?;
    let info = meta::ensure_meta(&root, None, None)?;
    state.set(root.clone())?;
    arm_watcher(&app, &root);
    Ok(info)
}

#[tauri::command]
fn create_vault(
    app: AppHandle,
    vault: String,
    name: String,
    description: String,
    state: State<'_, VaultState>,
) -> Result<meta::VaultInfo, String> {
    let candidate = PathBuf::from(&vault);
    std::fs::create_dir_all(&candidate).map_err(|e| format!("{vault}: {e}"))?;
    let root = candidate.canonicalize().map_err(|e| format!("{vault}: {e}"))?;
    let info = meta::ensure_meta(&root, Some(&name), Some(&description))?;
    meta::append_log(&root, "info", &format!("vault created: {}", info.name));
    state.set(root.clone())?;
    arm_watcher(&app, &root);
    Ok(info)
}

/// A vault passed on the command line (`macusanite C:\\Vaults\\Notes`), if any.
/// The frontend asks for it once at startup so `open_vault` stays the single
/// code path that actually loads a vault.
#[tauri::command]
fn startup_vault(state: State<'_, VaultState>) -> Result<Option<meta::VaultInfo>, String> {
    let root = {
        let guard = state.0.lock().map_err(|_| "vault state is poisoned".to_string())?;
        guard.clone()
    };
    match root {
        Some(root) => Ok(Some(meta::ensure_meta(&root, None, None)?)),
        None => Ok(None),
    }
}

/// One walk of the vault: the tree, the vein list and when each vein last
/// changed. Nothing is opened — this is what lets a large vault open at once,
/// with the index coming from `.macusanite/index.json` for everything that did
/// not move.
#[derive(Debug, Serialize)]
struct VaultScan {
    tree: Vec<vault::TreeNode>,
    veins: Vec<String>,
    stats: Vec<vault::FileStat>,
}

#[tauri::command]
fn vault_scan(state: State<'_, VaultState>) -> Result<VaultScan, String> {
    let root = state.root()?;
    let scan = vault::scan(&root).map_err(|e| e.to_string())?;
    Ok(VaultScan {
        tree: vault::build_tree(&scan),
        veins: scan.veins.clone(),
        stats: scan.stats.clone(),
    })
}

#[tauri::command]
fn vault_stat(rel: String, state: State<'_, VaultState>) -> Result<vault::FileStat, String> {
    let root = state.root()?;
    let path = vault::resolve_in_vault(&root, &rel)?;
    vault::FileStat::of(&root, &path).map_err(|e| format!("{rel}: {e}"))
}

#[tauri::command]
fn vault_tree(state: State<'_, VaultState>) -> Result<Vec<vault::TreeNode>, String> {
    let root = state.root()?;
    let scan = vault::scan(&root).map_err(|e| e.to_string())?;
    Ok(vault::build_tree(&scan))
}

#[tauri::command]
fn list_veins(state: State<'_, VaultState>) -> Result<Vec<String>, String> {
    let root = state.root()?;
    let scan = vault::scan(&root).map_err(|e| e.to_string())?;
    Ok(scan.veins)
}

/* ── veins and chambers ────────────────────────────────────────────────── */

#[tauri::command]
fn read_vein(rel: String, state: State<'_, VaultState>) -> Result<String, String> {
    let root = state.root()?;
    vault::read_text(&root, &rel)
}

#[tauri::command]
fn write_vein(
    app: AppHandle,
    rel: String,
    contents: String,
    label: Option<String>,
    state: State<'_, VaultState>,
) -> Result<PathResult, String> {
    let root = state.root()?;
    remember_write(&app, &rel);
    let before = if vault::exists(&root, &rel) {
        Some(vault::read_text(&root, &rel)?)
    } else {
        None
    };
    vault::write_text(&root, &rel, &contents)?;
    history::record(&root, &rel, label.as_deref().unwrap_or(&format!("edit {rel}")), before, &contents)?;
    meta::append_log(&root, "info", &format!("vein written: {rel}"));
    Ok(PathResult { path: rel })
}

#[tauri::command]
fn create_vein(
    app: AppHandle,
    rel: String,
    contents: Option<String>,
    state: State<'_, VaultState>,
) -> Result<CreateResult, String> {
    let root = state.root()?;
    remember_write(&app, &rel);
    if vault::exists(&root, &rel) {
        return Ok(CreateResult { path: rel, created: false });
    }
    let body = contents.unwrap_or_else(|| {
        let title = rel
            .rsplit('/')
            .next()
            .unwrap_or("Untitled")
            .trim_end_matches(".md")
            .to_string();
        format!("---\ntitle: {title}\n---\n# {title}\n\n")
    });
    vault::write_text(&root, &rel, &body)?;
    history::record(&root, &rel, &format!("create {rel}"), None, &body)?;
    meta::append_log(&root, "info", &format!("vein created: {rel}"));
    Ok(CreateResult { path: rel, created: true })
}

#[tauri::command]
fn create_chamber(
    app: AppHandle,
    rel: String,
    state: State<'_, VaultState>,
) -> Result<CreateResult, String> {
    let root = state.root()?;
    remember_write(&app, &rel);
    let path = vault::resolve_in_vault(&root, &rel)?;
    let created = !path.is_dir();
    std::fs::create_dir_all(&path).map_err(|e| format!("{rel}: {e}"))?;
    meta::append_log(&root, "info", &format!("chamber ready: {rel}"));
    Ok(CreateResult { path: rel, created })
}

/* ── .macusanite metadata ──────────────────────────────────────────────── */

#[tauri::command]
fn read_meta(name: String, state: State<'_, VaultState>) -> Result<Option<String>, String> {
    let root = state.root()?;
    Ok(meta::read_meta(&root, &name))
}

#[tauri::command]
fn write_meta(
    app: AppHandle,
    name: String,
    contents: String,
    label: Option<String>,
    record: Option<bool>,
    state: State<'_, VaultState>,
) -> Result<PathResult, String> {
    let root = state.root()?;
    // Before the write, not after: the watcher may report the change while the
    // command is still returning.
    remember_meta_write(&app, &name);
    meta::write_meta(&root, &name, &contents, label.as_deref(), record.unwrap_or(true))?;
    Ok(PathResult {
        path: format!("{}/{}", vault::META_DIR, name),
    })
}

#[tauri::command]
fn append_log(level: String, message: String, state: State<'_, VaultState>) -> Result<(), String> {
    let root = state.root()?;
    meta::append_log(&root, &level, &message);
    Ok(())
}

#[tauri::command]
fn reveal_meta(state: State<'_, VaultState>) -> Result<String, String> {
    let root = state.root()?;
    let dir = meta::meta_dir(&root);
    let target = if dir.is_dir() { dir } else { root.clone() };

    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("explorer").arg(&target).spawn();
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg(&target).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let result = std::process::Command::new("xdg-open").arg(&target).spawn();

    result.map_err(|e| format!("could not open {}: {e}", target.display()))?;
    Ok(target.to_string_lossy().to_string())
}

/* ── undo / redo ───────────────────────────────────────────────────────── */

#[tauri::command]
fn history_state(state: State<'_, VaultState>) -> Result<history::HistoryState, String> {
    let root = state.root()?;
    Ok(history::briefs(&history::load(&root)))
}

#[tauri::command]
fn history_undo(
    app: AppHandle,
    state: State<'_, VaultState>,
) -> Result<history::MoveResult, String> {
    let root = state.root()?;
    let result = history::undo(&root)?;
    if let (Some(path), Some(label)) = (result.path.as_ref(), result.label.as_ref()) {
        // Undo rewrites files on disk: the frontend already reflects the move.
        remember_write(&app, path);
        meta::append_log(&root, "info", &format!("undo: {label} ({path})"));
    }
    Ok(result)
}

#[tauri::command]
fn history_redo(
    app: AppHandle,
    state: State<'_, VaultState>,
) -> Result<history::MoveResult, String> {
    let root = state.root()?;
    let result = history::redo(&root)?;
    if let (Some(path), Some(label)) = (result.path.as_ref(), result.label.as_ref()) {
        remember_write(&app, path);
        meta::append_log(&root, "info", &format!("redo: {label} ({path})"));
    }
    Ok(result)
}

/* ── shell integration ─────────────────────────────────────────────────── */

#[tauri::command]
fn pick_folder(app: AppHandle) -> Result<Option<String>, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog().file().pick_folder(move |folder| {
        let _ = tx.send(folder);
    });
    let picked = rx.recv_timeout(std::time::Duration::from_secs(600)).map_err(|e| e.to_string())?;
    Ok(picked
        .and_then(|f| f.into_path().ok())
        .map(|p| p.to_string_lossy().to_string()))
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

/// Open the manual in its own window.
///
/// The manual is a second page (`help.html`) rather than a panel inside the
/// viewer, so reading it never costs you the vein you had open — and it needs no
/// vault, which is exactly when someone reads it. One window only: asking again
/// brings the existing one forward instead of stacking copies. The theme is
/// passed in the URL, because the help window has no vault to read settings from.
#[tauri::command]
fn open_help_window(app: AppHandle, theme: Option<String>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("help") {
        let _ = window.set_focus();
        return Ok(());
    }

    let query = match theme.as_deref() {
        Some("light") => "?theme=light",
        Some("dark") => "?theme=dark",
        _ => "",
    };
    tauri::WebviewWindowBuilder::new(
        &app,
        "help",
        tauri::WebviewUrl::App(format!("help.html{query}").into()),
    )
    .title("Macusanite Help")
    .inner_size(1080.0, 820.0)
    .min_inner_size(520.0, 420.0)
    .build()
    .map_err(|e| format!("could not open the help window: {e}"))?;

    Ok(())
}

/// Only web links leave the application; anything else is refused.
fn is_web_url(url: &str) -> bool {
    let trimmed = url.trim();
    (trimmed.starts_with("http://") || trimmed.starts_with("https://") || trimmed.starts_with("mailto:"))
        && !trimmed.contains(|c: char| c.is_whitespace() || c == '"' || c == '<' || c == '>')
}

/// Open a link in the user's browser rather than navigating the vault window.
#[tauri::command]
fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    if !is_web_url(&url) {
        return Err(format!("refusing to open non-web link: {url}"));
    }
    app.opener()
        .open_url(url.trim(), None::<&str>)
        .map_err(|e| format!("could not open {url}: {e}"))
}

/* ── builder ───────────────────────────────────────────────────────────── */

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(VaultState::default())
        .manage(WatcherState::default())
        .manage(Arc::new(watch::SelfWrites::default()))
        .invoke_handler(tauri::generate_handler![
            open_vault,
            create_vault,
            startup_vault,
            vault_scan,
            vault_stat,
            vault_tree,
            list_veins,
            read_vein,
            write_vein,
            create_vein,
            create_chamber,
            read_meta,
            write_meta,
            append_log,
            reveal_meta,
            history_state,
            history_undo,
            history_redo,
            open_help_window,
            pick_folder,
            quit_app,
            open_external,
        ])
        .setup(|app| {
            // Keep the default window label stable: capabilities and the
            // frontend both assume "main".
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_title("Macusanite");
            }

            // `macusanite <vault-folder>` opens that vault straight away.
            if let Some(candidate) = std::env::args().skip(1).find(|arg| !arg.starts_with('-')) {
                let path = PathBuf::from(&candidate);
                if path.is_dir() {
                    if let Ok(root) = path.canonicalize() {
                        meta::append_log(&root, "info", "opened from the command line");
                        let _ = app.state::<VaultState>().set(root.clone());
                        arm_watcher(&app.handle().clone(), &root);
                    }
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Macusanite");
}

#[cfg(test)]
mod tests {
    use super::is_web_url;

    /// The exact sequence the commands perform, end to end, on a throwaway vault.
    #[test]
    fn a_whole_vault_workflow_holds_together() {
        use crate::{history, meta, vault as v};

        let root = std::env::temp_dir().join("macusanite-workflow");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();

        // open_vault / create_vault
        let info = meta::ensure_meta(&root, Some("Workflow Vault"), Some("end to end")).unwrap();
        assert_eq!(info.name, "Workflow Vault");
        assert_eq!(info.description, "end to end");
        assert!(info.created.is_some());

        // create_vein
        v::write_text(&root, "Chambers/Lab/Notes.md", "# Notes\n").unwrap();
        history::record(&root, "Chambers/Lab/Notes.md", "create Chambers/Lab/Notes.md", None, "# Notes\n").unwrap();
        v::write_text(&root, "Home.md", "# Home\n\n[[Chambers/Lab/Notes]]\n").unwrap();
        history::record(&root, "Home.md", "create Home.md", None, "# Home\n").unwrap();

        // vault_tree / list_veins
        let scan = v::scan(&root).unwrap();
        assert_eq!(scan.veins, vec!["Chambers/Lab/Notes.md", "Home.md"]);
        let tree = v::build_tree(&scan);
        assert_eq!(tree.len(), 2);
        assert_eq!(tree[0].name, "Chambers");
        assert_eq!(tree[1].name, "Home.md");
        assert_eq!(tree[0].children[0].children[0].path, "Chambers/Lab/Notes.md");

        // write_meta with record = false must not touch the undo stack
        meta::write_meta(&root, meta::STATE_FILE, "{\"lastPath\":\"Home.md\"}", Some("viewer state"), false).unwrap();
        assert_eq!(history::load(&root).undo.len(), 2);

        // a colour change is undoable, like the picker expects
        meta::write_meta(&root, meta::COLORS_FILE, "{\"pages\":{\"Home.md\":\"#ffd700\"}}", Some("colour page Home.md"), true).unwrap();
        assert_eq!(history::load(&root).undo.len(), 3);
        let undone = history::undo(&root).unwrap();
        assert!(undone.applied);
        assert!(undone.path.unwrap().ends_with("colors.json"));

        // history_undo removes a created vein again
        history::undo(&root).unwrap();
        assert!(!v::exists(&root, "Home.md"));
        let restored = history::redo(&root).unwrap();
        assert!(restored.applied);
        assert_eq!(v::read_text(&root, "Home.md").unwrap(), "# Home\n");

        // append_log writes one JSON line per call
        meta::append_log(&root, "info", "workflow finished");
        let logs: Vec<_> = std::fs::read_dir(meta::meta_dir(&root).join(meta::LOGS_DIR))
            .unwrap()
            .filter_map(Result::ok)
            .collect();
        assert_eq!(logs.len(), 1);
        let text = std::fs::read_to_string(&logs[0].path()).unwrap();
        assert!(text.contains("workflow finished"));
        assert!(text.contains("\"level\":\"info\""));
    }

    #[test]
    fn only_web_links_may_leave_the_app() {
        assert!(is_web_url("https://example.com"));
        assert!(is_web_url("http://localhost:1420"));
        assert!(is_web_url("mailto:someone@example.com"));
        assert!(!is_web_url("file:///C:/Windows/system32"));
        assert!(!is_web_url("cmd:/C calc"));
        assert!(!is_web_url("https://example.com & calc"));
        assert!(!is_web_url("https://example.com\"quoted"));
        assert!(!is_web_url("javascript:alert(1)"));
    }
}
