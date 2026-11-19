//! The Bases engine's [`RowSource`] / [`RowContext`] over the vault index.
//!
//! Lives in `index/` (the engine in `bases/` stays free of the index); no
//! `tauri::` types. Every file in the index is a row (U17: attachments and
//! `.base` files included, hidden folders such as `.obsidian` are not indexed).
//!
//! * [`PushdownHint`] becomes SQL over `files`/`props`/`tags` using the typed
//!   shadow columns. It is only ever a narrowing: the engine re-verifies every
//!   candidate with the interpreter, so a hint the SQL cannot express exactly
//!   (`!=`, null, string ordering, tags that do not normalise) is dropped, never
//!   approximated. A differential test asserts pushdown == full scan.
//! * Row data is loaded lazily and cached per row; backlinks and the path index
//!   come from per-epoch caches on [`Index`].
//! * Errors inside lazy lookups cannot cross the `RowContext` trait, so they are
//!   parked in the source and surfaced by [`run_base_view`] (no silent fallback).

use super::markdown::{normalize_tag, LinkKind};
use super::{edges, Index, IndexError};
use crate::bases::context::{Clock, FileMeta, RowContext, SystemClock};
use crate::bases::datetime;
use crate::bases::document::{Document, RowKind};
use crate::bases::interp::{FormulaSet, Interp};
use crate::bases::query::{
    run_view, BaseQueryResult, Cell as QueryCell, CompareOp, Comparison, PushdownHint,
    QueryOptions, RowSource,
};
use crate::bases::value::{LinkValue, Value};
use crate::tasks::date::Day;
use crate::tasks::grammar::{Priority, TaskFields};
use crate::tasks::status::StatusTable;
use crate::tasks::urgency;
use rusqlite::{params_from_iter, types::Value as SqlValue};
use serde_json::{Map, Value as Json};
use std::cell::{Cell, OnceCell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;

type Res<T> = Result<T, IndexError>;

struct Env {
    index: Arc<Index>,
    offset: i32,
    /// "Today" for `task.urgency`: the clock's local day.
    today: Cell<Day>,
    /// The vault's task statuses (custom ones included), read on first use.
    statuses: OnceCell<StatusTable>,
    rows: RefCell<HashMap<String, Option<Rc<IndexRow>>>>,
    error: RefCell<Option<String>>,
}

impl Env {
    fn fail(&self, e: IndexError) {
        let mut slot = self.error.borrow_mut();
        if slot.is_none() {
            *slot = Some(e.to_string());
        }
    }

    fn row_by_path(self: &Rc<Env>, path: &str) -> Option<Rc<IndexRow>> {
        if let Some(r) = self.rows.borrow().get(path) {
            return r.clone();
        }
        let found = self.index.read(|c| {
            use rusqlite::OptionalExtension;
            Ok(c.query_row(
                "SELECT id, path, size, ctime, mtime FROM files WHERE path = ?1",
                [path],
                |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, i64>(2)?,
                        r.get::<_, i64>(3)?,
                        r.get::<_, i64>(4)?,
                    ))
                },
            )
            .optional()?)
        });
        let row = match found {
            Ok(v) => v.map(|(id, p, size, ctime, mtime)| self.make_row(id, p, size, ctime, mtime)),
            Err(e) => {
                self.fail(e);
                None
            }
        };
        self.rows.borrow_mut().insert(path.to_string(), row.clone());
        row
    }

    fn make_row(
        self: &Rc<Env>,
        id: i64,
        path: String,
        size: i64,
        ctime: i64,
        mtime: i64,
    ) -> Rc<IndexRow> {
        if let Some(Some(r)) = self.rows.borrow().get(&path) {
            return Rc::clone(r);
        }
        let row = Rc::new(IndexRow {
            env: Rc::clone(self),
            id,
            path: path.clone(),
            size,
            ctime,
            mtime,
            props: OnceCell::new(),
            tags: OnceCell::new(),
            links: OnceCell::new(),
            inline: OnceCell::new(),
            items: OnceCell::new(),
        });
        self.rows.borrow_mut().insert(path, Some(Rc::clone(&row)));
        row
    }
}

struct IndexRow {
    env: Rc<Env>,
    id: i64,
    path: String,
    size: i64,
    ctime: i64,
    mtime: i64,
    props: OnceCell<Vec<(String, Value)>>,
    tags: OnceCell<Vec<String>>,
    links: OnceCell<(Vec<LinkValue>, Vec<LinkValue>)>,
    inline: OnceCell<Vec<(String, Value)>>,
    items: OnceCell<Vec<Value>>,
}

fn typed_date(text: &str, offset: i32) -> Option<Value> {
    datetime::parse_date(text, offset).map(|(ms, has_time)| Value::date(ms, has_time))
}

