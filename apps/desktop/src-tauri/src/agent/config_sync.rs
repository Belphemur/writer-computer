//! Keeping a running chat's CLI in step with the files it read when it started (spec
//! `SPECs/native-agent-spec.md` "Reloading the session"). Tauri-free.
//!
//! Skills, MCP servers, settings and CLAUDE.md/AGENTS.md are read by the `claude` process at
//! start. This module decides WHEN a chat's process is stale:
//!
//! - [`affects_chat`]: the one pure rule "this changed path is one that chat's CLI read", fed by
//!   the app's existing file watcher (`watcher::observe_paths`, no second watcher). It does no IO
//!   and only ever accepts a path inside the vault root, so nothing under the user's home Claude
//!   folder (`~/.claude`, `~/.claude.json`) is watched, statted or read by Writer.
//! - [`decide`]: the one pure restart decision (idle: now, busy: after the turn, a send: first).
//! - the [`Worker`]: ONE thread (started through the app's spawner, so a panic fails the feature)
//!   that sleeps until a message or the nearest deadline: the debounce after a change burst and
//!   the MCP re-check backoff. No polling.
//! - the MCP re-check ([`McpProbe`]): the CLI's own `claude mcp list` as a child process in the
//!   chat's cwd with the chat's environment. The CLI reads its config, Writer never does; only
//!   server names and statuses are parsed, nothing else is kept or logged.
//!
//! What the runner does with a stale chat is in `runner.rs` (`Session::config_changed`, `settle`).

use super::events::McpServerStatus;
use super::session::{Shared, Timing};
use std::collections::{BTreeSet, HashMap};
use std::ffi::OsString;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

// ------------------------------------------------------------------------------- affects_chat

/// Why a chat's process is stale; `describe` is the text of the transcript notice.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reason {
    /// A file under `.claude/skills/<name>/` or `.agents/skills/<name>/`.
    Skill(String),
    /// `.mcp.json`.
    McpConfig,
    /// `.claude/settings*.json`.
    Settings,
    /// `CLAUDE.md` or `AGENTS.md` (the file name).
    Instructions(String),
    /// A server that was failing connects now.
    McpServer(String),
}

impl Reason {
    pub fn describe(&self) -> String {
        match self {
            Self::Skill(name) => format!("skill {name} changed"),
            Self::McpConfig => "MCP configuration changed".into(),
            Self::Settings => "Claude settings changed".into(),
            Self::Instructions(file) => format!("{file} changed"),
            Self::McpServer(name) => format!("MCP server {name} connected"),
        }
    }
}

