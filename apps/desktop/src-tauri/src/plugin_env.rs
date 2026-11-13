//! Native environment helpers for plugins that drive CLIs (Copilot Agent
//! Mode, Claude Code): executable lookup, the login-shell PATH, an allow-listed
//! environment snapshot and a read-only metadata probe. None of these spawns a
//! plugin-chosen process, so none needs the consent dialog. The command layer
//! restricts all of them to trusted vaults.

use parking_lot::Mutex;
use serde::Serialize;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const START: &str = "__WRITER_PATH_START__";
const END: &str = "__WRITER_PATH_END__";
const LOGIN_SCRIPT: &str =
    "printf '%s' __WRITER_PATH_START__; printenv PATH; printf '%s' __WRITER_PATH_END__";
const LOGIN_TIMEOUT: Duration = Duration::from_secs(10);
pub const PROBE_MAX_PATHS: usize = 256;

/* ------------------------------------------------------------- login PATH */

/// Run `shell args...` and pull PATH out from between the markers, ignoring
/// whatever banner or rc-file noise surrounds it. SIGKILLs the group on timeout.
pub fn run_login_shell(shell: &str, args: &[&str], timeout: Duration) -> Option<String> {
    let mut cmd = Command::new(shell);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = cmd.spawn().ok()?;
    let mut out = child.stdout.take()?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = out.read_to_end(&mut buf);
        let _ = tx.send(buf);
    });
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            _ => {
                #[cfg(unix)]
                unsafe {
                    libc::kill(-(child.id() as i32), libc::SIGKILL);
                }
                let _ = child.kill();
                let _ = child.wait();
                log::debug!("plugin login shell timed out");
                return None;
            }
        }
    }
    let buf = rx.recv_timeout(Duration::from_secs(2)).ok()?;
    parse_marked_path(&String::from_utf8_lossy(&buf))
}

pub fn parse_marked_path(s: &str) -> Option<String> {
    let from = s.find(START)? + START.len();
    let len = s[from..].find(END)?;
    let p = s[from..from + len].trim();
    (!p.is_empty() && !p.contains('\0')).then(|| p.to_string())
}

/// Computed once per app run (single flight): later callers get the cached
/// value, including a cached fallback so a broken shell is not retried.
pub struct LoginPathCache(Mutex<Option<String>>);

impl LoginPathCache {
    pub const fn new() -> Self {
        Self(Mutex::new(None))
    }

    pub fn get_with(
        &self,
        run: impl FnOnce() -> Option<String>,
        fallback: impl FnOnce() -> String,
    ) -> String {
        let mut g = self.0.lock();
        if let Some(p) = g.as_ref() {
            return p.clone();
        }
        let p = match run() {
            Some(p) => p,
            None => {
                log::debug!("plugin login PATH unavailable, using the app PATH");
                fallback()
            }
        };
        log::debug!("plugin login PATH resolved (len {})", p.len());
        *g = Some(p.clone());
        p
    }
}

impl Default for LoginPathCache {
    fn default() -> Self {
        Self::new()
    }
}

static LOGIN_PATH: LoginPathCache = LoginPathCache::new();

fn app_path() -> String {
    std::env::var("PATH").unwrap_or_default()
}

/// The user's login-shell PATH (cached). Blocks up to 10 s the first time.
pub fn login_path() -> String {
    LOGIN_PATH.get_with(
        || {
            let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty())?;
            run_login_shell(&shell, &["-ilc", LOGIN_SCRIPT], LOGIN_TIMEOUT)
        },
        app_path,
    )
}

/* ------------------------------------------------------------------ which */

pub fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
}

#[cfg(unix)]
fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    p.metadata()
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(p: &Path) -> bool {
    p.is_file()
}

fn bin_dirs_under(base: &Path, suffix: &str) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = std::fs::read_dir(base)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path().join(suffix))
        .filter(|p| p.is_dir())
        .collect();
    v.sort();
    v.reverse(); // newest-looking version first
    v
}

