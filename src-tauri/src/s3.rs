//! S3 backups: one gzipped tarball of the vault, signed with SigV4 and PUT.
//!
//! This is the window's half of `macusanite vault backup`. The object layout
//! and the signing rules are the same as the CLI's
//! (`src/lib/backup.js`, `src/lib/sigv4.js`, `src/lib/tar.js`), because a bucket
//! filled by one front end has to be readable by the other. Credentials follow
//! AWS's own order: explicit ones from the dialog, then the environment, then
//! `~/.aws/credentials`.
//!
//! The secret key never leaves memory: it is not written to the vault, to
//! `.macusanite`, or to the session log.
//!
//! An SSH backup (`BackupRequest::ssh`) is the other transport: the archive is
//! streamed to the host on stdin, uploaded there by its own `aws` CLI from a
//! temporary file, and that file is removed. Nothing is signed on this machine
//! and no AWS credential is read, which is the point of the route.

use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};
use url::Url;

const DEFAULT_PREFIX: &str = "macusanite/";

/// What the window sends from the backup dialog. Empty connection fields fall
/// back to the environment and the shared credentials file.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupRequest {
    pub bucket: String,
    pub region: Option<String>,
    pub prefix: Option<String>,
    pub endpoint: Option<String>,
    pub access_key: Option<String>,
    pub secret_key: Option<String>,
    pub session_token: Option<String>,
    pub profile: Option<String>,
    /// When present, stream the archive over SSH instead of uploading here.
    pub ssh: Option<SshTarget>,
}

/// The window's SSH route: a host, an optional private key, an optional port.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshTarget {
    pub host: String,
    pub key_file: Option<String>,
    pub port: Option<u16>,
}

/// What the dialog shows when the upload lands.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub bucket: String,
    pub key: String,
    pub region: Option<String>,
    pub endpoint: Option<String>,
    pub files: usize,
    pub bytes: usize,
    pub url: String,
    /// Where the credentials came from (`flags`, `environment`, a file path).
    pub credentials: String,
    /// `direct` or `ssh`.
    pub transport: String,
    /// The SSH host, when the upload went that way.
    pub ssh_host: Option<String>,
}

#[derive(Debug, Clone)]
struct Credentials {
    access_key: String,
    secret_key: String,
    session_token: Option<String>,
}

/* ── small utilities ───────────────────────────────────────────────────── */

fn home_dir() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_default()
}

fn read_if_present(path: &Path) -> String {
    fs::read_to_string(path).unwrap_or_default()
}

