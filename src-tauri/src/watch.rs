//! Live vault watching.
//!
//! A recursive `notify` watcher feeds a collector thread that coalesces a burst
//! of filesystem events into one batch, so an editor that writes a file five
//! times in a row produces a single refresh. The batch is handed to a callback
//! — in the app that is `AppHandle::emit("vault:changed", batch)`, and in the
//! tests it is a channel — which keeps the platform plumbing out of the tests.
//!
//! Three things are deliberately filtered out:
//!
//! * `.macusanite` and every other dot-entry, plus editor scratch files — with
//!   two exceptions, `settings.json` and `colors.json`. Those are meant to be
//!   hand-edited, so an edit to either one is reported and the running viewer
//!   picks it up; the rest of the folder (the session log, the index cache, the
//!   viewer's state, the undo stacks) belongs to the viewer and stays quiet, or
//!   reacting to it would be a feedback loop.
//! * writes this application just performed. A save is reflected in the UI
//!   immediately; hearing it echo back from the filesystem would re-render the
//!   document under the reader (or under the editor's caret). That includes the
//!   metadata files that *are* watched: `record_meta_write` is the counterpart
//!   of `write_meta` on the frontend's side.

use notify::{Event, EventKind, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::vault;

/// Event name the frontend listens for.
pub const EVENT: &str = "vault:changed";

const CREATED: &str = "created";
const MODIFIED: &str = "modified";
const REMOVED: &str = "removed";

/// Silence after the last event before a batch is emitted.
const QUIET: Duration = Duration::from_millis(220);
/// How long a write of ours keeps its path quiet.
const SELF_WRITE_WINDOW: Duration = Duration::from_millis(2000);
/// The same, for the two metadata files — deliberately much shorter.
///
/// A vein echoed back would re-render the document under the reader, so silence
/// is worth a wide window. A metadata echo is harmless: the frontend compares
/// what it reads with what it already has, so a stray event costs one read and
/// no redraw. The window only has to outlast the echo of our own `fs::write`,
/// and keeping it short is what stops a hand-edit made a moment after a save
/// from being swallowed — which is the whole point of following these files.
const META_WRITE_WINDOW: Duration = Duration::from_millis(400);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Change {
    /// Vault-relative POSIX path.
    pub path: String,
    /// `created`, `modified` or `removed`.
    pub kind: String,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct Batch {
    /// The watcher reported that events may have been missed: re-read everything.
    pub full: bool,
    pub changes: Vec<Change>,
}

impl Batch {
    pub fn is_empty(&self) -> bool {
        !self.full && self.changes.is_empty()
    }
}

/// Metadata files the viewer follows live, by their name inside `.macusanite`.
///
/// These two are the files a person is expected to edit by hand, so an edit is
/// reported to the frontend and applied to the window that is already open. The
/// rest of `.macusanite` (the log, the index cache, `state.json`, `history.json`)
/// is the viewer's own bookkeeping and never wakes it.
pub const LIVE_META: [&str; 2] = ["settings.json", "colors.json"];

/// True when a vault-relative path is one of the followed metadata files.
pub fn is_live_meta(rel: &str) -> bool {
    let normalized = rel.replace('\\', "/").to_ascii_lowercase();
    let Some(name) = normalized.strip_prefix(".macusanite/") else {
        return false;
    };
    LIVE_META.iter().any(|live| name == *live)
}

/* ── writes of our own ─────────────────────────────────────────────────── */

/// Vault-relative paths this application wrote recently, each with the instant
/// its silence runs out.
#[derive(Default)]
pub struct SelfWrites(Mutex<HashMap<String, Instant>>);

impl SelfWrites {
    /// Remember a path we are about to write so the watcher stays quiet about it.
    pub fn record(&self, rel: &str) {
        self.hold(rel, SELF_WRITE_WINDOW);
    }

    /// The same for a followed metadata file, on the shorter window.
    pub fn record_meta(&self, rel: &str) {
        self.hold(rel, META_WRITE_WINDOW);
    }

    fn hold(&self, rel: &str, window: Duration) {
        let rel = rel.replace('\\', "/");
        if rel.is_empty() {
            return;
        }
        let until = Instant::now() + window;
        if let Ok(mut map) = self.0.lock() {
            if map.len() > 256 {
                let now = Instant::now();
                map.retain(|_, deadline| *deadline > now);
            }
            map.insert(rel, until);
        }
    }

    fn recent(&self, rel: &str) -> bool {
        let Ok(mut map) = self.0.lock() else {
            return false;
        };
        match map.get(rel) {
            Some(deadline) if *deadline > Instant::now() => true,
            Some(_) => {
                map.remove(rel);
                false
            }
            None => false,
        }
    }
}

/* ── filtering ─────────────────────────────────────────────────────────── */

/// Paths the viewer never reacts to: anything inside a dot-folder
/// (`.macusanite`, `.git`), editor scratch files, and anything that is neither
/// markdown nor a chamber — with `settings.json` and `colors.json` as the two
/// exceptions, because those are made to be hand-edited.
pub fn ignored(rel: &str) -> bool {
    if rel.is_empty() {
        return true;
    }
    if is_live_meta(rel) {
        return false;
    }
    if rel.split('/').any(|part| part.starts_with('.')) {
        return true;
    }
    let name = rel.rsplit('/').next().unwrap_or(rel);
    if name.starts_with("~$") || name.ends_with('~') {
        return true;
    }
    if [".tmp", ".swp", ".swo", ".bak", ".orig", ".macusanite-tmp"]
        .iter()
        .any(|suffix| name.ends_with(suffix))
    {
        return true;
    }
    // A markdown name is a vein, a name with no extension at all is a chamber.
    // Anything else (a photo, an archive) is not what the viewer renders.
    if vault::is_markdown(name) {
        return false;
    }
    name.contains('.')
}

/// The kind of change an event describes, or `None` when it says nothing about
/// the vault's contents.
fn classify(kind: &EventKind) -> Option<&'static str> {
    use notify::event::{ModifyKind, RenameMode};
    match kind {
        EventKind::Create(_) => Some(CREATED),
        EventKind::Remove(_) => Some(REMOVED),
        // A rename arrives as two events: the old name is gone, the new one is here.
        EventKind::Modify(ModifyKind::Name(RenameMode::From)) => Some(REMOVED),
        EventKind::Modify(ModifyKind::Name(_)) => Some(CREATED),
        EventKind::Modify(ModifyKind::Data(_) | ModifyKind::Any | ModifyKind::Other) => Some(MODIFIED),
        EventKind::Any | EventKind::Other => Some(MODIFIED),
        // Metadata-only events (access time, permissions) never change what the
        // viewer renders — and our own reads would otherwise echo back forever.
        EventKind::Modify(_) => None,
        EventKind::Access(_) => None,
    }
}

/// Whether a reported change is worth waking the viewer for.
fn noteworthy(rel: &str, kind: &str) -> bool {
    // A followed metadata file changes what the window shows whatever the event
    // says: rewritten by hand, created (the viewer answers with its defaults) or
    // removed (which is the same thing, arrived at differently).
    if is_live_meta(rel) {
        return true;
    }
    if ignored(rel) {
        return false;
    }
    // A chamber's own timestamp moves whenever anything inside it does, and the
    // event for that file is already on its way. Only a chamber that appeared,
    // vanished or was renamed changes the tree.
    if kind == MODIFIED && !vault::is_markdown(rel) {
        return false;
    }
    true
}

/// How strongly a kind should win when one burst mentions a path twice.
/// A path that ended up deleted wins, then one that ended up existing.
fn rank(kind: &str) -> u8 {
    match kind {
        REMOVED => 3,
        CREATED => 2,
        _ => 1,
    }
}

/// Vault-relative POSIX path for an event path, or `None` when it is outside
/// the vault.
fn relative(root: &Path, path: &Path) -> Option<String> {
    if let Ok(stripped) = path.strip_prefix(root) {
        let text = join_components(stripped);
        return if text.is_empty() { None } else { Some(text) };
    }
    // Canonicalising the root on Windows can leave the watcher reporting a
    // differently-spelled prefix (with or without `\\?\`), so fall back to text.
    let root_text = vault::display_path(root).replace('\\', "/");
    let path_text = vault::display_path(path).replace('\\', "/");
    let prefix = format!("{}/", root_text.trim_end_matches('/'));
    path_text
        .strip_prefix(prefix.as_str())
        .map(|rest| rest.to_string())
        .filter(|rest| !rest.is_empty())
}

fn join_components(path: &Path) -> String {
    path.components()
        .filter_map(|c| c.as_os_str().to_str().map(|s| s.replace('\\', "/")))
        .collect::<Vec<_>>()
        .join("/")
}

/* ── the collector ─────────────────────────────────────────────────────── */

#[derive(Default)]
struct Pending {
    kinds: HashMap<String, String>,
    full: bool,
}

impl Pending {
    fn note(&mut self, path: String, kind: &str) {
        match self.kinds.get(&path) {
            Some(existing) if rank(existing) >= rank(kind) => {}
            _ => {
                self.kinds.insert(path, kind.to_string());
            }
        }
    }

    /// Drain what has accumulated into a batch (nothing to report → `None`).
    fn take(&mut self) -> Option<Batch> {
        if self.kinds.is_empty() && !self.full {
            return None;
        }
        let mut paths: Vec<String> = self.kinds.keys().cloned().collect();
        paths.sort();
        let changes = paths
            .into_iter()
            .map(|path| {
                let kind = self.kinds.get(&path).cloned().unwrap_or_else(|| MODIFIED.to_string());
                Change { path, kind }
            })
            .collect();
        let full = self.full;
        self.kinds.clear();
        self.full = false;
        Some(Batch { full, changes })
    }
}

/// Remember a `.macusanite` file this application is about to write.
///
/// The spelling of the path lives here, next to `is_live_meta`, so the file the
/// frontend names (`settings.json`) and the path the watcher reports
/// (`.macusanite/settings.json`) can never drift apart. Without this, saving a
/// setting would come back as "changed outside the viewer" and overwrite the
/// change with what was just written.
pub fn record_meta_write(writes: &SelfWrites, name: &str) {
    let name = name.trim_start_matches('/');
    if name.is_empty() || name.contains('/') {
        return;
    }
    writes.record_meta(&format!(".macusanite/{name}"));
}

/// A running watcher. Dropping it stops the watch: the platform watcher goes
/// away, the channel closes and the collector thread finishes.
pub struct Handle {
    _watcher: notify::RecommendedWatcher,
}

/// Watch `root` recursively and hand coalesced batches to `emit`.
pub fn start<F>(root: &Path, self_writes: Arc<SelfWrites>, emit: F) -> Result<Handle, String>
where
    F: Fn(Batch) + Send + Sync + 'static,
{
    let root = root.to_path_buf();
    let pending = Arc::new(Mutex::new(Pending::default()));
    let (tx, rx): (Sender<()>, Receiver<()>) = channel();

    let mut watcher = {
        let root = root.clone();
        let pending = Arc::clone(&pending);
        let tx = tx.clone();
        notify::recommended_watcher(move |result: notify::Result<Event>| {
            let Ok(event) = result else {
                // A watch error is reported once; there is nothing useful to do
                // with it here, and the next real event still arrives.
                return;
            };
            let kind = classify(&event.kind);
            let mut touched = false;
            if let Ok(mut pending) = pending.lock() {
                if event.need_rescan() {
                    // Events were dropped somewhere: re-read the whole vault.
                    pending.full = true;
                    touched = true;
                }
                if let Some(kind) = kind {
                    for path in &event.paths {
                        let Some(rel) = relative(&root, path) else {
                            continue;
                        };
                        if !noteworthy(&rel, kind) || self_writes.recent(&rel) {
                            continue;
                        }
                        pending.note(rel, kind);
                        touched = true;
                    }
                }
            }
            if touched {
                // Best effort: if the collector is gone the app is shutting down.
                let _ = tx.send(());
            }
        })
        .map_err(|e| format!("cannot start a watcher: {e}"))?
    };

    let flush_pending = Arc::clone(&pending);
    let emit = Arc::new(emit);
    std::thread::Builder::new()
        .name("macusanite-watch".to_string())
        .spawn(move || {
            loop {
                if rx.recv().is_err() {
                    break;
                }
                // Wait for the burst to go quiet before reporting it.
                loop {
                    match rx.recv_timeout(QUIET) {
                        Ok(()) => continue,
                        Err(RecvTimeoutError::Timeout) => break,
                        Err(RecvTimeoutError::Disconnected) => break,
                    }
                }
                if let Some(batch) = flush_pending.lock().ok().and_then(|mut p| p.take()) {
                    emit(batch);
                }
            }
            // The watcher was dropped: hand over anything still queued.
            if let Some(batch) = flush_pending.lock().ok().and_then(|mut p| p.take()) {
                emit(batch);
            }
        })
        .map_err(|e| format!("cannot start the watch thread: {e}"))?;

    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| format!("cannot watch {}: {e}", vault::display_path(&root)))?;

    Ok(Handle { _watcher: watcher })
}

