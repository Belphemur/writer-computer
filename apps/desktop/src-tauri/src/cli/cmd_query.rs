//! Read-only commands over the index and file text: `search`,
//! `search:context`, properties, aliases, tags, tasks, links, `outline`,
//! `wordcount`; plus the property writers (`property:set/remove`), which go
//! through the shared frontmatter patcher.

use super::args::Args;
use super::cmd_files::count;
use super::format::{cell_text, json_pretty, list_lines, pretty_object, render, Table};
use super::registry::CommandSpec;
use super::{CliError, Ctx};
use crate::index::patch::{self, ValueType};
use crate::index::{FileFilter, MetaSelector, SearchHit, SearchOptions, TaskFilter};
use crate::vault_ops;
use serde_json::{json, Value as Json};
use std::collections::BTreeMap;

fn render_table(t: &Table, format: &str, header: bool) -> Result<String, CliError> {
    render(t, format, header).map_err(CliError::fail)
}

fn parse_limit(args: &Args) -> Result<Option<usize>, CliError> {
    match args.get("limit") {
        None => Ok(None),
        Some(l) => l
            .trim()
            .parse::<usize>()
            .map(Some)
            .map_err(|_| CliError::Usage("limit= must be a number".into())),
    }
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

/// `query=/regex/` is the explicit regular-expression mode (regex-lite, no
/// lookaround, a scan over the note text); every other query runs on the
/// full-text index (`Index::search`, see SPECs/search-spec.md). Case-insensitive
/// unless the `case` flag is given.
struct Matcher {
    re: regex_lite::Regex,
}

impl Matcher {
    /// `Ok(None)` when `query` is not written as `/regex/`.
    fn regex(query: &str, case: bool) -> Result<Option<Matcher>, CliError> {
        if query.len() > 2 && query.starts_with('/') && query.ends_with('/') {
            let re = regex_lite::RegexBuilder::new(&query[1..query.len() - 1])
                .case_insensitive(!case)
                .build()
                .map_err(|e| CliError::fail(format!("invalid regular expression: {e}")))?;
            return Ok(Some(Matcher { re }));
        }
        Ok(None)
    }

    fn is_match(&self, s: &str) -> bool {
        self.re.is_match(s)
    }
}

fn require_query(args: &Args) -> Result<&str, CliError> {
    let q = args.require("query")?;
    if q.is_empty() {
        return Err(CliError::Usage("query= must not be empty".into()));
    }
    Ok(q)
}

fn regex_files(ctx: &Ctx, args: &Args) -> Result<Vec<crate::index::FileRow>, CliError> {
    Ok(ctx
        .index()?
        .query_files(&FileFilter {
            folder: args.get("path").map(str::to_string),
            ext: Some("md".into()),
            ..FileFilter::default()
        })?
        .rows)
}

/// Hits per index page while the CLI collects an unbounded result.
const SEARCH_PAGE: u32 = 200;

/// Ranked full-text hits for `query`, paged internally until `want` items
/// (counted by `count`) are collected or the matches run out.
fn fts_collect(
    ctx: &Ctx,
    args: &Args,
    query: &str,
    max_snippets: u32,
    count: impl Fn(&SearchHit) -> usize,
    want: Option<usize>,
) -> Result<Vec<SearchHit>, CliError> {
    let index = ctx.index()?;
    let mut opts = SearchOptions {
        folder: args.get("path").map(str::to_string),
        case_sensitive: args.flag("case"),
        limit: Some(SEARCH_PAGE),
        snippet_len: Some(0),
        max_snippets: Some(max_snippets),
        ..SearchOptions::default()
    };
    let mut out: Vec<SearchHit> = Vec::new();
    let mut counted = 0usize;
    loop {
        let page = index.search(query, &opts)?;
        let n = page.hits.len();
        for h in page.hits {
            counted += count(&h);
            out.push(h);
        }
        if want.is_some_and(|w| counted >= w) || (n as u32) < SEARCH_PAGE {
            return Ok(out);
        }
        opts.offset += SEARCH_PAGE;
    }
}

pub fn search(ctx: &Ctx, args: &Args, spec: &CommandSpec) -> Result<String, CliError> {
    let format = args.format(spec)?;
    let query = require_query(args)?;
    let limit = parse_limit(args)?;
    let mut hits: Vec<String> = Vec::new();
    if let Some(m) = Matcher::regex(query, args.flag("case"))? {
        let root = ctx.root()?.to_path_buf();
        for row in regex_files(ctx, args)? {
            if limit.is_some_and(|l| hits.len() >= l) {
                break;
            }
            let mut hit = m.is_match(&row.name);
            if !hit {
                match vault_ops::read_text(&root.join(&row.path)) {
                    Ok(text) => hit = text.lines().any(|l| m.is_match(l)),
                    Err(e) => ctx.warn(format!("skipped {}: {e}", row.path)),
                }
            }
            if hit {
                hits.push(row.path);
            }
        }
    } else {
        // Snippets are only needed to verify `case`.
        let found = fts_collect(ctx, args, query, 0, |_| 1, limit)?;
        hits = found.into_iter().map(|h| h.path).collect();
        if let Some(l) = limit {
            hits.truncate(l);
        }
    }
    if args.flag("total") {
        return Ok(count(hits.len()));
    }
    Ok(if format == "json" {
        format!("{}\n", json_pretty(&json!(hits)))
    } else {
        list_lines(hits)
    })
}

pub fn search_context(ctx: &Ctx, args: &Args, spec: &CommandSpec) -> Result<String, CliError> {
    let format = args.format(spec)?;
    let query = require_query(args)?;
    let limit = parse_limit(args)?;
    let mut hits: Vec<(String, usize, String)> = Vec::new();
    if let Some(m) = Matcher::regex(query, args.flag("case"))? {
        let root = ctx.root()?.to_path_buf();
        'files: for row in regex_files(ctx, args)? {
            let text = match vault_ops::read_text(&root.join(&row.path)) {
                Ok(t) => t,
                Err(e) => {
                    ctx.warn(format!("skipped {}: {e}", row.path));
                    continue;
                }
            };
            for (i, line) in text.lines().enumerate() {
                if m.is_match(line) {
                    if limit.is_some_and(|l| hits.len() >= l) {
                        break 'files;
                    }
                    hits.push((row.path.clone(), i + 1, line.trim_end().to_string()));
                }
            }
        }
    } else {
        let found = fts_collect(ctx, args, query, u32::MAX, |h| h.snippets.len(), limit)?;
        for h in found {
            if h.stale {
                ctx.warn(format!(
                    "{} changed while searching; lines are current",
                    h.path
                ));
            }
            for s in h.snippets {
                hits.push((h.path.clone(), s.line as usize, s.text));
            }
        }
        if let Some(l) = limit {
            hits.truncate(l);
        }
    }
    Ok(if format == "json" {
        let v: Vec<Json> = hits
            .iter()
            .map(|(p, l, t)| json!({"path": p, "line": l, "text": t}))
            .collect();
        format!("{}\n", json_pretty(&Json::Array(v)))
    } else {
        list_lines(hits.into_iter().map(|(p, l, t)| format!("{p}:{l}: {t}")))
    })
}