/// Enough of an INI parser for `~/.aws/credentials` and `~/.aws/config`.
fn parse_ini(text: &str) -> HashMap<String, HashMap<String, String>> {
    let mut sections: HashMap<String, HashMap<String, String>> = HashMap::new();
    let mut current: Option<String> = None;
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        if line.starts_with('[') && line.ends_with(']') {
            current = Some(line[1..line.len() - 1].trim().to_string());
            sections.entry(current.clone().unwrap_or_default()).or_default();
            continue;
        }
        if let (Some(section), Some((key, value))) = (&current, line.split_once('=')) {
            sections
                .entry(section.clone())
                .or_default()
                .insert(key.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }
    sections
}

fn config_section(profile: &str) -> String {
    if profile == "default" {
        "default".to_string()
    } else {
        format!("profile {profile}")
    }
}

fn resolve_region(request: &BackupRequest) -> String {
    if let Some(region) = request.region.as_deref().map(str::trim).filter(|r| !r.is_empty()) {
        return region.to_string();
    }
    if let Ok(region) = std::env::var("AWS_REGION") {
        if !region.trim().is_empty() {
            return region;
        }
    }
    if let Ok(region) = std::env::var("AWS_DEFAULT_REGION") {
        if !region.trim().is_empty() {
            return region;
        }
    }
    let profile = request
        .profile
        .clone()
        .or_else(|| std::env::var("AWS_PROFILE").ok())
        .unwrap_or_else(|| "default".to_string());
    let config_file = std::env::var("AWS_CONFIG_FILE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| home_dir().join(".aws").join("config"));
    let config = parse_ini(&read_if_present(&config_file));
    config
        .get(&config_section(&profile))
        .and_then(|section| section.get("region"))
        .cloned()
        .unwrap_or_else(|| "us-east-1".to_string())
}

fn resolve_credentials(request: &BackupRequest) -> Result<(Credentials, String), String> {
    match (&request.access_key, &request.secret_key) {
        (Some(access), Some(secret)) if !access.trim().is_empty() && !secret.trim().is_empty() => {
            return Ok((
                Credentials {
                    access_key: access.trim().to_string(),
                    secret_key: secret.trim().to_string(),
                    session_token: request.session_token.clone().filter(|t| !t.trim().is_empty()),
                },
                "flags".to_string(),
            ));
        }
        (Some(_), None) | (None, Some(_)) => {
            return Err("S3 credentials need both an access key id and a secret access key".to_string());
        }
        _ => {}
    }

    if let (Ok(access), Ok(secret)) = (
        std::env::var("AWS_ACCESS_KEY_ID"),
        std::env::var("AWS_SECRET_ACCESS_KEY"),
    ) {
        if !access.trim().is_empty() && !secret.trim().is_empty() {
            return Ok((
                Credentials {
                    access_key: access,
                    secret_key: secret,
                    session_token: request
                        .session_token
                        .clone()
                        .or_else(|| std::env::var("AWS_SESSION_TOKEN").ok())
                        .filter(|t| !t.trim().is_empty()),
                },
                "environment".to_string(),
            ));
        }
    }

    let profile = request
        .profile
        .clone()
        .or_else(|| std::env::var("AWS_PROFILE").ok())
        .unwrap_or_else(|| "default".to_string());
    let file = std::env::var("AWS_SHARED_CREDENTIALS_FILE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| home_dir().join(".aws").join("credentials"));
    let sections = parse_ini(&read_if_present(&file));
    if let Some(section) = sections.get(&profile) {
        if let (Some(access), Some(secret)) = (
            section.get("aws_access_key_id"),
            section.get("aws_secret_access_key"),
        ) {
            return Ok((
                Credentials {
                    access_key: access.clone(),
                    secret_key: secret.clone(),
                    session_token: request
                        .session_token
                        .clone()
                        .or_else(|| section.get("aws_session_token").cloned())
                        .filter(|t| !t.trim().is_empty()),
                },
                file.display().to_string(),
            ));
        }
    }

    Err(format!(
        "no S3 credentials: fill in the access key and secret, set AWS_ACCESS_KEY_ID and \
         AWS_SECRET_ACCESS_KEY, or add profile \"{profile}\" to {}",
        file.display()
    ))
}

/* ── the object key ────────────────────────────────────────────────────── */

fn vault_slug(name: &str) -> String {
    let mut slug = String::new();
    for ch in name.chars() {
        let lower = ch.to_ascii_lowercase();
        if lower.is_ascii_alphanumeric() || matches!(lower, '.' | '_' | '-') {
            slug.push(lower);
        } else if !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug = slug.trim_matches('-').chars().take(60).collect::<String>();
    if slug.is_empty() {
        "vault".to_string()
    } else {
        slug
    }
}

fn timestamp(now: SystemTime) -> String {
    let seconds = now.duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() as i64;
    let days = seconds.div_euclid(86_400);
    let seconds_of_day = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}{month:02}{day:02}T{:02}{:02}{:02}Z",
        seconds_of_day / 3600,
        (seconds_of_day % 3600) / 60,
        seconds_of_day % 60
    )
}

/// Howard Hinnant's `civil_from_days`: UTC date without a calendar crate.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = (z - era * 146_097) as u64;
    let year_of_era = (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era as i64 + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let mp = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

fn object_key(vault_name: &str, prefix: Option<&str>, stamp: &str) -> String {
    let base = prefix
        .unwrap_or(DEFAULT_PREFIX)
        .trim()
        .trim_start_matches('/')
        .trim_end_matches('/');
    if base.is_empty() {
        format!("{}/{}.tar.gz", vault_slug(vault_name), stamp)
    } else {
        format!("{base}/{}/{}.tar.gz", vault_slug(vault_name), stamp)
    }
}

fn vault_name(root: &Path) -> String {
    let meta = fs::read_to_string(root.join(".macusanite").join("vault.json")).unwrap_or_default();
    serde_json::from_str::<serde_json::Value>(&meta)
        .ok()
        .and_then(|value| value.get("name").and_then(|name| name.as_str()).map(str::to_string))
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| {
            root.file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_else(|| "vault".to_string())
        })
}

/* ── the archive ───────────────────────────────────────────────────────── */

/// Every regular file in the vault: path, bytes, mtime in seconds.
fn collect_files(root: &Path) -> Result<Vec<(String, Vec<u8>, u64)>, String> {
    if !root.is_dir() {
        return Err(format!("vault folder does not exist: {}", root.display()));
    }
    let mut files = Vec::new();
    walk(root, root, &mut files)?;
    files.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(files)
}

fn walk(root: &Path, directory: &Path, files: &mut Vec<(String, Vec<u8>, u64)>) -> Result<(), String> {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(_) => return Ok(()),
    };
    let mut entries = entries.filter_map(Result::ok).collect::<Vec<_>>();
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(_) => continue,
        };
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() {
            // A vault that is also a git repository backs up its notes, not its
            // object store; the CLI skips the same folder.
            if entry.file_name().to_string_lossy() == ".git" {
                continue;
            }
            walk(root, &path, files)?;
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        let Ok(metadata) = entry.metadata() else { continue };
        let Ok(data) = fs::read(&path) else { continue };
        let relative = path
            .strip_prefix(root)
            .map_err(|_| format!("path escaped the vault: {}", path.display()))?
            .to_string_lossy()
            .replace('\\', "/");
        let mtime = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_secs())
            .unwrap_or(0);
        files.push((relative, data, mtime));
    }
    Ok(())
}