/// Is `path` (an absolute path from the watcher) one the CLI of a chat in `chat_cwd`, inside
/// `vault_root`, read at start?
///
/// - `<root>/.claude/skills/**` and `<root>/.agents/skills/**`, and the same under the chat's own
///   cwd (a project folder): the skill folders the CLI scans;
/// - `.mcp.json`, `.claude/settings*.json`, `CLAUDE.md`, `AGENTS.md` in any folder of the chain
///   from `chat_cwd` up to `vault_root` (the CLI reads instruction files and project settings
///   along the cwd chain).
///
/// Pure (no IO, no symlink resolution) and cheap: one pass over the path's components. A path
/// outside the vault root is `None`, so a home folder is never matched. The chain stops at the
/// vault root on purpose: Writer does not look above its vault.
pub fn affects_chat(path: &Path, chat_cwd: &Path, vault_root: &Path) -> Option<Reason> {
    let rel = path.strip_prefix(vault_root).ok()?;
    let comps: Vec<&str> = rel
        .components()
        .map(|c| c.as_os_str().to_str())
        .collect::<Option<_>>()?;
    if comps
        .iter()
        .any(|c| matches!(*c, ".git" | "node_modules" | ".."))
    {
        return None;
    }
    let chain_dir = |depth: usize| -> bool {
        // the folder `root/comps[..depth]` is `chat_cwd` or one of its ancestors up to the root
        chat_cwd.starts_with(vault_root.join(comps[..depth].iter().collect::<PathBuf>()))
    };
    // `<dir>/.claude/skills/<name>/...`: the folder holding `.claude` is the vault root or the cwd
    for i in 0..comps.len().saturating_sub(2) {
        if matches!(comps[i], ".claude" | ".agents") && comps[i + 1] == "skills" {
            let dir = vault_root.join(comps[..i].iter().collect::<PathBuf>());
            if dir == vault_root || dir == chat_cwd {
                let name = comps[i + 2];
                let name = if i + 3 == comps.len() {
                    name.rsplit_once('.').map_or(name, |(stem, _)| stem)
                } else {
                    name
                };
                return Some(Reason::Skill(name.to_string()));
            }
            return None;
        }
    }
    let (file, dirs) = comps.split_last()?;
    match *file {
        ".mcp.json" if chain_dir(dirs.len()) => Some(Reason::McpConfig),
        "CLAUDE.md" | "AGENTS.md" if chain_dir(dirs.len()) => {
            Some(Reason::Instructions((*file).to_string()))
        }
        f if f.starts_with("settings")
            && f.ends_with(".json")
            && dirs.last() == Some(&".claude")
            && chain_dir(dirs.len() - 1) =>
        {
            Some(Reason::Settings)
        }
        _ => None,
    }
}

// ------------------------------------------------------------------------------------ decision

/// What the runner knows about a chat that is stale.
#[derive(Debug, Clone, Copy)]
pub struct StaleView {
    /// `agent.auto-reload`.
    pub auto_reload: bool,
    /// The backend's `restart_on_config_change` capability (`RoleAdapter`).
    pub backend_restarts: bool,
    /// A process is running.
    pub live: bool,
    /// A turn runs, a permission card is open, a process is starting or being replaced, or a
    /// message waits.
    pub busy: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    /// Not applicable (setting off, backend reloads itself) or a restart is on its way.
    Ignore,
    /// No process: the next spawn reads everything fresh.
    Forget,
    /// Idle: restart under the hood now.
    RestartNow,
    /// Busy: restart right after the turn ends.
    AfterTurn,
}

/// The one place that decides what a stale chat does. A send while stale uses the same answer:
/// `RestartNow` means "restart first, then send".
pub fn decide(v: StaleView) -> Decision {
    if !v.auto_reload || !v.backend_restarts {
        Decision::Ignore
    } else if !v.live {
        Decision::Forget
    } else if v.busy {
        Decision::AfterTurn
    } else {
        Decision::RestartNow
    }
}

// ------------------------------------------------------------------------------------ MCP

/// Statuses the CLI reports for a healthy server.
pub fn is_connected(status: &str) -> bool {
    status.eq_ignore_ascii_case("connected")
}

/// Wait before the `attempt`-th (0-based) MCP re-check: the schedule, then its last entry for
/// ever (1 min, 2 min, 5 min, then every 5 min).
pub fn backoff(schedule: &[Duration], attempt: usize) -> Duration {
    schedule
        .get(attempt)
        .or(schedule.last())
        .copied()
        .unwrap_or(Duration::from_secs(300))
}

/// Names of the servers that are not connected.
pub fn failing(servers: &[McpServerStatus]) -> BTreeSet<String> {
    servers
        .iter()
        .filter(|s| !is_connected(&s.status))
        .map(|s| s.name.clone())
        .collect()
}

/// The outcome of one re-check against the servers that were failing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpCheck {
    /// Failing before, connected now (sorted).
    pub recovered: Vec<String>,
    /// Still not connected (the next check keeps these).
    pub still_failing: BTreeSet<String>,
}