// ---------------------------------------------------------------------------
// properties
// ---------------------------------------------------------------------------

fn compact(v: &Json) -> String {
    match v {
        Json::String(_) | Json::Null | Json::Bool(_) | Json::Number(_) => cell_text(v),
        other => other.to_string(),
    }
}

pub fn properties(ctx: &Ctx, args: &Args, spec: &CommandSpec) -> Result<String, CliError> {
    let format = args.format(spec)?;
    let name = args.get("name");
    if let Some(s) = args.get("sort") {
        if s != "count" {
            return Err(CliError::Usage("sort= only supports count".into()));
        }
    }
    if let Some(t) = ctx.target_opt(args)? {
        if args.flag("counts") || args.get("sort").is_some() {
            return Err(CliError::Usage(
                "counts and sort= apply to the vault-wide list, not to one file".into(),
            ));
        }
        let text = vault_ops::read_text(&t.abs)?;
        let mut props = patch::read_properties(&text).map_err(|e| CliError::fail(e.to_string()))?;
        if let Some(n) = name {
            props.retain(|p| p.name == n);
        }
        if args.flag("total") {
            return Ok(count(props.len()));
        }
        return Ok(match format.as_str() {
            "json" => format!(
                "{}\n",
                pretty_object(
                    &props
                        .into_iter()
                        .map(|p| (p.name, p.value))
                        .collect::<Vec<_>>(),
                    0
                )
            ),
            "tsv" => list_lines(
                props
                    .iter()
                    .map(|p| format!("{}\t{}", p.name, compact(&p.value))),
            ),
            _ => {
                let mut lines = Vec::new();
                for p in &props {
                    lines.extend(
                        patch::render_entry(&p.name, &p.value, ValueType::from_index_type(p.vtype))
                            .map_err(|e| CliError::fail(e.to_string()))?,
                    );
                }
                list_lines(lines)
            }
        });
    }
    let index = ctx.index()?;
    let mut list = index.properties()?;
    // `types`: each name with its effective type (`relationships` included), the app's own report
    let types: std::collections::HashMap<String, String> = if args.flag("types") {
        crate::property_types::report(index.root(), index.properties_for_types()?)
            .into_iter()
            .map(|p| (p.key, p.ty.wire_name().to_string()))
            .collect()
    } else {
        Default::default()
    };
    let ty = |k: &str| types.get(k).cloned();
    if let Some(n) = name {
        list.retain(|p| p.key == n);
    }
    if args.get("sort") == Some("count") {
        list.sort_by(|a, b| b.count.cmp(&a.count).then(a.key.cmp(&b.key)));
    }
    if args.flag("total") {
        return Ok(count(list.len()));
    }
    let counts = args.flag("counts");
    Ok(match format.as_str() {
        "json" => {
            let v: Vec<Json> = list
                .iter()
                .map(|p| {
                    let mut o = json!({"name": p.key});
                    if counts {
                        o["count"] = json!(p.count);
                    }
                    if let Some(t) = ty(&p.key) {
                        o["type"] = json!(t);
                    }
                    o
                })
                .collect();
            format!("{}\n", json_pretty(&Json::Array(v)))
        }
        "tsv" => list_lines(list.iter().map(|p| {
            let mut cols = vec![p.key.clone()];
            if counts {
                cols.push(p.count.to_string());
            }
            cols.extend(ty(&p.key));
            cols.join("\t")
        })),
        _ => list_lines(list.iter().map(|p| {
            let mut tail = Vec::new();
            if counts {
                tail.push(p.count.to_string());
            }
            tail.extend(ty(&p.key));
            if tail.is_empty() {
                format!("- {}", yaml_key(&p.key))
            } else if counts {
                format!("{}: {}", yaml_key(&p.key), tail.join(", "))
            } else {
                format!("- {}: {}", yaml_key(&p.key), tail.join(", "))
            }
        })),
    })
}