/// Login PATH, app PATH, then well-known install dirs; absolute and unique.
pub fn search_dirs(login: &str, app: &str, home: Option<&Path>) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::split_paths(login)
        .chain(std::env::split_paths(app))
        .collect();
    if let Some(h) = home {
        dirs.push(h.join(".local/bin"));
        dirs.push(h.join(".claude/local"));
    }
    dirs.push("/opt/homebrew/bin".into());
    dirs.push("/usr/local/bin".into());
    if let Some(h) = home {
        dirs.push(h.join(".volta/bin"));
        dirs.push(h.join(".bun/bin"));
        dirs.push(h.join(".npm-global/bin"));
        dirs.extend(bin_dirs_under(&h.join(".nvm/versions/node"), "bin"));
        dirs.extend(bin_dirs_under(
            &h.join(".local/share/fnm/node-versions"),
            "installation/bin",
        ));
        dirs.extend(bin_dirs_under(
            &h.join("Library/Application Support/fnm/node-versions"),
            "installation/bin",
        ));
    }
    let mut seen = HashSet::new();
    dirs.retain(|d| d.is_absolute() && seen.insert(d.clone()));
    dirs
}

/// First executable regular file called `name` in `dirs`. A name with a
/// separator or `..` is refused, except an absolute path, which is only
/// checked for the executable bit.
pub fn which_in(name: &str, dirs: &[PathBuf]) -> Result<Option<PathBuf>, String> {
    if name.is_empty() || name.contains('\0') {
        return Err("EINVAL: bad executable name".into());
    }
    let p = Path::new(name);
    if p.is_absolute() {
        if p.components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            return Err("EINVAL: bad executable name".into());
        }
        return Ok(is_executable(p).then(|| p.to_path_buf()));
    }
    if name.contains(['/', '\\']) || name.contains("..") {
        return Err("EINVAL: name must be a bare executable name".into());
    }
    Ok(dirs.iter().map(|d| d.join(name)).find(|c| is_executable(c)))
}

pub fn which(name: &str) -> Result<Option<PathBuf>, String> {
    // validate first: do not run the login shell for a bad name
    which_in(name, &[])?;
    let dirs = search_dirs(&login_path(), &app_path(), home_dir().as_deref());
    which_in(name, &dirs)
}

/// Programs `plugin_which` returned, per window label: `plugin_fs_probe` may
/// stat exactly these.
#[derive(Default)]
pub struct PluginEnv {
    which_seen: Mutex<HashMap<String, HashSet<PathBuf>>>,
}

impl PluginEnv {
    pub fn remember(&self, label: &str, p: &Path) {
        self.which_seen
            .lock()
            .entry(label.to_string())
            .or_default()
            .insert(p.to_path_buf());
    }

    pub fn seen(&self, label: &str) -> HashSet<PathBuf> {
        self.which_seen
            .lock()
            .get(label)
            .cloned()
            .unwrap_or_default()
    }

    pub fn forget_window(&self, label: &str) {
        self.which_seen.lock().remove(label);
    }
}

/* ---------------------------------------------------------------- os info */

#[derive(Debug, Serialize)]
pub struct OsInfo {
    pub platform: &'static str,
    pub arch: String,
    pub homedir: String,
    pub username: String,
    pub shell: String,
    pub tmpdir: String,
    pub env: BTreeMap<String, String>,
}

fn secret_looking(name: &str) -> bool {
    let u = name.to_ascii_uppercase();
    ["KEY", "TOKEN", "SECRET", "PASSWORD", "CREDENTIAL"]
        .iter()
        .any(|w| u.contains(w))
}

fn env_allowed(name: &str) -> bool {
    if secret_looking(name) {
        return false;
    }
    matches!(
        name,
        "HOME"
            | "USER"
            | "LOGNAME"
            | "SHELL"
            | "TMPDIR"
            | "LANG"
            | "TERM"
            | "CLAUDE_CONFIG_DIR"
            | "EDITOR"
    ) || name.starts_with("LC_")
        || name.starts_with("XDG_")
}

