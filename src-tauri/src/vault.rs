//! Vault filesystem primitives: path safety, scanning, the chamber/vein tree,
//! atomic writes and the heading-slug function that must match the JS side.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// Metadata directory inside every vault root.
pub const META_DIR: &str = ".macusanite";
pub const MARKDOWN_EXTS: [&str; 3] = ["md", "markdown", "mdx"];
const MAX_DEPTH: usize = 32;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TreeNode {
    pub name: String,
    /// Vault-relative POSIX path (`Chambers/Lab/Methods.md`).
    pub path: String,
    /// `chamber` for a folder, `vein` for a markdown file.
    pub kind: String,
    pub children: Vec<TreeNode>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FileStat {
    /// Vault-relative POSIX path.
    pub path: String,
    /// Milliseconds since the Unix epoch; 0 when the platform will not say.
    pub mtime: i64,
    pub size: u64,
}

impl FileStat {
    /// Describe one file relative to the vault root. Freshness for the viewer's
    /// index cache is this pair, so it has to come from the file itself.
    pub fn of(root: &Path, path: &Path) -> io::Result<FileStat> {
        let meta = fs::metadata(path)?;
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        Ok(FileStat { path: relative(root, path), mtime, size: meta.len() })
    }
}

#[derive(Debug, Default, Clone)]
pub struct Scan {
    pub veins: Vec<String>,
    pub chambers: Vec<String>,
    /// Modification time and size of every vein, in the same order as `veins`.
    /// The viewer caches what it parsed per file and re-reads only what moved.
    pub stats: Vec<FileStat>,
}

/// Canonicalised Windows paths carry a verbatim prefix (four characters:
/// backslash backslash question backslash) that looks like a bug in the UI.
/// Internally we keep it, because it lifts the path-length limit; for display
/// and for the frontend we hand back the tidy form.
const VERBATIM_PREFIX: &str = "\\\\?\\";

pub fn display_path(path: &Path) -> String {
    let text = path.to_string_lossy().to_string();
    match text.strip_prefix(VERBATIM_PREFIX) {
        Some(rest) => rest.to_string(),
        None => text,
    }
}

pub fn is_markdown(name: &str) -> bool {
    Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| MARKDOWN_EXTS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// Join a vault-relative path onto the root, refusing anything that could escape it.
pub fn resolve_in_vault(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let cleaned = rel.replace('\\', "/");
    let mut out = PathBuf::from(root);
    for part in cleaned.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            return Err(format!("path escapes the vault: {rel}"));
        }
        if part.contains(':') {
            return Err(format!("invalid path segment: {part}"));
        }
        out.push(part);
    }
    Ok(out)
}

/// Vault-relative POSIX path for an absolute path inside the vault.
pub fn relative(root: &Path, path: &Path) -> String {
    let rel = path.strip_prefix(root).unwrap_or(path);
    rel.components()
        .filter_map(|c| c.as_os_str().to_str().map(|s| s.replace('\\', "/")))
        .collect::<Vec<_>>()
        .join("/")
}

fn dirname_of(path: &str) -> String {
    match path.rfind('/') {
        Some(i) => path[..i].to_string(),
        None => String::new(),
    }
}

fn basename_of(path: &str) -> String {
    match path.rfind('/') {
        Some(i) => path[i + 1..].to_string(),
        None => path.to_string(),
    }
}

/// Walk the vault, ignoring dot-folders (`.macusanite`, `.git`, …).
pub fn scan(root: &Path) -> io::Result<Scan> {
    let mut scan = Scan::default();
    walk(root, root, &mut scan, 0)?;
    scan.veins.sort();
    scan.veins.dedup();
    scan.chambers.sort();
    scan.chambers.dedup();
    scan.stats.sort_by(|a, b| a.path.cmp(&b.path));
    scan.stats.dedup_by(|a, b| a.path == b.path);
    Ok(scan)
}

