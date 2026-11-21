//! `writer git:status`, `writer git:log` and `writer git:commit`: the engine of the app, headless
//! (ADR 2026-11-18, spec `SPECs/git-sync-spec.md` "Agents and CLI"). `git:status` and `git:log`
//! read; `git:commit` writes (a `user(...)` commit of the pending changes, the message from the
//! global `git.commit-message` setting). Tagged with the feature, so the CLI's one gate answers
//! "turned off" while `features.git.enabled` is false. Phase 1 has no remote: the status says so.

use crate::cli::args::Args;
use crate::cli::cmd_app;
use crate::cli::format::json_pretty;
use crate::cli::registry::{cmd, p, CommandSpec, NO_FLAGS, PATH};
use crate::cli::{CliError, Ctx};
use crate::config;
use crate::features::scope::Spawner;
use crate::git::history::{self, Against, FileDiff};
use crate::git::sync as engine;
use crate::git::transport::{Exec, Helper};
use crate::git::{self, device, message, resolve, Change, Error};
use serde_json::{json, Map};

const FEATURE: Option<&str> = Some(super::runtime::ID);
const GROUP: &str = "Git";

pub static COMMANDS: &[CommandSpec] = &[
    CommandSpec {
        feature: FEATURE,
        ..cmd!(
            "git:status",
            GROUP,
            "Show the vault's version history state: the files changed since the last version (read-only)",
            &[p("format", "text | json")],
            NO_FLAGS,
            &["text", "json"],
            Some("text"),
            reads,
            status_cmd
        )
    },
    CommandSpec {
        feature: FEATURE,
        ..cmd!(
            "git:log",
            GROUP,
            "List the versions of a file, newest first: subject, type, scope, date, device, agent and model (read-only)",
            &[
                PATH,
                p("limit", "how many versions, default 20"),
                p("format", "text | json")
            ],
            NO_FLAGS,
            &["text", "json"],
            Some("text"),
            reads,
            log_cmd
        )
    },
    CommandSpec {
        feature: FEATURE,
        ..cmd!(
            "git:diff",
            GROUP,
            "Show what a version of a file changed: against its previous version (default), the file now or another version (read-only)",
            &[
                PATH,
                p("rev", "the version (an id from git:log), default the latest"),
                p("against", "parent | current | another version's id"),
                p("format", "text | json")
            ],
            NO_FLAGS,
            &["text", "json"],
            Some("text"),
            reads,
            diff_cmd
        )
    },
    CommandSpec {
        feature: FEATURE,
        ..cmd!(
            "git:show",
            GROUP,
            "Print a file as it was in a version (read-only)",
            &[PATH, p("rev", "the version (an id from git:log)")],
            NO_FLAGS,
            &["text"],
            Some("text"),
            reads,
            show_cmd
        )
    },
    CommandSpec {
        feature: FEATURE,
        ..cmd!(
            "git:restore",
            GROUP,
            "Restore a file to a version as a new change (user(restore) commit); history is kept",
            &[PATH, p("rev", "the version (an id from git:log)")],
            NO_FLAGS,
            &["text"],
            Some("text"),
            writes,
            restore_cmd
        )
    },
    CommandSpec {
        feature: FEATURE,
        ..cmd!(
            "git:sync",
            GROUP,
            "Sync with the remote: save a version, fetch, replay local versions on top, push. Without a remote it only saves a version. Through the running app when it is open, else here",
            &[],
            NO_FLAGS,
            &["text"],
            Some("text"),
            writes,
            sync_cmd
        )
    },
    CommandSpec {
        feature: FEATURE,
        ..cmd!(
            "git:resolve",
            GROUP,
            "Settle a conflicted file by taking a whole side: mine keeps the file as it is here, theirs takes the other device's version; for a binary, both keeps the conflict copy beside the file. Saved as a user(merge) version. git:status lists what is in conflict",
            &[PATH, p("take", "mine | theirs | both (binaries only)")],
            NO_FLAGS,
            &["text"],
            Some("text"),
            writes,
            resolve_cmd
        )
    },
    CommandSpec {
        feature: FEATURE,
        ..cmd!(
            "git:commit",
            GROUP,
            "Save a version now: commit the pending changes as a user(...) commit",
            &[],
            NO_FLAGS,
            &["text"],
            Some("text"),
            writes,
            commit_cmd
        )
    },
];

