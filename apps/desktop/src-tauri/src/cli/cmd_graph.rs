//! `writer graph:*`: how notes relate (SPECs/note-graph-spec.md 8.1). Handlers only shape
//! arguments and output; the data comes from `index::graph` (the one place with graph SQL).
//! Every command takes `format=text|json|tsv` (default `text`; agents use `json`).

use super::args::Args;
use super::format::{json_pretty, render, Table};
use super::registry::CommandSpec;
use super::{CliError, Ctx};
use crate::index::graph::{
    line_snippet, Direction, EdgeFilter, EdgeKind, NeighborQuery, Neighborhood,
    DEFAULT_NEIGHBOR_LIMIT, MAX_DEPTH,
};
use crate::vault_ops;
use serde_json::{json, Value as Json};

const DEFAULT_DEPTH: u32 = 2;
const DEFAULT_PATH_DEPTH: usize = 6;
const BACKLINK_LIMIT: usize = 20;
/// Largest number of edges that get a context snippet (each one reads a note).
const CONTEXT_CAP: usize = 50;
const SNIPPET_CHARS: usize = 240;

fn number(args: &Args, name: &str) -> Result<Option<usize>, CliError> {
    match args.get(name) {
        None => Ok(None),
        Some(v) => v
            .trim()
            .parse::<usize>()
            .map(Some)
            .map_err(|_| CliError::Usage(format!("{name}= must be a number"))),
    }
}

fn render_table(t: &Table, format: &str) -> Result<String, CliError> {
    render(t, format, format != "text").map_err(CliError::fail)
}

/// A note named like a wikilink or by path (`from=`, `to=`).
fn note(ctx: &Ctx, what: &str, name: &str) -> Result<String, CliError> {
    ctx.index()?
        .resolve_link("", name)?
        .ok_or_else(|| CliError::fail(format!("{what} not found: {name}")))
}

fn via_text(via: &Option<(EdgeKind, Option<String>)>) -> String {
    match via {
        None => String::new(),
        Some((k, Some(l))) => format!("{}:{l}", k.as_str()),
        Some((k, None)) => k.as_str().to_string(),
    }
}

fn kind_label(kind: EdgeKind, label: &Option<String>) -> String {
    via_text(&Some((kind, label.clone())))
}

fn parse_kinds(args: &Args) -> Result<Vec<String>, CliError> {
    let Some(raw) = args.get("kind") else {
        return Ok(Vec::new());
    };
    raw.split(',')
        .map(|k| match k.trim() {
            k @ ("link" | "embed" | "property") => Ok(k.to_string()),
            other => Err(CliError::Usage(format!(
                "kind= takes link, embed or property (comma separated), not \"{other}\""
            ))),
        })
        .collect()
}

pub fn neighbors(ctx: &Ctx, args: &Args, spec: &CommandSpec) -> Result<String, CliError> {
    let format = args.format(spec)?;
    let t = ctx.target(args)?;
    let direction = match args.get("direction") {
        None => Direction::Both,
        Some(d) => Direction::parse(d)
            .ok_or_else(|| CliError::Usage("direction= takes in, out or both".into()))?,
    };
    let depth = number(args, "depth")?.map_or(DEFAULT_DEPTH, |d| d as u32);
    if !(1..=MAX_DEPTH).contains(&depth) {
        return Err(CliError::Usage(format!("depth= takes 1 to {MAX_DEPTH}")));
    }
    let q = NeighborQuery {
        depth,
        direction,
        filter: EdgeFilter {
            kinds: parse_kinds(args)?,
            labels: args
                .get("label")
                .map(|l| vec![l.to_string()])
                .unwrap_or_default(),
        },
        limit: number(args, "limit")?.unwrap_or(DEFAULT_NEIGHBOR_LIMIT),
        ..NeighborQuery::default()
    };
    let hood = ctx.index()?.neighbors(&t.rel, &q)?;
    render_neighborhood(&hood, &format)
}

