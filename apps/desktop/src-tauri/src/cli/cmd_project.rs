//! `project:archive` and `project:unarchive`: the CLI front end of the one `agent::project::archive`
//! (ADR "archive agent projects by moving their folder"). Like every CLI write it goes straight to
//! the files; there are no chat sessions to check here, so an app chat running in the project is
//! the user's to stop first.

use super::args::Args;
use super::registry::CommandSpec;
use super::{CliError, Ctx};
use crate::agent::project::{self, ProjectError};

fn fail(e: ProjectError) -> CliError {
    CliError::Fail(e.to_string())
}

fn run(ctx: &Ctx, args: &Args, archived: bool) -> Result<String, CliError> {
    let root = ctx.root()?;
    let path = args.require("path")?;
    // the app's setting, read from the global config file (the CLI has no settings layer)
    let setting =
        ctx.env.data_dir().ok().and_then(|dir| {
            crate::config::read_global_string(&dir, project::SETTING_ARCHIVE_FOLDER)
        });
    let folder = project::archive_folder(root, setting.as_deref()).map_err(fail)?;
    let from = ctx.confine(path)?.rel;
    let moved = project::archive(root, path, archived, &folder, project::now_ms()).map_err(fail)?;
    let verb = if archived { "Archived" } else { "Unarchived" };
    Ok(if moved.info.path == from {
        format!("{verb} {from}\n")
    } else {
        format!("{verb} {from} -> {}\n", moved.info.path)
    })
}

pub fn project_archive(ctx: &Ctx, args: &Args, _: &CommandSpec) -> Result<String, CliError> {
    run(ctx, args, true)
}

pub fn project_unarchive(ctx: &Ctx, args: &Args, _: &CommandSpec) -> Result<String, CliError> {
    run(ctx, args, false)
}
