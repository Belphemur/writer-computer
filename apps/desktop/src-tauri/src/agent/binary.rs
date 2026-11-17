//! Finding the `claude` binary and its version (spec 7, "Binary discovery").
//!
//! Order: the `agent.binary-path` override (absolute, executable regular file), then the app's
//! PATH, the login-shell PATH (`plugin_env::login_path`, cached), the known install dirs
//! (`plugin_env::search_dirs`: `~/.claude/local`, Homebrew, version-manager bin dirs). The
//! version probe is Writer's own fixed `claude --version` with a 5 s timeout and the filtered
//! environment; it is not a plugin spawn, so it needs no consent and does not count toward the
//! process cap. The sign-in probe is the CLI's own `claude auth status --json` (local, prints
//! JSON, exit 1 when signed out, never starts a login or opens a browser), same env and timeout.

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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum BinarySource {
    Override,
    Path,
    LoginPath,
    KnownDir,
}

/// Mirror of `AgentBinaryInfo` in `events.ts`, plus `searched` (the directories tried when
/// nothing was found; `[]` when found).
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentBinaryInfo {
    pub found: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub source: Option<BinarySource>,
    pub searched: Vec<String>,
    /// `Some(false)` only when the CLI itself says it is signed out; `None` = unknown (probe
    /// failed, timed out, or printed something unrecognised).
    pub authenticated: Option<bool>,
    /// A non-sensitive label (sign-in method and plan, e.g. `claude.ai, enterprise`); never an
    /// email, organisation, id or path.
    pub account: Option<String>,
}

/// Result of `claude auth status`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct AuthStatus {
    pub authenticated: Option<bool>,
    pub account: Option<String>,
}

fn safe_label(s: &str) -> Option<String> {
    let t = s.trim();
    let ok = !t.is_empty()
        && t.len() <= 32
        && t.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '.' | '-' | '_'));
    ok.then(|| t.to_string())
}

