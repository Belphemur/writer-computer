//! Query executor: a [`Document`], a view name and a [`RowSource`] in, a
//! plain-data [`BaseQueryResult`] out (filters, formulas, sort, groupBy,
//! limit, summaries). The result serializes with serde for the Tauri command
//! and for the CLI formatters (json/csv/tsv/md/paths).
//!
//! Pipeline: effective filter = global AND view -> pushdown hint -> candidate
//! rows from the source -> **every** candidate verified against the full
//! filter (correctness never depends on the source honouring the hint) ->
//! sort keys and group keys -> stable sort -> group -> limit -> cells for the
//! kept rows -> summaries. Semantics for the gaps in the docs: U2, U7, U8 in
//! [`super::choices`].

use super::ast::{BinaryOp, Expr, PropertyId};
use super::choices::{self, FilterErrorPolicy};
use super::context::{Clock, FileMeta, RowContext};
use super::document::{Direction, Document, Filter, Node, View};
use super::interp::{FormulaSet, Interp, Scope};
use super::lexer::ParseError;
use super::parser;
use super::value::{compare_for_sort, ErrorKind, ErrorValue, Value};
use serde::ser::{Serialize, SerializeMap, Serializer};
use std::cmp::Ordering;
use std::collections::HashMap;
use std::rc::Rc;

// ---------------------------------------------------------------------------
// Data source seam
// ---------------------------------------------------------------------------

