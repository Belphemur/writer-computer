//! Exact home-directory files an agent plugin may read and replace (`HOME_FILES`).
//!
//! The plugin `fs` shim refuses everything outside the vault. Copilot manages Claude Code's
//! "always allow" rules by read-modify-writing the REAL `~/.claude/settings.json` (the file the
//! `claude` CLI reads), which a virtual mount cannot serve. This module is the one place that
//! touches such a file: an explicit allowlist of exact home-relative FILES (no directories, no
//! globs), each naming the plugin ids that may use it. Policy and IO are Tauri-free so they are
//! tested here; the command layer (`commands/plugins.rs`) adds the trusted-vault and spawn-consent
//! gates and the logging. ADR 2026-11-16 "Let a consented agent plugin edit Claude's settings file".
//!
//! Guarantees of `read` / `write`:
//! - the request path must be EXACTLY `<home>/<entry.rel>` (a `..` or any other spelling is refused);
//! - `<home>` and the entry's directory resolve through symlinks, and the resolved location (and a
//!   symlinked file's target) must stay inside the canonical home; the target must be a regular
//!   file (never a directory, FIFO or device);
//! - UTF-8 text only, at most `MAX_BYTES`;
//! - writes go to a temp file in the target's own directory, are fsynced, then renamed over the
//!   target, so the `claude` CLI never sees a partial file; an existing file's permission bits are
//!   kept, a new file is 0600, a missing entry directory is created 0700 (only the entry's own
//!   directory, directly under home);
//! - optimistic concurrency: `write` can carry the `version` that `read` returned and refuses
//!   (`ESTALE`) when the file changed since. The window between that check and the rename is not
//!   closed (the CLI takes no lock either).

use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

/// Largest file read or written.
pub const MAX_BYTES: usize = 1024 * 1024;

pub struct HomeFile {
    /// Path relative to the home directory, exactly two components: `<dir>/<file>`.
    pub rel: &'static str,
    /// Plugin ids that may use it (still needs native spawn consent in the vault).
    pub plugins: &'static [&'static str],
}

/// The allowlist. Adding an entry is a security decision (ADR 2026-11-16): exact file, named
/// plugins, and the plugin must be able to spawn programs already. Never list credentials
/// (`~/.claude.json`), transcripts (`~/.claude/projects`) or vault-local settings
/// (`<vault>/.claude/settings*.json` are inside the vault and use the vault fs).
pub const HOME_FILES: &[HomeFile] = &[HomeFile {
    rel: ".claude/settings.json",
    plugins: &["copilot"],
}];

#[derive(Debug, Clone, PartialEq)]
pub struct ReadOut {
    pub exists: bool,
    pub text: Option<String>,
    /// Content digest to pass back as `expected_version`; `None` when the file is missing.
    pub version: Option<String>,
    pub size: u64,
    /// Permission bits (`0o644`); 0 when missing.
    pub mode: u32,
    pub mtime_ms: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct WriteOut {
    pub version: String,
    pub bytes: usize,
}

/// `plugin_id` may use the allowlisted file at `path` (an absolute path from the plugin).
pub fn entry_for(home: &Path, path: &str, plugin_id: &str) -> Result<&'static HomeFile, String> {
    let p = Path::new(path);
    let found = HOME_FILES
        .iter()
        .find(|e| home.join(e.rel) == p && p.is_absolute());
    match found {
        Some(e) if e.plugins.contains(&plugin_id) => Ok(e),
        _ => Err("EACCES: permission denied (outside the vault)".into()),
    }
}

/// The gates the command layer applies before any IO. Pure so the matrix is tested.
pub fn gate(trusted: bool, spawn_consent: bool) -> Result<(), String> {
    if !trusted {
        return Err(
            "EACCES: permission denied (plugins are in restricted mode for this vault)".into(),
        );
    }
    if !spawn_consent {
        return Err("EACCES: permission denied (outside the vault)".into());
    }
    Ok(())
}