impl IndexRow {
    fn load_props(&self) -> Res<Vec<(String, Value)>> {
        let offset = self.env.offset;
        self.env.index.read(|c| {
            type PropRec = (String, String, Option<String>, Option<f64>);
            let mut st = c.prepare_cached(
                "SELECT key, vtype, v_text, v_num FROM props WHERE file_id = ?1 ORDER BY rowid",
            )?;
            let recs: Vec<PropRec> = st
                .query_map([self.id], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
                })?
                .collect::<Result<_, _>>()?;
            if recs.is_empty() {
                return Ok(Vec::new());
            }
            let need_json = recs.iter().any(|r| r.1 == "list" || r.1 == "object");
            let json: Map<String, Json> = if need_json {
                let text: Option<String> = c.query_row(
                    "SELECT fm_json FROM files WHERE id = ?1",
                    [self.id],
                    |r| r.get(0),
                )?;
                match text {
                    Some(t) => match serde_json::from_str::<Json>(&t) {
                        Ok(Json::Object(m)) => m,
                        _ => {
                            return Err(IndexError::Internal(format!(
                                "corrupt fm_json for {}",
                                self.path
                            )))
                        }
                    },
                    None => Map::new(),
                }
            } else {
                Map::new()
            };
            let mut item_types: HashMap<String, Vec<(String, Option<String>)>> = HashMap::new();
            if recs.iter().any(|r| r.1 == "list") {
                let mut st = c.prepare_cached(
                    "SELECT key, vtype, v_text FROM prop_items WHERE file_id = ?1 ORDER BY key, idx",
                )?;
                let mut rows = st.query([self.id])?;
                while let Some(r) = rows.next()? {
                    item_types
                        .entry(r.get(0)?)
                        .or_default()
                        .push((r.get(1)?, r.get(2)?));
                }
            }
            let mut out = Vec::with_capacity(recs.len());
            for (key, vtype, v_text, v_num) in recs {
                let value = match vtype.as_str() {
                    "null" => Value::Null,
                    "number" => Value::Number(v_num.unwrap_or(f64::NAN)),
                    "bool" => Value::Bool(v_text.as_deref() == Some("true")),
                    "date" | "datetime" => {
                        let t = v_text.unwrap_or_default();
                        typed_date(&t, offset).unwrap_or(Value::String(t))
                    }
                    "list" => {
                        let items = match json.get(&key) {
                            Some(Json::Array(a)) => a.clone(),
                            _ => Vec::new(),
                        };
                        let types = item_types.get(&key);
                        Value::List(
                            items
                                .iter()
                                .enumerate()
                                .map(|(i, item)| {
                                    match types.and_then(|t| t.get(i)) {
                                        Some((ty, Some(text))) if ty == "date" || ty == "datetime" => {
                                            typed_date(text, offset)
                                        }
                                        _ => None,
                                    }
                                    .unwrap_or_else(|| Value::from_json(item, false, offset))
                                })
                                .collect(),
                        )
                    }
                    "object" => json
                        .get(&key)
                        .map_or(Value::Null, |v| Value::from_json(v, false, offset)),
                    // text and link (the engine turns whole-wikilink strings into links)
                    _ => Value::String(v_text.unwrap_or_default()),
                };
                out.push((key, value));
            }
            Ok(out)
        })
    }

    fn load_tags(&self) -> Res<Vec<String>> {
        self.env.index.read(|c| {
            let mut st =
                c.prepare_cached("SELECT DISTINCT tag FROM tags WHERE file_id = ?1 ORDER BY tag")?;
            let all: Vec<String> = st
                .query_map([self.id], |r| r.get(0))?
                .collect::<Result<_, _>>()?;
            // The index stores ancestors of nested tags too; `file.tags` lists
            // tags as written (leaves), `hasTag` still matches ancestors.
            Ok(super::query::leaf_tags(all))
        })
    }

    fn load_links(&self) -> Res<(Vec<LinkValue>, Vec<LinkValue>)> {
        self.env.index.read(|c| {
            let mut st = c.prepare_cached(
                "SELECT e.target, d.path, e.kind, e.display FROM edges e \
                 LEFT JOIN files d ON d.id = e.dst_id WHERE e.src_id = ?1 ORDER BY e.ord",
            )?;
            let mut links = Vec::new();
            let mut embeds = Vec::new();
            let mut rows = st.query([self.id])?;
            while let Some(r) = rows.next()? {
                let raw: String = r.get(0)?;
                if raw.is_empty() {
                    continue; // `[[#Heading]]`: a section of this file, no target text
                }
                let kind: String = r.get(2)?;
                let link = LinkValue {
                    target: raw,
                    display: r.get(3)?,
                    resolved: r.get(1)?,
                };
                if edges::EdgeKind::from_column(&kind) == edges::EdgeKind::Embed {
                    embeds.push(link);
                } else {
                    links.push(link);
                }
            }
            Ok((links, embeds))
        })
    }

    /// The note's Dataview inline fields (`key:: value`), the raw key and its canonical form.
    fn load_inline(&self) -> Res<Vec<(String, Value)>> {
        let offset = self.env.offset;
        self.env.index.read(|c| {
            let mut st = c.prepare_cached(
                "SELECT key, canonical_key, raw FROM inline_fields WHERE file_id = ?1 ORDER BY rowid",
            )?;
            let rows: Vec<(String, String, String)> = st
                .query_map([self.id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                .collect::<Result<_, _>>()?;
            Ok(super::inline_fields::merge_fields(&rows, offset))
        })
    }

    /// The note's tasks as list-item objects (`file.tasks` of the DQL dialect).
    fn load_items(&self) -> Res<Vec<Value>> {
        self.env.index.read(|c| {
            let mut st = c.prepare_cached(
                "SELECT line, status_symbol, text FROM tasks WHERE file_id = ?1 ORDER BY line",
            )?;
            let items = st
                .query_map([self.id], |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?
                .into_iter()
                .map(|(line, status, text)| {
                    let done = status.eq_ignore_ascii_case("x");
                    Value::Object(vec![
                        ("text".into(), Value::String(text)),
                        ("line".into(), Value::Number(line as f64)),
                        ("task".into(), Value::Bool(true)),
                        ("status".into(), Value::String(status.clone())),
                        ("checked".into(), Value::Bool(status != " ")),
                        ("completed".into(), Value::Bool(done)),
                        ("fullyCompleted".into(), Value::Bool(done)),
                    ])
                })
                .collect();
            Ok(items)
        })
    }

    fn cached<T: Clone + Default>(&self, cell: &OnceCell<T>, load: impl FnOnce() -> Res<T>) -> T {
        if let Some(v) = cell.get() {
            return v.clone();
        }
        let v = match load() {
            Ok(v) => v,
            Err(e) => {
                self.env.fail(e);
                T::default()
            }
        };
        let _ = cell.set(v.clone());
        v
    }
}

impl RowContext for IndexRow {
    fn path(&self) -> String {
        self.path.clone()
    }

    fn meta(&self) -> FileMeta {
        let shift = self.env.offset as i64 * 60_000;
        FileMeta {
            size: self.size.max(0) as u64,
            ctime_ms: self.ctime + shift,
            mtime_ms: self.mtime + shift,
        }
    }

    fn properties(&self) -> Vec<(String, Value)> {
        self.cached(&self.props, || self.load_props())
    }

    fn tags(&self) -> Vec<String> {
        self.cached(&self.tags, || self.load_tags())
    }

    fn links(&self) -> Vec<LinkValue> {
        self.cached(&self.links, || self.load_links()).0
    }

    fn embeds(&self) -> Vec<LinkValue> {
        self.cached(&self.links, || self.load_links()).1
    }

    fn backlinks(&self) -> Vec<String> {
        match self.env.index.graph_snapshot() {
            Ok(graph) => graph
                .node_of_path(&self.path)
                .map(|n| {
                    graph
                        .in_neighbors(n)
                        .map(|m| graph.path(m).to_string())
                        .collect()
                })
                .unwrap_or_default(),
            Err(e) => {
                self.env.fail(e);
                Vec::new()
            }
        }
    }

    fn resolve_link(&self, text: &str) -> Option<String> {
        if text.trim().is_empty() {
            return None;
        }
        match self.env.index.cached_paths() {
            Ok(p) => p.resolve(&self.path, text, LinkKind::Wikilink),
            Err(e) => {
                self.env.fail(e);
                None
            }
        }
    }

    fn context_for_path(&self, path: &str) -> Option<Rc<dyn RowContext>> {
        self.env.row_by_path(path).map(|r| r as Rc<dyn RowContext>)
    }

    fn inline_fields(&self) -> Vec<(String, Value)> {
        self.cached(&self.inline, || self.load_inline())
    }

    fn list_items(&self) -> Vec<Value> {
        self.cached(&self.items, || self.load_items())
    }
}

// ---------------------------------------------------------------------------
// Pushdown
// ---------------------------------------------------------------------------

fn sql_op(op: CompareOp) -> Option<&'static str> {
    Some(match op {
        CompareOp::Eq => "=",
        CompareOp::Lt => "<",
        CompareOp::Gt => ">",
        CompareOp::Le => "<=",
        CompareOp::Ge => ">=",
        CompareOp::Ne => return None,
    })
}

fn comparison_sql(c: &Comparison) -> Option<(String, Vec<SqlValue>)> {
    // `props.key` is a top-level name: a dotted one may reach into a map (`metadata.version`),
    // which only the verification pass can see
    if c.property.contains('.') {
        return None;
    }
    let op = sql_op(c.op)?;
    let head = "EXISTS (SELECT 1 FROM props p WHERE p.file_id = f.id AND p.key = ?";
    match &c.value {
        Value::Number(n) if !n.is_nan() => Some((
            format!("{head} AND p.v_num {op} ?)"),
            vec![c.property.clone().into(), (*n).into()],
        )),
        Value::String(s) if c.op == CompareOp::Eq => Some((
            format!("{head} AND p.v_text = ?)"),
            vec![c.property.clone().into(), s.clone().into()],
        )),
        Value::Bool(b) if c.op == CompareOp::Eq => Some((
            format!("{head} AND p.vtype = 'bool' AND p.v_text = ?)"),
            vec![c.property.clone().into(), b.to_string().into()],
        )),
        // `!=`, null, string/bool ordering: left to the verification pass.
        _ => None,
    }
}

/// Conditions over alias `f` (`files`) narrowing to a superset of the rows the
/// hint can match.
pub fn hint_sql(hint: &PushdownHint) -> (Vec<String>, Vec<SqlValue>) {
    let mut conds = Vec::new();
    let mut args: Vec<SqlValue> = Vec::new();
    for folder in &hint.folders {
        let folder = folder.trim().trim_matches('/');
        if folder.is_empty() {
            continue;
        }
        conds.push("f.path >= ? AND f.path < ?".to_string());
        args.push(format!("{folder}/").into());
        args.push(format!("{folder}0").into());
    }
    if let Some(ext) = &hint.ext {
        conds.push("f.ext = ?".to_string());
        args.push(ext.trim_start_matches('.').to_lowercase().into());
    }
    for any in &hint.tags_any {
        let tags: Option<Vec<String>> = any.iter().map(|t| normalize_tag(t)).collect();
        let Some(tags) = tags else { continue };
        if tags.is_empty() {
            continue;
        }
        conds.push(format!(
            "EXISTS (SELECT 1 FROM tags t WHERE t.file_id = f.id AND t.tag IN ({}))",
            vec!["?"; tags.len()].join(",")
        ));
        args.extend(tags.into_iter().map(SqlValue::from));
    }
    for c in &hint.comparisons {
        if let Some((sql, a)) = comparison_sql(c) {
            conds.push(sql);
            args.extend(a);
        }
    }
    (conds, args)
}

// ---------------------------------------------------------------------------
// Source
// ---------------------------------------------------------------------------

pub struct IndexSource {
    env: Rc<Env>,
    this_path: Option<String>,
    narrow: bool,
    /// Candidates returned by the last `candidates` call (tests, diagnostics).
    pub last_candidates: Cell<usize>,
}

impl IndexSource {
    /// `this_path` is the `this` row (base file, embedding note); it must be in
    /// the index.
    pub fn new(index: Arc<Index>, utc_offset_minutes: i32, this_path: Option<String>) -> Res<Self> {
        if let Some(p) = &this_path {
            if index.get_file(p)?.is_none() {
                return Err(IndexError::Invalid(format!(
                    "`this` file is not in the index: {p}"
                )));
            }
        }
        Ok(IndexSource {
            env: Rc::new(Env {
                today: Cell::new(Day::from_local_ms(
                    SystemClock {
                        offset_minutes: utc_offset_minutes,
                    }
                    .now_local_ms(),
                )),
                statuses: OnceCell::new(),
                index,
                offset: utc_offset_minutes,
                rows: RefCell::new(HashMap::new()),
                error: RefCell::new(None),
            }),
            this_path,
            narrow: true,
            last_candidates: Cell::new(0),
        })
    }

    /// Disable SQL narrowing (full scan); the differential tests compare both.
    pub fn with_pushdown(mut self, on: bool) -> Self {
        self.narrow = on;
        self
    }

    /// First error raised inside a lazy row lookup, if any.
    pub fn take_error(&self) -> Option<String> {
        self.env.error.borrow_mut().take()
    }
}

impl IndexSource {
    /// Day `task.urgency` counts from (the clock of the query; the system day by default).
    pub fn with_today(self, today: Day) -> Self {
        self.env.today.set(today);
        self
    }

    fn file_candidates(
        &self,
        conds: &[String],
        args: &[SqlValue],
    ) -> Result<Vec<Rc<dyn RowContext>>, String> {
        let wh = where_clause(conds);
        let sql = format!(
            "SELECT f.id, f.path, f.size, f.ctime, f.mtime FROM files f{wh} ORDER BY f.path"
        );
        let recs = self
            .env
            .index
            .read(|c| {
                let mut st = c.prepare(&sql)?;
                let rows = st
                    .query_map(params_from_iter(args.iter()), |r| {
                        Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
                    })?
                    .collect::<Result<Vec<(i64, String, i64, i64, i64)>, _>>()?;
                Ok(rows)
            })
            .map_err(|e| e.to_string())?;
        self.last_candidates.set(recs.len());
        Ok(recs
            .into_iter()
            .map(|(id, path, size, ctime, mtime)| {
                self.env.make_row(id, path, size, ctime, mtime) as Rc<dyn RowContext>
            })
            .collect())
    }

    /// One row per task of the files the hint leaves (SPECs/tasks-spec.md 5).
    fn task_candidates(
        &self,
        conds: &[String],
        args: &[SqlValue],
    ) -> Result<Vec<Rc<dyn RowContext>>, String> {
        let wh = where_clause(conds);
        let sql = format!(
            "SELECT f.id, f.path, f.size, f.ctime, f.mtime, t.line, t.status_symbol, t.text, \
             t.description, t.due, t.scheduled, t.start, t.created, t.done, t.cancelled, \
             t.priority, t.recurrence, t.on_completion, t.task_id, t.depends_on, t.tags, \
             t.block_id, t.parent_line, li.section_heading, li.indent \
             FROM tasks t JOIN files f ON f.id = t.file_id \
             LEFT JOIN list_items li ON li.file_id = t.file_id AND li.line = t.line{wh} \
             ORDER BY f.path, t.line"
        );
        let recs = self
            .env
            .index
            .read(|c| {
                let mut st = c.prepare(&sql)?;
                let rows = st
                    .query_map(params_from_iter(args.iter()), |r| {
                        let text = |i: usize| r.get::<_, Option<String>>(i);
                        let list = |i: usize| -> rusqlite::Result<Vec<String>> {
                            Ok(text(i)?
                                .map(|s| s.split(',').map(str::to_string).collect())
                                .unwrap_or_default())
                        };
                        let day = |i: usize| -> rusqlite::Result<Option<Day>> {
                            Ok(text(i)?.as_deref().and_then(Day::parse))
                        };
                        let symbol: String = r.get(6)?;
                        let fields = TaskFields {
                            description: r.get(8)?,
                            due: day(9)?,
                            scheduled: day(10)?,
                            start: day(11)?,
                            created: day(12)?,
                            done: day(13)?,
                            cancelled: day(14)?,
                            priority: text(15)?.as_deref().and_then(Priority::parse),
                            recurrence: text(16)?,
                            on_completion: text(17)?,
                            id: text(18)?,
                            depends_on: list(19)?,
                            tags: list(20)?,
                            block_id: text(21)?,
                        };
                        Ok((
                            (r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?),
                            TaskRecord {
                                line: r.get(5)?,
                                symbol: symbol.chars().next().unwrap_or(' '),
                                text: r.get(7)?,
                                fields,
                                parent_line: r.get(22)?,
                                heading: r.get(23)?,
                                indent: r.get::<_, Option<u32>>(24)?.unwrap_or(0),
                            },
                        ))
                    })?
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(rows)
            })
            .map_err(|e| e.to_string())?;
        self.last_candidates.set(recs.len());
        Ok(recs
            .into_iter()
            .map(|((id, path, size, ctime, mtime), task)| {
                Rc::new(TaskRow {
                    file: self.env.make_row(id, path, size, ctime, mtime),
                    task,
                }) as Rc<dyn RowContext>
            })
            .collect())
    }
}

fn where_clause(conds: &[String]) -> String {
    if conds.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", conds.join(" AND "))
    }
}

