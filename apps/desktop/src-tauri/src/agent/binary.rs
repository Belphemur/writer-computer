//! Finding a backend's program and its version (spec 7, "Binary discovery"): `claude` for the core,
//! and any other backend's through [`Program`] (its name and its own install folders).
//!
//! Order: the backend's path setting (`agent.binary-path` for Claude; absolute, executable regular
//! file), then the app's PATH, the login-shell PATH (`plugin_env::login_path`, cached), the known
//! install dirs (`plugin_env::search_dirs`: `~/.claude/local`, Homebrew, version-manager bin
//! dirs) and the program's own `extra_dirs`. The version probe is Writer's own fixed
//! `<program> --version` with a 5 s timeout and the filtered environment; it is not a plugin
//! spawn, so it needs no consent and does not count toward the process cap. The sign-in probe is
//! Claude's own `claude auth status --json` (local, prints JSON, exit 1 when signed out, never
//! starts a login or opens a browser), same env and timeout; no other backend has one.

use crate::features::scope::Spawner;
use crate::plugin_env;
use crate::process_run::{self, RunOptions};
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

/// Where `claude` is and what the CLI says about itself; `searched` holds the directories tried
/// when nothing was found (`[]` when found).
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
    /// Whether the version found is one Writer supports: `None` when the backend has no such rule
    /// (Claude) or the version is unknown. Filled by the backend that has a rule.
    pub supported: Option<bool>,
    /// The oldest version Writer supports, for the card that says it does not.
    pub min_version: Option<String>,
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

/// Pure lookup of the `claude` program, no probe. `app`/`login` are PATH-style strings.
pub fn locate(
    override_path: Option<&str>,
    app: &str,
    login: &str,
    home: Option<&Path>,
) -> (Option<(PathBuf, BinarySource)>, Vec<String>) {
    locate_program(&CLAUDE, override_path, app, login, home)
}

/// A backend's program: its name and the install folders, relative to the home folder, searched
/// besides the ones every program shares (`plugin_env::search_dirs`). Core names none but its own.
#[derive(Debug, Clone, Copy)]
pub struct Program {
    pub name: &'static str,
    pub extra_dirs: &'static [&'static str],
}

/// The program of the core's own backend, the one this module was written for.
pub const CLAUDE: Program = Program {
    name: "claude",
    extra_dirs: &[],
};