/// Narrowing hint derived from the top-level AND conjuncts of the filters. A
/// source may use it to return fewer candidates (SQL pushdown) but must return
/// a **superset** of the matching rows; the engine re-checks everything.
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushdownHint {
    /// `file.inFolder("x")`: every listed folder must contain the file.
    pub folders: Vec<String>,
    /// `file.ext == "md"` (without the dot).
    pub ext: Option<String>,
    /// Each entry is one `file.hasTag(a, b, ...)` conjunct (any-of inside,
    /// all conjuncts must hold).
    pub tags_any: Vec<Vec<String>>,
    /// `property <op> literal` on note properties.
    pub comparisons: Vec<Comparison>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
pub enum CompareOp {
    Eq,
    Ne,
    Lt,
    Gt,
    Le,
    Ge,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct Comparison {
    /// Note property name.
    pub property: String,
    pub op: CompareOp,
    pub value: Value,
}

/// Where rows come from: the vault index in the app and the CLI, an in-memory
/// list in tests.
pub trait RowSource {
    /// Candidate rows, in a stable order (path order recommended: without a
    /// `sort` the result keeps this order).
    fn candidates(&self, hint: &PushdownHint) -> Result<Vec<Rc<dyn RowContext>>, String>;

    /// The `this` row (base file, embedding note or active file; U15).
    fn this_row(&self) -> Option<Rc<dyn RowContext>> {
        None
    }
}

#[derive(Clone, Copy, Debug)]
pub struct QueryOptions {
    /// What a filter evaluation error does (U4, spec 7.5).
    pub filter_errors: FilterErrorPolicy,
}

impl Default for QueryOptions {
    fn default() -> Self {
        QueryOptions {
            filter_errors: choices::FILTER_ERROR_POLICY,
        }
    }
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/// A value plus its display string, so consumers never re-implement display.
#[derive(Clone, Debug, PartialEq)]
pub struct Cell {
    pub value: Value,
    pub display: String,
}

impl Cell {
    pub fn new(value: Value) -> Cell {
        let display = value.display();
        Cell { value, display }
    }
}

impl Serialize for Cell {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let j = self.value.to_json();
        let mut m = s.serialize_map(None)?;
        if let serde_json::Value::Object(o) = &j {
            for (k, v) in o {
                m.serialize_entry(k, v)?;
            }
        }
        m.serialize_entry("display", &self.display)?;
        m.end()
    }
}

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewInfo {
    pub name: String,
    #[serde(rename = "type")]
    pub view_type: String,
    /// Index in `views`, `None` for the implicit view of a base without views.
    pub index: Option<usize>,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Column {
    /// Property id as written in `order`.
    pub id: String,
    /// Canonical key (`PropertyId::key`).
    pub key: String,
    pub display_name: String,
    /// Summary configured for this column.
    pub summary: Option<String>,
    /// Pixel width from the view's `columnSize`, matched on the canonical key.
    pub width: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct Row {
    /// Vault-relative path of the file.
    pub path: String,
    /// One cell per column.
    pub cells: Vec<Cell>,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct Group {
    pub key: Cell,
    /// Range of this group in the flat `rows`.
    pub start: usize,
    pub len: usize,
    /// Per column, `None` where no summary is configured.
    pub summaries: Vec<Option<Cell>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum QueryErrorKind {
    ViewNotFound,
    FilterSyntax,
    FilterEval,
    Source,
    /// The `.base` text itself does not parse.
    Document,
}

/// The explicit error state of a view (spec 7.5): shown instead of rows.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryError {
    pub kind: QueryErrorKind,
    pub message: String,
    /// The offending filter expression.
    pub expression: Option<String>,
    /// The row on which evaluation failed.
    pub path: Option<String>,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BaseQueryResult {
    pub view: ViewInfo,
    /// Names of every view of the base, in file order (view switcher).
    pub available_views: Vec<String>,
    pub columns: Vec<Column>,
    /// Flat rows in final order (group order when grouped, limit applied).
    pub rows: Vec<Row>,
    pub groups: Option<Vec<Group>>,
    /// Summaries over all shown rows, aligned with `columns`.
    pub summaries: Vec<Option<Cell>>,
    /// Rows that passed the filters, before `limit`.
    pub total_matched: usize,
    pub error: Option<QueryError>,
    pub warnings: Vec<String>,
}

impl BaseQueryResult {
    /// The explicit error state for a `.base` text that does not parse.
    pub fn document_error(message: String) -> BaseQueryResult {
        BaseQueryResult {
            view: ViewInfo {
                name: String::new(),
                view_type: String::new(),
                index: None,
            },
            available_views: Vec::new(),
            columns: Vec::new(),
            rows: Vec::new(),
            groups: None,
            summaries: Vec::new(),
            total_matched: 0,
            error: Some(QueryError {
                kind: QueryErrorKind::Document,
                message,
                expression: None,
                path: None,
            }),
            warnings: Vec::new(),
        }
    }
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

enum Compiled {
    Expr(String, Expr),
    And(Vec<Compiled>),
    Or(Vec<Compiled>),
    Not(Vec<Compiled>),
}

fn compile_filter(f: &Filter) -> Result<Compiled, (String, ParseError)> {
    Ok(match f {
        Filter::Expr(src) => Compiled::Expr(
            src.clone(),
            parser::parse(src).map_err(|e| (src.clone(), e))?,
        ),
        Filter::And(v) => Compiled::And(v.iter().map(compile_filter).collect::<Result<_, _>>()?),
        Filter::Or(v) => Compiled::Or(v.iter().map(compile_filter).collect::<Result<_, _>>()?),
        Filter::Not(v) => Compiled::Not(v.iter().map(compile_filter).collect::<Result<_, _>>()?),
    })
}

/// A filter evaluation failure: the expression and the error value.
struct FilterFailure {
    expression: String,
    error: ErrorValue,
}

fn eval_filter(c: &Compiled, it: &Interp) -> Result<bool, FilterFailure> {
    match c {
        Compiled::Expr(src, ast) => match it.eval(ast, &Scope::root()) {
            Value::Error(e) => Err(FilterFailure {
                expression: src.clone(),
                error: e,
            }),
            v => Ok(v.truthy()),
        },
        Compiled::And(v) => {
            for x in v {
                if !eval_filter(x, it)? {
                    return Ok(false);
                }
            }
            Ok(true)
        }
        Compiled::Or(v) => {
            for x in v {
                if eval_filter(x, it)? {
                    return Ok(true);
                }
            }
            Ok(false)
        }
        Compiled::Not(v) => {
            for x in v {
                if eval_filter(x, it)? {
                    return Ok(false);
                }
            }
            Ok(true)
        }
    }
}

// ---------------------------------------------------------------------------
// Pushdown extraction
// ---------------------------------------------------------------------------

fn conjuncts<'a>(f: &'a Filter, out: &mut Vec<&'a str>) {
    match f {
        Filter::Expr(s) => out.push(s),
        Filter::And(v) => v.iter().for_each(|x| conjuncts(x, out)),
        // or / not: nothing can be pushed down safely
        Filter::Or(_) | Filter::Not(_) => {}
    }
}

fn property_name(e: &Expr) -> Option<String> {
    match e {
        Expr::Ident(n) if !matches!(n.as_str(), "file" | "note" | "formula" | "this") => {
            Some(n.clone())
        }
        Expr::Member(o, n) if matches!(&**o, Expr::Ident(ns) if ns == "note") => Some(n.clone()),
        Expr::Index(o, i) => match (&**o, &**i) {
            (Expr::Ident(ns), Expr::Str(k)) if ns == "note" => Some(k.clone()),
            _ => None,
        },
        _ => None,
    }
}

fn literal(e: &Expr) -> Option<Value> {
    match e {
        Expr::Number(n) => Some(Value::Number(*n)),
        Expr::Str(s) => Some(Value::String(s.clone())),
        Expr::Bool(b) => Some(Value::Bool(*b)),
        Expr::Null => Some(Value::Null),
        _ => None,
    }
}

fn is_file_member(e: &Expr, name: &str) -> bool {
    matches!(e, Expr::Member(o, n) if n == name && matches!(&**o, Expr::Ident(ns) if ns == "file"))
}

fn flip(op: CompareOp) -> CompareOp {
    match op {
        CompareOp::Lt => CompareOp::Gt,
        CompareOp::Gt => CompareOp::Lt,
        CompareOp::Le => CompareOp::Ge,
        CompareOp::Ge => CompareOp::Le,
        o => o,
    }
}

fn compare_op(op: BinaryOp) -> Option<CompareOp> {
    Some(match op {
        BinaryOp::Eq => CompareOp::Eq,
        BinaryOp::Ne => CompareOp::Ne,
        BinaryOp::Lt => CompareOp::Lt,
        BinaryOp::Gt => CompareOp::Gt,
        BinaryOp::Le => CompareOp::Le,
        BinaryOp::Ge => CompareOp::Ge,
        _ => return None,
    })
}

/// Hint from the AND-conjuncts of the effective filters. Anything not
/// recognised is simply left for the verification pass.
pub fn pushdown_hint(filters: &[&Filter]) -> PushdownHint {
    let mut srcs = Vec::new();
    for f in filters {
        conjuncts(f, &mut srcs);
    }
    let mut hint = PushdownHint::default();
    for src in srcs {
        let Ok(ast) = parser::parse(src) else {
            continue;
        };
        match &ast {
            Expr::Call(callee, args) => {
                if let Expr::Member(recv, m) = &**callee {
                    let on_file = matches!(&**recv, Expr::Ident(n) if n == "file");
                    if on_file && m == "inFolder" {
                        if let [Expr::Str(f)] = args.as_slice() {
                            hint.folders.push(f.trim().trim_matches('/').to_string());
                        }
                    } else if on_file && m == "hasTag" {
                        let tags: Vec<String> = args
                            .iter()
                            .filter_map(|a| match a {
                                Expr::Str(s) => Some(s.clone()),
                                _ => None,
                            })
                            .collect();
                        if tags.len() == args.len() && !tags.is_empty() {
                            hint.tags_any.push(tags);
                        }
                    }
                }
            }
            Expr::Binary(op, l, r) => {
                let Some(cop) = compare_op(*op) else { continue };
                if cop == CompareOp::Eq {
                    if let (true, Expr::Str(s)) = (is_file_member(l, "ext"), &**r) {
                        hint.ext = Some(s.clone());
                        continue;
                    }
                    if let (true, Expr::Str(s)) = (is_file_member(r, "ext"), &**l) {
                        hint.ext = Some(s.clone());
                        continue;
                    }
                }
                if let (Some(p), Some(v)) = (property_name(l), literal(r)) {
                    hint.comparisons.push(Comparison {
                        property: p,
                        op: cop,
                        value: v,
                    });
                } else if let (Some(v), Some(p)) = (literal(l), property_name(r)) {
                    hint.comparisons.push(Comparison {
                        property: p,
                        op: flip(cop),
                        value: v,
                    });
                }
            }
            _ => {}
        }
    }
    hint
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/// A row with no data, the receiver of custom summaries (`values`).
struct NullRow;

impl RowContext for NullRow {
    fn path(&self) -> String {
        String::new()
    }
    fn meta(&self) -> FileMeta {
        FileMeta::default()
    }
    fn properties(&self) -> Vec<(String, Value)> {
        Vec::new()
    }
    fn tags(&self) -> Vec<String> {
        Vec::new()
    }
    fn links(&self) -> Vec<super::value::LinkValue> {
        Vec::new()
    }
    fn embeds(&self) -> Vec<super::value::LinkValue> {
        Vec::new()
    }
    fn backlinks(&self) -> Vec<String> {
        Vec::new()
    }
    fn resolve_link(&self, _: &str) -> Option<String> {
        None
    }
    fn context_for_path(&self, _: &str) -> Option<Rc<dyn RowContext>> {
        None
    }
}

struct Matched<'a> {
    interp: Interp<'a>,
    path: String,
    sort: Vec<Value>,
    group: Value,
}

/// Run one view of `doc`. `view_name` `None` selects the first view (or the
/// implicit table when the base has none).
pub fn run_view(
    doc: &Document,
    view_name: Option<&str>,
    source: &dyn RowSource,
    clock: &dyn Clock,
    opts: &QueryOptions,
) -> BaseQueryResult {
    let implicit;
    let (view, index) = match (doc.view(view_name), view_name) {
        (Some(v), _) => (v, doc.views.iter().position(|x| std::ptr::eq(x, v))),
        (None, None) if doc.views.is_empty() => {
            implicit = View::default_table();
            (&implicit, None)
        }
        (None, _) => {
            let wanted = view_name.unwrap_or("");
            return BaseQueryResult {
                view: ViewInfo {
                    name: wanted.to_string(),
                    view_type: String::new(),
                    index: None,
                },
                available_views: doc.views.iter().map(|v| v.name.clone()).collect(),
                columns: Vec::new(),
                rows: Vec::new(),
                groups: None,
                summaries: Vec::new(),
                total_matched: 0,
                error: Some(QueryError {
                    kind: QueryErrorKind::ViewNotFound,
                    message: format!("no view named \"{wanted}\""),
                    expression: None,
                    path: None,
                }),
                warnings: Vec::new(),
            };
        }
    };
    execute(doc, view, index, source, clock, opts)
}

fn default_title(id: &PropertyId) -> String {
    id.key()
}

fn columns_of(doc: &Document, view: &View) -> Vec<(Column, PropertyId)> {
    let ids: Vec<String> = match &view.order {
        Some(o) => o.clone(),
        None => vec!["file.name".to_string()],
    };
    ids.into_iter()
        .map(|id| {
            let pid = PropertyId::parse(&id);
            let key = pid.key();
            let display_name = doc
                .property_config(&key)
                .and_then(|c| c.display_name.clone())
                .unwrap_or_else(|| default_title(&pid));
            let summary = view
                .summaries
                .iter()
                .find(|(k, _)| PropertyId::parse(k).key() == key)
                .map(|(_, s)| s.clone());
            let width = view
                .column_size
                .iter()
                .find(|(k, _)| PropertyId::parse(k).key() == key)
                .and_then(|(_, n)| match n {
                    Node::Int(i) => Some(*i as f64),
                    Node::Real(f) => Some(*f),
                    _ => None,
                });
            (
                Column {
                    id,
                    key,
                    display_name,
                    summary,
                    width,
                },
                pid,
            )
        })
        .collect()
}

fn execute(
    doc: &Document,
    view: &View,
    index: Option<usize>,
    source: &dyn RowSource,
    clock: &dyn Clock,
    opts: &QueryOptions,
) -> BaseQueryResult {
    let cols = columns_of(doc, view);
    let mut result = BaseQueryResult {
        view: ViewInfo {
            name: view.name.clone(),
            view_type: view.view_type.clone(),
            index,
        },
        available_views: doc.views.iter().map(|v| v.name.clone()).collect(),
        columns: cols.iter().map(|(c, _)| c.clone()).collect(),
        rows: Vec::new(),
        groups: None,
        summaries: Vec::new(),
        total_matched: 0,
        error: None,
        warnings: doc.warnings.clone(),
    };
    let fail = |mut r: BaseQueryResult,
                kind,
                message: String,
                expr: Option<String>,
                path: Option<String>| {
        r.error = Some(QueryError {
            kind,
            message,
            expression: expr,
            path,
        });
        r
    };

    // 1. filters
    let filters: Vec<&Filter> = doc.filters.iter().chain(view.filters.iter()).collect();
    let mut compiled = Vec::new();
    for f in &filters {
        match compile_filter(f) {
            Ok(c) => compiled.push(c),
            Err((src, pe)) => {
                let (line, col) = pe.line_col(&src);
                return fail(
                    result,
                    QueryErrorKind::FilterSyntax,
                    format!("{} (line {line}, column {col})", pe.message),
                    Some(src),
                    None,
                );
            }
        }
    }
    let formulas = FormulaSet::compile(&doc.formulas);
    let this = source.this_row();

    // 2. candidates, verified
    let hint = pushdown_hint(&filters);
    let candidates = match source.candidates(&hint) {
        Ok(c) => c,
        Err(msg) => return fail(result, QueryErrorKind::Source, msg, None, None),
    };

    let sort_ids: Vec<PropertyId> = view
        .sort
        .iter()
        .map(|s| PropertyId::parse(&s.property))
        .collect();
    let group_id = view
        .group_by
        .as_ref()
        .map(|g| PropertyId::parse(&g.property));

    let mut matched: Vec<Matched> = Vec::new();
    'rows: for row in candidates {
        let interp = Interp::new(clock, &formulas, row.clone(), this.clone());
        for c in &compiled {
            match eval_filter(c, &interp) {
                Ok(true) => {}
                Ok(false) => continue 'rows,
                Err(f) => match opts.filter_errors {
                    FilterErrorPolicy::RowFails => continue 'rows,
                    FilterErrorPolicy::ErrorState => {
                        return fail(
                            result,
                            QueryErrorKind::FilterEval,
                            f.error.message,
                            Some(f.expression),
                            Some(row.path()),
                        )
                    }
                },
            }
        }
        let sort = sort_ids.iter().map(|id| interp.eval_property(id)).collect();
        let group = group_id
            .as_ref()
            .map(|id| interp.eval_property(id))
            .unwrap_or(Value::Null);
        matched.push(Matched {
            interp,
            path: row.path(),
            sort,
            group,
        });
    }
    result.total_matched = matched.len();

    // 3. stable multi-key sort
    if !view.sort.is_empty() {
        matched.sort_by(|a, b| {
            for (i, key) in view.sort.iter().enumerate() {
                let mut o = compare_for_sort(&a.sort[i], &b.sort[i]);
                if key.direction == Direction::Desc {
                    o = o.reverse();
                }
                if o != Ordering::Equal {
                    return o;
                }
            }
            Ordering::Equal
        });
    }

    // 4. group, 5. limit
    let mut order: Vec<usize> = (0..matched.len()).collect();
    let mut group_spans: Vec<(Value, usize, usize)> = Vec::new(); // key, start, len
    if let Some(g) = &view.group_by {
        let mut buckets: Vec<(Value, Vec<usize>)> = Vec::new();
        let mut index_of: HashMap<String, usize> = HashMap::new();
        for (i, m) in matched.iter().enumerate() {
            let k = group_key_string(&m.group);
            match index_of.get(&k) {
                Some(&b) => buckets[b].1.push(i),
                None => {
                    index_of.insert(k, buckets.len());
                    buckets.push((m.group.clone(), vec![i]));
                }
            }
        }
        buckets = order_groups(buckets, g.direction, view.group_order.as_deref());
        order.clear();
        for (key, idxs) in buckets {
            let start = order.len();
            order.extend(idxs.iter().copied());
            group_spans.push((key, start, idxs.len()));
        }
    }
    if let Some(limit) = view.limit {
        let limit = limit.min(usize::MAX as u64) as usize;
        order.truncate(limit);
        for g in group_spans.iter_mut() {
            let end = (g.1 + g.2).min(limit);
            g.2 = end.saturating_sub(g.1.min(limit));
        }
        group_spans.retain(|g| g.2 > 0);
    }

    // 6. cells for the kept rows
    let mut col_values: Vec<Vec<Value>> = vec![Vec::with_capacity(order.len()); cols.len()];
    for &i in &order {
        let m = &matched[i];
        let mut cells = Vec::with_capacity(cols.len());
        for (ci, (_, pid)) in cols.iter().enumerate() {
            let v = m.interp.eval_property(pid);
            col_values[ci].push(v.clone());
            cells.push(Cell::new(v));
        }
        result.rows.push(Row {
            path: m.path.clone(),
            cells,
        });
    }

    // 7. summaries
    let customs = CustomSummaries::compile(&doc.summaries);
    let summarize_range = |start: usize, len: usize| -> Vec<Option<Cell>> {
        cols.iter()
            .enumerate()
            .map(|(ci, (c, _))| {
                c.summary.as_ref().map(|name| {
                    Cell::new(summarize(
                        name,
                        &col_values[ci][start..start + len],
                        &customs,
                        clock,
                    ))
                })
            })
            .collect()
    };
    result.summaries = summarize_range(0, order.len());
    if view.group_by.is_some() {
        result.groups = Some(
            group_spans
                .into_iter()
                .map(|(key, start, len)| Group {
                    key: Cell::new(key),
                    start,
                    len,
                    summaries: summarize_range(start, len),
                })
                .collect(),
        );
    }
    result
}

/// Canonical string such that equal values (per `Value::equals`) share a key.
fn group_key_string(v: &Value) -> String {
    match v {
        Value::Null | Value::Error(_) => "n".into(),
        Value::Bool(b) => format!("b{b}"),
        Value::Number(n) => format!("#{n:?}"),
        Value::String(s) => format!("s{s}"),
        Value::Html(s) => format!("h{s}"),
        Value::Image(s) => format!("i{s}"),
        Value::Icon(s) => format!("c{s}"),
        Value::Date(d) => format!("d{}", d.ms),
        Value::Duration(d) => format!("u{}:{}", d.months, d.millis),
        Value::Link(l) => match &l.resolved {
            Some(p) => format!("p{p}"),
            None => format!("t{}", l.target.to_lowercase()),
        },
        Value::File(f) => format!("p{}", f.path),
        Value::Regexp(r) => format!("r{}/{}", r.source, r.flags),
        Value::List(l) => format!(
            "[{}]",
            l.iter()
                .map(group_key_string)
                .collect::<Vec<_>>()
                .join("\u{1}")
        ),
        Value::Object(o) => {
            let mut parts: Vec<String> = o
                .iter()
                .map(|(k, v)| format!("{k}={}", group_key_string(v)))
                .collect();
            parts.sort();
            format!("{{{}}}", parts.join("\u{1}"))
        }
    }
}

/// U8: manual `groupOrder` entries first, the rest in key order.
fn order_groups(
    mut buckets: Vec<(Value, Vec<usize>)>,
    dir: Direction,
    manual: Option<&[Node]>,
) -> Vec<(Value, Vec<usize>)> {
    let mut out = Vec::new();
    if let Some(manual) = manual {
        for entry in manual {
            let want = node_to_value(entry);
            if let Some(i) = buckets.iter().position(|(k, _)| k.equals(&want)) {
                out.push(buckets.remove(i));
            }
        }
    }
    buckets.sort_by(|a, b| {
        let o = compare_for_sort(&a.0, &b.0);
        if dir == Direction::Desc {
            o.reverse()
        } else {
            o
        }
    });
    out.extend(buckets);
    out
}

fn node_to_value(n: &Node) -> Value {
    match n {
        Node::Null => Value::Null,
        Node::Bool(b) => Value::Bool(*b),
        Node::Int(i) => Value::Number(*i as f64),
        Node::Real(f) => Value::Number(*f),
        Node::Str(s) => Value::String(s.clone()),
        Node::Seq(v) => Value::List(v.iter().map(node_to_value).collect()),
        Node::Map(m) => Value::Object(
            m.iter()
                .map(|(k, v)| (k.clone(), node_to_value(v)))
                .collect(),
        ),
    }
}

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

/// Built-in summary names (Obsidian's documented list plus `Count`, U2).
pub const BUILTIN_SUMMARIES: &[&str] = &[
    "Count",
    "Sum",
    "Average",
    "Min",
    "Max",
    "Range",
    "Median",
    "Stddev",
    "Earliest",
    "Latest",
    "Checked",
    "Unchecked",
    "Empty",
    "Filled",
    "Unique",
];

struct CustomSummaries {
    defs: Vec<(String, Result<Expr, ParseError>)>,
}

impl CustomSummaries {
    fn compile(pairs: &[(String, String)]) -> CustomSummaries {
        CustomSummaries {
            defs: pairs
                .iter()
                .map(|(n, s)| (n.clone(), parser::parse(s)))
                .collect(),
        }
    }
}

fn canonical_builtin(name: &str) -> Option<&'static str> {
    BUILTIN_SUMMARIES
        .iter()
        .find(|b| **b == name)
        .or_else(|| {
            BUILTIN_SUMMARIES
                .iter()
                .find(|b| b.eq_ignore_ascii_case(name))
        })
        .copied()
}

fn numbers_of(values: &[Value]) -> Vec<f64> {
    values
        .iter()
        .filter_map(|v| match v {
            Value::Number(n) => Some(*n),
            _ => None,
        })
        .collect()
}

fn dates_of(values: &[Value]) -> Vec<super::value::DateValue> {
    values
        .iter()
        .filter_map(|v| match v {
            Value::Date(d) => Some(*d),
            _ => None,
        })
        .collect()
}

/// Compute summary `name` over a column's values.
pub fn summarize_builtin(name: &str, values: &[Value]) -> Option<Value> {
    let name = canonical_builtin(name)?;
    let nums = numbers_of(values);
    let num = |f: fn(&[f64]) -> f64| -> Value {
        if nums.is_empty() {
            Value::Null
        } else {
            Value::Number(f(&nums))
        }
    };
    Some(match name {
        "Count" => Value::Number(values.len() as f64),
        "Sum" => Value::Number(nums.iter().sum()),
        "Average" => num(|n| n.iter().sum::<f64>() / n.len() as f64),
        "Min" => num(|n| n.iter().copied().fold(f64::INFINITY, f64::min)),
        "Max" => num(|n| n.iter().copied().fold(f64::NEG_INFINITY, f64::max)),
        "Median" => num(|n| {
            let mut s = n.to_vec();
            s.sort_by(|a, b| a.partial_cmp(b).unwrap_or(Ordering::Equal));
            if s.len() % 2 == 1 {
                s[s.len() / 2]
            } else {
                (s[s.len() / 2 - 1] + s[s.len() / 2]) / 2.0
            }
        }),
        "Stddev" => num(|n| {
            let mean = n.iter().sum::<f64>() / n.len() as f64;
            (n.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / n.len() as f64).sqrt()
        }),
        "Range" => {
            if !nums.is_empty() {
                let min = nums.iter().copied().fold(f64::INFINITY, f64::min);
                let max = nums.iter().copied().fold(f64::NEG_INFINITY, f64::max);
                Value::Number(max - min)
            } else {
                let d = dates_of(values);
                match (d.iter().map(|x| x.ms).min(), d.iter().map(|x| x.ms).max()) {
                    (Some(a), Some(b)) => Value::Duration(
                        super::datetime::DurationValue::from_millis(b.saturating_sub(a)),
                    ),
                    _ => Value::Null,
                }
            }
        }
        "Earliest" | "Latest" => {
            let d = dates_of(values);
            let pick = if name == "Earliest" {
                d.iter().min_by_key(|x| x.ms)
            } else {
                d.iter().max_by_key(|x| x.ms)
            };
            pick.map(|x| Value::Date(*x)).unwrap_or(Value::Null)
        }
        "Checked" => Value::Number(
            values
                .iter()
                .filter(|v| matches!(v, Value::Bool(true)))
                .count() as f64,
        ),
        "Unchecked" => Value::Number(
            values
                .iter()
                .filter(|v| matches!(v, Value::Bool(false)))
                .count() as f64,
        ),
        "Empty" => Value::Number(values.iter().filter(|v| v.is_empty()).count() as f64),
        "Filled" => Value::Number(values.iter().filter(|v| !v.is_empty()).count() as f64),
        "Unique" => {
            let mut seen: Vec<String> = Vec::new();
            for v in values.iter().filter(|v| !v.is_empty()) {
                let k = group_key_string(v);
                if !seen.contains(&k) {
                    seen.push(k);
                }
            }
            Value::Number(seen.len() as f64)
        }
        _ => return None,
    })
}

fn summarize(name: &str, values: &[Value], customs: &CustomSummaries, clock: &dyn Clock) -> Value {
    if let Some(v) = summarize_builtin(name, values) {
        return v;
    }
    let Some((_, def)) = customs.defs.iter().find(|(n, _)| n == name) else {
        return Value::err(
            ErrorKind::UnknownFormula,
            format!("unknown summary \"{name}\""),
        );
    };
    let expr = match def {
        Ok(e) => e,
        Err(pe) => return super::interp::syntax_value(pe),
    };
    let formulas = FormulaSet::default();
    let interp = Interp::new(clock, &formulas, Rc::new(NullRow), None);
    let sc = Scope::root();
    let sc = sc.child(vec![("values", Value::List(values.to_vec()))]);
    interp.eval(expr, &sc)
}