fn fail(e: Error) -> CliError {
    CliError::fail(match e {
        Error::NoIdentity => e.to_string(),
        Error::NotARepo => "this vault is not a Git repository".to_string(),
        other => other.to_string(),
    })
}

fn not_set_up() -> CliError {
    CliError::fail("version history is not set up for this vault: choose it in Settings > Git")
}

fn kind_of(c: &Change) -> (&'static str, String, Option<String>) {
    match c {
        Change::Add(p) => ("add", p.clone(), None),
        Change::Edit(p) => ("edit", p.clone(), None),
        Change::Delete(p) => ("delete", p.clone(), None),
        Change::Move { from, to } => ("move", to.clone(), Some(from.clone())),
    }
}

fn status_cmd(ctx: &Ctx, args: &Args, spec: &CommandSpec) -> Result<String, CliError> {
    let format = args.format(spec)?;
    let root = ctx.root()?;
    let s = git::status(root, &git::IdentityCache::default(), true).map_err(fail)?;
    if format == "json" {
        let changed: Vec<_> = s
            .changes
            .iter()
            .map(|c| {
                let (kind, path, from) = kind_of(c);
                json!({ "kind": kind, "path": path, "from": from })
            })
            .collect();
        return Ok(json_pretty(&json!({
            "setUp": s.set_up,
            "paused": s.paused,
            "syncPaused": s.sync_paused,
            "remote": s.remote.url.as_deref().map_or("none".into(), crate::git::transport::display_url),
            "branch": s.remote.branch,
            "ahead": s.remote.ahead,
            "behind": s.remote.behind,
            "conflicted": s.conflicts.iter().map(|c| c.path.clone()).collect::<Vec<_>>(),
            "conflictedBinaries": s.copies.iter().map(|(f, c)| json!({ "path": f, "copy": c })).collect::<Vec<_>>(),
            "held": s.held.iter().map(|h| h.path.clone()).collect::<Vec<_>>(),
            "lastCommit": s.last_commit,
            "identityError": s.identity_error,
            "changed": changed,
        })) + "\n");
    }
    if !s.set_up {
        return Ok("not set up\nremote: none\n".into());
    }
    let mut out = String::new();
    if s.identity_error {
        out.push_str("error: set your git name and email\n");
    }
    out.push_str(if s.paused { "paused\n" } else { "active\n" });
    match &s.remote.url {
        None => out.push_str("remote: none\n"),
        Some(url) => {
            out.push_str(&format!(
                "remote: {}\n",
                crate::git::transport::display_url(url)
            ));
            if s.sync_paused {
                out.push_str("sync: paused\n");
            }
            out.push_str(&format!(
                "ahead: {}\nbehind: {}\n",
                s.remote.ahead, s.remote.behind
            ));
        }
    }
    for c in &s.conflicts {
        match &c.theirs_path {
            Some(other) => out.push_str(&format!("conflict: {} (renamed: {other})\n", c.path)),
            None => out.push_str(&format!("conflict: {}\n", c.path)),
        }
    }
    for (file, copy) in &s.copies {
        out.push_str(&format!(
            "conflict (binary): {file} (mine is kept as {copy})\n"
        ));
    }
    for h in &s.held {
        out.push_str(&format!("held back (looks like a token): {}\n", h.path));
    }
    if s.changes.is_empty() {
        out.push_str("changed: none\n");
    } else {
        out.push_str(&format!("changed: {}\n", s.changes.len()));
        for c in &s.changes {
            let (kind, path, from) = kind_of(c);
            match from {
                Some(from) => out.push_str(&format!("  {kind} {from} -> {path}\n")),
                None => out.push_str(&format!("  {kind} {path}\n")),
            }
        }
    }
    Ok(out)
}