pub fn check(was_failing: &BTreeSet<String>, probed: &[McpServerStatus]) -> McpCheck {
    let now_failing = failing(probed);
    let recovered = was_failing
        .iter()
        .filter(|n| {
            probed
                .iter()
                .any(|s| &s.name == *n && is_connected(&s.status))
        })
        .cloned()
        .collect();
    McpCheck {
        recovered,
        still_failing: was_failing
            .iter()
            .filter(|n| now_failing.contains(*n) || !probed.iter().any(|s| &s.name == *n))
            .cloned()
            .collect(),
    }
}

/// `claude mcp list` output to names and statuses. A line is `<name>: <target> - <status>`
/// (a status such as `✓ Connected`, `✗ Failed to connect`, `⚠ Needs authentication`,
/// `⏸ Pending approval`); anything else (the "Checking..." banner, blanks) is skipped. The name is
/// the text before the first `": "` (plugin servers are `plugin:a:b`, no space after the colon);
/// the target (a URL or a command line) is dropped here and never kept.
pub fn parse_mcp_list(stdout: &str) -> Vec<McpServerStatus> {
    stdout
        .lines()
        .filter_map(|line| {
            let (head, status) = line.rsplit_once(" - ")?;
            let (name, _target) = head.split_once(": ")?;
            let name = name.trim();
            if name.is_empty() || name.contains(char::is_whitespace) {
                return None;
            }
            let s = status.to_ascii_lowercase();
            let word = if s.contains("fail") {
                "failed"
            } else if s.contains("needs auth") {
                "needs-auth"
            } else if s.contains("pending") {
                "pending"
            } else if s.contains("disconnect") {
                "disconnected"
            } else if s.contains("connected") {
                "connected"
            } else {
                "unknown"
            };
            Some(McpServerStatus {
                name: name.to_string(),
                status: word.to_string(),
            })
        })
        .collect()
}

/// What a re-check runs: the CLI, the chat's cwd and the chat's environment (the one builder of
/// `env.rs`, exactly as for the chat's own process).
#[derive(Debug, Clone)]
pub struct ProbeTarget {
    pub program: PathBuf,
    pub cwd: PathBuf,
    pub env: Vec<(String, String)>,
}

/// Asks the CLI which MCP servers connect. A port so tests use a fake.
pub trait McpProbe: Send + Sync {
    fn probe(
        &self,
        target: &ProbeTarget,
        timeout: Duration,
    ) -> Result<Vec<McpServerStatus>, String>;
}

/// `<program> mcp list` as a child process with a timeout; its output never reaches a log.
pub struct CliMcpProbe;

impl McpProbe for CliMcpProbe {
    fn probe(&self, t: &ProbeTarget, timeout: Duration) -> Result<Vec<McpServerStatus>, String> {
        let mut cmd = std::process::Command::new(&t.program);
        cmd.args(["mcp", "list"])
            .current_dir(&t.cwd)
            .env_clear()
            .envs(
                t.env
                    .iter()
                    .map(|(k, v)| (OsString::from(k), OsString::from(v))),
            )
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("could not run mcp list: {e}"))?;
        let mut out = child.stdout.take().ok_or("no stdout")?;
        let reader = std::thread::spawn(move || {
            let mut text = String::new();
            // bounded: a runaway server banner is cut
            let _ = (&mut out).take(256 * 1024).read_to_string(&mut text);
            text
        });
        let deadline = Instant::now() + timeout;
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(50))
                }
                Ok(None) => {
                    #[cfg(unix)]
                    // SAFETY: signals the child's own process group, created above
                    unsafe {
                        libc::kill(-(child.id() as i32), libc::SIGKILL);
                    }
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("mcp list timed out".into());
                }
                Err(e) => return Err(format!("mcp list failed: {e}")),
            }
        }
        let text = reader.join().map_err(|_| "reader panicked".to_string())?;
        Ok(parse_mcp_list(&text))
    }
}

// ------------------------------------------------------------------------------------ worker