pub fn version_of(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Log line for a write: plugin, file and size only, never contents.
pub fn write_log_line(plugin_id: &str, entry: &HomeFile, bytes: usize) -> String {
    format!("plugin {plugin_id}: wrote ~/{} ({bytes} bytes)", entry.rel)
}

fn eio(what: &str, e: std::io::Error) -> String {
    match e.kind() {
        std::io::ErrorKind::PermissionDenied => format!("EACCES: {what}: {e}"),
        _ => format!("EIO: {what}: {e}"),
    }
}

struct Target {
    /// Where the bytes live: the file, or its symlink target (inside home), maybe not yet created.
    file: PathBuf,
    exists: bool,
}

/// Resolve the entry to a real location inside the canonical home. `create_dir` makes the entry's
/// directory (0700) when it is absent; reads pass false.
fn resolve(home: &Path, entry: &HomeFile, create_dir: bool) -> Result<Option<Target>, String> {
    let home_c = home.canonicalize().map_err(|e| eio("home directory", e))?;
    let rel = Path::new(entry.rel);
    let (dir_name, file_name) = (
        rel.parent()
            .and_then(|p| p.file_name())
            .ok_or("bad allowlist entry")?,
        rel.file_name().ok_or("bad allowlist entry")?,
    );
    let dir = home.join(dir_name);
    match fs::symlink_metadata(&dir) {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            if !create_dir {
                return Ok(None);
            }
            make_dir_0700(&dir).map_err(|e| eio("create directory", e))?;
        }
        Err(e) => return Err(eio("directory", e)),
    }
    let dir_c = dir.canonicalize().map_err(|e| eio("directory", e))?;
    if !dir_c.starts_with(&home_c) || !dir_c.is_dir() {
        return Err(
            "EACCES: permission denied (the directory resolves outside the home directory)".into(),
        );
    }
    let file = dir_c.join(file_name);
    match fs::symlink_metadata(&file) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Some(Target {
            file,
            exists: false,
        })),
        Err(e) => Err(eio("file", e)),
        Ok(m) => {
            let real = if m.file_type().is_symlink() {
                let r = file.canonicalize().map_err(|e| eio("symlink target", e))?;
                if !r.starts_with(&home_c) {
                    return Err("EACCES: permission denied (the symlink resolves outside the home directory)".into());
                }
                r
            } else {
                file
            };
            let m = fs::metadata(&real).map_err(|e| eio("file", e))?;
            if !m.is_file() {
                return Err("EISDIR: not a regular file".into());
            }
            Ok(Some(Target {
                file: real,
                exists: true,
            }))
        }
    }
}

#[cfg(unix)]
fn make_dir_0700(dir: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    fs::DirBuilder::new().mode(0o700).create(dir)
}
#[cfg(not(unix))]
fn make_dir_0700(dir: &Path) -> std::io::Result<()> {
    fs::create_dir(dir)
}

#[cfg(unix)]
fn mode_of(m: &fs::Metadata) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    m.permissions().mode() & 0o777
}
#[cfg(not(unix))]
fn mode_of(_: &fs::Metadata) -> u32 {
    0o644
}

fn read_capped(file: &Path) -> Result<Vec<u8>, String> {
    let f = fs::File::open(file).map_err(|e| eio("open", e))?;
    let mut buf = Vec::new();
    f.take(MAX_BYTES as u64 + 1)
        .read_to_end(&mut buf)
        .map_err(|e| eio("read", e))?;
    if buf.len() > MAX_BYTES {
        return Err(format!("EFBIG: file is larger than {MAX_BYTES} bytes"));
    }
    Ok(buf)
}

pub fn read(home: &Path, entry: &HomeFile) -> Result<ReadOut, String> {
    let missing = ReadOut {
        exists: false,
        text: None,
        version: None,
        size: 0,
        mode: 0,
        mtime_ms: 0.0,
    };
    let Some(t) = resolve(home, entry, false)? else {
        return Ok(missing);
    };
    if !t.exists {
        return Ok(missing);
    }
    let bytes = read_capped(&t.file)?;
    let meta = fs::metadata(&t.file).map_err(|e| eio("stat", e))?;
    let text = String::from_utf8(bytes.clone())
        .map_err(|_| "EILSEQ: file is not UTF-8 text".to_string())?;
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0.0, |d| d.as_secs_f64() * 1000.0);
    Ok(ReadOut {
        exists: true,
        text: Some(text),
        version: Some(version_of(&bytes)),
        size: bytes.len() as u64,
        mode: mode_of(&meta),
        mtime_ms,
    })
}