impl RowSource for IndexSource {
    fn candidates(&self, hint: &PushdownHint) -> Result<Vec<Rc<dyn RowContext>>, String> {
        let (conds, args) = if self.narrow {
            hint_sql(hint)
        } else {
            (Vec::new(), Vec::new())
        };
        match hint.rows {
            RowKind::Files => self.file_candidates(&conds, &args),
            RowKind::Tasks => self.task_candidates(&conds, &args),
        }
    }

    fn this_row(&self) -> Option<Rc<dyn RowContext>> {
        let p = self.this_path.as_deref()?;
        self.env.row_by_path(p).map(|r| r as Rc<dyn RowContext>)
    }
}

// ---------------------------------------------------------------------------
// Task rows
// ---------------------------------------------------------------------------

/// One `tasks` row with its list item's context.
struct TaskRecord {
    line: u32,
    symbol: char,
    text: String,
    fields: TaskFields,
    parent_line: Option<u32>,
    heading: Option<String>,
    indent: u32,
}

/// A row of a `rows: tasks` base: the task's own properties as `task.*`, everything else
/// (`file.*`, `note.*`, tags, links) the file's.
struct TaskRow {
    file: Rc<IndexRow>,
    task: TaskRecord,
}

fn date_value(day: Option<Day>) -> Value {
    day.map_or(Value::Null, |d| Value::date(d.0 * 86_400_000, false))
}