pub(crate) enum Msg {
    /// Changed paths (any kind but access) of one window's vault; `own` are Writer's own writes
    /// among them; `at` is when the watcher delivered the batch.
    Paths {
        label: String,
        root: PathBuf,
        paths: Vec<PathBuf>,
        own: Vec<PathBuf>,
        at: Instant,
    },
    /// An `init` reported servers: `true` when some are not connected (start or keep the
    /// re-check), `false` to stop it.
    Mcp { chat_id: String, failing: bool },
    /// A re-check finished.
    Probed {
        chat_id: String,
        result: Result<Vec<McpServerStatus>, String>,
    },
}

#[derive(Default)]
struct McpTimer {
    attempt: usize,
    due: Option<Instant>,
    probing: bool,
}

pub(crate) struct Worker {
    pub rx: Receiver<Msg>,
    pub tx: std::sync::mpsc::Sender<Msg>,
    pub shared: Weak<Shared>,
    pub probe: Arc<dyn McpProbe>,
    pub timing: Timing,
}

impl Worker {
    pub(crate) fn run(self) {
        let mut debounce: HashMap<String, Instant> = HashMap::new();
        let mut mcp: HashMap<String, McpTimer> = HashMap::new();
        loop {
            let next = debounce
                .values()
                .copied()
                .chain(mcp.values().filter_map(|t| t.due))
                .min();
            let msg = match next {
                None => self.rx.recv().map_err(|_| RecvTimeoutError::Disconnected),
                Some(t) => self
                    .rx
                    .recv_timeout(t.saturating_duration_since(Instant::now())),
            };
            let Some(shared) = self.shared.upgrade() else {
                return;
            };
            match msg {
                Ok(Msg::Paths {
                    label,
                    root,
                    paths,
                    own,
                    at,
                }) => {
                    let external: Vec<PathBuf> =
                        paths.iter().filter(|p| !own.contains(p)).cloned().collect();
                    for s in shared.all() {
                        if s.label != label || s.root != root {
                            continue;
                        }
                        s.vault_paths_changed(&external, at);
                        let hit = paths.iter().find_map(|p| affects_chat(p, &s.cwd, &s.root));
                        if let Some(reason) = hit {
                            if s.config_changed(reason) {
                                debounce.insert(
                                    s.chat_id.clone(),
                                    Instant::now() + self.timing.config_debounce,
                                );
                            }
                        }
                    }
                }
                Ok(Msg::Mcp { chat_id, failing }) => {
                    if failing {
                        let t = mcp.entry(chat_id).or_default();
                        if t.due.is_none() && !t.probing {
                            t.due =
                                Some(Instant::now() + backoff(&self.timing.mcp_backoff, t.attempt));
                        }
                    } else {
                        mcp.remove(&chat_id);
                    }
                }
                Ok(Msg::Probed { chat_id, result }) => {
                    let Some(t) = mcp.get_mut(&chat_id) else {
                        continue;
                    };
                    t.probing = false;
                    let session = shared.sessions.lock().get(&chat_id).cloned();
                    let keep = session.as_ref().is_some_and(|s| match &result {
                        Ok(servers) => match s.mcp_checked(servers) {
                            McpWatch::Stop => false,
                            McpWatch::Recovered => {
                                debounce.insert(chat_id.clone(), Instant::now());
                                false
                            }
                            McpWatch::Keep => true,
                        },
                        // a failed probe is retried on the schedule
                        Err(_) => s.is_live(),
                    });
                    if keep {
                        t.attempt += 1;
                        t.due = Some(Instant::now() + backoff(&self.timing.mcp_backoff, t.attempt));
                    } else {
                        mcp.remove(&chat_id);
                    }
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return,
            }
            let now = Instant::now();
            let due: Vec<String> = debounce
                .iter()
                .filter(|(_, t)| **t <= now)
                .map(|(c, _)| c.clone())
                .collect();
            for chat_id in due {
                debounce.remove(&chat_id);
                if let Some(s) = shared.sessions.lock().get(&chat_id).cloned() {
                    s.settle();
                }
            }
            let probes: Vec<String> = mcp
                .iter()
                .filter(|(_, t)| t.due.is_some_and(|d| d <= now) && !t.probing)
                .map(|(c, _)| c.clone())
                .collect();
            for chat_id in probes {
                let session = shared.sessions.lock().get(&chat_id).cloned();
                let target = session.as_ref().and_then(|s| s.probe_target());
                let Some(t) = mcp.get_mut(&chat_id) else {
                    continue;
                };
                let Some(target) = target else {
                    // closed, or no process: nothing to check (the next init starts it again)
                    mcp.remove(&chat_id);
                    continue;
                };
                t.due = None;
                t.probing = true;
                let (probe, tx, timeout, id) = (
                    Arc::clone(&self.probe),
                    self.tx.clone(),
                    self.timing.mcp_probe_timeout,
                    chat_id.clone(),
                );
                let started = std::thread::Builder::new()
                    .name("agent-mcp-probe".into())
                    .spawn(move || {
                        let result = probe.probe(&target, timeout);
                        let _ = tx.send(Msg::Probed {
                            chat_id: id,
                            result,
                        });
                    });
                if started.is_err() {
                    t.probing = false;
                    t.due = Some(now + backoff(&self.timing.mcp_backoff, t.attempt));
                }
            }
        }
    }
}

/// What a finished re-check means for the watch of one chat.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpWatch {
    /// Some server is still failing: check again later.
    Keep,
    /// Everything is healthy, or nothing to watch any more.
    Stop,
    /// A server that was failing connects: the chat is stale (settled at once).
    Recovered,
}