/// Replace the file's content atomically. `expected_version`: `Some(v)` requires the current
/// content to hash to `v`; `Some("")` requires the file to be absent; `None` skips the check.
pub fn write(
    home: &Path,
    entry: &HomeFile,
    text: &str,
    expected_version: Option<&str>,
) -> Result<WriteOut, String> {
    if text.len() > MAX_BYTES {
        return Err(format!("EFBIG: content is larger than {MAX_BYTES} bytes"));
    }
    let t = resolve(home, entry, true)?.ok_or("ENOENT: directory is missing")?;
    if let Some(want) = expected_version {
        let current = if t.exists {
            Some(version_of(&read_capped(&t.file)?))
        } else {
            None
        };
        let ok = match (&current, want) {
            (None, "") => true,
            (Some(c), w) => c == w,
            (None, _) => false,
        };
        if !ok {
            return Err(format!(
                "ESTALE: ~/{} changed on disk since it was read",
                entry.rel
            ));
        }
    }
    let mode = if t.exists {
        mode_of(&fs::metadata(&t.file).map_err(|e| eio("stat", e))?)
    } else {
        0o600
    };
    let dir = t.file.parent().ok_or("bad path")?;
    let name = t
        .file
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("bad path")?;
    let tmp = dir.join(format!(".{name}.writer-{}.tmp", uuid::Uuid::new_v4()));
    let res = (|| -> std::io::Result<()> {
        let mut f = open_new(&tmp, mode)?;
        f.write_all(text.as_bytes())?;
        set_mode(&f, mode)?;
        f.sync_all()?;
        drop(f);
        fs::rename(&tmp, &t.file)
    })();
    if let Err(e) = res {
        let _ = fs::remove_file(&tmp);
        return Err(eio("write", e));
    }
    Ok(WriteOut {
        version: version_of(text.as_bytes()),
        bytes: text.len(),
    })
}

#[cfg(unix)]
fn open_new(p: &Path, mode: u32) -> std::io::Result<fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(mode)
        .open(p)
}
#[cfg(not(unix))]
fn open_new(p: &Path, _mode: u32) -> std::io::Result<fs::File> {
    fs::OpenOptions::new().write(true).create_new(true).open(p)
}