/* ── tests ─────────────────────────────────────────────────────────────── */

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs as stdfs;
    use std::path::PathBuf;

    fn temp_vault(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("macusanite-watch-{name}"));
        let _ = stdfs::remove_dir_all(&dir);
        stdfs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Collect batches until `done` is satisfied, or the deadline passes.
    fn collect(rx: &Receiver<Batch>, within: Duration, done: impl Fn(&[Change]) -> bool) -> Vec<Change> {
        let deadline = Instant::now() + within;
        let mut seen: Vec<Change> = Vec::new();
        while Instant::now() < deadline {
            match rx.recv_timeout(Duration::from_millis(100)) {
                Ok(batch) => {
                    seen.extend(batch.changes);
                    if done(&seen) {
                        break;
                    }
                }
                Err(RecvTimeoutError::Timeout) => continue,
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }
        seen
    }

    fn has(changes: &[Change], path: &str) -> bool {
        changes.iter().any(|c| c.path == path)
    }

    #[test]
    fn metadata_scratch_and_foreign_files_are_ignored() {
        for ignored_path in [
            ".macusanite/state.json",
            ".macusanite/index.json",
            ".macusanite/history.json",
            ".macusanite/vault.json",
            ".macusanite/logs/session-20261012.log",
            ".git/config",
            "Chambers/.hidden/Note.md",
            "Chambers/~$Notes.md",
            "Chambers/Notes.md~",
            "Chambers/.#Notes.md",
            "Home.md.swp",
            "photo.png",
            "archive.zip",
            ".Home.md.macusanite-tmp",
            "",
        ] {
            assert!(ignored(ignored_path), "{ignored_path} should be ignored");
        }
        for watched in [
            "Home.md",
            "Chambers",
            "Chambers/Lab",
            "Chambers/Lab/Analytical Methods.md",
            "Notes.markdown",
            "Draft.mdx",
            "Chambers/Fieldwork 2026/Notes.md",
        ] {
            assert!(!ignored(watched), "{watched} should be watched");
        }
    }

    #[test]
    fn the_hand_editable_metadata_is_followed_and_the_rest_is_not() {
        // The two files a person is meant to edit by hand.
        assert!(is_live_meta(".macusanite/settings.json"));
        assert!(is_live_meta(".macusanite/colors.json"));
        assert!(!ignored(".macusanite/settings.json"));
        assert!(!ignored(".macusanite/colors.json"));
        // A backslash spelling (as some Windows callers produce) is the same file.
        assert!(is_live_meta(".macusanite\\settings.json"));
        assert!(is_live_meta(".macusanite/Settings.JSON") || is_live_meta(".macusanite/settings.json"));

        // Everything else in the folder is the viewer's own bookkeeping.
        for other in [
            ".macusanite/vault.json",
            ".macusanite/state.json",
            ".macusanite/history.json",
            ".macusanite/index.json",
            ".macusanite/logs/session-20261012.log",
            ".macusanite/settings.json.bak",
            "settings.json",
        ] {
            assert!(!is_live_meta(other), "{other} should not be followed");
            assert!(ignored(other), "{other} should be ignored");
        }

        // Which is what makes an edit to either one worth reporting.
        assert!(noteworthy(".macusanite/settings.json", MODIFIED));
        assert!(noteworthy(".macusanite/colors.json", CREATED));
        assert!(noteworthy(".macusanite/settings.json", REMOVED));
        assert!(!noteworthy(".macusanite/index.json", MODIFIED));
        assert!(!noteworthy(".macusanite/logs/session.log", CREATED));
    }

    #[test]
    fn our_own_metadata_writes_do_not_echo_back() {
        let root = temp_vault("meta-selfwrites");
        let writes = Arc::new(SelfWrites::default());
        let (tx, rx) = channel::<Batch>();
        let _handle = start(&root, Arc::clone(&writes), move |batch| {
            let _ = tx.send(batch);
        })
        .unwrap();
        std::thread::sleep(Duration::from_millis(400));

        // Exactly what the `write_meta` command does: remember the path, write it.
        record_meta_write(&writes, "settings.json");
        crate::meta::write_meta(&root, "settings.json", "{\n  \"theme\": \"light\"\n}\n", None, true).unwrap();
        // …while a hand-edit to the same file still comes through.
        std::thread::sleep(Duration::from_millis(300));
        stdfs::write(root.join(".macusanite/colors.json"), "{\n  \"pages\": {}\n}\n").unwrap();

        let seen = collect(&rx, Duration::from_secs(8), |changes| {
            has(changes, ".macusanite/colors.json")
        });
        assert!(
            has(&seen, ".macusanite/colors.json"),
            "a hand-edited metadata file was swallowed: {seen:?}"
        );
        assert!(
            !has(&seen, ".macusanite/settings.json"),
            "our own settings write echoed back: {seen:?}"
        );
    }

    #[test]
    fn a_hand_edit_soon_after_our_own_metadata_write_is_still_reported() {
        let root = temp_vault("meta-after-selfwrite");
        let writes = Arc::new(SelfWrites::default());
        let (tx, rx) = channel::<Batch>();
        let _handle = start(&root, Arc::clone(&writes), move |batch| {
            let _ = tx.send(batch);
        })
        .unwrap();
        std::thread::sleep(Duration::from_millis(400));

        // The viewer saves a setting, exactly as the `write_meta` command does.
        record_meta_write(&writes, "settings.json");
        crate::meta::write_meta(&root, "settings.json", "{\n  \"theme\": \"dark\"\n}\n", None, true).unwrap();

        // Nothing of ours may be in the way of the next assertion: drain whatever
        // the save produced before touching the file by hand.
        std::thread::sleep(Duration::from_millis(600));
        while rx.recv_timeout(Duration::from_millis(50)).is_ok() {}

        // A person edits the same file a moment later, and is heard. This is the
        // test that keeps `META_WRITE_WINDOW` short: the silence is there for the
        // echo of our own write, not for the next second of the user's attention.
        stdfs::write(root.join(".macusanite/settings.json"), "{\n  \"theme\": \"light\"\n}\n").unwrap();
        let seen = collect(&rx, Duration::from_secs(8), |changes| {
            has(changes, ".macusanite/settings.json")
        });
        assert!(
            has(&seen, ".macusanite/settings.json"),
            "a hand-edit after our own save was swallowed: {seen:?}"
        );
    }

    #[test]
    fn event_kinds_map_onto_the_three_things_the_ui_cares_about() {
        use notify::event::{AccessKind, CreateKind, DataChange, MetadataKind, ModifyKind, RemoveKind, RenameMode};

        assert_eq!(classify(&EventKind::Create(CreateKind::File)), Some(CREATED));
        assert_eq!(classify(&EventKind::Remove(RemoveKind::Folder)), Some(REMOVED));
        assert_eq!(classify(&EventKind::Modify(ModifyKind::Data(DataChange::Content))), Some(MODIFIED));
        // A rename is a delete plus a create for the viewer's purposes.
        assert_eq!(classify(&EventKind::Modify(ModifyKind::Name(RenameMode::From))), Some(REMOVED));
        assert_eq!(classify(&EventKind::Modify(ModifyKind::Name(RenameMode::To))), Some(CREATED));
        // Reads and access-time updates must never wake the UI.
        assert_eq!(classify(&EventKind::Access(AccessKind::Read)), None);
        assert_eq!(classify(&EventKind::Modify(ModifyKind::Metadata(MetadataKind::AccessTime))), None);
    }

    #[test]
    fn chamber_churn_is_not_a_change_but_a_new_chamber_is() {
        // Editing a vein inside a chamber touches the chamber too: one report.
        assert!(noteworthy("Chambers/Lab/Notes.md", MODIFIED));
        assert!(!noteworthy("Chambers/Lab", MODIFIED));
        assert!(!noteworthy("Chambers", MODIFIED));
        // A chamber that appeared, went away or moved does change the tree.
        assert!(noteworthy("Chambers/Lab", CREATED));
        assert!(noteworthy("Chambers/Lab", REMOVED));
        // …and metadata is still off limits whatever the event kind.
        assert!(!noteworthy(".macusanite/logs/session.log", CREATED));
        assert!(!noteworthy("scan.png", CREATED));
    }

    #[test]
    fn paths_outside_the_vault_are_not_reported() {
        let root = PathBuf::from("/vault");
        assert_eq!(relative(&root, &root.join("Chambers/Lab/Methods.md")), Some("Chambers/Lab/Methods.md".to_string()));
        assert_eq!(relative(&root, &root), None);
        assert_eq!(relative(&root, Path::new("/elsewhere/Notes.md")), None);
    }

    #[test]
    fn one_burst_mentions_a_path_once_with_its_strongest_kind() {
        let mut pending = Pending::default();
        pending.note("A.md".into(), MODIFIED);
        pending.note("B.md".into(), CREATED);
        pending.note("A.md".into(), REMOVED);
        pending.note("A.md".into(), CREATED);
        let batch = pending.take().unwrap();
        assert_eq!(
            batch.changes,
            vec![
                Change { path: "A.md".into(), kind: REMOVED.into() },
                Change { path: "B.md".into(), kind: CREATED.into() },
            ]
        );
        // A drained batch leaves nothing behind.
        assert!(pending.take().is_none());
        assert!(Batch::default().is_empty());
    }

    #[test]
    fn external_creates_edits_and_deletes_arrive_as_one_batch_each() {
        let root = temp_vault("live");
        let (tx, rx) = channel::<Batch>();
        let _handle = start(&root, Arc::new(SelfWrites::default()), move |batch| {
            let _ = tx.send(batch);
        })
        .unwrap();
        // Let the watch registration settle before touching the tree.
        std::thread::sleep(Duration::from_millis(400));

        // A new vein, a chamber around it, and an edit.
        stdfs::create_dir_all(root.join("Chambers")).unwrap();
        stdfs::write(root.join("Chambers/Notes.md"), "# Notes\n").unwrap();
        let seen = collect(&rx, Duration::from_secs(8), |changes| {
            has(changes, "Chambers") && has(changes, "Chambers/Notes.md")
        });
        assert!(has(&seen, "Chambers"), "chamber creation was not reported: {seen:?}");
        assert!(has(&seen, "Chambers/Notes.md"), "vein creation was not reported: {seen:?}");

        stdfs::write(root.join("Chambers/Notes.md"), "# Notes\n\nedited outside\n").unwrap();
        let seen = collect(&rx, Duration::from_secs(8), |changes| has(changes, "Chambers/Notes.md"));
        assert!(has(&seen, "Chambers/Notes.md"), "the edit was not reported: {seen:?}");

        stdfs::remove_file(root.join("Chambers/Notes.md")).unwrap();
        let seen = collect(&rx, Duration::from_secs(8), |changes| {
            changes.iter().any(|c| c.path == "Chambers/Notes.md" && c.kind == REMOVED)
        });
        let removal = seen.iter().find(|c| c.path == "Chambers/Notes.md" && c.kind == REMOVED);
        assert!(removal.is_some(), "the delete was not reported: {seen:?}");
    }

    #[test]
    fn our_own_writes_do_not_echo_back() {
        let root = temp_vault("selfwrites");
        let writes = Arc::new(SelfWrites::default());
        let (tx, rx) = channel::<Batch>();
        let _handle = start(&root, Arc::clone(&writes), move |batch| {
            let _ = tx.send(batch);
        })
        .unwrap();
        std::thread::sleep(Duration::from_millis(400));

        // Exactly what `write_vein` does: remember the path, then write it.
        writes.record("Ours.md");
        vault::write_text(&root, "Ours.md", "# Ours\n").unwrap();
        // …while a file nobody told us about still comes through.
        stdfs::write(root.join("Theirs.md"), "# Theirs\n").unwrap();

        let seen = collect(&rx, Duration::from_secs(8), |changes| has(changes, "Theirs.md"));
        assert!(has(&seen, "Theirs.md"), "an external write was swallowed: {seen:?}");
        assert!(!has(&seen, "Ours.md"), "our own write echoed back: {seen:?}");
    }
}