fn iso_day(secs: i64) -> String {
    // civil date from days since the epoch (UTC), so the output never depends on the machine's zone
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{y:04}-{m:02}-{d:02} {:02}:{:02}Z",
        rem / 3600,
        (rem % 3600) / 60
    )
}

fn log_cmd(ctx: &Ctx, args: &Args, spec: &CommandSpec) -> Result<String, CliError> {
    let format = args.format(spec)?;
    let root = ctx.root()?;
    let limit = match args.get("limit") {
        None => 20,
        Some(n) => n
            .parse::<usize>()
            .map_err(|_| CliError::Usage(format!("limit= takes a number, not \"{n}\"")))?,
    };
    let rel = match args.get("path") {
        Some(p) => Some(ctx.confine(p)?.rel),
        None => None,
    };
    let repo = git::Repo::open(root)
        .map_err(fail)?
        .ok_or_else(not_set_up)?;
    let entries = match &rel {
        // a file's log follows renames; the vault's log is every commit
        Some(rel) => repo
            .file_versions(rel, limit)
            .map_err(fail)?
            .into_iter()
            .map(|v| git::LogEntry {
                id: v.id,
                time: v.time,
                message: v.message,
            })
            .collect(),
        None => repo.log(None, limit).map_err(fail)?,
    };
    if format == "json" {
        let list: Vec<_> = entries
            .iter()
            .map(|e| {
                json!({
                    "rev": e.id,
                    "time": e.time,
                    "subject": e.message.subject,
                    "type": e.message.ty.map(message::Type::as_str),
                    "scope": e.message.scope.map(message::Scope::as_str),
                    "device": e.message.device,
                    "chat": e.message.chat,
                    "agent": e.message.agent,
                    "models": e.message.models,
                })
            })
            .collect();
        return Ok(json_pretty(&json!({ "path": rel, "versions": list })) + "\n");
    }
    if entries.is_empty() {
        return Ok("no versions\n".into());
    }
    Ok(entries
        .iter()
        .map(|e| {
            let kind = match (e.message.ty, e.message.scope) {
                (Some(t), Some(s)) => format!("{}({})", t.as_str(), s.as_str()),
                _ => "other".to_string(),
            };
            let mut line = format!(
                "{} {} {} {}",
                &e.id[..e.id.len().min(8)],
                iso_day(e.time),
                kind,
                e.message.subject
            );
            if let Some(d) = &e.message.device {
                line.push_str(&format!(" [device {d}]"));
            }
            if let Some(a) = &e.message.agent {
                line.push_str(&format!(" [agent {a}"));
                if !e.message.models.is_empty() {
                    line.push_str(&format!(" {}", e.message.models.join(", ")));
                }
                line.push(']');
            }
            line.push('\n');
            line
        })
        .collect())
}

fn commit_cmd(ctx: &Ctx, _args: &Args, _: &CommandSpec) -> Result<String, CliError> {
    let root = ctx.root()?;
    if !git::is_set_up(root) {
        return Err(not_set_up());
    }
    let data_dir = ctx.env.data_dir()?;
    let template = config::read_global_value(&data_dir, "git.commit-message")
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_else(|| message::DEFAULT_TEMPLATE.to_string());
    let dev = device::name();
    match git::commit_user(root, &template, &git::template_ctx(&dev), &dev).map_err(fail)? {
        Some(id) => Ok(format!("committed {}\n", &id[..id.len().min(8)])),
        None => Ok("nothing to commit\n".into()),
    }
}

fn repo_of(ctx: &Ctx) -> Result<(std::path::PathBuf, git::Repo), CliError> {
    let root = ctx.root()?.to_path_buf();
    if !git::is_set_up(&root) {
        return Err(not_set_up());
    }
    let repo = git::Repo::open(&root)
        .map_err(fail)?
        .ok_or_else(not_set_up)?;
    Ok((root, repo))
}

fn path_arg(ctx: &Ctx, args: &Args) -> Result<String, CliError> {
    let p = args
        .get("path")
        .ok_or_else(|| CliError::Usage("path= is required".into()))?;
    Ok(ctx.confine(p)?.rel)
}