#[cfg(unix)]
fn set_mode(f: &fs::File, mode: u32) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    f.set_permissions(fs::Permissions::from_mode(mode))
}
#[cfg(not(unix))]
fn set_mode(_: &fs::File, _: u32) -> std::io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }
    fn entry() -> &'static HomeFile {
        &HOME_FILES[0]
    }
    fn abs(h: &Path) -> String {
        h.join(".claude/settings.json")
            .to_string_lossy()
            .into_owned()
    }
    fn put(h: &Path, text: &str) {
        fs::create_dir_all(h.join(".claude")).unwrap();
        fs::write(h.join(".claude/settings.json"), text).unwrap();
    }

    #[test]
    fn exact_path_and_plugin_only() {
        let h = home();
        let p = abs(h.path());
        assert!(entry_for(h.path(), &p, "copilot").is_ok());
        assert!(entry_for(h.path(), &p, "other").is_err());
        let hs = h.path().to_string_lossy();
        for bad in [
            format!("{hs}/.claude/settings.local.json"),
            format!("{hs}/.claude.json"),
            format!("{hs}/.claude/../.claude/settings.json"),
            format!("{hs}/.claude/../.ssh/x"),
            format!("{hs}/.claude"),
            ".claude/settings.json".to_string(),
            "/etc/passwd".to_string(),
        ] {
            assert!(entry_for(h.path(), &bad, "copilot").is_err(), "{bad}");
        }
    }

    #[test]
    fn gates() {
        assert!(gate(true, true).is_ok());
        assert!(gate(false, true).unwrap_err().contains("restricted"));
        assert!(gate(true, false).unwrap_err().starts_with("EACCES"));
        assert!(gate(false, false).is_err());
    }

    #[test]
    fn read_missing_then_roundtrip_and_mode() {
        let h = home();
        assert!(!read(h.path(), entry()).unwrap().exists); // no ~/.claude at all
        let w = write(h.path(), entry(), "{\"a\":1}", Some("")).unwrap();
        assert_eq!(w.bytes, 7);
        let dir_mode = mode_of(&fs::metadata(h.path().join(".claude")).unwrap());
        assert_eq!(dir_mode, 0o700);
        let r = read(h.path(), entry()).unwrap();
        assert_eq!(r.text.as_deref(), Some("{\"a\":1}"));
        assert_eq!(r.version.as_deref(), Some(w.version.as_str()));
        assert_eq!(r.mode, 0o600);
        // existing 0644 is preserved
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let f = h.path().join(".claude/settings.json");
            fs::set_permissions(&f, fs::Permissions::from_mode(0o644)).unwrap();
            write(h.path(), entry(), "{}", Some(&w.version)).unwrap();
            assert_eq!(mode_of(&fs::metadata(&f).unwrap()), 0o644);
        }
        // no temp files are left behind
        let names: Vec<_> = fs::read_dir(h.path().join(".claude"))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["settings.json"]);
    }

    #[test]
    fn stale_version_is_refused_and_file_untouched() {
        let h = home();
        put(h.path(), "one");
        let v = read(h.path(), entry()).unwrap().version.unwrap();
        fs::write(h.path().join(".claude/settings.json"), "two").unwrap(); // the CLI wrote
        let e = write(h.path(), entry(), "three", Some(&v)).unwrap_err();
        assert!(e.starts_with("ESTALE"), "{e}");
        assert_eq!(
            fs::read_to_string(h.path().join(".claude/settings.json")).unwrap(),
            "two"
        );
        // existing file but "must be absent"
        assert!(write(h.path(), entry(), "x", Some(""))
            .unwrap_err()
            .starts_with("ESTALE"));
        // None skips the check
        write(h.path(), entry(), "four", None).unwrap();
    }

    #[test]
    fn refuses_directory_oversize_and_non_utf8() {
        let h = home();
        fs::create_dir_all(h.path().join(".claude/settings.json")).unwrap();
        assert!(read(h.path(), entry()).unwrap_err().starts_with("EISDIR"));
        assert!(write(h.path(), entry(), "x", None)
            .unwrap_err()
            .starts_with("EISDIR"));
        fs::remove_dir(h.path().join(".claude/settings.json")).unwrap();

        fs::write(
            h.path().join(".claude/settings.json"),
            vec![b'a'; MAX_BYTES + 1],
        )
        .unwrap();
        assert!(read(h.path(), entry()).unwrap_err().starts_with("EFBIG"));
        let big = "a".repeat(MAX_BYTES + 1);
        assert!(write(h.path(), entry(), &big, None)
            .unwrap_err()
            .starts_with("EFBIG"));

        fs::write(h.path().join(".claude/settings.json"), [0xff, 0xfe, 0x00]).unwrap();
        assert!(read(h.path(), entry()).unwrap_err().starts_with("EILSEQ"));
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_stay_inside_home() {
        use std::os::unix::fs::symlink;
        let h = home();
        let outside = home();
        fs::write(outside.path().join("evil.json"), "{}").unwrap();

        // file symlink to a path outside home: refused (read and write)
        fs::create_dir_all(h.path().join(".claude")).unwrap();
        symlink(
            outside.path().join("evil.json"),
            h.path().join(".claude/settings.json"),
        )
        .unwrap();
        assert!(read(h.path(), entry()).unwrap_err().starts_with("EACCES"));
        assert!(write(h.path(), entry(), "x", None)
            .unwrap_err()
            .starts_with("EACCES"));
        assert_eq!(
            fs::read_to_string(outside.path().join("evil.json")).unwrap(),
            "{}"
        );

        // dangling symlink: refused, not created through
        fs::remove_file(h.path().join(".claude/settings.json")).unwrap();
        symlink(
            h.path().join("nope.json"),
            h.path().join(".claude/settings.json"),
        )
        .unwrap();
        assert!(read(h.path(), entry()).is_err());
        fs::remove_file(h.path().join(".claude/settings.json")).unwrap();

        // directory symlink out of home: refused
        fs::remove_dir(h.path().join(".claude")).unwrap();
        symlink(outside.path(), h.path().join(".claude")).unwrap();
        assert!(read(h.path(), entry()).unwrap_err().starts_with("EACCES"));
        assert!(write(h.path(), entry(), "x", None)
            .unwrap_err()
            .starts_with("EACCES"));
        assert!(!outside.path().join("settings.json").exists());
        fs::remove_file(h.path().join(".claude")).unwrap();

        // symlink to a file elsewhere inside home (dotfiles repo): works, the link is kept
        fs::create_dir_all(h.path().join("dotfiles")).unwrap();
        fs::write(h.path().join("dotfiles/cs.json"), "old").unwrap();
        fs::create_dir_all(h.path().join(".claude")).unwrap();
        symlink(
            h.path().join("dotfiles/cs.json"),
            h.path().join(".claude/settings.json"),
        )
        .unwrap();
        assert_eq!(
            read(h.path(), entry()).unwrap().text.as_deref(),
            Some("old")
        );
        write(h.path(), entry(), "new", None).unwrap();
        assert_eq!(
            fs::read_to_string(h.path().join("dotfiles/cs.json")).unwrap(),
            "new"
        );
        assert!(fs::symlink_metadata(h.path().join(".claude/settings.json"))
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[test]
    fn missing_home_is_an_error_not_a_creation() {
        let h = home();
        let gone = h.path().join("no-such-home");
        assert!(write(&gone, entry(), "x", None).is_err());
        assert!(!gone.exists());
    }

    #[test]
    fn log_line_never_carries_contents() {
        let secret = "sk-ant-SECRET";
        let line = write_log_line("copilot", entry(), secret.len());
        assert_eq!(
            line,
            "plugin copilot: wrote ~/.claude/settings.json (13 bytes)"
        );
        assert!(!line.contains(secret));
    }
}
