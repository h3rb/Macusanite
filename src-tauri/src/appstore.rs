//! The installation's shared, human-readable storage folder.
//!
//! Everything a vault owns lives inside that vault (`.macusanite/`). A few
//! facts are about the computer instead — which vaults this installation has
//! opened — and those need one home shared by every window and every vault:
//!
//! ```text
//! <CurrentUser>/Documents/macusanite/localstorage/
//!   vaults.json   the known vaults, newest first (plain JSON)
//!   README.md     this explanation, kept beside the data
//! ```
//!
//! The folder is deliberately ordinary: no database, no opaque blob. The
//! frontend owns the file format (`src/lib/vaultRegistry.js`); this module only
//! resolves the folder, keeps the README in place and enforces that a name is a
//! single flat file in it.

use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// The explanation left beside the data, rewritten only when it is missing so
/// a reader's own notes survive.
pub const README: &str = r#"# Macusanite local storage

This folder holds the small amount of information Macusanite keeps about *this
computer*, shared by every vault you open. It is plain text on purpose: you can
read it, back it up, or edit it by hand, and the app will simply carry on.

| File | What it holds |
| --- | --- |
| `vaults.json` | The vaults this installation has opened, newest first: each vault's folder path, its display name, and when it was last opened. The vault menu in the title bar lists this file. |
| `tutorials.json` | The teaching notes that have been closed, by id with the date they were dismissed. One record covers every vault, so each note is dismissed once per computer. |
| `README.md` | This explanation. |

There is no note content here. Notes, settings, colours and undo history live
inside each vault's own `.macusanite` folder; this folder only records which
vaults exist on this machine so you can switch between them quickly.

`vaults.json` is ordinary JSON:

```json
{
  "version": 1,
  "vaults": [
    {
      "name": "Field Notes",
      "path": "C:\\Users\\you\\Documents\\Field Notes",
      "lastOpened": 1764150000000
    }
  ]
}
```

`lastOpened` is a Unix timestamp in milliseconds. The list keeps the twelve most
recent vaults.

Editing or deleting entries is safe: removing one only removes it from the menu,
and the vault itself is untouched. Deleting this folder is safe too — Macusanite
creates it again, with this README, the next time it starts.

Macusanite never writes anything else into this folder.
"#;

/// A single flat file name: no separators, no traversal, no hidden files.
pub fn safe_name(name: &str) -> Result<&str, String> {
    let trimmed = name.trim();
    let valid = !trimmed.is_empty()
        && trimmed.len() <= 64
        && !trimmed.starts_with('.')
        && !trimmed.contains('/')
        && !trimmed.contains('\\')
        && !trimmed.contains("..")
        && trimmed
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    if !valid {
        return Err(format!("invalid local storage file name: {name}"));
    }
    Ok(trimmed)
}

/// `<Documents>/macusanite/localstorage`, created (with the README) on demand.
///
/// A machine without a Documents folder falls back to `<home>/Documents`, which
/// is where every desktop platform would put it anyway.
pub fn folder(app: &AppHandle) -> Result<PathBuf, String> {
    let documents = app
        .path()
        .document_dir()
        .or_else(|_| app.path().home_dir().map(|home| home.join("Documents")))
        .map_err(|error| format!("could not find your Documents folder: {error}"))?;
    let dir = documents.join("macusanite").join("localstorage");
    std::fs::create_dir_all(&dir).map_err(|error| format!("{}: {error}", dir.display()))?;
    ensure_readme(&dir)?;
    Ok(dir)
}

/// Leave the README in place. Only written when absent: the file is for the
/// reader, and their edits are theirs.
pub fn ensure_readme(dir: &Path) -> Result<(), String> {
    let readme = dir.join("README.md");
    if readme.is_file() {
        return Ok(());
    }
    std::fs::write(&readme, README).map_err(|error| format!("{}: {error}", readme.display()))
}

/// Read one file from the folder, or `None` when it does not exist yet.
pub fn read(app: &AppHandle, name: &str) -> Result<Option<String>, String> {
    let name = safe_name(name)?;
    let path = folder(app)?.join(name);
    match std::fs::read_to_string(&path) {
        Ok(text) => Ok(Some(text)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("{}: {error}", path.display())),
    }
}

/// Write one file in the folder atomically enough for its size: a temporary
/// neighbour is renamed over the real file, so a crash never leaves half a
/// `vaults.json` for the next launch to parse.
pub fn write(app: &AppHandle, name: &str, contents: &str) -> Result<String, String> {
    let name = safe_name(name)?;
    let dir = folder(app)?;
    let path = dir.join(name);
    let temp = dir.join(format!("{name}.tmp"));
    std::fs::write(&temp, contents).map_err(|error| format!("{}: {error}", temp.display()))?;
    std::fs::rename(&temp, &path).map_err(|error| format!("{}: {error}", path.display()))?;
    Ok(path.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::{safe_name, README};

    #[test]
    fn names_are_one_flat_file() {
        assert_eq!(safe_name("vaults.json").unwrap(), "vaults.json");
        assert_eq!(safe_name("  settings-v1_test.json ").unwrap(), "settings-v1_test.json");

        for bad in ["", ".", "..", "../evil.json", "nested/vaults.json", "a\\b.json", ".hidden", "vaults json"] {
            assert!(safe_name(bad).is_err(), "{bad} should be refused");
        }
    }

    #[test]
    fn the_readme_explains_the_folder_and_the_file() {
        assert!(README.contains("vaults.json"));
        assert!(README.contains("tutorials.json"));
        assert!(README.contains("README.md"));
        assert!(README.contains("local storage"));
    }
}
