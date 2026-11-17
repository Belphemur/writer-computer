//! Finding the `claude` binary and its version (spec 7, "Binary discovery").
//!
//! Order: the `agent.binary-path` override (absolute, executable regular file), then the app's
//! PATH, the login-shell PATH (`plugin_env::login_path`, cached), the known install dirs
//! (`plugin_env::search_dirs`: `~/.claude/local`, Homebrew, version-manager bin dirs). The
//! version probe is Writer's own fixed `claude --version` with a 5 s timeout and the filtered
//! environment; it is not a plugin spawn, so it needs no consent and does not count toward the
//! process cap.

use crate::plugin_env;
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// The version the CLI behaviour in the spec was verified against.
pub const VERIFIED_VERSION: &str = "2.1.325";
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum BinarySource {
    Override,
    Path,
    LoginPath,
    KnownDir,
}

/// Mirror of `AgentBinaryInfo` in `events.ts`, plus `searched` (the directories tried when
/// nothing was found; `[]` when found).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentBinaryInfo {
    pub found: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub source: Option<BinarySource>,
    pub searched: Vec<String>,
}

/// Pure lookup, no probe. `app`/`login` are PATH-style strings.
pub fn locate(
    override_path: Option<&str>,
    app: &str,
    login: &str,
    home: Option<&Path>,
) -> (Option<(PathBuf, BinarySource)>, Vec<String>) {
    if let Some(o) = override_path.map(str::trim).filter(|o| !o.is_empty()) {
        let found = Path::new(o)
            .is_absolute()
            .then(|| plugin_env::which_in(o, &[]).ok().flatten())
            .flatten();
        let searched = if found.is_some() {
            vec![]
        } else {
            vec![o.to_string()]
        };
        return (found.map(|p| (p, BinarySource::Override)), searched);
    }
    let app_dirs: Vec<PathBuf> = std::env::split_paths(app).collect();
    let login_dirs: Vec<PathBuf> = std::env::split_paths(login).collect();
    let dirs = plugin_env::search_dirs(login, app, home);
    let hit = plugin_env::which_in("claude", &dirs).ok().flatten();
    let Some(hit) = hit else {
        return (
            None,
            dirs.iter()
                .map(|d| d.to_string_lossy().into_owned())
                .collect(),
        );
    };
    let dir = hit.parent().map(Path::to_path_buf).unwrap_or_default();
    let source = if app_dirs.contains(&dir) {
        BinarySource::Path
    } else if login_dirs.contains(&dir) {
        BinarySource::LoginPath
    } else {
        BinarySource::KnownDir
    };
    (Some((hit, source)), vec![])
}

/// `2.1.325 (Claude Code)` -> `2.1.325`.
pub fn parse_version(out: &str) -> Option<String> {
    out.split_whitespace()
        .find(|t| {
            !t.is_empty()
                && t.split('.').count() >= 2
                && t.split('.')
                    .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
        })
        .map(str::to_string)
}

fn numeric(v: &str) -> Vec<u64> {
    v.split('.').map(|p| p.parse().unwrap_or(0)).collect()
}

/// `true` only for a known version older than the verified one.
pub fn is_older_than_verified(version: Option<&str>) -> bool {
    version.is_some_and(|v| numeric(v) < numeric(VERIFIED_VERSION))
}

type ProbeKey = (PathBuf, u64, std::time::SystemTime);
static PROBES: Mutex<Option<HashMap<ProbeKey, Option<String>>>> = Mutex::new(None);

/// `claude --version`, cached per (path, size, mtime). Blocks up to 5 s: blocking thread only.
pub fn probe_version(program: &Path) -> Option<String> {
    let key = std::fs::metadata(program)
        .ok()
        .and_then(|m| Some((program.to_path_buf(), m.len(), m.modified().ok()?)));
    if let Some(k) = &key {
        if let Some(v) = PROBES.lock().as_ref().and_then(|m| m.get(k)) {
            return v.clone();
        }
    }
    let version = run_version(program);
    log::info!(
        target: "agent",
        "agent: version probe finished (version known: {})",
        version.is_some()
    );
    if let Some(k) = key {
        PROBES
            .lock()
            .get_or_insert_with(HashMap::new)
            .insert(k, version.clone());
    }
    version
}

