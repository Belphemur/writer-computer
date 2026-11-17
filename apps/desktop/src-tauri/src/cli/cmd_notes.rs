//! Commands that read or change file content: `read`, `create`, `append`,
//! `prepend`, `move`, `rename`, `delete`, `task`. Writes go straight to the
//! files (atomic write), never through the index, never into `.obsidian`.

use super::args::Args;
use super::registry::CommandSpec;
use super::{CliError, Ctx, Target};
use crate::index::frontmatter;
use crate::index::markdown;
use crate::vault_ops;
use std::path::Path;

fn name_of(path: &str) -> &str {
    path.rfind('/').map_or(path, |i| &path[i + 1..])
}

fn folder_of(path: &str) -> &str {
    path.rfind('/').map_or("", |i| &path[..i])
}

/// Extension of the last path segment, without the dot.
fn ext_of(path: &str) -> Option<&str> {
    let n = name_of(path);
    n.rfind('.').filter(|i| *i > 0).map(|i| &n[i + 1..])
}

pub fn read(ctx: &Ctx, args: &Args, _: &CommandSpec) -> Result<String, CliError> {
    let t = ctx.target(args)?;
    Ok(vault_ops::read_text(&t.abs)?)
}

fn ignored_ui_flags(ctx: &Ctx, args: &Args) {
    if args.flag("open") || args.flag("newtab") {
        ctx.warn("open/newtab ignored: the Writer CLI does not control the app");
    }
}

pub fn create(ctx: &Ctx, args: &Args, _: &CommandSpec) -> Result<String, CliError> {
    ignored_ui_flags(ctx, args);
    let overwrite = args.flag("overwrite");
    let with_md = |s: &str| {
        let l = s.to_ascii_lowercase();
        if l.ends_with(".md") || l.ends_with(".markdown") {
            s.to_string()
        } else {
            format!("{s}.md")
        }
    };
    let (input, explicit) = match (args.get("path"), args.get("name")) {
        (Some(_), Some(_)) => {
            return Err(CliError::Usage(
                "give either name= or path=, not both".into(),
            ))
        }
        (Some(p), None) => (with_md(p), true),
        (None, Some(n)) => (with_md(n), true),
        (None, None) => ("Untitled.md".to_string(), false),
    };
    let mut c = ctx.confine(&input)?;
    if !explicit && c.abs.exists() && !overwrite {
        // Untitled, Untitled 1, ...
        let mut n = 1;
        loop {
            let cand = ctx.confine(&format!("Untitled {n}.md"))?;
            if !cand.abs.exists() {
                c = cand;
                break;
            }
            n += 1;
        }
    }
    let existed = c.abs.exists();
    if existed && !overwrite {
        return Err(CliError::fail(format!(
            "{} already exists (use the overwrite flag)",
            c.rel
        )));
    }
    if existed && !c.abs.is_file() {
        return Err(CliError::fail(format!("{} is not a file", c.rel)));
    }
    let mut text = String::new();
    if let Some(t) = args.get("template") {
        let rel = match ctx.index()?.resolve_link("", t)? {
            Some(r) => r,
            None => {
                let c = ctx.confine(t)?;
                if c.abs.is_file() {
                    c.rel
                } else {
                    return Err(CliError::fail(format!("template not found: {t}")));
                }
            }
        };
        text = vault_ops::read_text(&ctx.confine(&rel)?.abs)?;
    }
    if let Some(content) = args.get("content") {
        if !text.is_empty() && !text.ends_with('\n') {
            text.push('\n');
        }
        text.push_str(content);
    }
    if let Some(parent) = c.abs.parent() {
        std::fs::create_dir_all(parent)?;
    }
    vault_ops::write_text(&c.abs, &text)?;
    Ok(format!(
        "{} {}\n",
        if existed { "Overwrote" } else { "Created" },
        c.rel
    ))
}

fn eol_of(text: &str) -> &'static str {
    if text.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    }
}

/// Start offset of the line after `offset`'s line (text.len() at the end).
fn next_line_start(text: &str, offset: usize) -> usize {
    text[offset..]
        .find('\n')
        .map_or(text.len(), |i| offset + i + 1)
}