fn walk(root: &Path, dir: &Path, scan: &mut Scan, depth: usize) -> io::Result<()> {
    if depth > MAX_DEPTH {
        return Ok(());
    }
    let mut entries: Vec<fs::DirEntry> = fs::read_dir(dir)?.collect::<Result<_, _>>()?;
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let file_type = entry.file_type()?;
        let path = entry.path();
        if file_type.is_dir() {
            scan.chambers.push(relative(root, &path));
            walk(root, &path, scan, depth + 1)?;
        } else if file_type.is_file() && is_markdown(&name) {
            scan.veins.push(relative(root, &path));
            if let Ok(stat) = FileStat::of(root, &path) {
                scan.stats.push(stat);
            }
        }
    }
    Ok(())
}

/// Assemble chambers and veins into a sorted tree (chambers first, then names).
pub fn build_tree(scan: &Scan) -> Vec<TreeNode> {
    let mut nodes: BTreeMap<String, TreeNode> = BTreeMap::new();

    for chamber in &scan.chambers {
        nodes.insert(
            chamber.clone(),
            TreeNode {
                name: basename_of(chamber),
                path: chamber.clone(),
                kind: "chamber".to_string(),
                children: Vec::new(),
            },
        );
    }

    let mut roots: Vec<TreeNode> = Vec::new();

    // 1. Veins go into their chamber while every chamber is still in the map.
    for vein in &scan.veins {
        let node = TreeNode {
            name: basename_of(vein),
            path: vein.clone(),
            kind: "vein".to_string(),
            children: Vec::new(),
        };
        let parent = dirname_of(vein);
        match nodes.get_mut(&parent) {
            Some(parent_node) => parent_node.children.push(node),
            None => roots.push(node), // a vein at the vault root
        }
    }

    // 2. Chambers deepest-first, so a parent is still in the map when its child
    //    is moved into it. Moving a chamber carries its veins with it.
    let mut deepest: Vec<String> = nodes.keys().cloned().collect();
    deepest.sort_by_key(|path| std::cmp::Reverse(path.matches('/').count()));

    for path in deepest {
        if let Some(node) = nodes.remove(&path) {
            let parent = dirname_of(&path);
            match nodes.get_mut(&parent) {
                Some(parent_node) if !parent.is_empty() => parent_node.children.push(node),
                _ => roots.push(node),
            }
        }
    }

    sort_nodes(&mut roots);
    roots
}

pub fn sort_nodes(nodes: &mut [TreeNode]) {
    nodes.sort_by(|a, b| {
        // "chamber" sorts before "vein" alphabetically, which is exactly the
        // order the sidebar wants: folders first, then files.
        a.kind
            .cmp(&b.kind)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    for node in nodes.iter_mut() {
        sort_nodes(&mut node.children);
    }
}

pub fn read_text(root: &Path, rel: &str) -> Result<String, String> {
    let path = resolve_in_vault(root, rel)?;
    fs::read_to_string(&path).map_err(|e| format!("{rel}: {e}"))
}

/// Write through a temp file so a crash cannot leave a half-written vein.
pub fn write_text(root: &Path, rel: &str, contents: &str) -> Result<(), String> {
    let path = resolve_in_vault(root, rel)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("{rel}: {e}"))?;
    }
    let tmp = path.with_file_name(format!(
        ".{}.macusanite-tmp",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("vein")
    ));
    fs::write(&tmp, contents).map_err(|e| format!("{rel}: {e}"))?;
    if fs::rename(&tmp, &path).is_err() {
        // Windows will not rename over an existing file.
        let _ = fs::remove_file(&path);
        fs::rename(&tmp, &path).map_err(|e| format!("{rel}: {e}"))?;
    }
    Ok(())
}

pub fn delete_file(root: &Path, rel: &str) -> Result<(), String> {
    let path = resolve_in_vault(root, rel)?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("{rel}: {e}")),
    }
}