fn archive(files: &[(String, Vec<u8>, u64)]) -> Result<Vec<u8>, String> {
    let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    {
        let mut builder = tar::Builder::new(&mut gzip);
        for (path, data, mtime) in files {
            let mut header = tar::Header::new_gnu();
            header.set_size(data.len() as u64);
            header.set_mode(0o644);
            header.set_mtime(*mtime);
            header.set_cksum();
            builder
                .append_data(&mut header, path, data.as_slice())
                .map_err(|error| format!("could not archive {path}: {error}"))?;
        }
        builder
            .finish()
            .map_err(|error| format!("could not finish the archive: {error}"))?;
    }
    gzip.finish().map_err(|error| format!("could not compress the archive: {error}"))
}

/* ── SigV4 ─────────────────────────────────────────────────────────────── */

fn uri_encode(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn encode_key(key: &str) -> String {
    key.split('/').map(uri_encode).collect::<Vec<_>>().join("/")
}

fn sha256_hex(data: &[u8]) -> String {
    format!("{:x}", Sha256::digest(data))
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC accepts any key length");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

fn signing_key(secret: &str, day: &str, region: &str) -> Vec<u8> {
    let date = hmac_sha256(format!("AWS4{secret}").as_bytes(), day.as_bytes());
    let zone = hmac_sha256(&date, region.as_bytes());
    let service = hmac_sha256(&zone, b"s3");
    hmac_sha256(&service, b"aws4_request")
}

/// The canonical request and the `Authorization` header for one request.
#[allow(clippy::too_many_arguments)]
fn authorize(
    method: &str,
    url: &Url,
    host: &str,
    payload_hash: &str,
    region: &str,
    credentials: &Credentials,
    amz_date: &str,
    content_type: Option<&str>,
) -> (String, String) {
    let mut headers = vec![
        ("host".to_string(), host.to_string()),
        ("x-amz-content-sha256".to_string(), payload_hash.to_string()),
        ("x-amz-date".to_string(), amz_date.to_string()),
    ];
    if let Some(value) = content_type {
        headers.push(("content-type".to_string(), value.to_string()));
    }
    if let Some(token) = &credentials.session_token {
        headers.push(("x-amz-security-token".to_string(), token.clone()));
    }
    headers.sort_by(|a, b| a.0.cmp(&b.0));

    let canonical_headers = headers
        .iter()
        .map(|(name, value)| format!("{name}:{}\n", value.trim()))
        .collect::<String>();
    let signed_headers = headers
        .iter()
        .map(|(name, _)| name.as_str())
        .collect::<Vec<_>>()
        .join(";");
    let canonical = format!(
        "{}\n{}\n{}\n{}\n{}\n{}",
        method.to_ascii_uppercase(),
        url.path(),
        url.query().unwrap_or(""),
        canonical_headers,
        signed_headers,
        payload_hash
    );
    let day = &amz_date[..8];
    let scope = format!("{day}/{region}/s3/aws4_request");
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{:x}",
        Sha256::digest(canonical.as_bytes())
    );
    let signature = hmac_sha256(&signing_key(&credentials.secret_key, day, region), string_to_sign.as_bytes());
    let signature = signature.iter().map(|byte| format!("{byte:02x}")).collect::<String>();
    let authorization = format!(
        "AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={signed_headers}, Signature={signature}",
        credentials.access_key
    );
    (canonical, authorization)
}

/* ── request target ────────────────────────────────────────────────────── */

struct Target {
    url: Url,
    host: String,
    endpoint: Option<String>,
}

fn normalize_endpoint(endpoint: &str) -> Option<String> {
    let text = endpoint.trim();
    if text.is_empty() {
        return None;
    }
    let with_scheme = if text.starts_with("http://") || text.starts_with("https://") {
        text.to_string()
    } else {
        format!("https://{text}")
    };
    Some(with_scheme.trim_end_matches('/').to_string())
}

fn target(bucket: &str, region: &str, endpoint: Option<&str>, key: &str) -> Result<Target, String> {
    let encoded = encode_key(key);
    let (url, endpoint) = match endpoint.and_then(normalize_endpoint) {
        Some(base) => {
            let url = Url::parse(&format!("{base}/{}/{encoded}", uri_encode(bucket)))
                .map_err(|error| format!("not a usable endpoint: {error}"))?;
            (url, Some(base))
        }
        None => {
            let url = Url::parse(&format!("https://{bucket}.s3.{region}.amazonaws.com/{encoded}"))
                .map_err(|error| format!("not a usable bucket name: {error}"))?;
            (url, None)
        }
    };
    let host = match url.port() {
        Some(port) => format!("{}:{port}", url.host_str().unwrap_or_default()),
        None => url.host_str().unwrap_or_default().to_string(),
    };
    Ok(Target { url, host, endpoint })
}

/// The useful sentence out of an S3 XML error body.
fn s3_error_detail(text: &str) -> String {
    let Some(start) = text.find("<Message>") else { return String::new() };
    let rest = &text[start + "<Message>".len()..];
    let Some(end) = rest.find("</Message>") else { return String::new() };
    format!(
        " — {}",
        rest[..end]
            .replace("&amp;", "&")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
    )
}

/* ── the upload ────────────────────────────────────────────────────────── */

/* ── the SSH transport ─────────────────────────────────────────────────── */

/// One word, quoted for a POSIX shell.
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// The host from the dialog, checked before ssh is started.
fn assert_ssh_host(host: &str) -> Result<String, String> {
    let name = host.trim();
    if name.is_empty() {
        return Err("an SSH host is required (user@host)".to_string());
    }
    if name.starts_with('-') || name.chars().any(|ch| ch.is_whitespace() || ch.is_control()) {
        return Err(format!("not a usable SSH host: {host}"));
    }
    Ok(name.to_string())
}

/// The script the remote host runs: stdin → temporary file → `aws s3 cp` → cleanup.
///
/// `--region`, `--profile` and `--endpoint` describe that host's own settings, so
/// only the ones the dialog supplied are passed through; otherwise its `aws`
/// configuration decides.
fn remote_script(url: &str, request: &BackupRequest) -> String {
    let mut args = format!("aws s3 cp \"$tmp\" {}", shell_quote(url));
    if let Some(region) = request.region.as_deref().map(str::trim).filter(|r| !r.is_empty()) {
        args.push_str(" --region ");
        args.push_str(&shell_quote(region));
    }
    if let Some(profile) = request.profile.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
        args.push_str(" --profile ");
        args.push_str(&shell_quote(profile));
    }
    if let Some(endpoint) = request.endpoint.as_deref().and_then(normalize_endpoint) {
        args.push_str(" --endpoint-url ");
        args.push_str(&shell_quote(&endpoint));
    }
    format!(
        "set -eu\n\
         command -v aws >/dev/null 2>&1 || {{ echo \"aws CLI not found on the remote host\" >&2; exit 127; }}\n\
         tmp=$(mktemp \"${{TMPDIR:-/tmp}}/macusanite.XXXXXX\")\n\
         trap 'rm -f \"$tmp\"' EXIT HUP INT TERM\n\
         cat > \"$tmp\"\n\
         {args}\n"
    )
}