/// `(heading line start, heading level, section end)` of the first heading
/// matching `want` (`Plan` or `## Plan`, case-insensitive).
fn find_section(text: &str, body_start: usize, want: &str) -> Option<(usize, usize, usize)> {
    let want = want.trim();
    let level = want.chars().take_while(|c| *c == '#').count();
    let want_text = want.trim_start_matches('#').trim().to_lowercase();
    let mut fence: Option<(char, usize)> = None;
    let mut found: Option<(usize, usize)> = None; // (line start, level)
    let mut offset = body_start;
    for raw in text[body_start..].split_inclusive('\n') {
        let line = raw.trim_end_matches(['\n', '\r']);
        let start = offset;
        offset += raw.len();
        if let Some((ch, len)) = fence {
            if markdown::fence_closes(line, ch, len) {
                fence = None;
            }
            continue;
        }
        if let Some(open) = markdown::fence_open(line) {
            fence = Some(open);
            continue;
        }
        let Some(h) = markdown::heading(line, 0) else {
            continue;
        };
        match found {
            None => {
                if h.text.to_lowercase() == want_text && (level == 0 || level == h.level as usize) {
                    found = Some((start, h.level as usize));
                }
            }
            Some((hs, hl)) if h.level as usize <= hl => return Some((hs, hl, start)),
            Some(_) => {}
        }
    }
    found.map(|(hs, hl)| (hs, hl, text.len()))
}

/// Pure insertion logic of `append` / `prepend`.
pub fn apply_insert(
    text: &str,
    content: &str,
    heading: Option<&str>,
    append: bool,
    inline: bool,
) -> Result<String, CliError> {
    let eol = eol_of(text);
    let split = frontmatter::split(text);
    let body_start = split.body_start;
    let mut offset = if append { text.len() } else { body_start };
    if let Some(h) = heading {
        let (hs, _, end) = find_section(text, body_start, h)
            .ok_or_else(|| CliError::fail(format!("heading not found: {h}")))?;
        if append {
            offset = end;
            let floor = next_line_start(text, hs);
            // Insert before the blank lines that separate this section from the next.
            while offset > floor {
                let prev_start = text[..offset - 1].rfind('\n').map_or(0, |i| i + 1);
                if text[prev_start..offset].trim().is_empty() && prev_start >= floor {
                    offset = prev_start;
                } else {
                    break;
                }
            }
        } else {
            offset = next_line_start(text, hs);
        }
    }
    let mut insert = String::new();
    if inline {
        insert.push_str(content);
    } else {
        if offset > 0 && !text[..offset].ends_with('\n') {
            insert.push_str(eol);
        }
        insert.push_str(content);
        insert.push_str(eol);
    }
    let mut out = String::with_capacity(text.len() + insert.len());
    out.push_str(&text[..offset]);
    out.push_str(&insert);
    out.push_str(&text[offset..]);
    Ok(out)
}

fn insert(ctx: &Ctx, args: &Args, append: bool) -> Result<String, CliError> {
    let t = ctx.target(args)?;
    let content = args.require("content")?;
    let text = vault_ops::read_text(&t.abs)?;
    let new = apply_insert(
        &text,
        content,
        args.get("heading"),
        append,
        args.flag("inline"),
    )?;
    vault_ops::write_text(&t.abs, &new)?;
    Ok(format!(
        "{} {}\n",
        if append {
            "Appended to"
        } else {
            "Prepended to"
        },
        t.rel
    ))
}

pub fn append(ctx: &Ctx, args: &Args, _: &CommandSpec) -> Result<String, CliError> {
    insert(ctx, args, true)
}

pub fn prepend(ctx: &Ctx, args: &Args, _: &CommandSpec) -> Result<String, CliError> {
    insert(ctx, args, false)
}