fn render_neighborhood(hood: &Neighborhood, format: &str) -> Result<String, CliError> {
    let name_of = |id: i64| {
        hood.nodes
            .iter()
            .find(|n| n.node.id == id)
            .map_or_else(String::new, |n| n.node.path.clone())
    };
    let mut nodes = Table::new(&["path", "depth", "degree_in", "degree_out", "via"]);
    for n in &hood.nodes {
        nodes.push(vec![
            json!(n.node.path),
            json!(n.depth),
            json!(n.node.degree_in),
            json!(n.node.degree_out),
            json!(via_text(&n.via)),
        ]);
    }
    let edge_row = |e: &crate::index::graph::GraphEdge| {
        (
            name_of(e.src),
            e.dst.map(name_of).unwrap_or_default(),
            kind_label(e.kind, &e.label),
        )
    };
    match format {
        "json" => {
            let v = json!({
                "center": hood.nodes.first().map(|n| n.node.path.clone()),
                "nodes": hood.nodes.iter().map(|n| json!({
                    "path": n.node.path, "depth": n.depth,
                    "degreeIn": n.node.degree_in, "degreeOut": n.node.degree_out,
                    "tags": n.node.tags,
                    "via": n.via.as_ref().map(|(k, l)| json!({"kind": k.as_str(), "label": l})),
                })).collect::<Vec<_>>(),
                "edges": hood.edges.iter().map(|e| {
                    let (source, target, _) = edge_row(e);
                    json!({"source": source, "target": target, "kind": e.kind.as_str(), "label": e.label})
                }).collect::<Vec<_>>(),
                "truncated": hood.truncated,
            });
            Ok(format!("{}\n", json_pretty(&v)))
        }
        "tsv" => render_table(&nodes, "tsv"),
        _ => {
            let mut out = render_table(&nodes, "text")?;
            if !hood.edges.is_empty() {
                out.push_str("\nedges:\n");
                let mut edges = Table::new(&["source", "target", "via"]);
                for e in &hood.edges {
                    let (s, t, v) = edge_row(e);
                    edges.push(vec![json!(format!("{s} ->")), json!(t), json!(v)]);
                }
                out.push_str(&render_table(&edges, "text")?);
            }
            if hood.truncated {
                out.push_str("\n(truncated: raise limit= or lower depth=)\n");
            }
            Ok(out)
        }
    }
}

pub fn path(ctx: &Ctx, args: &Args, spec: &CommandSpec) -> Result<String, CliError> {
    let format = args.format(spec)?;
    let from = note(ctx, "from", args.require("from")?)?;
    let to = note(ctx, "to", args.require("to")?)?;
    let max = number(args, "maxdepth")?.unwrap_or(DEFAULT_PATH_DEPTH);
    let steps = ctx
        .index()?
        .shortest_path(&from, &to, max)?
        .ok_or_else(|| CliError::fail(format!("no path within {max} hops")))?;
    let mut nodes = vec![from.clone()];
    nodes.extend(steps.iter().map(|s| s.to.clone()));
    let mut table = Table::new(&["from", "direction", "to", "via"]);
    for s in &steps {
        table.push(vec![
            json!(s.from),
            json!(s.direction),
            json!(s.to),
            json!(kind_label(s.kind, &s.label)),
        ]);
    }
    match format.as_str() {
        "json" => Ok(format!(
            "{}\n",
            json_pretty(&json!({
                "nodes": nodes,
                "steps": steps.iter().map(|s| json!({
                    "from": s.from, "to": s.to, "direction": s.direction,
                    "kind": s.kind.as_str(), "label": s.label,
                })).collect::<Vec<_>>(),
            }))
        )),
        "tsv" => render_table(&table, "tsv"),
        _ => {
            let mut out = format!("{from}\n");
            for s in &steps {
                let arrow = if s.direction == "out" { "->" } else { "<-" };
                out.push_str(&format!(
                    "  {arrow} [{}] {}\n",
                    kind_label(s.kind, &s.label),
                    s.to
                ));
            }
            Ok(out)
        }
    }
}