fn rev_arg(repo: &git::Repo, rel: &str, args: &Args) -> Result<String, CliError> {
    match args.get("rev") {
        Some(r) => Ok(r.to_string()),
        None => repo
            .file_versions(rel, 1)
            .map_err(fail)?
            .into_iter()
            .next()
            .map(|v| v.id)
            .ok_or_else(|| CliError::fail("this file has no versions")),
    }
}

/// Changed rows with three lines of context, gaps as `...`.
fn unified(rows: &[crate::text_diff::DiffRow]) -> String {
    use crate::text_diff::DiffRowKind::*;
    let near = |i: usize| {
        let (lo, hi) = (i.saturating_sub(3), (i + 4).min(rows.len()));
        rows[lo..hi].iter().any(|r| r.kind != Context)
    };
    let mut out = String::new();
    let mut gap = false;
    for (i, r) in rows.iter().enumerate() {
        if r.kind == Context && !near(i) {
            gap = true;
            continue;
        }
        if gap {
            out.push_str("...\n");
            gap = false;
        }
        let sign = match r.kind {
            Context => ' ',
            Add => '+',
            Del => '-',
        };
        out.push_str(&format!("{sign} {}\n", r.text));
    }
    out
}

fn diff_cmd(ctx: &Ctx, args: &Args, spec: &CommandSpec) -> Result<String, CliError> {
    let format = args.format(spec)?;
    let (root, repo) = repo_of(ctx)?;
    let rel = path_arg(ctx, args)?;
    let rev = rev_arg(&repo, &rel, args)?;
    let against = match args.get("against") {
        None | Some("parent") => Against::Parent,
        Some("current") => Against::Current,
        Some(other) => Against::Version(other.to_string()),
    };
    let diff = history::diff(&repo, &root, &rel, &rev, &against).map_err(fail)?;
    if format == "json" {
        return Ok(json_pretty(&serde_json::to_value(&diff).unwrap_or_default()) + "\n");
    }
    Ok(match diff {
        FileDiff::Text { diff }
            if diff
                .rows
                .iter()
                .all(|r| r.kind == crate::text_diff::DiffRowKind::Context) =>
        {
            "no changes\n".to_string()
        }
        FileDiff::Text { diff } => {
            let mut out = format!("+{} -{}", diff.added, diff.removed);
            if diff.formatting_only {
                out.push_str(" (formatting only)");
            }
            out.push('\n');
            out.push_str(&unified(&diff.rows));
            out
        }
        FileDiff::Image { before, after } => format!(
            "image: before {} bytes, after {} bytes\n",
            before.map_or(0, |p| p.size),
            after.map_or(0, |p| p.size)
        ),
        FileDiff::Binary {
            before_size,
            after_size,
        } => format!(
            "binary file: before {} bytes, after {} bytes\n",
            before_size.unwrap_or(0),
            after_size.unwrap_or(0)
        ),
    })
}

fn show_cmd(ctx: &Ctx, args: &Args, _: &CommandSpec) -> Result<String, CliError> {
    let (_, repo) = repo_of(ctx)?;
    let rel = path_arg(ctx, args)?;
    let rev = rev_arg(&repo, &rel, args)?;
    let version = history::find(&repo, &rel, &rev).map_err(fail)?;
    let bytes = history::content(&repo, &version)
        .map_err(fail)?
        .ok_or_else(|| CliError::fail("the file was deleted in this version"))?;
    history::as_text(&bytes)
        .map(str::to_string)
        .ok_or_else(|| CliError::fail("this version is not a text file"))
}

fn restore_cmd(ctx: &Ctx, args: &Args, _: &CommandSpec) -> Result<String, CliError> {
    let (root, repo) = repo_of(ctx)?;
    let rel = path_arg(ctx, args)?;
    let rev = args
        .get("rev")
        .ok_or_else(|| CliError::Usage("rev= is required".into()))?
        .to_string();
    let done = history::restore(&repo, &root, &rel, &rev, &device::name()).map_err(fail)?;
    Ok(if done.commit.is_empty() {
        format!("{} already holds that version\n", done.path)
    } else {
        format!("restored {}\n", done.path)
    })
}

