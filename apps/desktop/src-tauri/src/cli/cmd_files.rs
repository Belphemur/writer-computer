//! `vault`, `vaults`, `files`, `file`, `folders`, `folder`.

use super::args::Args;
use super::format::list_lines;
use super::registry::CommandSpec;
use super::vault::{load_recents, vault_id, vault_name};
use super::{CliError, Ctx};
use crate::index::FileFilter;

pub(super) fn count(n: usize) -> String {
    format!("{n}\n")
}

pub fn vault(ctx: &Ctx, args: &Args, _: &CommandSpec) -> Result<String, CliError> {
    let index = ctx.index()?;
    let s = index.vault_summary()?;
    let row = |k: &str, v: String| format!("{k}\t{v}\n");
    Ok(match args.get("info") {
        None => [
            row("name", s.name),
            row("path", s.path),
            row("files", s.files.to_string()),
            row("folders", s.folders.to_string()),
            row("size", s.size.to_string()),
        ]
        .concat(),
        Some("name") => format!("{}\n", s.name),
        Some("path") => format!("{}\n", s.path),
        Some("files") => format!("{}\n", s.files),
        Some("folders") => format!("{}\n", s.folders),
        Some("size") => format!("{}\n", s.size),
        Some(other) => {
            return Err(CliError::Usage(format!(
                "unknown info \"{other}\" (name, path, files, folders, size)"
            )))
        }
    })
}

pub fn vaults(ctx: &Ctx, args: &Args, _: &CommandSpec) -> Result<String, CliError> {
    let dir = ctx.env.data_dir()?;
    let recents = load_recents(&dir).map_err(CliError::Fail)?;
    // Existing directories only: a vault that is gone cannot be targeted.
    let mut items = Vec::new();
    for r in recents {
        let p = std::path::Path::new(&r);
        if let Ok(c) = p.canonicalize() {
            if c.is_dir() {
                items.push((
                    vault_name(&c),
                    vault_id(&dir, &c),
                    c.to_string_lossy().into_owned(),
                ));
            }
        }
    }
    if args.flag("total") {
        return Ok(count(items.len()));
    }
    Ok(list_lines(items.into_iter().map(|(name, id, path)| {
        if args.flag("verbose") {
            format!("{name}\t{id}\t{path}")
        } else {
            name
        }
    })))
}

pub fn files(ctx: &Ctx, args: &Args, _: &CommandSpec) -> Result<String, CliError> {
    let index = ctx.index()?;
    let page = index.query_files(&FileFilter {
        folder: args.get("folder").map(str::to_string),
        ext: args.get("ext").map(str::to_string),
        ..FileFilter::default()
    })?;
    if args.flag("total") {
        return Ok(count(page.total as usize));
    }
    Ok(list_lines(page.rows.into_iter().map(|r| r.path)))
}

pub fn file(ctx: &Ctx, args: &Args, _: &CommandSpec) -> Result<String, CliError> {
    let t = ctx.target(args)?;
    let row = ctx
        .index()?
        .get_file(&t.rel)?
        .ok_or_else(|| CliError::fail(format!("{} is not in the vault index", t.rel)))?;
    Ok(format!(
        "path\t{}\nname\t{}\nextension\t{}\nsize\t{}\ncreated\t{}\nmodified\t{}\n",
        row.path, row.basename, row.ext, row.size, row.ctime, row.mtime
    ))
}

pub fn folders(ctx: &Ctx, args: &Args, _: &CommandSpec) -> Result<String, CliError> {
    let index = ctx.index()?;
    let prefix = args.get("folder").map(|f| f.trim_matches('/').to_string());
    let list: Vec<String> = index
        .list_folders(prefix.as_deref())?
        .into_iter()
        .filter(|f| prefix.as_deref() != Some(f.path.as_str()))
        .map(|f| f.path)
        .collect();
    if args.flag("total") {
        return Ok(count(list.len()));
    }
    Ok(list_lines(list))
}

pub fn folder(ctx: &Ctx, args: &Args, _: &CommandSpec) -> Result<String, CliError> {
    let path = args.require("path")?.trim_matches('/').to_string();
    let c = ctx.confine(&path)?;
    if !c.abs.is_dir() {
        return Err(CliError::fail(format!("folder not found: {}", c.rel)));
    }
    let index = ctx.index()?;
    let all = index.list_folders(Some(&c.rel))?;
    let me = all.iter().find(|f| f.path == c.rel);
    let (files, size) = me.map_or((0, 0), |f| (f.total_files, f.size));
    let sub = all.iter().filter(|f| f.path != c.rel).count();
    Ok(match args.get("info") {
        None => format!(
            "path\t{}\nfiles\t{files}\nfolders\t{sub}\nsize\t{size}\n",
            c.rel
        ),
        Some("files") => format!("{files}\n"),
        Some("folders") => format!("{sub}\n"),
        Some("size") => format!("{size}\n"),
        Some(other) => {
            return Err(CliError::Usage(format!(
                "unknown info \"{other}\" (files, folders, size)"
            )))
        }
    })
}