pub fn relationships(ctx: &Ctx, args: &Args, spec: &CommandSpec) -> Result<String, CliError> {
    let format = args.format(spec)?;
    let target = ctx.target_opt(args)?;
    let label = args.get("label");
    let index = ctx.index()?;
    if target.is_none() && label.is_none() {
        let mut t = Table::new(&["label", "edges", "notes"]);
        for l in index.relationship_labels()? {
            t.push(vec![json!(l.label), json!(l.edges), json!(l.notes)]);
        }
        return render_table(&t, &format);
    }
    let mut t = Table::new(&["source", "label", "target", "resolved", "line"]);
    for r in index.relationships(target.as_ref().map(|t| t.rel.as_str()), label)? {
        t.push(vec![
            json!(r.source),
            json!(r.label),
            json!(r.target),
            json!(r.resolved),
            json!(r.line),
        ]);
    }
    render_table(&t, &format)
}

pub fn backlinks(ctx: &Ctx, args: &Args, spec: &CommandSpec) -> Result<String, CliError> {
    let format = args.format(spec)?;
    let t = ctx.target(args)?;
    let context = args.flag("context");
    let mut limit = number(args, "limit")?.unwrap_or(BACKLINK_LIMIT);
    if context {
        limit = limit.min(CONTEXT_CAP);
    }
    let rows = ctx.index()?.backlink_details(&t.rel, limit)?;
    let mut cols = vec!["source", "kind", "label", "line", "section"];
    if context {
        cols.push("context");
    }
    let mut table = Table::new(&cols);
    for b in rows {
        let mut row = vec![
            json!(b.source),
            json!(b.kind.as_str()),
            json!(b.label),
            json!(b.line),
            json!(b.section),
        ];
        if context {
            // Read through the confined path; a note that moved or changed is skipped.
            let snippet = b.line.and_then(|line| {
                let c = ctx.confine(&b.source).ok()?;
                let text = vault_ops::read_text(&c.abs).ok()?;
                line_snippet(&text, line, &b.target, SNIPPET_CHARS)
            });
            row.push(json!(snippet));
        }
        table.push(row);
    }
    render_table(&table, &format)
}

pub fn related(ctx: &Ctx, args: &Args, spec: &CommandSpec) -> Result<String, CliError> {
    let format = args.format(spec)?;
    let t = ctx.target(args)?;
    let limit = number(args, "limit")?.unwrap_or(10);
    let mut table = Table::new(&["path", "score", "shared", "via"]);
    for r in ctx.index()?.related(&t.rel, limit)? {
        table.push(vec![
            json!(r.path),
            json!((r.score * 1000.0).round() / 1000.0),
            json!(r.shared),
            json!(r.via),
        ]);
    }
    render_table(&table, &format)
}

pub fn hubs(ctx: &Ctx, args: &Args, spec: &CommandSpec) -> Result<String, CliError> {
    let format = args.format(spec)?;
    let mut table = Table::new(&["path", "degree", "in", "out"]);
    for h in ctx.index()?.hubs(number(args, "limit")?.unwrap_or(20))? {
        table.push(vec![
            json!(h.path),
            json!(h.degree_in + h.degree_out),
            json!(h.degree_in),
            json!(h.degree_out),
        ]);
    }
    render_table(&table, &format)
}

pub fn components(ctx: &Ctx, args: &Args, spec: &CommandSpec) -> Result<String, CliError> {
    let format = args.format(spec)?;
    let mut table = Table::new(&["size", "example"]);
    for c in ctx
        .index()?
        .components(number(args, "limit")?.unwrap_or(20))?
    {
        table.push(vec![json!(c.size), json!(c.example)]);
    }
    render_table(&table, &format)
}

/// Notes with no link in or out. (`orphans` keeps Obsidian's meaning, no incoming link.)
pub fn orphans(ctx: &Ctx, args: &Args, spec: &CommandSpec) -> Result<String, CliError> {
    let format = args.format(spec)?;
    let mut table = Table::new(&["path"]);
    let list = ctx.index()?.isolated_notes()?;
    let limit = number(args, "limit")?.unwrap_or(usize::MAX);
    for p in list.into_iter().take(limit) {
        table.push(vec![Json::String(p)]);
    }
    render_table(&table, &format)
}