fn resolve_cmd(ctx: &Ctx, args: &Args, _: &CommandSpec) -> Result<String, CliError> {
    let (root, _repo) = repo_of(ctx)?;
    let rel = path_arg(ctx, args)?;
    let side = args
        .get("take")
        .and_then(resolve::Take::parse)
        .ok_or_else(|| CliError::Usage("take=mine, take=theirs or take=both is required".into()))?;
    resolve::take(&root, &rel, side, &device::name(), None)
        .map_err(|e| CliError::fail(e.to_string()))?;
    Ok(format!("resolved {rel}\n"))
}

fn sync_line(v: &serde_json::Value) -> String {
    let n = |k: &str| v[k].as_u64().unwrap_or(0);
    let mut out = format!("synced: pushed {}, pulled {}\n", n("pushed"), n("pulled"));
    if let Some(files) = v["conflicted"].as_array() {
        for f in files.iter().filter_map(|f| f.as_str()) {
            out.push_str(&format!("conflict: {f} (resolve it in Writer)\n"));
        }
    }
    out
}

/// `writer git:sync`: through the running app when the vault is open there (its scheduler owns the
/// run, a conflict reaches its panel), else here with the same engine.
fn sync_cmd(ctx: &Ctx, _args: &Args, _: &CommandSpec) -> Result<String, CliError> {
    let root = ctx.root()?.to_path_buf();
    if !git::is_set_up(&root) {
        return Err(not_set_up());
    }
    match cmd_app::call_app(ctx, "git:sync", Some(&root), Map::new()) {
        Ok(v) if v["open"].as_bool() == Some(true) => {
            if let Some(e) = v["error"].as_str() {
                return Err(CliError::fail(e.to_string()));
            }
            return Ok(sync_line(&v));
        }
        Ok(_) | Err(CliError::NotRunning) => {}
        Err(e) => return Err(e),
    }
    headless_sync(ctx, &root)
}

fn headless_sync(ctx: &Ctx, root: &std::path::Path) -> Result<String, CliError> {
    let data_dir = ctx.env.data_dir()?;
    let template = config::read_global_value(&data_dir, "git.commit-message")
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_else(|| message::DEFAULT_TEMPLATE.to_string());
    let dev = device::name();
    let committed =
        git::commit_user(root, &template, &git::template_ctx(&dev), &dev).map_err(fail)?;
    let mut out = String::new();
    if let Some(id) = &committed {
        out.push_str(&format!("committed {}\n", &id[..id.len().min(8)]));
    }
    let repo = git::Repo::open(root)
        .map_err(fail)?
        .ok_or_else(not_set_up)?;
    if !git::has_remote(&repo) {
        out.push_str("no remote: versions only\n");
        return Ok(out);
    }
    let exec = Exec::new(Spawner::detached());
    let helper = std::env::current_exe().ok().map(|exe| Helper {
        exe,
        source: git::state::credential_source(root),
        service: crate::plugin_secrets::PluginSecrets::service_name(
            crate::index::paths::RELEASE_IDENTIFIER,
        ),
    });
    let outcome = engine::sync(
        root,
        &engine::Options {
            exec: &exec,
            helper: helper.as_ref(),
            secrets: Vec::new(),
            device: &dev,
            announce: None,
        },
    );
    if let Some(e) = outcome.error {
        return Err(CliError::fail(match e {
            engine::Error::Transport(t) => t.line,
            other => other.to_string(),
        }));
    }
    let r = outcome.report;
    out.push_str(&format!(
        "synced: pushed {}, pulled {}\n",
        r.pushed, r.pulled
    ));
    for c in &r.conflicts {
        out.push_str(&format!(
            "conflict: {} (left as it is here; open Writer to resolve it)\n",
            c.path
        ));
    }
    for (file, copy) in &r.copies {
        out.push_str(&format!("kept both: {file} and {copy}\n"));
    }
    for h in &r.held {
        out.push_str(&format!("held back (looks like a token): {}\n", h.path));
    }
    Ok(out)
}