/// Move `from` to `new_rel` and rewrite links to it (and the relative links
/// of the moved note itself) across the vault: plan first, then apply
/// (`crate::relocate`). `dry-run` prints the plan and writes nothing.
fn relocate(
    ctx: &Ctx,
    args: &Args,
    from: &Target,
    new_rel: &str,
    verb: &str,
) -> Result<String, CliError> {
    let root = ctx.root()?.to_path_buf();
    let update = !args.flag("no-update-links");
    let json = match args.get("format") {
        None | Some("text") => false,
        Some("json") => true,
        Some(f) => {
            return Err(CliError::Usage(format!(
                "format= must be text or json, not {f}"
            )))
        }
    };
    let dry = args.flag("dry-run");
    let plan = crate::relocate::plan(&root, ctx.index()?, &from.rel, new_rel, update)?;
    for u in &plan.unreadable {
        ctx.warn(format!("{u} is not UTF-8 text; its links were not checked"));
    }
    if plan.skipped > 0 {
        ctx.warn(format!(
            "{} link(s) to the file could not be rewritten automatically; check for broken links",
            plan.skipped
        ));
    }
    if !dry {
        crate::relocate::apply(&plan).map_err(|e| CliError::fail(e.to_string()))?;
    }
    let links = plan.links();
    let files = plan.edits.len();
    if json {
        let v = serde_json::json!({
            "from": plan.from, "to": plan.to, "dryRun": dry, "links": links, "files": files,
            "skipped": plan.skipped,
            "edits": plan.edits.iter().map(|e| serde_json::json!({"path": e.rel, "links": e.links})).collect::<Vec<_>>(),
        });
        return Ok(format!(
            "{}\n",
            serde_json::to_string_pretty(&v).unwrap_or_default()
        ));
    }
    let plural = |n: usize, w: &str| format!("{n} {w}{}", if n == 1 { "" } else { "s" });
    let mut out = if dry {
        format!(
            "Would {} {} -> {} (would update {} in {})\n",
            if verb == "Renamed" { "rename" } else { "move" },
            plan.from,
            plan.to,
            plural(links, "link"),
            plural(files, "file"),
        )
    } else {
        format!(
            "{verb} {} -> {} (updated {} in {})\n",
            plan.from,
            plan.to,
            plural(links, "link"),
            plural(files, "file"),
        )
    };
    if dry {
        for e in &plan.edits {
            out.push_str(&format!("  {} ({})\n", e.rel, plural(e.links, "link")));
        }
    }
    Ok(out)
}

pub fn mv(ctx: &Ctx, args: &Args, _: &CommandSpec) -> Result<String, CliError> {
    let t = ctx.target(args)?;
    let to = args.require("to")?.trim();
    if to.is_empty() {
        return Err(CliError::Usage("to= needs a folder or path".into()));
    }
    let name = name_of(&t.rel);
    let as_folder = to.ends_with('/') || ext_of(to).is_none();
    let new_rel = if as_folder {
        let folder = to.trim_matches('/');
        if folder.is_empty() {
            name.to_string()
        } else {
            format!("{folder}/{name}")
        }
    } else {
        to.to_string()
    };
    relocate(ctx, args, &t, &new_rel, "Moved")
}

pub fn rename(ctx: &Ctx, args: &Args, _: &CommandSpec) -> Result<String, CliError> {
    let t = ctx.target(args)?;
    let name = args.require("name")?.trim();
    if name.is_empty() || name.contains(['/', '\\']) {
        return Err(CliError::Usage(
            "name= must be a file name without folders (use move to change folders)".into(),
        ));
    }
    crate::relocate::validate_file_name(name).map_err(|e| CliError::fail(e.to_string()))?;
    let ext = ext_of(&t.rel);
    let full = match ext {
        Some(e) if ext_of(name).is_some_and(|n| n.eq_ignore_ascii_case(e)) => name.to_string(),
        Some(e) => format!("{name}.{e}"),
        None => name.to_string(),
    };
    let folder = folder_of(&t.rel);
    let new_rel = if folder.is_empty() {
        full
    } else {
        format!("{folder}/{full}")
    };
    relocate(ctx, args, &t, &new_rel, "Renamed")
}