fn yaml_key(k: &str) -> String {
    patch::render_entry(k, &Json::Null, None)
        .ok()
        .and_then(|l| l.first().map(|s| s.trim_end_matches(':').to_string()))
        .unwrap_or_else(|| k.to_string())
}

fn require_markdown(rel: &str) -> Result<(), CliError> {
    if vault_ops::is_markdown_rel(rel) {
        Ok(())
    } else {
        Err(CliError::fail(format!(
            "{rel} is not a markdown note; properties live in markdown frontmatter"
        )))
    }
}

pub fn property_set(ctx: &Ctx, args: &Args, _: &CommandSpec) -> Result<String, CliError> {
    let t = ctx.target(args)?;
    require_markdown(&t.rel)?;
    let name = args.require("name")?;
    let value = args.require("value")?;
    let mut hint = match args.get("type") {
        None => None,
        Some(s) => Some(ValueType::parse(s).ok_or_else(|| {
            CliError::Usage(format!(
                "unknown type \"{s}\" (text, list, number, checkbox, date, datetime)"
            ))
        })?),
    };
    if hint.is_none() {
        // Without type=, keep the type the property already has; a new
        // property is text.
        let text = vault_ops::read_text(&t.abs)?;
        if let Ok(Some(p)) = patch::read_property(&text, name) {
            hint = ValueType::from_index_type(p.vtype);
        }
    }
    vault_ops::set_property_file(&t.abs, name, &Json::String(value.to_string()), hint)?;
    Ok(format!("Set {name} in {}\n", t.rel))
}

pub fn property_read(ctx: &Ctx, args: &Args, _: &CommandSpec) -> Result<String, CliError> {
    let t = ctx.target(args)?;
    require_markdown(&t.rel)?;
    let name = args.require("name")?;
    let text = vault_ops::read_text(&t.abs)?;
    let p = patch::read_property(&text, name)
        .map_err(|e| CliError::fail(e.to_string()))?
        .ok_or_else(|| CliError::fail(format!("property not found: {name} in {}", t.rel)))?;
    Ok(match &p.value {
        Json::Array(items) => list_lines(items.iter().map(compact)),
        Json::Object(_) => format!("{}\n", p.value),
        other => format!("{}\n", cell_text(other)),
    })
}

pub fn property_remove(ctx: &Ctx, args: &Args, _: &CommandSpec) -> Result<String, CliError> {
    let t = ctx.target(args)?;
    require_markdown(&t.rel)?;
    let name = args.require("name")?;
    vault_ops::remove_property_file(&t.abs, name)?;
    Ok(format!("Removed {name} from {}\n", t.rel))
}