/// Cost guard for the tests: `affects_chat` over a batch.
#[cfg(test)]
pub(crate) fn count_hits(paths: &[PathBuf], cwd: &Path, root: &Path) -> usize {
    paths
        .iter()
        .filter_map(|p| affects_chat(p, cwd, root))
        .count()
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROOT: &str = "/vault";

    fn hit(path: &str, cwd: &str) -> Option<Reason> {
        affects_chat(Path::new(path), Path::new(cwd), Path::new(ROOT))
    }

    #[test]
    fn skill_folders_of_the_vault_and_of_the_chats_project_count() {
        let skill = |n: &str| Some(Reason::Skill(n.into()));
        assert_eq!(
            hit("/vault/.claude/skills/writer-graph/SKILL.md", "/vault"),
            skill("writer-graph")
        );
        assert_eq!(
            hit("/vault/.agents/skills/x/refs/deep/a.md", "/vault"),
            skill("x")
        );
        // the vault's skills reach a project chat too
        assert_eq!(
            hit("/vault/.claude/skills/x/SKILL.md", "/vault/Projects/P"),
            skill("x")
        );
        // the chat's own project folder
        assert_eq!(
            hit(
                "/vault/Projects/P/.claude/skills/y/SKILL.md",
                "/vault/Projects/P"
            ),
            skill("y")
        );
        // a single-file skill: the name is the stem
        assert_eq!(
            hit("/vault/.claude/skills/note.md", "/vault"),
            skill("note")
        );
        // another project's skills are not this chat's
        assert_eq!(
            hit(
                "/vault/Projects/Q/.claude/skills/y/SKILL.md",
                "/vault/Projects/P"
            ),
            None
        );
        assert_eq!(
            hit("/vault/Projects/P/.claude/skills/y/SKILL.md", "/vault"),
            None
        );
        // the folder itself, or a sibling of skills
        assert_eq!(hit("/vault/.claude/skills", "/vault"), None);
        assert_eq!(hit("/vault/.claude/commands/x.md", "/vault"), None);
    }

    #[test]
    fn config_files_count_along_the_cwd_chain_up_to_the_vault_root() {
        let cwd = "/vault/Projects/P";
        assert_eq!(hit("/vault/.mcp.json", cwd), Some(Reason::McpConfig));
        assert_eq!(
            hit("/vault/Projects/.mcp.json", cwd),
            Some(Reason::McpConfig)
        );
        assert_eq!(
            hit("/vault/Projects/P/.mcp.json", cwd),
            Some(Reason::McpConfig)
        );
        assert_eq!(
            hit("/vault/Projects/P/sub/.mcp.json", cwd),
            None,
            "below the cwd"
        );
        assert_eq!(hit("/vault/Other/.mcp.json", cwd), None, "a sibling branch");
        assert_eq!(
            hit("/vault/AGENTS.md", cwd),
            Some(Reason::Instructions("AGENTS.md".into()))
        );
        assert_eq!(
            hit("/vault/Projects/P/CLAUDE.md", cwd),
            Some(Reason::Instructions("CLAUDE.md".into()))
        );
        assert_eq!(hit("/vault/Projects/P/notes.md", cwd), None);
        assert_eq!(
            hit("/vault/.claude/settings.json", cwd),
            Some(Reason::Settings)
        );
        assert_eq!(
            hit("/vault/Projects/P/.claude/settings.local.json", cwd),
            Some(Reason::Settings)
        );
        assert_eq!(hit("/vault/.claude/settings.txt", cwd), None);
        assert_eq!(
            hit("/vault/settings.json", cwd),
            None,
            "not in a .claude folder"
        );
        assert_eq!(hit("/vault/.claude/other.json", cwd), None);
    }

    #[test]
    fn nothing_outside_the_vault_ever_matches_least_of_all_the_home_claude_folder() {
        for p in [
            "/home/u/.claude/settings.json",
            "/home/u/.claude/skills/x/SKILL.md",
            "/home/u/.claude.json",
            "/home/u/.mcp.json",
            "/home/u/CLAUDE.md",
            "/vaultish/.mcp.json",
            "/vault/../home/u/.claude/settings.json",
        ] {
            assert_eq!(hit(p, "/vault"), None, "{p}");
        }
        // a vault that lives in the home folder: only paths inside the vault match, and the home
        // folder's own files (`~/.claude`, `~/.claude.json`, `~/CLAUDE.md`) are outside it
        let r = Path::new("/home/u/Vault");
        let w = |p: &str| affects_chat(Path::new(p), r, r);
        assert_eq!(w("/home/u/.claude/skills/x/SKILL.md"), None);
        assert_eq!(w("/home/u/.claude.json"), None);
        assert_eq!(w("/home/u/CLAUDE.md"), None);
        assert!(w("/home/u/Vault/CLAUDE.md").is_some());
    }

    #[test]
    fn git_and_node_modules_are_never_config() {
        assert_eq!(hit("/vault/.git/AGENTS.md", "/vault"), None);
        assert_eq!(hit("/vault/node_modules/p/.mcp.json", "/vault"), None);
        assert_eq!(
            hit("/vault/node_modules/p/.claude/skills/x/SKILL.md", "/vault"),
            None
        );
    }

    /// The matcher runs on every path of every watcher batch: a git checkout is 100k paths.
    #[test]
    fn matching_a_big_batch_is_cheap() {
        let paths: Vec<PathBuf> = (0..100_000)
            .map(|i| PathBuf::from(format!("/vault/Projects/P/notes/deep/er/{i}.md")))
            .chain((0..1000).map(|i| PathBuf::from(format!("/vault/.claude/skills/s{i}/SKILL.md"))))
            .collect();
        let start = Instant::now();
        let n = count_hits(&paths, Path::new("/vault/Projects/P"), Path::new("/vault"));
        let took = start.elapsed();
        eprintln!("affects_chat: {} paths in {took:?}", paths.len());
        assert_eq!(n, 1000);
        // measured around 25 ms in release-less test builds; the bound only catches an
        // accidental per-path IO or quadratic scan
        assert!(took < Duration::from_secs(2), "{took:?}");
    }

    fn view() -> StaleView {
        StaleView {
            auto_reload: true,
            backend_restarts: true,
            live: true,
            busy: false,
        }
    }

    #[test]
    fn the_decision_table() {
        assert_eq!(decide(view()), Decision::RestartNow);
        assert_eq!(
            decide(StaleView {
                busy: true,
                ..view()
            }),
            Decision::AfterTurn
        );
        assert_eq!(
            decide(StaleView {
                live: false,
                ..view()
            }),
            Decision::Forget
        );
        assert_eq!(
            decide(StaleView {
                auto_reload: false,
                ..view()
            }),
            Decision::Ignore
        );
        assert_eq!(
            decide(StaleView {
                backend_restarts: false,
                ..view()
            }),
            Decision::Ignore
        );
        // off wins over everything else
        assert_eq!(
            decide(StaleView {
                auto_reload: false,
                live: false,
                busy: true,
                ..view()
            }),
            Decision::Ignore
        );
    }

    #[test]
    fn the_mcp_backoff_is_one_two_five_then_every_five_minutes() {
        let m = |s: u64| Duration::from_secs(s * 60);
        let sched = [m(1), m(2), m(5)];
        let got: Vec<_> = (0..6).map(|i| backoff(&sched, i)).collect();
        assert_eq!(got, [m(1), m(2), m(5), m(5), m(5), m(5)]);
        assert_eq!(backoff(&[], 0), m(5), "an empty schedule still waits");
    }

    fn st(name: &str, status: &str) -> McpServerStatus {
        McpServerStatus {
            name: name.into(),
            status: status.into(),
        }
    }

    #[test]
    fn a_recheck_names_the_servers_that_recovered_and_those_still_failing() {
        let was: BTreeSet<String> = ["a", "b", "gone"].map(String::from).into();
        let c = check(
            &was,
            &[st("a", "connected"), st("b", "failed"), st("new", "failed")],
        );
        assert_eq!(c.recovered, ["a"]);
        // a server the probe no longer lists stays on the watch list until the chat re-inits
        assert_eq!(c.still_failing, ["b", "gone"].map(String::from).into());
        let all = check(
            &was,
            &[
                st("a", "connected"),
                st("b", "connected"),
                st("gone", "connected"),
            ],
        );
        assert_eq!(all.recovered, ["a", "b", "gone"]);
        assert!(all.still_failing.is_empty());
    }

    #[test]
    fn the_mcp_list_output_gives_names_and_statuses_and_drops_targets() {
        let out = "Checking MCP server health...\n\n\
            notes: npx -y @acme/notes-server --token abc - \u{2713} Connected\n\
            web: https://example.com/mcp (HTTP) - \u{2717} Failed to connect\n\
            plugin:github:github: https://api.example.com/mcp/ (HTTP) - \u{26a0} Needs authentication\n\
            lazy: /usr/bin/x - \u{23f8} Pending approval\n\
            odd: cmd - something else\n\
            not a server line\n";
        let got = parse_mcp_list(out);
        let pairs: Vec<_> = got
            .iter()
            .map(|s| (s.name.as_str(), s.status.as_str()))
            .collect();
        assert_eq!(
            pairs,
            [
                ("notes", "connected"),
                ("web", "failed"),
                ("plugin:github:github", "needs-auth"),
                ("lazy", "pending"),
                ("odd", "unknown"),
            ]
        );
        assert!(
            !format!("{got:?}").contains("example.com"),
            "targets are not kept"
        );
    }

    #[test]
    fn describe_names_the_cause() {
        assert_eq!(
            Reason::Skill("writer-graph".into()).describe(),
            "skill writer-graph changed"
        );
        assert_eq!(
            Reason::McpServer("github".into()).describe(),
            "MCP server github connected"
        );
    }
}
