//! `bases`, `base:views`, `base:create`, `base:query`: the CLI front end of the
//! Rust Bases engine over the vault index.

use super::args::Args;
use super::format::{list_lines, render, Table};
use super::registry::CommandSpec;
use super::{CliError, Ctx, Target};
use crate::bases::context::SystemClock;
use crate::bases::document::Document;
use crate::bases::query::{pushdown_hint, BaseQueryResult, CompareOp};
use crate::bases::value::Value;
use crate::index::bases_source::run_base_view;
use crate::index::patch::ValueType;
use crate::index::FileFilter;
use crate::vault_ops;
use serde_json::{json, Value as Json};

pub fn bases(ctx: &Ctx, _: &Args, _: &CommandSpec) -> Result<String, CliError> {
    let page = ctx.index()?.query_files(&FileFilter {
        ext: Some("base".into()),
        ..FileFilter::default()
    })?;
    Ok(list_lines(page.rows.into_iter().map(|r| r.path)))
}

/// `file=Name` also finds `Name.base` (a wikilink to a non-markdown file
/// carries its extension).
fn base_target(ctx: &Ctx, args: &Args) -> Result<Target, CliError> {
    if let Some(name) = args.get("file") {
        if !name.to_ascii_lowercase().ends_with(".base") {
            if let Some(rel) = ctx.index()?.resolve_link("", &format!("{name}.base"))? {
                let c = ctx.confine(&rel)?;
                return Ok(Target {
                    rel: c.rel,
                    abs: c.abs,
                });
            }
        }
    }
    let t = ctx.target(args)?;
    if !t.rel.to_ascii_lowercase().ends_with(".base") {
        return Err(CliError::fail(format!("{} is not a .base file", t.rel)));
    }
    Ok(t)
}

fn load_document(t: &Target) -> Result<Document, CliError> {
    let text = vault_ops::read_text(&t.abs)?;
    Document::parse(&text).map_err(|e| CliError::fail(format!("{}: {e}", t.rel)))
}

pub fn base_views(ctx: &Ctx, args: &Args, _: &CommandSpec) -> Result<String, CliError> {
    let t = base_target(ctx, args)?;
    let doc = load_document(&t)?;
    Ok(list_lines(doc.views.iter().map(|v| v.name.clone())))
}

/// Plain JSON of a cell value (machine output; `display` is used for the
/// text formats).
fn plain(v: &Value) -> Json {
    match v {
        Value::Null => Json::Null,
        Value::Bool(b) => json!(b),
        Value::Number(n) if n.fract() == 0.0 && n.abs() < 9.0e15 => json!(*n as i64),
        Value::Number(n) => json!(n),
        Value::String(s) | Value::Html(s) | Value::Image(s) | Value::Icon(s) => json!(s),
        Value::List(l) => Json::Array(l.iter().map(plain).collect()),
        Value::Object(o) => {
            let mut m = serde_json::Map::new();
            for (k, x) in o {
                m.insert(k.clone(), plain(x));
            }
            Json::Object(m)
        }
        Value::Link(l) => json!(l.resolved.clone().unwrap_or_else(|| l.target.clone())),
        Value::File(f) => json!(f.path),
        other => json!(other.display()),
    }
}

/// Render a query result in `format` (`json|csv|tsv|md|paths`).
pub fn format_result(r: &BaseQueryResult, format: &str) -> Result<String, CliError> {
    let fail = CliError::fail;
    match format {
        "paths" => {
            let mut seen = std::collections::BTreeSet::new();
            Ok(list_lines(
                r.rows
                    .iter()
                    .filter(|row| seen.insert(row.path.clone()))
                    .map(|row| row.path.clone()),
            ))
        }
        "json" => {
            let mut t = Table {
                cols: r.columns.iter().map(|c| c.id.clone()).collect(),
                rows: Vec::new(),
            };
            for row in &r.rows {
                t.push(row.cells.iter().map(|c| plain(&c.value)).collect());
            }
            render(&t, "json", true).map_err(fail)
        }
        "csv" | "tsv" | "md" => {
            let mut t = Table {
                cols: r.columns.iter().map(|c| c.display_name.clone()).collect(),
                rows: Vec::new(),
            };
            for row in &r.rows {
                t.push(row.cells.iter().map(|c| json!(c.display)).collect());
            }
            render(&t, format, true).map_err(fail)
        }
        other => Err(CliError::Usage(format!("unknown format \"{other}\""))),
    }
}