/// How ssh is invoked, without the program name. The host cannot be an option
/// (it may not start with `-`), and ssh joins the trailing words into the one
/// command the remote shell runs.
fn ssh_arguments(ssh: &SshTarget, script: &str) -> Result<Vec<String>, String> {
    let host = assert_ssh_host(&ssh.host)?;
    // `-T` matters: an ssh config that asks for a tty would corrupt the binary
    // archive on the way through.
    let mut args = vec![
        "-T".to_string(),
        "-o".to_string(),
        "BatchMode=yes".to_string(),
        "-o".to_string(),
        "StrictHostKeyChecking=accept-new".to_string(),
    ];
    if let Some(key) = ssh.key_file.as_deref().map(str::trim).filter(|k| !k.is_empty()) {
        args.push("-i".to_string());
        args.push(key.to_string());
    }
    if let Some(port) = ssh.port {
        args.push("-p".to_string());
        args.push(port.to_string());
    }
    args.push(host);
    args.push(script.to_string());
    Ok(args)
}

/// Feed the archive to ssh, and report the remote side's own error when it fails.
///
/// stdin and stderr are handled on separate threads: a remote that refuses the
/// connection closes stdin early, and an `aws` that complains must not block on a
/// full pipe while this side is still writing.
fn run_ssh(ssh: &SshTarget, script: &str, body: &[u8]) -> Result<(), String> {
    let mut ssh = ssh.clone();
    if let Some(key) = ssh.key_file.as_deref().map(str::trim).filter(|k| !k.is_empty()) {
        let expanded = expand_home(key);
        if !expanded.exists() {
            return Err(format!("private key not found: {key}"));
        }
        ssh.key_file = Some(expanded.to_string_lossy().to_string());
    }
    let args = ssh_arguments(&ssh, script)?;
    let mut child = Command::new("ssh")
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| match error.kind() {
            std::io::ErrorKind::NotFound => {
                "the ssh command was not found — install an OpenSSH client".to_string()
            }
            _ => format!("could not start ssh: {error}"),
        })?;

    let mut stdin = child.stdin.take().ok_or("could not open ssh's input")?;
    let payload = body.to_vec();
    let writer = std::thread::spawn(move || {
        // A remote that exits early is reported by its status, not by EPIPE.
        let _ = stdin.write_all(&payload);
    });
    let mut stderr = child.stderr.take().ok_or("could not read ssh's error output")?;
    let reader = std::thread::spawn(move || {
        let mut text = String::new();
        let _ = stderr.read_to_string(&mut text);
        text
    });

    let status = child.wait().map_err(|error| format!("ssh did not finish: {error}"))?;
    let _ = writer.join();
    let detail = reader.join().unwrap_or_default();
    if status.success() {
        return Ok(());
    }
    let lines: Vec<&str> = detail.trim().lines().filter(|line| !line.trim().is_empty()).collect();
    let detail = lines[lines.len().saturating_sub(3)..].join(" ");
    let how = match status.code() {
        Some(code) => format!("exit {code}"),
        None => "a signal".to_string(),
    };
    Err(format!(
        "ssh {} could not upload the archive ({how}){}",
        ssh.host.trim(),
        if detail.is_empty() { String::new() } else { format!(": {detail}") }
    ))
}

