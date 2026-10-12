//! Everything inside `<vault>/.macusanite/`:
//!
//! | File | Contents |
//! | --- | --- |
//! | `vault.json` | the vault's name, description and creation time |
//! | `settings.json` | viewer settings (defaults live in the JS layer) |
//! | `colors.json` | page/section/link/concept colour assignments |
//! | `history.json` | undo and redo stacks |
//! | `logs/session-YYYYMMDD.log` | one JSON-lines log file per day |

use serde::Serialize;
use serde_json::{json, Value};
use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

pub const VAULT_FILE: &str = "vault.json";
pub const SETTINGS_FILE: &str = "settings.json";
pub const COLORS_FILE: &str = "colors.json";
pub const HISTORY_FILE: &str = "history.json";
pub const STATE_FILE: &str = "state.json";
pub const LOGS_DIR: &str = "logs";

/// Files the viewer owns. Anything else in `.macusanite` is left alone.
pub const KNOWN_FILES: [&str; 4] = [VAULT_FILE, SETTINGS_FILE, COLORS_FILE, HISTORY_FILE];

#[derive(Debug, Clone, Serialize)]
pub struct VaultInfo {
    pub path: String,
    pub name: String,
    pub description: String,
    pub created: Option<String>,
    pub settings: Value,
    pub colors: Value,
}

/* ── time ──────────────────────────────────────────────────────────────── */

pub fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Days-since-epoch to a civil date (Howard Hinnant's algorithm).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as i64;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// ISO-8601 UTC timestamp, e.g. `2026-10-11T20:55:07.412Z`.
pub fn iso_timestamp(millis: u128) -> String {
    let secs = (millis / 1000) as i64;
    let ms = (millis % 1000) as u32;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{ms:03}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// `YYYYMMDD` used to name the daily log file.
pub fn day_stamp(millis: u128) -> String {
    let days = (millis / 1000) as i64 / 86_400;
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}{m:02}{d:02}")
}

/* ── paths ─────────────────────────────────────────────────────────────── */

pub fn meta_dir(root: &Path) -> std::path::PathBuf {
    root.join(crate::vault::META_DIR)
}

fn meta_file(root: &Path, name: &str) -> std::path::PathBuf {
    meta_dir(root).join(name)
}

/// Guard against `../` sneaking in through an IPC-supplied meta file name.
fn safe_meta_name(name: &str) -> Result<&str, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.contains('/') || trimmed.contains('\\') || trimmed.contains("..") {
        return Err(format!("invalid meta file name: {name}"));
    }
    Ok(trimmed)
}

/* ── reading and writing ───────────────────────────────────────────────── */

pub fn read_meta(root: &Path, name: &str) -> Option<String> {
    safe_meta_name(name)
        .ok()
        .and_then(|name| fs::read_to_string(meta_file(root, name)).ok())
}

pub fn write_meta_raw(root: &Path, name: &str, contents: &str) -> Result<(), String> {
    let name = safe_meta_name(name)?;
    fs::create_dir_all(meta_dir(root)).map_err(|e| format!(".macusanite: {e}"))?;
    fs::write(meta_file(root, name), contents).map_err(|e| format!("{name}: {e}"))
}

/// Read a meta file as JSON, falling back when it is missing or malformed.
pub fn read_json(root: &Path, name: &str) -> Option<Value> {
    read_meta(root, name).and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
}

/// Write a meta file, optionally recording an undoable history entry.
pub fn write_meta(root: &Path, name: &str, contents: &str, label: Option<&str>, record: bool) -> Result<(), String> {
    let name = safe_meta_name(name)?;
    let before = read_meta(root, name);
    write_meta_raw(root, name, contents)?;
    if record {
        let rel = format!("{}/{}", crate::vault::META_DIR, name);
        let label = label.unwrap_or(name).to_string();
        crate::history::record(root, &rel, &label, before, contents)?;
    }
    Ok(())
}

/* ── vault identity ───────────────────────────────────────────────────── */