pub fn platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(windows) {
        "win32"
    } else {
        "linux"
    }
}

pub fn arch() -> String {
    match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        "x86" => "ia32",
        other => other,
    }
    .to_string()
}

/// Build the snapshot from explicit inputs (testable without touching the
/// real environment).
pub fn os_info_from(vars: impl Iterator<Item = (String, String)>, login_path: &str) -> OsInfo {
    let all: BTreeMap<String, String> = vars.collect();
    let mut env: BTreeMap<String, String> = all
        .iter()
        .filter(|(k, _)| env_allowed(k))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    env.insert("PATH".into(), login_path.to_string());
    let get = |k: &str| all.get(k).cloned();
    let homedir = get("HOME")
        .or_else(|| get("USERPROFILE"))
        .unwrap_or_default();
    let username = get("USER")
        .or_else(|| get("LOGNAME"))
        .or_else(|| get("USERNAME"))
        .or_else(|| {
            Path::new(&homedir)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
        })
        .unwrap_or_default();
    OsInfo {
        platform: platform(),
        arch: arch(),
        homedir,
        username,
        shell: get("SHELL").unwrap_or_else(|| "/bin/sh".into()),
        tmpdir: std::env::temp_dir().to_string_lossy().into_owned(),
        env,
    }
}

pub fn os_info() -> OsInfo {
    os_info_from(std::env::vars(), &login_path())
}

/* ----------------------------------------------------------------- probe */

#[derive(Debug, Serialize, PartialEq)]
pub struct ProbeResult {
    pub path: String,
    pub exists: bool,
    pub is_file: bool,
    pub is_dir: bool,
    pub size: Option<u64>,
}

pub struct ProbeScope<'a> {
    /// Canonical workspace root.
    pub vault: &'a Path,
    /// `~/.claude` and `CLAUDE_CONFIG_DIR`.
    pub claude_dirs: Vec<PathBuf>,
    /// Paths `plugin_which` returned for this window.
    pub which: &'a HashSet<PathBuf>,
}

pub fn claude_dirs() -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = home_dir().map(|h| h.join(".claude")).into_iter().collect();
    if let Some(c) = std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from) {
        if c.is_absolute() {
            v.push(c);
        }
    }
    v
}

fn lexically_clean(p: &Path) -> bool {
    p.is_absolute()
        && !p
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
}

fn stat(path: &Path) -> Option<std::fs::Metadata> {
    std::fs::metadata(path).ok()
}

fn allowed_metadata(p: &Path, scope: &ProbeScope) -> Option<std::fs::Metadata> {
    if scope.which.contains(p) {
        return stat(p);
    }
    if !lexically_clean(p) {
        return None;
    }
    // vault: canonical containment, so a symlink out of the vault is refused
    if let Ok(canon) = p.canonicalize() {
        if canon.starts_with(scope.vault) {
            return stat(&canon);
        }
    }
    // ~/.claude: lexical containment (users symlink skills/ etc. elsewhere)
    // or canonical containment of a canonical config dir
    for d in &scope.claude_dirs {
        if p.starts_with(d) {
            return stat(p);
        }
        if let (Ok(c), Ok(cd)) = (p.canonicalize(), d.canonicalize()) {
            if c.starts_with(&cd) {
                return stat(&c);
            }
        }
    }
    None
}