fn run_version(program: &Path) -> Option<String> {
    let mut cmd = Command::new(program);
    cmd.arg("--version")
        .env_clear()
        .envs(super::env::current())
        .current_dir(std::env::temp_dir())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = cmd.spawn().ok()?;
    let deadline = Instant::now() + PROBE_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return None;
                }
                let mut out = String::new();
                if let Some(mut so) = child.stdout.take() {
                    use std::io::Read;
                    let _ = so.by_ref().take(4096).read_to_string(&mut out);
                }
                return parse_version(&out);
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            _ => {
                #[cfg(unix)]
                unsafe {
                    libc::kill(-(child.id() as i32), libc::SIGKILL);
                }
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

/// The `agent_detect_binary` result. Blocking (login shell, version probe).
pub fn detect(override_path: Option<&str>) -> AgentBinaryInfo {
    let app = std::env::var("PATH").unwrap_or_default();
    // the login shell is only needed without an override
    let login = if override_path.is_some_and(|o| !o.trim().is_empty()) {
        String::new()
    } else {
        plugin_env::login_path()
    };
    let (found, searched) = locate(
        override_path,
        &app,
        &login,
        plugin_env::home_dir().as_deref(),
    );
    match found {
        Some((path, source)) => AgentBinaryInfo {
            found: true,
            version: probe_version(&path),
            path: Some(path.to_string_lossy().into_owned()),
            source: Some(source),
            searched,
        },
        None => AgentBinaryInfo {
            found: false,
            path: None,
            version: None,
            source: None,
            searched,
        },
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn exe(path: &Path, body: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[test]
    fn version_parsing_and_comparison() {
        assert_eq!(
            parse_version("2.1.325 (Claude Code)\n").as_deref(),
            Some("2.1.325")
        );
        assert_eq!(parse_version("nonsense"), None);
        assert!(is_older_than_verified(Some("2.1.324")));
        assert!(is_older_than_verified(Some("1.9.999")));
        assert!(!is_older_than_verified(Some("2.1.325")));
        assert!(!is_older_than_verified(Some("2.10.0")));
        assert!(!is_older_than_verified(None), "unknown is not old");
    }

    #[test]
    fn locate_orders_override_path_login_known() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path();
        let app_bin = p.join("app");
        let login_bin = p.join("login");
        let home = p.join("home");
        exe(&app_bin.join("claude"), "#!/bin/sh\n");
        exe(&login_bin.join("claude"), "#!/bin/sh\n");
        exe(&home.join(".claude/local/claude"), "#!/bin/sh\n");
        let app = app_bin.to_string_lossy().into_owned();
        let login = login_bin.to_string_lossy().into_owned();

        let (f, _) = locate(None, &app, "", Some(&home));
        assert_eq!(f.unwrap().1, BinarySource::Path);
        // the login PATH is searched before the app's (existing plugin_env order)
        let (f, _) = locate(None, &app, &login, Some(&home));
        assert_eq!(f.unwrap().1, BinarySource::LoginPath);
        let (f, _) = locate(None, "", &login, Some(&home));
        assert_eq!(f.unwrap().1, BinarySource::LoginPath);
        let (f, _) = locate(None, "", "", Some(&home));
        let (path, source) = f.unwrap();
        assert_eq!(source, BinarySource::KnownDir);
        assert!(path.ends_with(".claude/local/claude"));

        let custom = p.join("custom/my-claude");
        exe(&custom, "#!/bin/sh\n");
        let (f, _) = locate(Some(custom.to_str().unwrap()), &app, &login, Some(&home));
        assert_eq!(f.unwrap(), (custom.clone(), BinarySource::Override));

        // invalid overrides are reported, never silently replaced by a PATH hit
        for bad in ["relative/claude", p.join("nope").to_str().unwrap()] {
            let (f, searched) = locate(Some(bad), &app, &login, Some(&home));
            assert!(f.is_none());
            assert_eq!(searched, vec![bad.to_string()]);
        }
    }

    #[test]
    fn not_found_lists_searched_dirs() {
        let d = tempfile::tempdir().unwrap();
        let (f, searched) = locate(
            None,
            "/nonexistent-dir-a",
            "/nonexistent-dir-b",
            Some(d.path()),
        );
        // a machine with a real `claude` in /usr/local/bin or /opt/homebrew/bin would find it
        if f.is_none() {
            assert!(searched.iter().any(|s| s == "/nonexistent-dir-a"));
            assert!(searched.iter().any(|s| s == "/nonexistent-dir-b"));
        }
    }

    #[test]
    fn probe_reads_the_fake_version_and_caches() {
        let d = tempfile::tempdir().unwrap();
        let fake = d.path().join("claude");
        exe(
            &fake,
            "#!/bin/sh\n[ \"$1\" = \"--version\" ] && echo '2.1.325 (Claude Code)'\n",
        );
        assert_eq!(probe_version(&fake).as_deref(), Some("2.1.325"));
        let broken = d.path().join("broken");
        exe(&broken, "#!/bin/sh\nexit 1\n");
        assert_eq!(probe_version(&broken), None);
    }
}
