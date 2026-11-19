//! The `writer` CLI's Obsidian-parity commands (spec: `SPECs/writer-cli-spec.md`,
//! "Obsidian CLI parity"). `writer_cli.rs` stays the launcher and hands argv
//! here when the first argument is `vault=...` or a parity command name.
//!
//! * `args.rs` — the key=value grammar and validation against a command spec
//! * `registry.rs` — one entry per command (name, params, flags, formats,
//!   handler) plus `help`; adding a command is one entry and one handler
//! * `format.rs` — the shared table formatter (json/csv/tsv/md)
//! * `vault.rs` — `vault=` and working-directory vault resolution
//! * `cmd_*.rs` — handlers; `relocate/` (crate level) — link updates for move/rename
//!
//! Handlers return the text for stdout; nothing here prints except [`run_main`].
//! Exit codes: 0 ok, 1 failure/validation, 2 usage, 4 Writer is not running (the launcher keeps
//! its own).

pub mod args;
mod clipboard;
pub(crate) mod cmd_app;
pub(crate) mod cmd_bases;
pub(crate) mod cmd_dql;
mod cmd_files;
mod cmd_graph;
pub(crate) mod cmd_icons;
mod cmd_notes;
pub(crate) mod cmd_project;
mod cmd_query;
mod cmd_skills;
pub(crate) mod cmd_tasks;
pub mod format;
pub mod registry;
#[cfg(test)]
mod skill_doc;
pub mod vault;

#[cfg(test)]
mod tests;

pub use clipboard::{Clipboard, SystemClipboard};

use crate::index::{Index, IndexError};
use crate::vault_ops::{self, Confined, VaultOpError};
use crate::writer_cli::Launcher;
use std::cell::{OnceCell, RefCell};
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub const EXIT_OK: u8 = 0;
pub const EXIT_FAIL: u8 = 1;
pub const EXIT_USAGE: u8 = 2;
/// A command that needs the running app and found none (`status`, `open`, `reveal`, `active`).
pub const EXIT_NOT_RUNNING: u8 = 4;

#[derive(Debug, Clone, PartialEq)]
pub enum CliError {
    /// Bad invocation (exit 2).
    Usage(String),
    /// The command ran and failed or the input was invalid (exit 1).
    Fail(String),
    /// The command needs the running app and there is none (exit 4).
    NotRunning,
}

impl CliError {
    pub fn fail(msg: impl Into<String>) -> CliError {
        CliError::Fail(msg.into())
    }

    /// The message, as printed after `writer: `.
    pub fn text(&self) -> &str {
        match self {
            CliError::Usage(m) | CliError::Fail(m) => m,
            CliError::NotRunning => NOT_RUNNING,
        }
    }
}

/// What `writer` says when a command needs the app and none is running.
pub const NOT_RUNNING: &str = "Writer is not running";

impl From<VaultOpError> for CliError {
    fn from(e: VaultOpError) -> Self {
        CliError::Fail(e.to_string())
    }
}

impl From<IndexError> for CliError {
    fn from(e: IndexError) -> Self {
        if let IndexError::Sqlite(rusqlite::Error::SqliteFailure(f, _)) = &e {
            if matches!(
                f.code,
                rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked
            ) {
                return CliError::Fail(
                    "the vault index is busy (the Writer app may be scanning this vault); try again in a moment".into(),
                );
            }
        }
        CliError::Fail(e.to_string())
    }
}

impl From<std::io::Error> for CliError {
    fn from(e: std::io::Error) -> Self {
        CliError::Fail(e.to_string())
    }
}

/// What the CLI needs from the outside world (injectable for tests).
pub struct Env {
    /// App data directory (index databases, recent workspaces); `None` uses
    /// `WRITER_INDEX_DIR` or the platform default.
    pub app_data_dir: Option<PathBuf>,
    pub clipboard: Box<dyn Clipboard>,
    /// Local UTC offset for `now()` in bases.
    pub utc_offset_minutes: i32,
    /// Starts the app for `open --launch`.
    pub launcher: Box<dyn Launcher>,
    /// How long `open --launch` waits for the app it started to open its socket.
    pub launch_wait: std::time::Duration,
}

impl Env {
    pub fn system() -> Env {
        Env {
            app_data_dir: None,
            clipboard: Box::new(SystemClipboard),
            utc_offset_minutes: local_utc_offset_minutes(),
            launcher: Box::new(crate::writer_cli::SystemLauncher),
            launch_wait: std::time::Duration::from_secs(20),
        }
    }

    pub fn data_dir(&self) -> Result<PathBuf, CliError> {
        match &self.app_data_dir {
            Some(d) => Ok(d.clone()),
            None => crate::index::cli_app_data_dir().map_err(CliError::Fail),
        }
    }
}