/// `~/keys/backup.pem`, the way a shell would read it. The dialog has no shell.
fn expand_home(file: &str) -> PathBuf {
    if file == "~" {
        return home_dir();
    }
    if let Some(rest) = file.strip_prefix("~/").or_else(|| file.strip_prefix("~\\")) {
        return home_dir().join(rest);
    }
    PathBuf::from(file)
}

/// Back the vault up. Returns the report the window shows; never writes inside
/// the vault, and never logs the secret.
pub async fn backup(root: &Path, request: BackupRequest) -> Result<Report, String> {
    let bucket = request.bucket.trim().to_string();
    if bucket.is_empty() {
        return Err("an S3 bucket is required".to_string());
    }
    if !bucket
        .chars()
        .next()
        .map(|ch| ch.is_ascii_alphanumeric())
        .unwrap_or(false)
        || bucket
            .chars()
            .any(|ch| !(ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-')))
    {
        return Err(format!("not a usable S3 bucket name: {bucket}"));
    }

    // The SSH route reads the vault before it needs anything else: nothing is
    // signed here, and the remote host's own identity does the upload.
    if let Some(ssh) = request.ssh.as_ref() {
        let host = assert_ssh_host(&ssh.host)?;
        let files = collect_files(root)?;
        let stamp = timestamp(SystemTime::now());
        let key = object_key(&vault_name(root), request.prefix.as_deref(), &stamp);
        let body = archive(&files)?;
        let body_len = body.len();
        let url = format!("s3://{bucket}/{key}");
        let script = remote_script(&url, &request);
        let target = ssh.clone();
        tauri::async_runtime::spawn_blocking(move || run_ssh(&target, &script, &body))
            .await
            .map_err(|error| format!("the SSH upload could not run: {error}"))??;
        return Ok(Report {
            bucket,
            key,
            region: request
                .region
                .as_deref()
                .map(str::trim)
                .filter(|region| !region.is_empty())
                .map(str::to_string),
            endpoint: request.endpoint.as_deref().and_then(normalize_endpoint),
            files: files.len(),
            bytes: body_len,
            url,
            credentials: "remote".to_string(),
            transport: "ssh".to_string(),
            ssh_host: Some(host),
        });
    }

    let region = resolve_region(&request);
    let (credentials, source) = resolve_credentials(&request)?;
    let files = collect_files(root)?;
    let stamp = timestamp(SystemTime::now());
    let key = object_key(&vault_name(root), request.prefix.as_deref(), &stamp);
    let body = archive(&files)?;
    let body_len = body.len();
    let target = target(&bucket, &region, request.endpoint.as_deref(), &key)?;
    let payload_hash = sha256_hex(&body);

    let (_, authorization) = authorize(
        "PUT",
        &target.url,
        &target.host,
        &payload_hash,
        &region,
        &credentials,
        &stamp,
        Some("application/gzip"),
    );

    let client = reqwest::Client::builder()
        .build()
        .map_err(|error| format!("could not create an HTTP client: {error}"))?;
    let mut outgoing = client
        .put(target.url.clone())
        .header("content-type", "application/gzip")
        .header("x-amz-content-sha256", &payload_hash)
        .header("x-amz-date", &stamp)
        .header("authorization", authorization);
    if let Some(token) = &credentials.session_token {
        outgoing = outgoing.header("x-amz-security-token", token);
    }
    let response = outgoing
        .body(body)
        .send()
        .await
        .map_err(|error| format!("could not reach {}: {error}", target.host))?;
    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(format!("S3 refused the upload ({status}){}", s3_error_detail(&text)));
    }

    Ok(Report {
        bucket: bucket.clone(),
        key: key.clone(),
        region: Some(region),
        endpoint: target.endpoint,
        files: files.len(),
        bytes: body_len,
        url: format!("s3://{bucket}/{key}"),
        credentials: source,
        transport: "direct".to_string(),
        ssh_host: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;
    use std::time::Duration;

    fn example_credentials() -> Credentials {
        Credentials {
            access_key: "AKIAIOSFODNN7EXAMPLE".to_string(),
            secret_key: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY".to_string(),
            session_token: None,
        }
    }

    /// The worked GET example from AWS's SigV4 documentation.
    #[test]
    fn signature_matches_the_published_aws_example() {
        let mut headers = vec![
            ("host".to_string(), "examplebucket.s3.amazonaws.com".to_string()),
            (
                "x-amz-content-sha256".to_string(),
                "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855".to_string(),
            ),
            ("x-amz-date".to_string(), "20130524T000000Z".to_string()),
        ];
        // `authorize` signs a fixed header set, so add the range header through a
        // direct canonical-request calculation instead.
        headers.push(("range".to_string(), "bytes=0-9".to_string()));
        headers.sort_by(|a, b| a.0.cmp(&b.0));
        let canonical_headers = headers
            .iter()
            .map(|(name, value)| format!("{name}:{value}\n"))
            .collect::<String>();
        let signed = "host;range;x-amz-content-sha256;x-amz-date";
        let canonical = format!(
            "GET\n/test.txt\n\n{canonical_headers}\n{signed}\n{}",
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            canonical,
            "GET\n/test.txt\n\nhost:examplebucket.s3.amazonaws.com\nrange:bytes=0-9\n\
             x-amz-content-sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\n\
             x-amz-date:20130524T000000Z\n\nhost;range;x-amz-content-sha256;x-amz-date\n\
             e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        let scope = "20130524/us-east-1/s3/aws4_request";
        let string_to_sign = format!(
            "AWS4-HMAC-SHA256\n20130524T000000Z\n{scope}\n{:x}",
            Sha256::digest(canonical.as_bytes())
        );
        let signature = hmac_sha256(&signing_key(&example_credentials().secret_key, "20130524", "us-east-1"), string_to_sign.as_bytes());
        let signature = signature.iter().map(|byte| format!("{byte:02x}")).collect::<String>();
        assert_eq!(signature, "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
    }

    #[test]
    fn authorize_signs_the_headers_it_sends() {
        let url = Url::parse("https://notes.s3.eu-west-1.amazonaws.com/macusanite/a.tar.gz").unwrap();
        let (canonical, authorization) = authorize(
            "PUT",
            &url,
            "notes.s3.eu-west-1.amazonaws.com",
            &sha256_hex(b"body"),
            "eu-west-1",
            &example_credentials(),
            "20261105T131415Z",
            Some("application/gzip"),
        );
        // The same request, signed by the CLI's implementation, so the two front
        // ends cannot drift apart: this signature comes from src/lib/sigv4.js,
        // which is checked against AWS's published example above it.
        assert_eq!(
            canonical,
            "PUT\n/macusanite/a.tar.gz\n\ncontent-type:application/gzip\n\
             host:notes.s3.eu-west-1.amazonaws.com\n\
             x-amz-content-sha256:230d8358dc8e8890b4c58deeb62912ee2f20357ae92a5cc861b98e68fe31acb5\n\
             x-amz-date:20261105T131415Z\n\n\
             content-type;host;x-amz-content-sha256;x-amz-date\n\
             230d8358dc8e8890b4c58deeb62912ee2f20357ae92a5cc861b98e68fe31acb5"
        );
        assert_eq!(
            authorization,
            "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20261105/eu-west-1/s3/aws4_request, \
             SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, \
             Signature=8ec434f8a49ccbabd228ec0722be5eeaa40fa55eb2c2ec72e36a1b8074273143"
        );
    }

    #[test]
    fn keys_match_the_cli_layout() {
        assert_eq!(vault_slug("Macusani Field Notes!"), "macusani-field-notes");
        assert_eq!(vault_slug("***"), "vault");
        assert_eq!(
            object_key("Field Notes", Some("/archive/"), "20261105T131415Z"),
            "archive/field-notes/20261105T131415Z.tar.gz"
        );
        assert_eq!(
            object_key("Field Notes", None, "20261105T131415Z"),
            "macusanite/field-notes/20261105T131415Z.tar.gz"
        );
    }

    #[test]
    fn endpoints_are_path_style_and_aws_is_virtual_host() {
        let aws = target("notes", "eu-west-1", None, "a/b.tar.gz").unwrap();
        assert_eq!(aws.url.as_str(), "https://notes.s3.eu-west-1.amazonaws.com/a/b.tar.gz");
        assert_eq!(aws.host, "notes.s3.eu-west-1.amazonaws.com");

        let custom = target("notes", "eu-west-1", Some("http://127.0.0.1:9000"), "a/b.tar.gz").unwrap();
        assert_eq!(custom.url.as_str(), "http://127.0.0.1:9000/notes/a/b.tar.gz");
        assert_eq!(custom.host, "127.0.0.1:9000");
    }

    #[test]
    fn the_archive_is_gzipped_tar_with_the_right_contents() {
        let files = vec![
            ("Home.md".to_string(), b"# Home\n".to_vec(), 1_700_000_000),
            ("Chambers/Lab.md".to_string(), b"# Lab\n".to_vec(), 1_700_000_000),
        ];
        let bytes = archive(&files).unwrap();
        assert_eq!(&bytes[..2], &[0x1f, 0x8b], "gzip magic");
        let mut decode = flate2::read::GzDecoder::new(bytes.as_slice());
        let mut tar_bytes = Vec::new();
        std::io::Read::read_to_end(&mut decode, &mut tar_bytes).unwrap();
        let mut tar = tar::Archive::new(tar_bytes.as_slice());
        let mut seen = Vec::new();
        for entry in tar.entries().unwrap() {
            let entry = entry.unwrap();
            let path = entry.path().unwrap().to_string_lossy().to_string();
            seen.push(path);
        }
        assert_eq!(seen, vec!["Home.md", "Chambers/Lab.md"]);
    }

    /// The whole Rust path against a local HTTP server: path-style endpoint,
    /// signed PUT, and a gzipped tar that still holds the vault.
    #[test]
    fn an_upload_sends_one_signed_tarball() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (sender, receiver) = mpsc::channel();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buffer = Vec::new();
            let mut chunk = [0u8; 8192];
            let headers_end = loop {
                let read = stream.read(&mut chunk).unwrap();
                if read == 0 {
                    break 0;
                }
                buffer.extend_from_slice(&chunk[..read]);
                if let Some(at) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
                    break at + 4;
                }
            };
            let headers = String::from_utf8_lossy(&buffer[..headers_end]).to_string();
            let length = headers
                .lines()
                .find_map(|line| {
                    let lower = line.to_ascii_lowercase();
                    lower.strip_prefix("content-length:").map(|value| value.trim().parse::<usize>().unwrap())
                })
                .unwrap_or(0);
            while buffer.len() < headers_end + length {
                let read = stream.read(&mut chunk).unwrap();
                if read == 0 {
                    break;
                }
                buffer.extend_from_slice(&chunk[..read]);
            }
            let body = buffer[headers_end..headers_end + length].to_vec();
            sender.send((headers, body)).unwrap();
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .unwrap();
        });

        let root = std::env::temp_dir().join(format!("macusanite-s3-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join(".macusanite")).unwrap();
        fs::write(
            root.join(".macusanite").join("vault.json"),
            "{\"name\":\"Field Notes\"}",
        )
        .unwrap();
        fs::write(root.join("Home.md"), "# Home\n").unwrap();

        let request = BackupRequest {
            bucket: "notes".to_string(),
            region: Some("us-east-1".to_string()),
            endpoint: Some(format!("http://127.0.0.1:{port}")),
            access_key: Some("AKIATEST".to_string()),
            secret_key: Some("secret".to_string()),
            ..Default::default()
        };
        let report = tauri::async_runtime::block_on(backup(&root, request)).unwrap();
        assert_eq!(report.bucket, "notes");
        assert_eq!(report.files, 2);
        assert_eq!(report.credentials, "flags");
        assert!(report.key.starts_with("macusanite/field-notes/"));

        let (headers, body) = receiver.recv_timeout(Duration::from_secs(10)).unwrap();
        server.join().unwrap();
        assert!(headers.starts_with(&format!("PUT /notes/{}", report.key)), "request line: {headers}");
        let lower = headers.to_ascii_lowercase();
        assert!(lower.contains("authorization: aws4-hmac-sha256 credential=akiatest/"), "headers: {headers}");
        assert!(lower.contains("x-amz-content-sha256:"));
        assert_eq!(&body[..2], &[0x1f, 0x8b], "gzip magic");
        let mut decode = flate2::read::GzDecoder::new(body.as_slice());
        let mut tar_bytes = Vec::new();
        std::io::Read::read_to_end(&mut decode, &mut tar_bytes).unwrap();
        let mut tar = tar::Archive::new(tar_bytes.as_slice());
        let paths = tar
            .entries()
            .unwrap()
            .map(|entry| entry.unwrap().path().unwrap().to_string_lossy().to_string())
            .collect::<Vec<_>>();
        assert_eq!(paths, vec![".macusanite/vault.json", "Home.md"]);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn timestamps_are_utc_without_a_calendar_crate() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(20_727), (2026, 10, 1));
        let stamp = timestamp(UNIX_EPOCH + std::time::Duration::from_secs(1_791_000_000));
        assert!(stamp.ends_with('Z'), "stamp is UTC: {stamp}");
        assert_eq!(stamp.len(), 16);
    }

    /// The remote half of the SSH route: the archive goes to that host's own
    /// `aws` CLI, with its own region, profile and endpoint.
    #[test]
    fn the_ssh_script_quotes_the_object_and_remote_settings() {
        let request = BackupRequest {
            bucket: "notes".to_string(),
            region: Some("eu-west-1".to_string()),
            profile: Some("backup".to_string()),
            endpoint: Some("minio.local:9000".to_string()),
            ..BackupRequest::default()
        };
        let script = remote_script("s3://notes/macusanite/v/20261105T131415Z.tar.gz", &request);
        assert!(script.starts_with("set -eu\n"), "{script}");
        assert!(script.contains("trap 'rm -f \"$tmp\"' EXIT HUP INT TERM"), "{script}");
        assert!(
            script.contains("aws s3 cp \"$tmp\" 's3://notes/macusanite/v/20261105T131415Z.tar.gz'"),
            "{script}"
        );
        assert!(script.contains("--region 'eu-west-1'"), "{script}");
        assert!(script.contains("--profile 'backup'"), "{script}");
        assert!(script.contains("--endpoint-url 'https://minio.local:9000'"), "{script}");

        // Nothing supplied means nothing passed: the host's own aws config decides.
        let bare = remote_script("s3://notes/k", &BackupRequest::default());
        assert!(!bare.contains("--region"), "{bare}");
        assert!(!bare.contains("--profile"), "{bare}");
        assert!(!bare.contains("--endpoint-url"), "{bare}");
    }

    #[test]
    fn ssh_arguments_name_the_key_and_port_and_refuse_option_like_hosts() {
        let ssh = SshTarget {
            host: "backup@example.com".to_string(),
            key_file: Some("/keys/backup.pem".to_string()),
            port: Some(2222),
        };
        let args = ssh_arguments(&ssh, "echo hi").unwrap();
        assert!(args.iter().any(|arg| arg == "BatchMode=yes"));
        assert_eq!(args[args.iter().position(|arg| arg == "-i").unwrap() + 1], "/keys/backup.pem");
        assert_eq!(args[args.iter().position(|arg| arg == "-p").unwrap() + 1], "2222");
        assert_eq!(args[args.len() - 2], "backup@example.com");
        assert_eq!(args[args.len() - 1], "echo hi");

        let bad_host = SshTarget { host: "-oProxyCommand=bad".to_string(), ..SshTarget::default() };
        assert!(ssh_arguments(&bad_host, "x").is_err());
        let empty_host = SshTarget { host: "   ".to_string(), ..SshTarget::default() };
        assert!(ssh_arguments(&empty_host, "x").is_err());
    }

    #[test]
    fn a_leading_tilde_in_the_key_path_is_the_home_folder() {
        assert_eq!(expand_home("~"), home_dir());
        assert_eq!(expand_home("~/keys/backup.pem"), home_dir().join("keys/backup.pem"));
        assert_eq!(expand_home("/keys/backup.pem"), PathBuf::from("/keys/backup.pem"));
    }
}