pub fn aliases(ctx: &Ctx, args: &Args, _: &CommandSpec) -> Result<String, CliError> {
    let target = ctx.target_opt(args)?;
    let mut list = ctx.index()?.aliases()?;
    if let Some(t) = &target {
        list.retain(|a| a.path == t.rel);
    }
    if args.flag("total") {
        return Ok(count(list.len()));
    }
    Ok(list_lines(list.into_iter().map(|a| {
        if args.flag("verbose") {
            format!("{}\t{}", a.path, a.alias)
        } else {
            a.alias
        }
    })))
}

// ---------------------------------------------------------------------------
// tags
// ---------------------------------------------------------------------------

pub fn tags(ctx: &Ctx, args: &Args, spec: &CommandSpec) -> Result<String, CliError> {
    let format = args.format(spec)?;
    if let Some(s) = args.get("sort") {
        if s != "count" {
            return Err(CliError::Usage("sort= only supports count".into()));
        }
    }
    let mut rows: Vec<(String, i64)> = match ctx.target_opt(args)? {
        Some(t) => {
            if args.flag("counts") || args.get("sort").is_some() {
                return Err(CliError::Usage(
                    "counts and sort= apply to the vault-wide list, not to one file".into(),
                ));
            }
            let meta = ctx
                .index()?
                .get_metadata(&MetaSelector::Paths(vec![t.rel.clone()]))?;
            let mut set = BTreeMap::new();
            for n in meta.notes {
                for tag in n.tags {
                    set.insert(tag.tag, 1);
                }
            }
            set.into_iter().collect()
        }
        None => ctx
            .index()?
            .tags()?
            .into_iter()
            .map(|t| (t.tag, t.count))
            .collect(),
    };
    if args.get("sort") == Some("count") {
        rows.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    }
    if args.flag("total") {
        return Ok(count(rows.len()));
    }
    let counts = args.flag("counts");
    let mut t = if counts {
        Table::new(&["tag", "count"])
    } else {
        Table::new(&["tag"])
    };
    for (tag, n) in rows {
        let mut row = vec![json!(format!("#{tag}"))];
        if counts {
            row.push(json!(n));
        }
        t.push(row);
    }
    render_table(&t, &format, false)
}