/// [`locate`] for any backend's program: the one lookup, so the order (override, app PATH, login
/// PATH, known install folders) is the same for every backend.
pub fn locate_program(
    program: &Program,
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
    let mut dirs = plugin_env::search_dirs(login, app, home);
    if let Some(h) = home {
        for extra in program.extra_dirs {
            let d = h.join(extra);
            if !dirs.contains(&d) {
                dirs.push(d);
            }
        }
    }
    let hit = plugin_env::which_in(program.name, &dirs).ok().flatten();
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

/// `2.1.325 (Claude Code)` -> `2.1.325`; `othercli v2.4.0` -> `2.4.0` (a leading `v` is dropped).
pub fn parse_version(out: &str) -> Option<String> {
    out.split_whitespace()
        .map(|t| t.strip_prefix('v').unwrap_or(t))
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
pub fn probe_version(spawner: &Spawner, program: &Path) -> Option<String> {
    let key = std::fs::metadata(program)
        .ok()
        .and_then(|m| Some((program.to_path_buf(), m.len(), m.modified().ok()?)));
    if let Some(k) = &key {
        if let Some(v) = PROBES.lock().as_ref().and_then(|m| m.get(k)) {
            return v.clone();
        }
    }
    let version = run_version(spawner, program);
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

/// Run `program args...` with the filtered environment (`env::current`) in `cwd`, optional
/// stdin text (written, then closed), at most `max_out` bytes of stdout, through the one bounded
/// runner on the agent's scope (`process_run`): the whole group is killed at `timeout` or when the
/// scope stops. Returns whether it exited 0 and its stdout, whatever the exit status, or `None`
/// when it could not start, timed out or was stopped. The one place Writer runs a fixed,
/// short-lived `claude` command outside a chat session (version, sign-in, chat title).
pub fn run_capture(
    spawner: &Spawner,
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
        .envs(super::env::current(None))
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut opts = RunOptions::new(timeout).max_out(max_out);
    if let Some(text) = stdin_text {
        opts = opts.stdin(text);
    }
    let out = process_run::run(spawner, cmd, &opts).ok()?;
    Some((out.ok(), out.stdout))
}

/// [`run_capture`] for a probe: no stdin, in the temp dir, the first 16 KiB.
fn probe_capture(
    spawner: &Spawner,
    program: &Path,
    args: &[&str],
    timeout: Duration,
) -> Option<(bool, String)> {
    let args: Vec<String> = args.iter().map(|a| a.to_string()).collect();
    run_capture(
        spawner,
        program,
        &args,
        &std::env::temp_dir(),
        None,
        timeout,
        16 * 1024,
    )
}

fn run_version(spawner: &Spawner, program: &Path) -> Option<String> {
    let (ok, out) = probe_capture(spawner, program, &["--version"], PROBE_TIMEOUT)?;
    ok.then(|| parse_version(&out)).flatten()
}

const AUTH_TTL: Duration = Duration::from_secs(10);
type AuthKey = PathBuf;
static AUTH_PROBES: Mutex<Option<HashMap<AuthKey, (Instant, AuthStatus)>>> = Mutex::new(None);

/// `claude auth status --json`, cached for a few seconds per program so "Re-detect" after
/// signing in is fresh but a burst of calls is one process. Blocking (up to 5 s).
pub fn probe_auth(spawner: &Spawner, program: &Path) -> AuthStatus {
    probe_auth_with(spawner, program, PROBE_TIMEOUT)
}

fn probe_auth_with(spawner: &Spawner, program: &Path, timeout: Duration) -> AuthStatus {
    if let Some((at, st)) = AUTH_PROBES.lock().as_ref().and_then(|m| m.get(program)) {
        if at.elapsed() < AUTH_TTL {
            return st.clone();
        }
    }
    // exit status is 1 when signed out, so only the printed JSON counts
    let status = probe_capture(spawner, program, &["auth", "status", "--json"], timeout)
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
fn locate_here(
    program: &Program,
    override_path: Option<&str>,
) -> (Option<(PathBuf, BinarySource)>, Vec<String>) {
    let app = std::env::var("PATH").unwrap_or_default();
    // the login shell is only needed without an override
    let login = if override_path.is_some_and(|o| !o.trim().is_empty()) {
        String::new()
    } else {
        plugin_env::login_path()
    };
    locate_program(
        program,
        override_path,
        &app,
        &login,
        plugin_env::home_dir().as_deref(),
    )
}

/// The `claude` program alone, without the version and sign-in probes (a one-shot helper call
/// that must not wait for them). Blocking (login shell).
pub fn find(override_path: Option<&str>) -> Option<PathBuf> {
    find_program(&CLAUDE, override_path)
}

/// [`find`] for any backend's program.
pub fn find_program(program: &Program, override_path: Option<&str>) -> Option<PathBuf> {
    locate_here(program, override_path).0.map(|(path, _)| path)
}

/// The `agent_detect_binary` result. Blocking (login shell, version probe).
pub fn detect(spawner: &Spawner, override_path: Option<&str>) -> AgentBinaryInfo {
    detect_program(spawner, &CLAUDE, override_path, true)
}

/// [`detect`] for any backend's program. `probe_sign_in` runs `claude auth status`, which only
/// Claude has: another backend reports `authenticated: None` (unknown) and finds out at send time.
pub fn detect_program(
    spawner: &Spawner,
    program: &Program,
    override_path: Option<&str>,
    probe_sign_in: bool,
) -> AgentBinaryInfo {
    let (found, searched) = locate_here(program, override_path);
    match found {
        Some((path, source)) => {
            let auth = if probe_sign_in {
                probe_auth(spawner, &path)
            } else {
                AuthStatus::default()
            };
            AgentBinaryInfo {
                found: true,
                version: probe_version(spawner, &path),
                authenticated: auth.authenticated,
                account: auth.account,
                path: Some(path.to_string_lossy().into_owned()),
                source: Some(source),
                searched,
                supported: None,
                min_version: None,
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
            supported: None,
            min_version: None,
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
        assert_eq!(parse_version("othercli v2.4.0\n").as_deref(), Some("2.4.0"));
        assert_eq!(parse_version("v"), None);
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
            probe_auth_with(&Spawner::detached(), &signed_out, Duration::from_secs(5))
                .authenticated,
            Some(false)
        );
        let signed_in = d.path().join("in/claude");
        exe(
            &signed_in,
            "#!/bin/sh\necho '{\"loggedIn\":true,\"authMethod\":\"apiKey\"}'\n",
        );
        let st = probe_auth_with(&Spawner::detached(), &signed_in, Duration::from_secs(5));
        assert_eq!(
            (st.authenticated, st.account.as_deref()),
            (Some(true), Some("apiKey"))
        );
        let garbage = d.path().join("garbage/claude");
        exe(&garbage, "#!/bin/sh\necho 'what'\n");
        assert_eq!(
            probe_auth_with(&Spawner::detached(), &garbage, Duration::from_secs(5)),
            AuthStatus::default()
        );
        // a hang is killed at the timeout and is unknown
        let hang = d.path().join("hang/claude");
        exe(&hang, "#!/bin/sh\nsleep 30\n");
        let t = Instant::now();
        assert_eq!(
            probe_auth_with(&Spawner::detached(), &hang, Duration::from_millis(300)),
            AuthStatus::default()
        );
        assert!(t.elapsed() < Duration::from_secs(5));
        // cannot start at all
        assert_eq!(
            probe_auth_with(
                &Spawner::detached(),
                &d.path().join("missing"),
                Duration::from_secs(1)
            ),
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
        assert_eq!(
            probe_version(&Spawner::detached(), &fake).as_deref(),
            Some("2.1.325")
        );
        let broken = d.path().join("broken");
        exe(&broken, "#!/bin/sh\nexit 1\n");
        assert_eq!(probe_version(&Spawner::detached(), &broken), None);
    }

    #[test]
    fn a_program_searches_its_own_folders_and_no_other_programs() {
        let home = tempfile::tempdir().unwrap();
        let bin = home.path().join(".other-agent/bin");
        std::fs::create_dir_all(&bin).unwrap();
        let prog = bin.join("other-agent-cli");
        std::fs::write(&prog, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&prog, std::fs::Permissions::from_mode(0o755)).unwrap();
        let other = Program {
            name: "other-agent-cli",
            extra_dirs: &[".other-agent/bin"],
        };
        // its own folder is searched for it
        let (found, _) = locate_program(&other, None, "", "", Some(home.path()));
        assert_eq!(found.unwrap().0, prog);
        // and for Claude, the core, there is no other backend's folder: not in the folders it searches,
        // and its own name is not found there
        let (found, searched) = locate_program(&CLAUDE, None, "", "", Some(home.path()));
        assert!(found.is_none_or(|(p, _)| !p.starts_with(home.path())));
        assert!(
            !searched.iter().any(|d| d.contains(".other-agent")),
            "{searched:?}"
        );
        let shared = crate::plugin_env::search_dirs("", "", Some(home.path()));
        assert!(!shared
            .iter()
            .any(|d| d.to_string_lossy().contains(".other-agent")));
    }
}