/// Create `.macusanite` (and any missing file inside it) and report the vault.
pub fn ensure_meta(root: &Path, name_hint: Option<&str>, description_hint: Option<&str>) -> Result<VaultInfo, String> {
    fs::create_dir_all(meta_dir(root)).map_err(|e| format!(".macusanite: {e}"))?;
    fs::create_dir_all(meta_dir(root).join(LOGS_DIR)).map_err(|e| format!("logs: {e}"))?;

    if !meta_file(root, VAULT_FILE).exists() {
        let folder_name = root
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("Untitled Vault")
            .to_string();
        let payload = json!({
            "version": 1,
            "kind": "macusanite-vault",
            "name": name_hint.unwrap_or(&folder_name),
            "description": description_hint.unwrap_or(""),
            "created": iso_timestamp(now_millis()),
        });
        write_meta_raw(root, VAULT_FILE, &format!("{}\n", serde_json::to_string_pretty(&payload).unwrap()))?;
    } else if name_hint.is_some() || description_hint.is_some() {
        // `create_vault` on an existing vault updates the identity instead of
        // silently keeping the old one.
        let mut current = read_json(root, VAULT_FILE).unwrap_or_else(|| json!({}));
        if let Some(name) = name_hint {
            current["name"] = json!(name);
        }
        if let Some(description) = description_hint {
            current["description"] = json!(description);
        }
        write_meta_raw(root, VAULT_FILE, &format!("{}\n", serde_json::to_string_pretty(&current).unwrap()))?;
    }

    if !meta_file(root, SETTINGS_FILE).exists() {
        write_meta_raw(root, SETTINGS_FILE, "{\n  \"version\": 1\n}\n")?;
    }
    if !meta_file(root, COLORS_FILE).exists() {
        let empty = json!({ "pages": {}, "sections": {}, "links": {}, "concepts": {} });
        write_meta_raw(root, COLORS_FILE, &format!("{}\n", serde_json::to_string_pretty(&empty).unwrap()))?;
    }
    if !meta_file(root, HISTORY_FILE).exists() {
        write_meta_raw(root, HISTORY_FILE, "{\n  \"version\": 1,\n  \"undo\": [],\n  \"redo\": []\n}\n")?;
    }

    let vault_json = read_json(root, VAULT_FILE).unwrap_or_else(|| json!({}));
    Ok(VaultInfo {
        path: crate::vault::display_path(root),
        name: vault_json
            .get("name")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .unwrap_or_else(|| "Untitled Vault".to_string()),
        description: vault_json
            .get("description")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        created: vault_json.get("created").and_then(|v| v.as_str()).map(str::to_string),
        settings: read_json(root, SETTINGS_FILE).unwrap_or_else(|| json!({ "version": 1 })),
        colors: read_json(root, COLORS_FILE).unwrap_or_else(|| json!({})),
    })
}

/* ── logs ──────────────────────────────────────────────────────────────── */

/// Append one JSON-lines record to today's session log.
pub fn append_log(root: &Path, level: &str, message: &str) {
    let millis = now_millis();
    let dir = meta_dir(root).join(LOGS_DIR);
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    let file = dir.join(format!("session-{}.log", day_stamp(millis)));
    let line = json!({
        "ts": iso_timestamp(millis),
        "level": level,
        "message": message,
    });
    let mut payload = serde_json::to_string(&line).unwrap_or_else(|_| "{}".to_string());
    payload.push('\n');
    use std::io::Write;
    if let Ok(mut handle) = fs::OpenOptions::new().create(true).append(true).open(file) {
        let _ = handle.write_all(payload.as_bytes());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_timestamps_are_well_formed() {
        // Cross-checked against Python's datetime: 2026-10-11T00:00:00Z.
        assert_eq!(iso_timestamp(1_791_676_800_000), "2026-10-11T00:00:00.000Z");
        assert_eq!(iso_timestamp(1_791_676_867_412), "2026-10-11T00:01:07.412Z");
        assert_eq!(iso_timestamp(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(day_stamp(1_791_676_800_000), "20261011");
        // Leap day, to pin the civil-date maths.
        assert_eq!(day_stamp(1_709_164_800_000), "20240229");
    }

    #[test]
    fn meta_names_cannot_escape_the_meta_folder() {
        assert!(safe_meta_name("../evil.json").is_err());
        assert!(safe_meta_name("nested/evil.json").is_err());
        assert!(safe_meta_name("").is_err());
        assert_eq!(safe_meta_name("colors.json").unwrap(), "colors.json");
    }

    #[test]
    fn ensure_meta_creates_the_whole_folder() {
        let root = std::env::temp_dir().join("macusanite-meta-create");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();

        let info = ensure_meta(&root, None, None).unwrap();
        assert!(meta_dir(&root).join(VAULT_FILE).exists());
        assert!(meta_dir(&root).join(SETTINGS_FILE).exists());
        assert!(meta_dir(&root).join(COLORS_FILE).exists());
        assert!(meta_dir(&root).join(HISTORY_FILE).exists());
        assert!(meta_dir(&root).join(LOGS_DIR).is_dir());
        assert_eq!(info.name, "macusanite-meta-create");

        // Second call must not clobber the existing identity.
        let again = ensure_meta(&root, None, None).unwrap();
        assert_eq!(again.name, info.name);
        assert_eq!(again.created, info.created);
    }

    #[test]
    fn log_lines_are_appended_per_day() {
        let root = std::env::temp_dir().join("macusanite-meta-log");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        ensure_meta(&root, None, None).unwrap();
        append_log(&root, "info", "hello");
        append_log(&root, "warn", "again");

        let dir = meta_dir(&root).join(LOGS_DIR);
        let file = fs::read_dir(&dir).unwrap().next().unwrap().unwrap().path();
        let text = fs::read_to_string(file).unwrap();
        assert_eq!(text.lines().count(), 2);
        assert!(text.contains("\"info\""));
        assert!(text.contains("hello"));
    }

    #[test]
    fn writes_can_be_recorded_or_not() {
        let root = std::env::temp_dir().join("macusanite-meta-record");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        ensure_meta(&root, None, None).unwrap();

        write_meta(&root, STATE_FILE, "{\"lastPath\":\"Home.md\"}", Some("viewer state"), false).unwrap();
        assert!(crate::history::load(&root).undo.is_empty());

        write_meta(&root, COLORS_FILE, "{\"pages\":{}}", Some("colour change"), true).unwrap();
        let stacks = crate::history::load(&root);
        assert_eq!(stacks.undo.len(), 1);
        assert!(stacks.undo[0].path.ends_with("colors.json"));
    }
}