pub fn tag(ctx: &Ctx, args: &Args, _: &CommandSpec) -> Result<String, CliError> {
    let raw = args.require("name")?;
    let files = ctx.index()?.tag_files(raw)?;
    let name = format!(
        "#{}",
        raw.trim()
            .trim_start_matches('#')
            .trim_end_matches('/')
            .to_lowercase()
    );
    if args.flag("total") {
        return Ok(count(files.len()));
    }
    let mut out = format!("{name}\t{}\n", files.len());
    if args.flag("verbose") {
        out.push_str(&list_lines(files));
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// tasks
// ---------------------------------------------------------------------------

pub fn tasks(ctx: &Ctx, args: &Args, spec: &CommandSpec) -> Result<String, CliError> {
    let format = args.format(spec)?;
    let (done, todo) = (args.flag("done"), args.flag("todo"));
    if done && todo {
        return Err(CliError::Usage("use only one of done, todo".into()));
    }
    if args.get("status").is_some() && (done || todo) {
        return Err(CliError::Usage(
            "status= cannot be combined with done/todo".into(),
        ));
    }
    let target = ctx.target_opt(args)?;
    let list = ctx.index()?.tasks(&TaskFilter {
        path: target.map(|t| t.rel),
        status: args.get("status").map(str::to_string),
        done: if done {
            Some(true)
        } else if todo {
            Some(false)
        } else {
            None
        },
        ..TaskFilter::default()
    })?;
    if args.flag("total") {
        return Ok(count(list.len()));
    }
    if format == "text" {
        if args.flag("verbose") {
            let mut out = String::new();
            let mut last = "";
            for t in &list {
                if t.path != last {
                    out.push_str(&format!("{}\n", t.path));
                    last = &t.path;
                }
                out.push_str(&format!("  {}: [{}] {}\n", t.line, t.status, t.text));
            }
            return Ok(out);
        }
        return Ok(list_lines(list.iter().map(|t| {
            format!("{}:{}: [{}] {}", t.path, t.line, t.status, t.text)
        })));
    }
    let mut table = Table::new(&["path", "line", "status", "text"]);
    for t in list {
        table.push(vec![
            json!(t.path),
            json!(t.line),
            json!(t.status),
            json!(t.text),
        ]);
    }
    render_table(&table, &format, false)
}

// ---------------------------------------------------------------------------
// links
// ---------------------------------------------------------------------------

pub fn links(ctx: &Ctx, args: &Args, _: &CommandSpec) -> Result<String, CliError> {
    let t = ctx.target(args)?;
    let mut seen = std::collections::BTreeSet::new();
    let mut out = Vec::new();
    for l in ctx.index()?.links(&t.rel)? {
        let shown = l.target.unwrap_or(l.raw);
        if seen.insert(shown.clone()) {
            out.push(shown);
        }
    }
    if args.flag("total") {
        return Ok(count(out.len()));
    }
    Ok(list_lines(out))
}

pub fn backlinks(ctx: &Ctx, args: &Args, spec: &CommandSpec) -> Result<String, CliError> {
    let format = args.format(spec)?;
    let t = ctx.target(args)?;
    let mut by_source: BTreeMap<String, usize> = BTreeMap::new();
    for b in ctx.index()?.backlinks(&t.rel)? {
        *by_source.entry(b.source).or_default() += 1;
    }
    if args.flag("total") {
        return Ok(count(by_source.len()));
    }
    let counts = args.flag("counts");
    let mut table = if counts {
        Table::new(&["path", "count"])
    } else {
        Table::new(&["path"])
    };
    for (p, n) in by_source {
        let mut row = vec![json!(p)];
        if counts {
            row.push(json!(n));
        }
        table.push(row);
    }
    render_table(&table, &format, false)
}

pub fn unresolved(ctx: &Ctx, args: &Args, spec: &CommandSpec) -> Result<String, CliError> {
    let format = args.format(spec)?;
    let list = ctx.index()?.unresolved()?;
    if args.flag("total") {
        return Ok(count(list.len()));
    }
    let (counts, verbose) = (args.flag("counts"), args.flag("verbose"));
    let mut cols = vec!["link"];
    if counts {
        cols.push("count");
    }
    if verbose {
        cols.push("sources");
    }
    let mut table = Table::new(&cols);
    for u in list {
        let mut row = vec![json!(u.target)];
        if counts {
            row.push(json!(u.count));
        }
        if verbose {
            row.push(json!(u.sources));
        }
        table.push(row);
    }
    render_table(&table, &format, false)
}

pub fn orphans(ctx: &Ctx, args: &Args, _: &CommandSpec) -> Result<String, CliError> {
    let list = ctx.index()?.orphans()?;
    Ok(if args.flag("total") {
        count(list.len())
    } else {
        list_lines(list)
    })
}

pub fn deadends(ctx: &Ctx, args: &Args, _: &CommandSpec) -> Result<String, CliError> {
    let list = ctx.index()?.deadends()?;
    Ok(if args.flag("total") {
        count(list.len())
    } else {
        list_lines(list)
    })
}

// ---------------------------------------------------------------------------
// structure
// ---------------------------------------------------------------------------

pub fn outline(ctx: &Ctx, args: &Args, spec: &CommandSpec) -> Result<String, CliError> {
    let format = args.format(spec)?;
    let t = ctx.target(args)?;
    let meta = ctx
        .index()?
        .get_metadata(&MetaSelector::Paths(vec![t.rel.clone()]))?;
    let headings = meta
        .notes
        .into_iter()
        .next()
        .map(|n| n.headings)
        .ok_or_else(|| CliError::fail(format!("{} is not in the vault index", t.rel)))?;
    if args.flag("total") {
        return Ok(count(headings.len()));
    }
    let min = headings.iter().map(|h| h.level).min().unwrap_or(1);
    Ok(match format.as_str() {
        "json" => {
            let v: Vec<Json> = headings
                .iter()
                .map(|h| json!({"level": h.level, "text": h.text, "line": h.line}))
                .collect();
            format!("{}\n", json_pretty(&Json::Array(v)))
        }
        "md" => list_lines(
            headings
                .iter()
                .map(|h| format!("{} {}", "#".repeat(h.level.clamp(1, 6) as usize), h.text)),
        ),
        _ => list_lines(
            headings
                .iter()
                .map(|h| format!("{}{}", "  ".repeat((h.level - min).max(0) as usize), h.text)),
        ),
    })
}

pub fn wordcount(ctx: &Ctx, args: &Args, _: &CommandSpec) -> Result<String, CliError> {
    let t = ctx.target(args)?;
    let row = ctx
        .index()?
        .get_file(&t.rel)?
        .ok_or_else(|| CliError::fail(format!("{} is not in the vault index", t.rel)))?;
    let (Some(words), Some(chars)) = (row.words, row.chars) else {
        return Err(CliError::fail(format!("{} is not a markdown note", t.rel)));
    };
    Ok(match (args.flag("words"), args.flag("characters")) {
        (true, false) => format!("{words}\n"),
        (false, true) => format!("{chars}\n"),
        _ => format!("words\t{words}\ncharacters\t{chars}\n"),
    })
}