#[cfg(unix)]
pub fn local_utc_offset_minutes() -> i32 {
    // SAFETY: `localtime_r` writes into the zeroed `tm` we own; `now` is valid.
    unsafe {
        let now: libc::time_t = libc::time(std::ptr::null_mut());
        let mut tm: libc::tm = std::mem::zeroed();
        if libc::localtime_r(&now, &mut tm).is_null() {
            return 0;
        }
        (tm.tm_gmtoff / 60) as i32
    }
}

#[cfg(not(unix))]
pub fn local_utc_offset_minutes() -> i32 {
    0
}

/// A resolved `file=` / `path=` target.
#[derive(Debug, Clone)]
pub struct Target {
    pub rel: String,
    pub abs: PathBuf,
}

/// Per-invocation context: the vault (resolved lazily, so `help`, `version`
/// and `vaults` need none) and the index (opened and refreshed on first use).
pub struct Ctx<'a> {
    pub env: &'a Env,
    cwd: PathBuf,
    vault_spec: Option<String>,
    root: OnceCell<PathBuf>,
    index: OnceCell<Arc<Index>>,
    warnings: RefCell<Vec<String>>,
}

impl<'a> Ctx<'a> {
    pub fn new(env: &'a Env, cwd: &Path, vault_spec: Option<String>) -> Ctx<'a> {
        Ctx {
            env,
            cwd: cwd.to_path_buf(),
            vault_spec,
            root: OnceCell::new(),
            index: OnceCell::new(),
            warnings: RefCell::new(Vec::new()),
        }
    }

    pub fn root(&self) -> Result<&Path, CliError> {
        if let Some(r) = self.root.get() {
            return Ok(r);
        }
        let dir = match &self.env.app_data_dir {
            Some(d) => Some(d.clone()),
            None if self.vault_spec.is_some() => crate::index::cli_app_data_dir().ok(),
            None => None,
        };
        let r = vault::resolve_vault(self.vault_spec.as_deref(), &self.cwd, dir.as_deref())
            .map_err(CliError::Fail)?;
        Ok(self.root.get_or_init(|| r))
    }

    pub fn index(&self) -> Result<&Arc<Index>, CliError> {
        if let Some(i) = self.index.get() {
            return Ok(i);
        }
        let root = self.root()?;
        let dir = self.env.app_data_dir.clone();
        let index = Index::open_for_cli(root, dir.as_deref()).map_err(CliError::from)?;
        Ok(self.index.get_or_init(|| Arc::new(index)))
    }

    /// A note for stderr (never stdout).
    pub fn warn(&self, msg: impl Into<String>) {
        self.warnings.borrow_mut().push(msg.into());
    }

    pub fn take_warnings(&self) -> Vec<String> {
        std::mem::take(&mut self.warnings.borrow_mut())
    }

    pub fn confine(&self, input: &str) -> Result<Confined, CliError> {
        Ok(vault_ops::confine(self.root()?, input)?)
    }

    /// `path=` (exact) or `file=` (wikilink-style) -> an existing file.
    /// `None` when neither is given.
    pub fn target_opt(&self, args: &args::Args) -> Result<Option<Target>, CliError> {
        if args.flag("active") {
            return Err(CliError::Usage(
                "the active flag is not available in the Writer CLI (it has no active file); use file= or path=".into(),
            ));
        }
        match (args.get("file"), args.get("path")) {
            (Some(_), Some(_)) => Err(CliError::Usage(
                "give either file=<name> or path=<path>, not both".into(),
            )),
            (None, None) => Ok(None),
            (None, Some(p)) => {
                let c = self.confine(p)?;
                if !c.abs.is_file() {
                    return Err(CliError::fail(format!("file not found: {}", c.rel)));
                }
                Ok(Some(Target {
                    rel: c.rel,
                    abs: c.abs,
                }))
            }
            (Some(name), None) => {
                let rel = self
                    .index()?
                    .resolve_link("", name)?
                    .ok_or_else(|| CliError::fail(format!("file not found: {name}")))?;
                let c = self.confine(&rel)?;
                if !c.abs.is_file() {
                    return Err(CliError::fail(format!("file not found: {rel}")));
                }
                Ok(Some(Target {
                    rel: c.rel,
                    abs: c.abs,
                }))
            }
        }
    }

    pub fn target(&self, args: &args::Args) -> Result<Target, CliError> {
        self.target_opt(args)?.ok_or_else(|| {
            CliError::Usage(
                "specify file=<name> or path=<path> (the Writer CLI has no active file)".into(),
            )
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Outcome {
    pub code: u8,
    pub stdout: String,
    pub stderr: String,
}

fn usage_outcome(msg: &str, hint: Option<&str>) -> Outcome {
    let mut stderr = format!("writer: {msg}\n");
    if let Some(h) = hint {
        stderr.push_str(&format!("Run `writer help {h}` for usage.\n"));
    }
    Outcome {
        code: EXIT_USAGE,
        stdout: String::new(),
        stderr,
    }
}

/// Should the launcher hand this argv (without the program name) to the
/// parity CLI? `vault=` first, or a known command name.
pub fn is_parity_invocation(args: &[String]) -> bool {
    let Some(first) = args.first() else {
        return false;
    };
    first.starts_with("vault=") || registry::find(first).is_some() || registry::app_control(first)
}

/// Why a command of a built-in feature cannot run: the feature's switch (`features.<id>.enabled`
/// in the app's global settings) is off. `None` for core commands and for a feature that is on.
/// The one gate for every feature's CLI commands (`CommandSpec::feature`).
fn feature_off(spec: &registry::CommandSpec, env: &Env) -> Option<String> {
    let id = spec.feature?;
    let on = env
        .data_dir()
        .map_or(true, |dir| crate::features::cli_enabled(&dir, id));
    (!on).then(|| {
        format!(
            "{}: the {id} feature is turned off (features.{id}.enabled); turn it on in Writer's Settings > Features",
            spec.name
        )
    })
}

/// Run one invocation. `argv` excludes the program name.
pub fn execute(argv: &[String], cwd: &Path, env: &Env) -> Outcome {
    let inv = match args::parse(argv) {
        Ok(i) => i,
        Err(e) => return usage_outcome(e.text(), None),
    };
    if registry::app_control(&inv.command) {
        return Outcome {
            code: EXIT_USAGE,
            stdout: String::new(),
            stderr: format!("Not available in the Writer CLI: {}\n", inv.command),
        };
    }
    if let Some(f) = inv.flags.iter().find(|f| *f == "active" || *f == "daily") {
        return Outcome {
            code: EXIT_USAGE,
            stdout: String::new(),
            stderr: format!(
                "Not available in the Writer CLI: the {f} flag (it has no active file or daily note); use file= or path=\n"
            ),
        };
    }
    let Some(spec) = registry::find(&inv.command) else {
        return usage_outcome(&format!("unknown command \"{}\"", inv.command), Some(""));
    };
    if inv.help {
        return Outcome {
            code: EXIT_OK,
            stdout: registry::help_for(spec),
            stderr: String::new(),
        };
    }
    let parsed = match args::validate(&inv, spec) {
        Ok(a) => a,
        Err(e) => return usage_outcome(e.text(), Some(spec.name)),
    };
    if let Some(message) = feature_off(spec, env) {
        return Outcome {
            code: EXIT_FAIL,
            stdout: String::new(),
            stderr: format!("writer: {message}\n"),
        };
    }
    let ctx = Ctx::new(env, cwd, inv.vault.clone());
    let result = (spec.run)(&ctx, &parsed, spec);
    let mut stderr: String = ctx
        .take_warnings()
        .into_iter()
        .map(|w| format!("writer: {w}\n"))
        .collect();
    match result {
        Ok(stdout) => {
            if inv.copy {
                if let Err(e) = env.clipboard.copy(&stdout) {
                    stderr.push_str(&format!("writer: {e}\n"));
                    return Outcome {
                        code: EXIT_FAIL,
                        stdout,
                        stderr,
                    };
                }
            }
            Outcome {
                code: EXIT_OK,
                stdout,
                stderr,
            }
        }
        Err(CliError::Usage(m)) => {
            let mut o = usage_outcome(&m, Some(spec.name));
            o.stderr = format!("{stderr}{}", o.stderr);
            o
        }
        Err(e @ (CliError::Fail(_) | CliError::NotRunning)) => {
            stderr.push_str(&format!("writer: {}\n", e.text()));
            Outcome {
                code: if e == CliError::NotRunning {
                    EXIT_NOT_RUNNING
                } else {
                    EXIT_FAIL
                },
                stdout: String::new(),
                stderr,
            }
        }
    }
}

/// Binary entry: run, write stdout/stderr, return the exit code.
pub fn run_main(argv: &[String], cwd: &Path) -> u8 {
    use std::io::Write;
    let env = Env::system();
    // The CLI process has no settings layer: the code-files switch comes from the config file.
    if let Ok(dir) = env.data_dir() {
        crate::features::code_files::apply_for_cli(&dir);
        crate::features::icons::apply_for_cli(&dir);
    }
    let out = execute(argv, cwd, &env);
    if out.code != 0 {
        // The command name only: the arguments can carry note text.
        let command = argv
            .iter()
            .find(|a| !a.contains('='))
            .map_or("", |s| s.as_str());
        tracing::error!(
            target: "cli",
            command,
            exit_code = out.code,
            "writer {command} failed: {}",
            crate::logging::truncated(out.stderr.trim(), 500)
        );
    }
    let _ = std::io::stdout().write_all(out.stdout.as_bytes());
    let _ = std::io::stdout().flush();
    let _ = std::io::stderr().write_all(out.stderr.as_bytes());
    out.code
}
