//! The allowlisted commands the socket accepts: one table, not a `match` per case. The core
//! commands are in [`super::commands`]; a built-in feature adds its own through
//! `Feature::ipc_commands`, and [`Registry`] is the union of the two for the features that are
//! running. A name outside the registry is refused, so no feature (and no request) can reach code
//! that was not put in the table on purpose.

use super::host::{BoxFuture, Host};
use super::protocol::{ErrorCode, IpcError, DEFAULT_COMMAND_TIMEOUT};
use crate::vault_ops::{self, Confined};
use serde_json::{Map, Value};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

/// How a command relates to the `vault` field of the request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VaultRule {
    /// The vault is optional; when given it is resolved and reported as open or not.
    Optional,
    /// The vault is required and must be open in Writer.
    MustBeOpen,
    /// The vault is required; the command opens its window when it is closed.
    OpensIt,
}

/// The vault a request named: canonical root, and whether Writer has it open.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Vault {
    pub root: PathBuf,
    pub open: bool,
}

/// Everything a handler gets. Arguments are untrusted JSON; the accessors validate.
pub struct Call {
    pub host: Arc<dyn Host>,
    pub vault: Option<Vault>,
    pub args: Map<String, Value>,
}

impl Call {
    /// The vault of a command whose [`VaultRule`] guarantees one.
    pub fn vault(&self) -> Result<&Vault, IpcError> {
        self.vault
            .as_ref()
            .ok_or_else(|| IpcError::new(ErrorCode::InvalidArgs, "this command needs a vault"))
    }

    /// Refuse an argument the command does not take.
    pub fn only_args(&self, allowed: &[&str]) -> Result<(), IpcError> {
        match self.args.keys().find(|k| !allowed.contains(&k.as_str())) {
            Some(k) => Err(IpcError::invalid_args(format!("unknown argument {k}"))),
            None => Ok(()),
        }
    }

    pub fn str_arg(&self, key: &str) -> Result<Option<&str>, IpcError> {
        match self.args.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(s)) => Ok(Some(s)),
            Some(_) => Err(IpcError::invalid_args(format!("{key} must be a string"))),
        }
    }

    pub fn require_str(&self, key: &str) -> Result<&str, IpcError> {
        self.str_arg(key)?
            .ok_or_else(|| IpcError::invalid_args(format!("{key} is required")))
    }

    pub fn bool_arg(&self, key: &str) -> Result<bool, IpcError> {
        match self.args.get(key) {
            None | Some(Value::Null) => Ok(false),
            Some(Value::Bool(b)) => Ok(*b),
            Some(_) => Err(IpcError::invalid_args(format!(
                "{key} must be true or false"
            ))),
        }
    }

    /// A 1-based line number.
    pub fn line_arg(&self, key: &str) -> Result<Option<u64>, IpcError> {
        match self.args.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(v) => match v.as_u64() {
                Some(n) if n >= 1 => Ok(Some(n)),
                _ => Err(IpcError::invalid_args(format!(
                    "{key} must be a whole number from 1"
                ))),
            },
        }
    }

    /// The vault-relative path in `key`, confined to the vault by `vault_ops::confine` (no `..`,
    /// no absolute path outside, no symlink out, no `.obsidian`/`.git`) and required to exist
    /// (and to be a file when `file_only`). The one confinement every path argument goes through;
    /// it touches the disk, so it runs on the blocking pool.
    pub async fn confine_existing(&self, key: &str, file_only: bool) -> Result<Confined, IpcError> {
        let root = self.vault()?.root.clone();
        let input = self.require_str(key)?.to_string();
        tokio::task::spawn_blocking(move || {
            let c = vault_ops::confine(&root, &input)?;
            let ok = if file_only {
                c.abs.is_file()
            } else {
                c.abs.exists()
            };
            if ok {
                Ok(c)
            } else {
                Err(IpcError::new(
                    ErrorCode::NotFound,
                    format!("not found: {}", c.rel),
                ))
            }
        })
        .await
        .map_err(|_| IpcError::new(ErrorCode::Internal, "the check did not finish"))?
    }
}

pub type Handler = fn(Call) -> BoxFuture<'static, Result<Value, IpcError>>;

/// One command of the allowlist.
#[derive(Debug)]
pub struct IpcCommand {
    pub name: &'static str,
    pub vault: VaultRule,
    /// The server's deadline and the client's wait.
    pub timeout: Duration,
    /// The built-in feature that contributes it (`Feature::ipc_commands`); while that feature is
    /// off or failed the command answers `feature_off`. `None` for the core commands.
    pub feature: Option<&'static str>,
    pub run: Handler,
}

impl IpcCommand {
    pub const fn core(name: &'static str, vault: VaultRule, run: Handler) -> Self {
        Self {
            name,
            vault,
            timeout: DEFAULT_COMMAND_TIMEOUT,
            feature: None,
            run,
        }
    }
}

/// Box a handler's future (a closure `|c| boxed(open(c))` is a `Handler`).
pub fn boxed<F>(f: F) -> BoxFuture<'static, F::Output>
where
    F: std::future::Future + Send + 'static,
{
    Box::pin(f)
}

/// The commands the server answers: the core table plus what the running features contributed.
pub struct Registry {
    commands: Vec<&'static IpcCommand>,
}

impl Registry {
    /// The core commands followed by `contributed`. A contributed name that is already taken
    /// is dropped and logged: a feature cannot replace a core command or another feature's.
    pub fn new(contributed: impl IntoIterator<Item = &'static IpcCommand>) -> Self {
        let mut commands: Vec<&'static IpcCommand> = super::commands::CORE.iter().collect();
        for c in contributed {
            if commands.iter().any(|k| k.name == c.name) {
                log::error!(
                    "ipc command {} is already taken; the duplicate is ignored",
                    c.name
                );
            } else {
                commands.push(c);
            }
        }
        Self { commands }
    }

    pub fn find(&self, name: &str) -> Option<&'static IpcCommand> {
        self.commands.iter().find(|c| c.name == name).copied()
    }

    pub fn names(&self) -> Vec<&'static str> {
        self.commands.iter().map(|c| c.name).collect()
    }
}

/// The client's wait for `name`: the command's own timeout when some registered feature or the
/// core knows it, the default otherwise (the app answers `unknown_command` at once).
pub fn client_timeout(name: &str) -> Duration {
    Registry::new(crate::features::ipc_commands())
        .find(name)
        .map_or(DEFAULT_COMMAND_TIMEOUT, |c| c.timeout)
}
