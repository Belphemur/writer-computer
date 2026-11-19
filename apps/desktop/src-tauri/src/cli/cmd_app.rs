//! The commands that talk to the running app over the local socket (`ipc/`, ADR 2026-11-18,
//! spec "Talking to the running app"): `status`, `open`, `reveal`, `active`. The rest of the CLI
//! works headless on the files; these need Writer to be running and say so
//! (`CliError::NotRunning`, exit code 4) when it is not. `open --launch` starts the app first.

use super::args::Args;
use super::registry::CommandSpec;
use super::{CliError, Ctx};
use crate::ipc::client::{self, ClientError};
use crate::ipc::registry::client_timeout;
use serde_json::{json, Map, Value};
use std::path::Path;
use std::time::{Duration, Instant};

/// How often `--launch` looks for the socket of the app it started.
const LAUNCH_POLL: Duration = Duration::from_millis(200);

fn map_error(e: ClientError) -> CliError {
    match e {
        ClientError::NotRunning => CliError::NotRunning,
        ClientError::Timeout => CliError::fail("Writer did not answer in time"),
        ClientError::Remote(r) => CliError::Fail(r.message),
        ClientError::Protocol(m) => CliError::Fail(m),
    }
}

/// One request to the app for `cmd`. The vault is the one the CLI resolved (`vault=` or the working
/// directory); `None` for a command that works without one.
fn send(
    ctx: &Ctx,
    cmd: &str,
    vault: Option<&Path>,
    args: Map<String, Value>,
) -> Result<Value, ClientError> {
    let dir = ctx
        .env
        .data_dir()
        .map_err(|_| ClientError::Protocol("no app data directory".into()))?;
    let vault = vault.map(|v| v.to_string_lossy().into_owned());
    client::call(&dir, cmd, vault.as_deref(), &args, client_timeout(cmd))
}

/// [`send`], and when the app is not running and `launch` is set, start it on the vault, wait for
/// its socket (up to `Env::launch_wait`) and send again.
fn send_or_launch(
    ctx: &Ctx,
    cmd: &str,
    vault: &Path,
    args: Map<String, Value>,
    launch: bool,
) -> Result<Value, CliError> {
    match send(ctx, cmd, Some(vault), args.clone()) {
        Err(ClientError::NotRunning) if launch => {}
        other => return other.map_err(map_error),
    }
    ctx.env
        .launcher
        .launch(Some(vault))
        .map_err(|e| CliError::Fail(e.to_string()))?;
    let deadline = Instant::now() + ctx.env.launch_wait;
    loop {
        match send(ctx, cmd, Some(vault), args.clone()) {
            Err(ClientError::NotRunning) if Instant::now() < deadline => {
                std::thread::sleep(LAUNCH_POLL);
            }
            other => return other.map_err(map_error),
        }
    }
}

fn want_json(args: &Args, spec: &CommandSpec) -> Result<bool, CliError> {
    Ok(args.format(spec)? == "json")
}

fn as_json(v: &Value) -> String {
    format!("{}\n", serde_json::to_string_pretty(v).unwrap_or_default())
}

pub fn status(ctx: &Ctx, args: &Args, spec: &CommandSpec) -> Result<String, CliError> {
    let json = want_json(args, spec)?;
    // `status` works without a vault (outside any vault the app's own list is the answer).
    let vault = ctx.root().ok().map(Path::to_path_buf);
    let v = send(ctx, "status", vault.as_deref(), Map::new()).map_err(map_error)?;
    if json {
        return Ok(as_json(&v));
    }
    let mut out = format!(
        "Writer {} is running\n",
        v["version"].as_str().unwrap_or("?")
    );
    for p in v["vaults"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        out.push_str(&format!("vault\t{p}\n"));
    }
    if let Some(open) = v["vaultOpen"].as_bool() {
        out.push_str(&format!(
            "this vault is {}\n",
            if open { "open" } else { "not open" }
        ));
    }
    Ok(out)
}

pub fn open(ctx: &Ctx, args: &Args, _: &CommandSpec) -> Result<String, CliError> {
    let target = ctx.target(args)?;
    let mut call = Map::new();
    call.insert("path".into(), json!(target.rel));
    if args.flag("newtab") {
        call.insert("newTab".into(), json!(true));
    }
    if let Some(line) = args.get("line") {
        let n: u64 = line
            .parse()
            .ok()
            .filter(|n| *n >= 1)
            .ok_or_else(|| CliError::Usage("line= must be a whole number from 1".into()))?;
        call.insert("line".into(), json!(n));
    }
    if let Some(anchor) = args.get("anchor") {
        call.insert("anchor".into(), json!(anchor));
    }
    let v = send_or_launch(ctx, "open", ctx.root()?, call, args.flag("launch"))?;
    Ok(format!(
        "Opened {}\n",
        v["path"].as_str().unwrap_or(&target.rel)
    ))
}

/// The sidebar shows folders too: a `path=` may name a folder, a `file=` is always a file.
pub fn reveal(ctx: &Ctx, args: &Args, _: &CommandSpec) -> Result<String, CliError> {
    let rel = match (args.get("file"), args.get("path")) {
        (None, Some(path)) => {
            let c = ctx.confine(path)?;
            if !c.abs.exists() {
                return Err(CliError::fail(format!("not found: {}", c.rel)));
            }
            c.rel
        }
        _ => ctx.target(args)?.rel,
    };
    let mut call = Map::new();
    call.insert("path".into(), json!(rel));
    let v = send(ctx, "reveal", Some(ctx.root()?), call).map_err(map_error)?;
    Ok(format!("Revealed {}\n", v["path"].as_str().unwrap_or(&rel)))
}

pub fn active(ctx: &Ctx, args: &Args, spec: &CommandSpec) -> Result<String, CliError> {
    let json = want_json(args, spec)?;
    let v = send(ctx, "active", Some(ctx.root()?), Map::new()).map_err(map_error)?;
    if json {
        return Ok(as_json(&v));
    }
    let Some(path) = v["path"].as_str() else {
        return Ok("No active note\n".into());
    };
    let mut out = format!("path\t{path}\n");
    if let Some(kind) = v["kind"].as_str() {
        out.push_str(&format!("kind\t{kind}\n"));
    }
    if let Some(line) = v["line"].as_u64() {
        out.push_str(&format!("line\t{line}\n"));
    }
    Ok(out)
}