pub fn base_query(ctx: &Ctx, args: &Args, spec: &CommandSpec) -> Result<String, CliError> {
    let format = args.format(spec)?;
    let t = base_target(ctx, args)?;
    let doc = load_document(&t)?;
    let clock = SystemClock {
        offset_minutes: ctx.env.utc_offset_minutes,
    };
    let result = run_base_view(ctx.index()?, &doc, args.get("view"), Some(&t.rel), &clock)?;
    if let Some(e) = &result.error {
        let mut msg = format!("{}: {}", t.rel, e.message);
        if let Some(x) = &e.expression {
            msg.push_str(&format!(" (in `{x}`)"));
        }
        if let Some(p) = &e.path {
            msg.push_str(&format!(" (on {p})"));
        }
        return Err(CliError::Fail(msg));
    }
    for w in &result.warnings {
        ctx.warn(format!("{}: {w}", t.rel));
    }
    format_result(&result, &format)
}

pub fn base_create(ctx: &Ctx, args: &Args, _: &CommandSpec) -> Result<String, CliError> {
    if args.flag("open") || args.flag("newtab") {
        ctx.warn("open/newtab ignored: the Writer CLI does not control the app");
    }
    let t = base_target(ctx, args)?;
    let doc = load_document(&t)?;
    let view = match args.get("view") {
        Some(v) => Some(
            doc.view(Some(v))
                .ok_or_else(|| CliError::fail(format!("no view named \"{v}\" in {}", t.rel)))?,
        ),
        None => doc.views.first(),
    };
    // Like Obsidian, a new item satisfies the view's filters where it can:
    // the folder of `file.inFolder(..)`, `prop == literal` as properties, a
    // single `file.hasTag(x)` as a tag.
    let filters: Vec<&crate::bases::document::Filter> = doc
        .filters
        .iter()
        .chain(view.and_then(|v| v.filters.as_ref()))
        .collect();
    let hint = pushdown_hint(&filters);
    let folder = hint
        .folders
        .iter()
        .find(|f| !f.is_empty())
        .cloned()
        .unwrap_or_default();
    let name = args.get("name");
    let base_name = name.unwrap_or("Untitled");
    let file_name = if base_name.to_ascii_lowercase().ends_with(".md") {
        base_name.to_string()
    } else {
        format!("{base_name}.md")
    };
    let join = |n: &str| {
        if folder.is_empty() {
            n.to_string()
        } else {
            format!("{folder}/{n}")
        }
    };
    let mut c = ctx.confine(&join(&file_name))?;
    if c.abs.exists() {
        if name.is_some() {
            return Err(CliError::fail(format!("{} already exists", c.rel)));
        }
        let mut n = 1;
        loop {
            let cand = ctx.confine(&join(&format!("{base_name} {n}.md")))?;
            if !cand.abs.exists() {
                c = cand;
                break;
            }
            n += 1;
        }
    }
    if let Some(parent) = c.abs.parent() {
        std::fs::create_dir_all(parent)?;
    }
    vault_ops::write_text(&c.abs, args.get("content").unwrap_or(""))?;
    let mut done: Vec<String> = Vec::new();
    for cmp in &hint.comparisons {
        if cmp.op != CompareOp::Eq || done.contains(&cmp.property) {
            continue;
        }
        if matches!(
            cmp.value,
            Value::String(_) | Value::Number(_) | Value::Bool(_)
        ) {
            vault_ops::set_property_file(&c.abs, &cmp.property, &plain(&cmp.value), None)?;
            done.push(cmp.property.clone());
        }
    }
    let tags: Vec<Json> = hint
        .tags_any
        .iter()
        .filter(|t| t.len() == 1)
        .map(|t| json!(t[0].trim_start_matches('#')))
        .collect();
    if !tags.is_empty() && !done.iter().any(|p| p == "tags") {
        vault_ops::set_property_file(&c.abs, "tags", &Json::Array(tags), Some(ValueType::List))?;
    }
    Ok(format!("Created {}\n", c.rel))
}