fn opt_string(s: &Option<String>) -> Value {
    s.as_ref().map_or(Value::Null, |s| Value::String(s.clone()))
}

fn string_list(v: &[String]) -> Value {
    Value::List(v.iter().cloned().map(Value::String).collect())
}

impl RowContext for TaskRow {
    fn path(&self) -> String {
        self.file.path()
    }
    fn meta(&self) -> FileMeta {
        self.file.meta()
    }
    fn properties(&self) -> Vec<(String, Value)> {
        self.file.properties()
    }
    fn property(&self, key: &str) -> Option<Value> {
        self.file.property(key)
    }
    fn tags(&self) -> Vec<String> {
        self.file.tags()
    }
    fn links(&self) -> Vec<LinkValue> {
        self.file.links()
    }
    fn embeds(&self) -> Vec<LinkValue> {
        self.file.embeds()
    }
    fn backlinks(&self) -> Vec<String> {
        self.file.backlinks()
    }
    fn resolve_link(&self, text: &str) -> Option<String> {
        self.file.resolve_link(text)
    }
    fn context_for_path(&self, path: &str) -> Option<Rc<dyn RowContext>> {
        self.file.context_for_path(path)
    }

    fn line(&self) -> Option<u32> {
        Some(self.task.line)
    }

    /// The `task.*` properties (SPECs/tasks-spec.md 5.2). The status type comes from the vault's
    /// statuses, so custom ones count.
    fn task_field(&self, name: &str) -> Option<Value> {
        let t = &self.task;
        let f = &t.fields;
        let env = &self.file.env;
        let kind = || {
            env.statuses
                .get_or_init(|| crate::tasks::settings::load_statuses(env.index.root()))
                .kind_of(t.symbol)
        };
        Some(match name {
            "description" => Value::String(f.description.clone()),
            "text" => Value::String(t.text.clone()),
            "status" => Value::str(kind().as_str()),
            "symbol" => Value::String(t.symbol.to_string()),
            "checked" => Value::Bool(kind().is_closed()),
            "due" => date_value(f.due),
            "scheduled" => date_value(f.scheduled),
            "start" => date_value(f.start),
            "created" => date_value(f.created),
            "done" => date_value(f.done),
            "cancelled" => date_value(f.cancelled),
            "priority" => f.priority.map_or(Value::Null, |p| Value::str(p.name())),
            "recurrence" => opt_string(&f.recurrence),
            "on_completion" => opt_string(&f.on_completion),
            "id" => opt_string(&f.id),
            "depends_on" => string_list(&f.depends_on),
            "tags" => string_list(&f.tags),
            "block" => opt_string(&f.block_id),
            "urgency" => Value::Number(urgency::urgency(f, env.today.get())),
            "line" => Value::Number(t.line as f64),
            "parent" => t
                .parent_line
                .map_or(Value::Null, |l| Value::Number(l as f64)),
            "indent" => Value::Number(t.indent as f64),
            "heading" => opt_string(&t.heading),
            _ => return None,
        })
    }
}