/// Parse the output of `claude auth status --json`. Defensive: anything that is not a JSON
/// object with a boolean `loggedIn` is "unknown". Only `authMethod` and `subscriptionType` are
/// ever read besides `loggedIn`, so an email, organisation or id cannot leak from here.
pub fn parse_auth_status(stdout: &str) -> AuthStatus {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(stdout.trim()) else {
        return AuthStatus::default();
    };
    let Some(logged_in) = v.get("loggedIn").and_then(|b| b.as_bool()) else {
        return AuthStatus::default();
    };
    let account = logged_in
        .then(|| {
            let part = |k: &str| v.get(k).and_then(|x| x.as_str()).and_then(safe_label);
            let parts: Vec<String> = [part("authMethod"), part("subscriptionType")]
                .into_iter()
                .flatten()
                .filter(|p| p != "none")
                .collect();
            (!parts.is_empty()).then(|| parts.join(", "))
        })
        .flatten();
    AuthStatus {
        authenticated: Some(logged_in),
        account,
    }
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

/// Run `program args...` with the filtered environment and no stdin in the temp dir, return its
/// stdout (first 16 KiB) whatever the exit status, or `None` when it could not start or outlived
/// `timeout` (the whole group is killed then).
fn run_capture(program: &Path, args: &[&str], timeout: Duration) -> Option<(bool, String)> {
    let args: Vec<String> = args.iter().map(|a| a.to_string()).collect();
    run_capture_in(
        program,
        &args,
        &std::env::temp_dir(),
        None,
        timeout,
        16 * 1024,
    )
}

/// [`run_capture`] with a working directory, optional stdin text (written, then closed) and an
/// output cap. The one place Writer runs a fixed, short-lived `claude` command outside a chat
/// session (version, sign-in, chat title).
pub fn run_capture_in(
    program: &Path,
    args: &[String],
    cwd: &Path,
    stdin_text: Option<&str>,
    timeout: Duration,
    max_out: u64,
) -> Option<(bool, String)> {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .env_clear()
        .envs(super::env::current())
        .current_dir(cwd)
        .stdin(if stdin_text.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = cmd.spawn().ok()?;
    if let Some(text) = stdin_text {
        use std::io::Write;
        if let Some(mut si) = child.stdin.take() {
            // a child that exits early closes the pipe: its exit status tells the story
            let _ = si.write_all(text.as_bytes());
        }
    }
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut out = String::new();
                if let Some(mut so) = child.stdout.take() {
                    use std::io::Read;
                    let _ = so.by_ref().take(max_out).read_to_string(&mut out);
                }
                return Some((status.success(), out));
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

fn run_version(program: &Path) -> Option<String> {
    let (ok, out) = run_capture(program, &["--version"], PROBE_TIMEOUT)?;
    ok.then(|| parse_version(&out)).flatten()
}

const AUTH_TTL: Duration = Duration::from_secs(10);
type AuthKey = PathBuf;
static AUTH_PROBES: Mutex<Option<HashMap<AuthKey, (Instant, AuthStatus)>>> = Mutex::new(None);

/// `claude auth status --json`, cached for a few seconds per program so "Re-detect" after
/// signing in is fresh but a burst of calls is one process. Blocking (up to 5 s).
pub fn probe_auth(program: &Path) -> AuthStatus {
    probe_auth_with(program, PROBE_TIMEOUT)
}

fn probe_auth_with(program: &Path, timeout: Duration) -> AuthStatus {
    if let Some((at, st)) = AUTH_PROBES.lock().as_ref().and_then(|m| m.get(program)) {
        if at.elapsed() < AUTH_TTL {
            return st.clone();
        }
    }
    // exit status is 1 when signed out, so only the printed JSON counts
    let status = run_capture(program, &["auth", "status", "--json"], timeout)
        .map(|(_, out)| parse_auth_status(&out))
        .unwrap_or_default();
    // never the account label, never the output
    log::info!(
        target: "agent",
        "agent: sign-in probe finished (known: {}, signed in: {:?})",
        status.authenticated.is_some(),
        status.authenticated
    );
    AUTH_PROBES
        .lock()
        .get_or_insert_with(HashMap::new)
        .insert(program.to_path_buf(), (Instant::now(), status.clone()));
    status
}

/// [`locate`] with the real environment. Blocking when it needs the login shell's PATH.
fn locate_here(override_path: Option<&str>) -> (Option<(PathBuf, BinarySource)>, Vec<String>) {
    let app = std::env::var("PATH").unwrap_or_default();
    // the login shell is only needed without an override
    let login = if override_path.is_some_and(|o| !o.trim().is_empty()) {
        String::new()
    } else {
        plugin_env::login_path()
    };
    locate(
        override_path,
        &app,
        &login,
        plugin_env::home_dir().as_deref(),
    )
}

/// The `claude` program alone, without the version and sign-in probes (a one-shot helper call
/// that must not wait for them). Blocking (login shell).
pub fn find(override_path: Option<&str>) -> Option<PathBuf> {
    locate_here(override_path).0.map(|(path, _)| path)
}

/// The `agent_detect_binary` result. Blocking (login shell, version probe).
pub fn detect(override_path: Option<&str>) -> AgentBinaryInfo {
    let (found, searched) = locate_here(override_path);
    match found {
        Some((path, source)) => {
            let auth = probe_auth(&path);
            AgentBinaryInfo {
                found: true,
                version: probe_version(&path),
                authenticated: auth.authenticated,
                account: auth.account,
                path: Some(path.to_string_lossy().into_owned()),
                source: Some(source),
                searched,
            }
        }
        None => AgentBinaryInfo {
            authenticated: None,
            account: None,
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
    fn auth_status_parsing() {
        // signed in: only the method and plan become the label, never email/org/ids
        let signed_in = r#"{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty",
            "email":"someone@example.com","orgId":"org-123","orgName":"Example Org",
            "subscriptionType":"enterprise"}"#;
        let st = parse_auth_status(signed_in);
        assert_eq!(st.authenticated, Some(true));
        assert_eq!(st.account.as_deref(), Some("claude.ai, enterprise"));
        let label = st.account.unwrap();
        assert!(!label.contains('@') && !label.contains("Example") && !label.contains("org-"));
        // signed out
        let out =
            parse_auth_status(r#"{"loggedIn":false,"authMethod":"none","loginExpiresAt":null}"#);
        assert_eq!(
            out,
            AuthStatus {
                authenticated: Some(false),
                account: None
            }
        );
        // a hostile or odd label is dropped, the sign-in state is kept
        let odd = parse_auth_status(
            r#"{"loggedIn":true,"authMethod":"me@x.com","subscriptionType":"a/b"}"#,
        );
        assert_eq!(
            odd,
            AuthStatus {
                authenticated: Some(true),
                account: None
            }
        );
        // anything else is unknown, never "signed out"
        for garbage in [
            "",
            "Not logged in.",
            "{",
            "[]",
            r#"{"loggedIn":"no"}"#,
            r#"{"status":"ok"}"#,
        ] {
            assert_eq!(
                parse_auth_status(garbage),
                AuthStatus::default(),
                "{garbage:?}"
            );
        }
    }

    #[test]
    fn auth_probe_reads_exit_1_stdout_and_treats_failures_as_unknown() {
        let d = tempfile::tempdir().unwrap();
        let signed_out = d.path().join("out/claude");
        exe(
            &signed_out,
            "#!/bin/sh\n[ \"$1 $2 $3\" = \"auth status --json\" ] && echo '{\"loggedIn\":false}' && exit 1\nexit 2\n",
        );
        assert_eq!(
            probe_auth_with(&signed_out, Duration::from_secs(5)).authenticated,
            Some(false)
        );
        let signed_in = d.path().join("in/claude");
        exe(
            &signed_in,
            "#!/bin/sh\necho '{\"loggedIn\":true,\"authMethod\":\"apiKey\"}'\n",
        );
        let st = probe_auth_with(&signed_in, Duration::from_secs(5));
        assert_eq!(
            (st.authenticated, st.account.as_deref()),
            (Some(true), Some("apiKey"))
        );
        let garbage = d.path().join("garbage/claude");
        exe(&garbage, "#!/bin/sh\necho 'what'\n");
        assert_eq!(
            probe_auth_with(&garbage, Duration::from_secs(5)),
            AuthStatus::default()
        );
        // a hang is killed at the timeout and is unknown
        let hang = d.path().join("hang/claude");
        exe(&hang, "#!/bin/sh\nsleep 30\n");
        let t = Instant::now();
        assert_eq!(
            probe_auth_with(&hang, Duration::from_millis(300)),
            AuthStatus::default()
        );
        assert!(t.elapsed() < Duration::from_secs(5));
        // cannot start at all
        assert_eq!(
            probe_auth_with(&d.path().join("missing"), Duration::from_secs(1)),
            AuthStatus::default()
        );
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