pub fn delete(ctx: &Ctx, args: &Args, _: &CommandSpec) -> Result<String, CliError> {
    let t = ctx.target(args)?;
    if args.flag("permanent") {
        std::fs::remove_file(&t.abs)?;
        return Ok(format!("Deleted {}\n", t.rel));
    }
    trash::delete(&t.abs).map_err(|e| {
        CliError::fail(format!(
            "could not move {} to the trash ({e}); nothing was deleted (use the permanent flag to delete for good)",
            t.rel
        ))
    })?;
    Ok(format!("Trashed {}\n", t.rel))
}

/// Status character of the task on `line`, and its byte offset in the line.
fn task_status(line: &str) -> Option<(char, usize)> {
    markdown::task(line, 0)?;
    let re = regex_lite::Regex::new(r"^\s*(?:>\s*)*(?:[-*+]|\d{1,9}[.)])[ \t]+\[(.)\]").ok()?;
    let m = re.captures(line)?.get(1)?;
    Some((line[m.start()..m.end()].chars().next()?, m.start()))
}

pub fn task(ctx: &Ctx, args: &Args, _: &CommandSpec) -> Result<String, CliError> {
    let (t, line_no): (Target, usize) = match args.get("ref") {
        Some(r) => {
            if args.get("file").is_some()
                || args.get("path").is_some()
                || args.get("line").is_some()
            {
                return Err(CliError::Usage("ref= replaces file=/path=/line=".into()));
            }
            let (p, l) = r
                .rsplit_once(':')
                .ok_or_else(|| CliError::Usage("ref= must be path:line".into()))?;
            let line = l
                .trim()
                .parse::<usize>()
                .map_err(|_| CliError::Usage(format!("invalid line number in ref: {l}")))?;
            let c = ctx.confine(p)?;
            if !c.abs.is_file() {
                return Err(CliError::fail(format!("file not found: {}", c.rel)));
            }
            (
                Target {
                    rel: c.rel,
                    abs: c.abs,
                },
                line,
            )
        }
        None => {
            let t = ctx.target(args)?;
            let line = args
                .require("line")?
                .trim()
                .parse::<usize>()
                .map_err(|_| CliError::Usage("line= must be a number".into()))?;
            (t, line)
        }
    };
    let actions = [
        args.flag("toggle"),
        args.flag("done"),
        args.flag("todo"),
        args.get("status").is_some(),
    ]
    .iter()
    .filter(|b| **b)
    .count();
    if actions > 1 {
        return Err(CliError::Usage(
            "use only one of toggle, done, todo, status=".into(),
        ));
    }
    let text = vault_ops::read_text(&t.abs)?;
    let mut start = 0usize;
    let mut found: Option<(usize, usize)> = None;
    for (i, raw) in text.split_inclusive('\n').enumerate() {
        if i + 1 == line_no {
            found = Some((start, start + raw.trim_end_matches(['\n', '\r']).len()));
            break;
        }
        start += raw.len();
    }
    let (ls, le) =
        found.ok_or_else(|| CliError::fail(format!("{} has no line {line_no}", t.rel)))?;
    let line = &text[ls..le];
    let (status, at) = task_status(line)
        .ok_or_else(|| CliError::fail(format!("{}:{line_no} is not a task", t.rel)))?;
    let new_status = if args.flag("toggle") {
        Some(if status == 'x' || status == 'X' {
            ' '
        } else {
            'x'
        })
    } else if args.flag("done") {
        Some('x')
    } else if args.flag("todo") {
        Some(' ')
    } else if let Some(s) = args.get("status") {
        let mut it = s.chars();
        match (it.next(), it.next()) {
            (Some(c), None) if c != '\n' && c != '\r' => Some(c),
            _ => {
                return Err(CliError::Usage(
                    "status= must be exactly one character".into(),
                ))
            }
        }
    } else {
        None
    };
    let Some(new_status) = new_status else {
        return Ok(format!("[{status}]\n"));
    };
    if new_status != status {
        let abs = ls + at;
        let mut out = String::with_capacity(text.len());
        out.push_str(&text[..abs]);
        out.push(new_status);
        out.push_str(&text[abs + status.len_utf8()..]);
        vault_ops::write_text(Path::new(&t.abs), &out)?;
    }
    Ok(format!("[{new_status}]\n"))
}