/// Run `view` of `doc` over the index. Lookup errors raised while evaluating
/// rows surface as `Err` instead of a silently incomplete result.
pub fn run_base_view(
    index: &Arc<Index>,
    doc: &Document,
    view: Option<&str>,
    this_path: Option<&str>,
    clock: &dyn Clock,
) -> Res<BaseQueryResult> {
    let source = IndexSource::new(
        Arc::clone(index),
        clock.utc_offset_minutes(),
        this_path.map(str::to_string),
    )?;
    let source = source.with_today(Day::from_local_ms(clock.now_local_ms()));
    let result = run_view(doc, view, &source, clock, &QueryOptions::default());
    match source.take_error() {
        Some(e) => Err(IndexError::Internal(e)),
        None => Ok(result),
    }
}

/// Evaluate one expression with `this_path` as both the current row and `this`
/// (no row exists for a plugin's `getEvaluatedFormula`). `formulas` makes
/// `formula.x` resolvable. Evaluation failures are error cells, not `Err`;
/// `Err` is a missing `this` file or a failed index lookup.
pub fn eval_expression(
    index: &Arc<Index>,
    expression: &str,
    formulas: &[(String, String)],
    this_path: &str,
    clock: &dyn Clock,
) -> Res<QueryCell> {
    let source = IndexSource::new(
        Arc::clone(index),
        clock.utc_offset_minutes(),
        Some(this_path.to_string()),
    )?;
    let this = source.this_row().ok_or_else(|| {
        IndexError::Invalid(format!("`this` file is not in the index: {this_path}"))
    })?;
    let set = FormulaSet::compile(formulas);
    let interp = Interp::new(clock, &set, Rc::clone(&this), Some(this));
    let value = interp.eval_source(expression);
    match source.take_error() {
        Some(e) => Err(IndexError::Internal(e)),
        None => Ok(QueryCell::new(value)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bases::context::FixedClock;
    use std::fs;
    use tempfile::TempDir;

    fn write(root: &std::path::Path, rel: &str, content: &str) {
        let p = root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, content).unwrap();
    }

    struct Vault {
        _vault: TempDir,
        _data: TempDir,
        index: Arc<Index>,
    }

    fn vault() -> Vault {
        let v = TempDir::new().unwrap();
        let r = v.path();
        let status = ["active", "done", "planned"];
        for i in 0..18 {
            write(
                r,
                &format!("Projects/Task {i:02}.md"),
                &format!(
                    "---\nstatus: {}\npriority: {}\ndone: {}\ndue: 2024-03-{:02}\ntags: [work, {}]\nowner: \"[[People/Ann]]\"\n---\n# T\nlinks [[Plan]] #body{}\n",
                    status[i % 3],
                    i % 4,
                    i % 2 == 0,
                    1 + i,
                    if i % 2 == 0 { "even/deep" } else { "odd" },
                    i % 3
                ),
            );
        }
        write(
            r,
            "Projects/Plan.md",
            "---\nstatus: active\nscore: 8.5\n---\nPlan [[Archive/Plan]] ![[img/pic.png]]\n",
        );
        write(r, "Archive/Plan.md", "---\nstatus: done\n---\nold\n");
        write(
            r,
            "People/Ann.md",
            "---\nrole: lead\naliases: [A]\n---\nAnn\n",
        );
        write(r, "Home.md", "see [[Task 00]] and [[Missing]]\n");
        write(r, "img/pic.png", "png");
        write(r, "x.base", "views:\n  - type: table\n    name: T\n");
        write(r, ".obsidian/app.json", "{}");
        let data = TempDir::new().unwrap();
        let index = Arc::new(Index::open_for_cli(r, Some(data.path())).unwrap());
        Vault {
            _vault: v,
            _data: data,
            index,
        }
    }

    fn clock() -> FixedClock {
        FixedClock::at("2024-03-15T10:30:00")
    }

    fn query(v: &Vault, base: &str, narrow: bool, this: Option<&str>) -> (BaseQueryResult, usize) {
        let doc = Document::parse(base).unwrap();
        let source = IndexSource::new(Arc::clone(&v.index), 0, this.map(str::to_string))
            .unwrap()
            .with_pushdown(narrow);
        let r = run_view(&doc, None, &source, &clock(), &QueryOptions::default());
        assert_eq!(source.take_error(), None);
        (r, source.last_candidates.get())
    }

    fn paths(r: &BaseQueryResult) -> Vec<String> {
        r.rows.iter().map(|r| r.path.clone()).collect()
    }

    #[test]
    fn pushdown_equals_full_scan_for_a_set_of_filters() {
        let v = vault();
        let filters = [
            r#"file.inFolder("Projects")"#,
            r#"file.ext == "md""#,
            r#"file.ext == "png""#,
            r#"file.hasTag("work")"#,
            r#"file.hasTag("EVEN")"#,
            r#"file.hasTag("even/deep", "odd")"#,
            r#"file.hasTag("not a tag")"#,
            r#"status == "done""#,
            r#"status != "done""#,
            r#"priority > 1"#,
            r#"priority <= 2"#,
            r#"2 < priority"#,
            r#"priority == 3"#,
            r#"done == true"#,
            r#"done == false"#,
            r#"status == null"#,
            r#"due < date("2024-03-05")"#,
            r#"status == "active" && priority >= 1"#,
            r#"file.inFolder("Projects") && file.hasTag("work") && priority > 0"#,
            r#"status == "done" || priority == 0"#,
            r#"!(status == "done")"#,
            r#"note["status"] == "planned""#,
            r#"file.hasLink("Plan")"#,
            r#"file.inFolder("")"#,
            r#"score > 5"#,
            r#"status > "a""#,
        ];
        let mut narrowed = 0;
        for f in filters {
            let base = format!(
                "filters:\n  and:\n    - '{}'\nviews:\n  - type: table\n    name: T\n    order: [file.name, status]\n",
                f.replace('\'', "''")
            );
            let (full, full_n) = query(&v, &base, false, None);
            let (fast, fast_n) = query(&v, &base, true, None);
            assert!(full.error.is_none(), "{f}: {:?}", full.error);
            assert_eq!(full, fast, "differential mismatch for {f}");
            assert!(fast_n <= full_n);
            if fast_n < full_n {
                narrowed += 1;
            }
        }
        assert!(narrowed >= 12, "pushdown narrowed only {narrowed} filters");
    }

    #[test]
    fn narrowing_is_real() {
        let v = vault();
        let base =
            "filters:\n  and:\n    - 'status == \"done\"'\n    - 'file.inFolder(\"Projects\")'\n";
        let (_, full) = query(&v, base, false, None);
        let (r, fast) = query(&v, base, true, None);
        assert!(fast < full / 2, "{fast} vs {full}");
        assert!(r.rows.iter().all(|r| r.path.starts_with("Projects/")));
        assert_eq!(r.rows.len(), 6);
    }

    #[test]
    fn every_indexed_file_is_a_row_but_not_hidden_ones() {
        let v = vault();
        let (r, _) = query(&v, "", true, None);
        let p = paths(&r);
        assert!(p.contains(&"img/pic.png".to_string()));
        assert!(p.contains(&"x.base".to_string()));
        assert!(!p.iter().any(|x| x.starts_with(".obsidian")));
        assert_eq!(p, {
            let mut s = p.clone();
            s.sort();
            s
        });
    }

    #[test]
    fn file_fields_properties_links_and_backlinks() {
        let v = vault();
        let base = "views:\n  - type: table\n    name: T\n    filters: 'file.name == \"Plan.md\" || file.name == \"Task 00.md\" || file.name == \"Ann.md\"'\n    order:\n      - file.path\n      - file.folder\n      - file.ext\n      - file.tags\n      - file.links\n      - file.embeds\n      - file.backlinks\n      - due\n      - priority\n      - done\n      - owner\n      - tags\n";
        let (r, _) = query(&v, base, true, None);
        let by = |p: &str| r.rows.iter().find(|x| x.path == p).unwrap();
        let col = |name: &str| r.columns.iter().position(|c| c.id == name).unwrap();
        let t0 = by("Projects/Task 00.md");
        assert_eq!(t0.cells[col("file.folder")].display, "Projects");
        assert_eq!(t0.cells[col("file.ext")].display, "md");
        assert_eq!(t0.cells[col("due")].display, "2024-03-01");
        assert_eq!(t0.cells[col("due")].value.type_name(), "date");
        assert_eq!(t0.cells[col("priority")].display, "0");
        assert_eq!(t0.cells[col("done")].display, "true");
        assert_eq!(t0.cells[col("owner")].value.type_name(), "link");
        assert_eq!(t0.cells[col("tags")].display, "work, even/deep");
        // leaf tags only: work, even/deep, body0 (no `even` ancestor)
        assert_eq!(t0.cells[col("file.tags")].display, "body0, even/deep, work");
        assert!(t0.cells[col("file.backlinks")].display.contains("Home.md"));
        let plan = by("Projects/Plan.md");
        assert_eq!(plan.cells[col("file.links")].display, "Archive/Plan");
        assert_eq!(plan.cells[col("file.embeds")].display, "img/pic.png");
        assert!(plan.cells[col("file.backlinks")]
            .display
            .contains("Projects/Task 00.md"));
        let ann = by("People/Ann.md");
        assert!(ann.cells[col("file.backlinks")].display.contains("Task 05"));
    }

    #[test]
    fn this_and_linked_note_lookups() {
        let v = vault();
        let base = "filters: 'file.folder == this.file.folder'\nformulas:\n  role: owner.asFile().properties.role\nviews:\n  - type: table\n    name: T\n    order: [file.name, formula.role]\n";
        let (r, _) = query(&v, base, true, Some("Projects/Plan.md"));
        assert_eq!(r.rows.len(), 19);
        let task = r
            .rows
            .iter()
            .find(|x| x.path == "Projects/Task 00.md")
            .unwrap();
        assert_eq!(task.cells[1].display, "lead");
        assert!(IndexSource::new(Arc::clone(&v.index), 0, Some("nope.md".into())).is_err());
    }

    #[test]
    fn backlink_snapshot_follows_the_index_epoch() {
        let v = vault();
        let first = v.index.graph_snapshot().unwrap();
        let again = v.index.graph_snapshot().unwrap();
        assert!(Arc::ptr_eq(&first, &again));
        write(v.index.root(), "Newcomer.md", "[[Home]]\n");
        v.index
            .index_paths_blocking(vec![v.index.root().join("Newcomer.md")])
            .unwrap();
        let after = v.index.graph_snapshot().unwrap();
        assert!(!Arc::ptr_eq(&first, &after));
        let home = after.node_of_path("Home.md").unwrap();
        assert!(after
            .in_neighbors(home)
            .any(|n| after.path(n) == "Newcomer.md"));
    }

    #[test]
    fn eval_expression_uses_this_and_formulas() {
        let v = vault();
        let formulas = vec![("twice".to_string(), "priority * 2".to_string())];
        let c = eval_expression(
            &v.index,
            "this.status + \"!\"",
            &[],
            "Projects/Plan.md",
            &clock(),
        )
        .unwrap();
        assert_eq!(c.display, "active!");
        let c =
            eval_expression(&v.index, "1 + 2", &formulas, "Projects/Plan.md", &clock()).unwrap();
        assert_eq!(c.display, "3");
        let bad = eval_expression(&v.index, "nope(1)", &[], "Projects/Plan.md", &clock()).unwrap();
        assert!(matches!(bad.value, Value::Error(_)));
        assert!(eval_expression(&v.index, "1", &[], "Missing.md", &clock()).is_err());
    }

    #[test]
    fn run_base_view_reports_view_errors_in_the_result() {
        let v = vault();
        let doc = Document::parse("views:\n  - type: table\n    name: T\n").unwrap();
        let r = run_base_view(&v.index, &doc, Some("Nope"), None, &clock()).unwrap();
        assert!(r.error.is_some());
        let ok = run_base_view(&v.index, &doc, None, None, &clock()).unwrap();
        assert!(ok.error.is_none() && !ok.rows.is_empty());
    }

    #[test]
    fn has_tag_matches_nested_descendants_with_and_without_pushdown() {
        let v = vault();
        for (rel, body) in super::super::NESTED_TAG_NOTES {
            write(v._vault.path(), rel, body);
        }
        // Re-open so the new notes are indexed.
        let index = Arc::new(Index::open_for_cli(v._vault.path(), Some(v._data.path())).unwrap());
        let v = Vault { index, ..v };
        for (tag, want) in [
            ("research", 3),
            ("Research/HLO", 2),
            ("research/hlo/docs", 1),
            ("researcher", 1),
            ("res", 0),
            ("research/h", 0),
        ] {
            let base = format!("filters:\n  and:\n    - 'file.hasTag(\"{tag}\")'\n");
            let (full, _) = query(&v, &base, false, None);
            let (fast, _) = query(&v, &base, true, None);
            assert_eq!(full, fast, "{tag}");
            assert_eq!(full.rows.len(), want, "{tag}");
        }
    }
}