pub fn exists(root: &Path, rel: &str) -> bool {
    resolve_in_vault(root, rel).map(|p| p.exists()).unwrap_or(false)
}

/// Heading anchor slug. Deliberately mirrors `slugify` in `src/lib/path.js`.
pub fn slugify(text: &str) -> String {
    let mut out = String::new();
    let mut pending_dash = false;

    for ch in text.chars() {
        if ch.is_alphanumeric() {
            if pending_dash && !out.is_empty() {
                out.push('-');
            }
            pending_dash = false;
            for lower in ch.to_lowercase() {
                out.push(lower);
            }
        } else if ch.is_whitespace() || ch == '-' {
            pending_dash = true;
        }
        // everything else (punctuation, underscores, symbols) is dropped
    }

    out.trim_matches('-').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs as stdfs;

    fn temp_vault(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("macusanite-test-{name}"));
        let _ = stdfs::remove_dir_all(&dir);
        stdfs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn display_paths_drop_the_windows_verbatim_prefix() {
        assert_eq!(display_path(Path::new(r"\\?\C:\Vaults\Notes")), r"C:\Vaults\Notes");
        // A path without the prefix is handed back untouched.
        assert_eq!(display_path(Path::new(r"C:\Vaults\Notes")), r"C:\Vaults\Notes");
        assert_eq!(display_path(Path::new("vault")), "vault");
    }

    #[test]
    fn rejects_paths_that_escape_the_vault() {
        let root = Path::new("/vault");
        assert!(resolve_in_vault(root, "../secrets.md").is_err());
        assert!(resolve_in_vault(root, "Chambers/../../secrets.md").is_err());
        assert!(resolve_in_vault(root, "C:/Windows/system32/x.md").is_err());
        assert!(resolve_in_vault(root, "Chambers/Lab/Methods.md").is_ok());
        assert_eq!(
            resolve_in_vault(root, "Chambers//Lab/./Methods.md").unwrap(),
            PathBuf::from("/vault/Chambers/Lab/Methods.md")
        );
    }

    #[test]
    fn scan_finds_veins_and_chambers_and_hides_meta() {
        let root = temp_vault("scan");
        stdfs::create_dir_all(root.join("Chambers/Fieldwork")).unwrap();
        stdfs::create_dir_all(root.join(".macusanite/logs")).unwrap();
        stdfs::write(root.join("Home.md"), "# Home").unwrap();
        stdfs::write(root.join("Chambers/Fieldwork/Notes.md"), "# Notes").unwrap();
        stdfs::write(root.join("Chambers/Fieldwork/photo.txt"), "no").unwrap();
        stdfs::write(root.join(".macusanite/vault.json"), "{}").unwrap();

        let scan = scan(&root).unwrap();
        assert_eq!(scan.veins, vec!["Chambers/Fieldwork/Notes.md", "Home.md"]);
        assert_eq!(scan.chambers, vec!["Chambers", "Chambers/Fieldwork"]);
    }

    #[test]
    fn a_scan_reports_when_each_vein_last_changed() {
        let root = temp_vault("stat");
        stdfs::create_dir_all(root.join("Chambers")).unwrap();
        stdfs::write(root.join("Home.md"), "# Home\n").unwrap();
        stdfs::write(root.join("Chambers/Notes.md"), "# Notes, a bit longer\n").unwrap();
        stdfs::write(root.join("Chambers/photo.txt"), "not a vein").unwrap();

        let first = scan(&root).unwrap();
        assert_eq!(first.stats.len(), 2, "only veins get a stat");
        assert_eq!(first.stats[0].path, "Chambers/Notes.md");
        assert_eq!(first.stats[1].path, "Home.md");
        assert_eq!(first.stats[0].size, "# Notes, a bit longer\n".len() as u64);
        assert!(first.stats[1].mtime > 1_600_000_000_000, "a real timestamp, not 0");

        // The stat describes the file, so it moves when the content does.
        std::thread::sleep(std::time::Duration::from_millis(20));
        stdfs::write(root.join("Home.md"), "# Home, rewritten\n").unwrap();
        let second = scan(&root).unwrap();
        assert!(second.stats[1].mtime >= first.stats[1].mtime);
        assert_ne!(second.stats[1].size, first.stats[1].size);
    }

    #[test]
    fn a_single_vein_can_be_statted_without_walking_the_vault() {
        let root = temp_vault("stat-one");
        stdfs::write(root.join("Home.md"), "# Home\n").unwrap();
        let path = resolve_in_vault(&root, "Home.md").unwrap();

        let stat = FileStat::of(&root, &path).unwrap();
        assert_eq!(stat.path, "Home.md");
        assert_eq!(stat.size, 7);

        // A path that escapes the vault is refused before it is touched.
        assert!(resolve_in_vault(&root, "../outside.md").is_err());
    }

    /// The viewer's index cache is keyed on `path`, `mtime` and `size`: these
    /// three names are the whole contract between the two sides.
    #[test]
    fn a_stat_crosses_the_bridge_with_the_names_the_cache_expects() {
        let root = temp_vault("stat-json");
        stdfs::write(root.join("Home.md"), "# Home\n").unwrap();
        let stat = FileStat::of(&root, &resolve_in_vault(&root, "Home.md").unwrap()).unwrap();

        let json = serde_json::to_value(&stat).unwrap();
        assert_eq!(json["path"], "Home.md");
        assert_eq!(json["size"], 7);
        assert!(json["mtime"].as_i64().unwrap() > 1_600_000_000_000, "a real timestamp, not 0");
        assert_eq!(json.as_object().unwrap().len(), 3, "no other field should leak into the cache");
    }

    #[test]
    fn tree_nests_chambers_before_veins_and_sorts() {
        let scan = Scan {
            veins: vec![
                "Chambers/Lab/Methods.md".into(),
                "Home.md".into(),
                "Chambers/Fieldwork/Notes.md".into(),
            ],
            chambers: vec!["Chambers".into(), "Chambers/Lab".into(), "Chambers/Fieldwork".into()],
            ..Scan::default()
        };
        let tree = build_tree(&scan);
        assert_eq!(tree.len(), 2);
        assert_eq!(tree[0].kind, "chamber");
        assert_eq!(tree[0].name, "Chambers");
        assert_eq!(tree[1].name, "Home.md");
        let children = &tree[0].children;
        assert_eq!(children[0].name, "Fieldwork");
        assert_eq!(children[1].name, "Lab");
        assert_eq!(children[1].children[0].path, "Chambers/Lab/Methods.md");
    }

    #[test]
    fn write_then_read_round_trips_and_creates_chambers() {
        let root = temp_vault("write");
        write_text(&root, "A/B/Deep.md", "# Deep").unwrap();
        assert_eq!(read_text(&root, "A/B/Deep.md").unwrap(), "# Deep");
        assert!(exists(&root, "A/B/Deep.md"));
        write_text(&root, "A/B/Deep.md", "# Replaced").unwrap();
        assert_eq!(read_text(&root, "A/B/Deep.md").unwrap(), "# Replaced");
        delete_file(&root, "A/B/Deep.md").unwrap();
        assert!(!exists(&root, "A/B/Deep.md"));
    }

    #[test]
    fn slugify_matches_the_javascript_implementation() {
        // The same expectations live in tests/node/path.test.js.
        assert_eq!(slugify("Sieve series"), "sieve-series");
        assert_eq!(slugify("What they record"), "what-they-record");
        assert_eq!(slugify("Th 780C — hot, dry!"), "th-780c-hot-dry");
        assert_eq!(slugify("Undo/redo"), "undoredo");
        assert_eq!(slugify("  padded  "), "padded");
        assert_eq!(slugify("already-slugged"), "already-slugged");
        assert_eq!(slugify("snake_case_name"), "snakecasename");
    }
}