/// Metadata only, never content. Anything out of scope looks like a miss.
pub fn probe(paths: &[String], scope: &ProbeScope) -> Result<Vec<ProbeResult>, String> {
    if paths.len() > PROBE_MAX_PATHS {
        return Err(format!("E2BIG: at most {PROBE_MAX_PATHS} paths per call"));
    }
    Ok(paths
        .iter()
        .map(|s| {
            let md = if s.contains('\0') {
                None
            } else {
                allowed_metadata(Path::new(s), scope)
            };
            match md {
                Some(m) => ProbeResult {
                    path: s.clone(),
                    exists: true,
                    is_file: m.is_file(),
                    is_dir: m.is_dir(),
                    size: m.is_file().then_some(m.len()),
                },
                None => ProbeResult {
                    path: s.clone(),
                    exists: false,
                    is_file: false,
                    is_dir: false,
                    size: None,
                },
            }
        })
        .collect())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn marked_path_ignores_noise() {
        let s = format!("motd!\n{START}/a:/b\n{END}trailing\n");
        assert_eq!(parse_marked_path(&s).as_deref(), Some("/a:/b"));
        assert_eq!(parse_marked_path("no markers"), None);
        assert_eq!(parse_marked_path(&format!("{START}{END}")), None);
    }

    #[test]
    fn login_shell_parses_and_times_out() {
        let ok = run_login_shell(
            "/bin/sh",
            &[
                "-c",
                "echo noise; printf %s __WRITER_PATH_START__/x:/y; printf %s __WRITER_PATH_END__; echo more",
            ],
            Duration::from_secs(5),
        );
        assert_eq!(ok.as_deref(), Some("/x:/y"));
        let t = Instant::now();
        let slow = run_login_shell(
            "/bin/sh",
            &[
                "-c",
                "sleep 30; echo __WRITER_PATH_START__/z__WRITER_PATH_END__",
            ],
            Duration::from_millis(300),
        );
        assert_eq!(slow, None);
        assert!(t.elapsed() < Duration::from_secs(5), "SIGKILL on timeout");
    }

    #[test]
    fn login_path_is_cached_and_falls_back() {
        let cache = LoginPathCache::new();
        let runs = AtomicUsize::new(0);
        let a = cache.get_with(
            || {
                runs.fetch_add(1, Ordering::SeqCst);
                None
            },
            || "/fallback".into(),
        );
        let b = cache.get_with(
            || {
                runs.fetch_add(1, Ordering::SeqCst);
                Some("/other".into())
            },
            || "/never".into(),
        );
        assert_eq!((a.as_str(), b.as_str()), ("/fallback", "/fallback"));
        assert_eq!(runs.load(Ordering::SeqCst), 1);
        let c = LoginPathCache::new();
        assert_eq!(c.get_with(|| Some("/p".into()), || "/f".into()), "/p");
    }

    #[test]
    fn which_finds_sh_and_rejects_traversal() {
        let dirs = search_dirs("/bin:/usr/bin", "", None);
        let sh = which_in("sh", &dirs).unwrap().unwrap();
        assert!(sh.is_absolute() && sh.ends_with("sh"));
        assert_eq!(which_in("definitely-not-a-program-xyz", &dirs), Ok(None));
        for bad in ["../bin/sh", "bin/sh", "..", "a/../sh", ""] {
            assert!(which_in(bad, &dirs).is_err(), "{bad:?}");
        }
        assert_eq!(
            which_in("/bin/sh", &[]).unwrap(),
            Some(PathBuf::from("/bin/sh"))
        );
        assert_eq!(which_in("/etc/hosts", &[]), Ok(None), "not executable");
        assert!(which_in("/bin/../bin/sh", &[]).is_err());
    }

    #[test]
    fn which_skips_non_executable_files() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("tool"), "x").unwrap();
        let dirs = vec![dir.path().to_path_buf()];
        assert_eq!(which_in("tool", &dirs), Ok(None));
    }

    #[test]
    fn os_info_allow_list_excludes_secrets() {
        let vars = [
            ("HOME", "/Users/u"),
            ("USER", "u"),
            ("SHELL", "/bin/zsh"),
            ("LANG", "en_US.UTF-8"),
            ("LC_ALL", "C"),
            ("XDG_CONFIG_HOME", "/Users/u/.config"),
            ("CLAUDE_CONFIG_DIR", "/Users/u/.claude"),
            ("PATH", "/app/path"),
            ("ANTHROPIC_API_KEY", "sk-secret"),
            ("GITHUB_TOKEN", "t"),
            ("my_Password", "p"),
            ("AWS_SECRET_ACCESS_KEY", "s"),
            ("DB_CREDENTIALS", "c"),
            ("XDG_SECRET_THING", "x"),
            ("RANDOM_VAR", "r"),
            ("PWD", "/tmp"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()));
        let info = os_info_from(vars, "/login/path");
        assert_eq!(
            info.env.get("PATH").map(String::as_str),
            Some("/login/path")
        );
        assert_eq!(info.env.get("HOME").map(String::as_str), Some("/Users/u"));
        assert!(info.env.contains_key("LC_ALL") && info.env.contains_key("XDG_CONFIG_HOME"));
        assert!(info.env.contains_key("CLAUDE_CONFIG_DIR"));
        for k in [
            "ANTHROPIC_API_KEY",
            "GITHUB_TOKEN",
            "my_Password",
            "AWS_SECRET_ACCESS_KEY",
            "DB_CREDENTIALS",
            "XDG_SECRET_THING",
            "RANDOM_VAR",
            "PWD",
        ] {
            assert!(!info.env.contains_key(k), "{k} leaked");
        }
        assert!(!info.env.values().any(|v| v.contains("secret")));
        assert_eq!(info.homedir, "/Users/u");
        assert_eq!(info.username, "u");
        assert!(["darwin", "linux"].contains(&info.platform));
    }

    #[test]
    fn probe_allows_vault_claude_and_which_only() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().canonicalize().unwrap();
        let vault = base.join("vault");
        let claude = base.join("home/.claude");
        let outside = base.join("outside");
        for d in [&vault, &claude, &outside] {
            std::fs::create_dir_all(d).unwrap();
        }
        std::fs::write(vault.join("a.md"), "12345").unwrap();
        std::fs::write(claude.join("settings.json"), "{}").unwrap();
        std::fs::write(outside.join("secret.txt"), "s").unwrap();
        std::fs::write(outside.join("tool"), "t").unwrap();
        std::os::unix::fs::symlink(&outside, vault.join("escape")).unwrap();
        std::os::unix::fs::symlink(outside.join("secret.txt"), vault.join("link.txt")).unwrap();
        let tool = outside.join("tool");
        let which: HashSet<PathBuf> = [tool.clone()].into();
        let scope = ProbeScope {
            vault: &vault,
            claude_dirs: vec![claude.clone()],
            which: &which,
        };
        let s = |p: &Path| p.to_string_lossy().into_owned();
        let paths = vec![
            s(&vault.join("a.md")),
            s(&vault),
            s(&vault.join("missing")),
            s(&vault.join("escape/secret.txt")),
            s(&vault.join("link.txt")),
            s(&vault.join("../outside/secret.txt")),
            s(&claude.join("settings.json")),
            s(&claude.join("../../outside/secret.txt")),
            s(&outside.join("secret.txt")),
            s(&tool),
            "relative/path".into(),
            "/etc/hosts".into(),
        ];
        let r = probe(&paths, &scope).unwrap();
        let ex: Vec<bool> = r.iter().map(|x| x.exists).collect();
        assert_eq!(
            ex,
            [true, true, false, false, false, false, true, false, false, true, false, false]
        );
        assert_eq!(r[0].size, Some(5));
        assert!(r[0].is_file && !r[0].is_dir);
        assert!(r[1].is_dir && r[1].size.is_none());
        assert_eq!(r[4].size, None, "denied entries reveal nothing");
        assert!(probe(&vec!["/x".to_string(); PROBE_MAX_PATHS + 1], &scope).is_err());
        assert_eq!(
            probe(&vec!["/x".to_string(); PROBE_MAX_PATHS], &scope)
                .unwrap()
                .len(),
            PROBE_MAX_PATHS
        );
    }
}
