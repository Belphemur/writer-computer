//! `icon:set`, `icon:get`, `icon:remove`: the CLI front end of the one icon store and resolver
//! (`crate::icons`, spec `SPECs/icons-spec.md`). Files and folders both take an icon; `path=` is
//! vault-relative, `file=` names a note like a wikilink. Like every CLI write, it goes straight
//! to `.writer/icons.json` (the app's watcher shows the change); `.obsidian` is never touched.

use super::args::Args;
use super::format::json_pretty;
use super::registry::CommandSpec;
use super::{CliError, Ctx};
use crate::icons::{self, IconError};
use serde_json::json;

fn fail(e: IconError) -> CliError {
    CliError::Fail(e.to_string())
}

/// The vault-relative path of the file or folder `path=` (or the note `file=`) names.
fn target(ctx: &Ctx, args: &Args) -> Result<String, CliError> {
    if let (None, Some(path)) = (args.get("file"), args.get("path")) {
        let c = ctx.confine(path)?;
        if !c.abs.exists() {
            return Err(CliError::fail(format!("not found: {}", c.rel)));
        }
        return Ok(c.rel);
    }
    Ok(ctx.target(args)?.rel)
}

pub fn icon_set(ctx: &Ctx, args: &Args, _: &CommandSpec) -> Result<String, CliError> {
    let rel = target(ctx, args)?;
    let raw = args.require("icon")?;
    let icon = icons::normalize_icon(raw).ok_or_else(|| {
        CliError::fail(format!(
            "not an icon: {raw} (use emoji:<emoji> or icon:<Hugeicons name>, e.g. icon:Rocket01Icon)"
        ))
    })?;
    icons::set(
        ctx.root()?,
        std::slice::from_ref(&rel),
        &icon,
        args.get("color"),
    )
    .map_err(fail)?;
    Ok(format!("Set {icon} on {rel}\n"))
}

pub fn icon_get(ctx: &Ctx, args: &Args, spec: &CommandSpec) -> Result<String, CliError> {
    let format = args.format(spec)?;
    let rel = target(ctx, args)?;
    let (entry, source) = icons::icon_of(ctx.root()?, &rel)
        .map_err(fail)?
        .ok_or_else(|| CliError::fail(format!("no icon: {rel}")))?;
    if format == "json" {
        return Ok(json_pretty(&json!({
            "path": rel,
            "icon": entry.icon,
            "color": entry.color,
            "source": source.as_str(),
        })) + "\n");
    }
    Ok(format!("{}\n", entry.icon))
}

pub fn icon_remove(ctx: &Ctx, args: &Args, _: &CommandSpec) -> Result<String, CliError> {
    let rel = target(ctx, args)?;
    icons::remove(ctx.root()?, std::slice::from_ref(&rel)).map_err(fail)?;
    Ok(format!("Removed the icon of {rel}\n"))
}
