//! The lowering: a [`Query`] to a Bases [`Document`], the one executor.
//!
//! Every DQL expression becomes a Bases expression (`bases::ast::Expr`, printed with its own
//! `to_source`): operators map one to one, `file.name` becomes `file.basename`, the functions
//! both languages have are rewritten to their Bases method form (`contains(a, b)` to
//! `a.contains(b)`), a lambda to a Bases list expression over `value`. What Bases cannot say is
//! left to the DQL dialect (`bases::dialect`, switched on by `dialect: dql` in the live
//! document) and **recorded** in [`Lowered::unmapped`], which is what "Convert to Base" checks:
//! a query with nothing unmapped is also a valid plain `.base`.
//!
//! The pipeline: `FROM` and the `WHERE` clauses before any `FLATTEN` become the document's
//! filters (and so SQL pushdown); `FLATTEN` and the `WHERE` after it the view's `flatten` steps;
//! `SORT` the view's `sort`; `GROUP BY` of a task query the view's `groupBy` (a grouped list),
//! of any other query `groupBy` plus `dqlGroup` (one row per group, `key` and `rows`); `LIMIT`
//! the view's `limit`. DQL runs clauses in the order written; the one reordering that would
//! change a result (a `LIMIT` before the end) is an error, not a silent difference.

use super::ast::*;
use super::parser::{self, line_col};
use super::tasks::{task_field, TaskMap};
use crate::bases::ast::{BinaryOp, Expr as B, UnaryOp};
use crate::bases::document::{
    Direction, Document, Filter, GroupBy, Node, PropertyConfig, SortKey, View,
};

/// A query that does not parse or cannot be lowered, at a position.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct DqlError {
    pub message: String,
    pub line: usize,
    pub col: usize,
}

impl std::fmt::Display for DqlError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{} (line {}, column {})",
            self.message, self.line, self.col
        )
    }
}

/// A clause that has no plain-Bases form.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct Unmapped {
    /// `FLATTEN`, `GROUP BY`, `WHERE`, `SORT`, `TABLE`, ...
    pub clause: String,
    pub reason: String,
    pub line: usize,
    pub col: usize,
}

impl std::fmt::Display for Unmapped {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{} (line {}, column {}): {}",
            self.clause, self.line, self.col, self.reason
        )
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Table,
    List,
    Task,
    Calendar,
}

/// A lowered query.
#[derive(Clone, Debug)]
pub struct Lowered {
    pub document: Document,
    pub kind: Kind,
    pub unmapped: Vec<Unmapped>,
}

impl Lowered {
    /// The document to run: the lowering plus `dialect: dql`.
    pub fn live_document(&self) -> Document {
        let mut doc = self.document.clone();
        doc.extra
            .insert(0, ("dialect".to_string(), Node::Str("dql".to_string())));
        doc
    }

    /// `.base` text that runs live (the DQL dialect on).
    pub fn live_text(&self) -> String {
        self.live_document().to_yaml()
    }

    /// `.base` text of the equivalent plain base, or the clauses that have no Bases form.
    pub fn base_text(&self) -> Result<String, &[Unmapped]> {
        if self.unmapped.is_empty() {
            Ok(self.document.to_yaml())
        } else {
            Err(&self.unmapped)
        }
    }
}

/// Parse and lower DQL text.
pub fn lower(text: &str) -> Result<Lowered, DqlError> {
    let query = parser::parse_query(text).map_err(|e| {
        let (line, col) = line_col(text, e.pos);
        DqlError {
            message: e.message,
            line,
            col,
        }
    })?;
    Lowering::new(text).run(&query)
}

type Res<T> = Result<T, DqlError>;

// ---------------------------------------------------------------------------
// Bases expression builders
// ---------------------------------------------------------------------------

fn ident(n: &str) -> B {
    B::Ident(n.to_string())
}
fn member(o: B, n: &str) -> B {
    B::Member(Box::new(o), n.to_string())
}
fn method(recv: B, name: &str, args: Vec<B>) -> B {
    B::Call(Box::new(member(recv, name)), args)
}
fn global(name: &str, args: Vec<B>) -> B {
    B::Call(Box::new(ident(name)), args)
}
fn string(s: &str) -> B {
    B::Str(s.to_string())
}
fn binary(op: BinaryOp, l: B, r: B) -> B {
    B::Binary(op, Box::new(l), Box::new(r))
}

/// `file.link`: a link to the file shown by its name, as Dataview shows it.
fn as_link(file: B) -> B {
    method(file.clone(), "asLink", vec![member(file, "basename")])
}

/// Can `name` be written as a bare Bases identifier?
fn bases_ident(name: &str) -> bool {
    let mut cs = name.chars();
    cs.next()
        .is_some_and(|c| c.is_alphabetic() || c == '_' || c == '$')
        && cs.all(|c| c.is_alphanumeric() || c == '_' || c == '$')
}

/// The source of `e` without the parentheses around a top-level binary.
fn source(e: &B) -> String {
    let s = e.to_source();
    match e {
        B::Binary(..) => s[1..s.len() - 1].to_string(),
        _ => s,
    }
}

/// The names a Bases property id cannot take as a bare note property.
const NAMESPACES: [&str; 4] = ["file", "note", "formula", "this"];

// ---------------------------------------------------------------------------
// Lowering
// ---------------------------------------------------------------------------

struct Lowering<'a> {
    text: &'a str,
    task: bool,
    lambda: Vec<(String, &'static str)>,
    /// Why the clause being lowered has no Bases form (dialect functions and fields).
    flags: Vec<String>,
    formulas: Vec<(String, String)>,
    props: Vec<(String, PropertyConfig)>,
    unmapped: Vec<Unmapped>,
}

struct FlattenL {
    expr: String,
    name: String,
    wheres: Vec<String>,
}

struct GroupL {
    name: String,
    id: String,
    wheres: Vec<String>,
    sorts: Vec<(String, bool)>,
}

impl<'a> Lowering<'a> {
    fn new(text: &'a str) -> Self {
        Lowering {
            text,
            task: false,
            lambda: Vec::new(),
            flags: Vec::new(),
            formulas: Vec::new(),
            props: Vec::new(),
            unmapped: Vec::new(),
        }
    }

    fn err(&self, pos: usize, message: impl Into<String>) -> DqlError {
        let (line, col) = line_col(self.text, pos);
        DqlError {
            message: message.into(),
            line,
            col,
        }
    }

    fn flag(&mut self, why: impl Into<String>) {
        let why = why.into();
        if !self.flags.contains(&why) {
            self.flags.push(why);
        }
    }

    /// Record the flags of the clause just lowered as one unmapped clause.
    fn close_clause(&mut self, clause: &str, pos: usize) {
        if self.flags.is_empty() {
            return;
        }
        let (line, col) = line_col(self.text, pos);
        let reason = self.flags.join("; ");
        self.flags.clear();
        self.unmapped.push(Unmapped {
            clause: clause.to_string(),
            reason,
            line,
            col,
        });
    }

    // ----- expressions ---------------------------------------------------------

    fn emit(&mut self, e: &Expr) -> Res<B> {
        Ok(match e {
            Expr::Null => B::Null,
            Expr::Bool(b) => B::Bool(*b),
            Expr::Number(n) => B::Number(*n),
            Expr::Str(s) => B::Str(s.clone()),
            Expr::Date(d) => global("date", vec![string(d)]),
            Expr::Shorthand(s) => self.shorthand(*s),
            Expr::Duration(d) => global("duration", vec![string(d)]),
            Expr::Link { path, display } => {
                let mut args = vec![string(path)];
                if let Some(d) = display {
                    args.push(string(d));
                }
                global("link", args)
            }
            Expr::List(items) => B::List(self.emit_all(items)?),
            Expr::Object(fields) => {
                self.flag("object literals have no Bases form");
                let mut args = Vec::new();
                for (k, v) in fields {
                    args.push(string(k));
                    args.push(self.emit(v)?);
                }
                global("object", args)
            }
            Expr::Var { name, pos } => self.var(name, *pos)?,
            Expr::Field(obj, name) => self.field(obj, name)?,
            Expr::Index(obj, idx) => B::Index(Box::new(self.emit(obj)?), Box::new(self.emit(idx)?)),
            Expr::Call { callee, args, pos } => self.call(callee, args, *pos)?,
            Expr::Lambda { .. } => {
                return Err(self.err(
                    0,
                    "a lambda is only supported as the argument of map, filter or reduce",
                ))
            }
            Expr::Not(inner) => B::Unary(UnaryOp::Not, Box::new(self.emit(inner)?)),
            Expr::Bin(op, l, r) => {
                let op = match op {
                    BinOp::Add => BinaryOp::Add,
                    BinOp::Sub => BinaryOp::Sub,
                    BinOp::Mul => BinaryOp::Mul,
                    BinOp::Div => BinaryOp::Div,
                    BinOp::Mod => BinaryOp::Mod,
                    BinOp::Eq => BinaryOp::Eq,
                    BinOp::Ne => BinaryOp::Ne,
                    BinOp::Lt => BinaryOp::Lt,
                    BinOp::Gt => BinaryOp::Gt,
                    BinOp::Le => BinaryOp::Le,
                    BinOp::Ge => BinaryOp::Ge,
                    BinOp::And => BinaryOp::And,
                    BinOp::Or => BinaryOp::Or,
                };
                binary(op, self.emit(l)?, self.emit(r)?)
            }
        })
    }

    fn emit_all(&mut self, items: &[Expr]) -> Res<Vec<B>> {
        items.iter().map(|i| self.emit(i)).collect()
    }

    fn shorthand(&mut self, s: Shorthand) -> B {
        let one_day = || string("1 day");
        match s {
            Shorthand::Now => global("now", vec![]),
            Shorthand::Today => global("today", vec![]),
            Shorthand::Yesterday => binary(BinaryOp::Sub, global("today", vec![]), one_day()),
            Shorthand::Tomorrow => binary(BinaryOp::Add, global("today", vec![]), one_day()),
            Shorthand::StartOf(u) | Shorthand::EndOf(u) => {
                let unit = match u {
                    Unit::Week => "week",
                    Unit::Month => "month",
                    Unit::Year => "year",
                };
                let (f, what) = match s {
                    Shorthand::StartOf(_) => ("startof", "start"),
                    _ => ("endof", "end"),
                };
                self.flag(format!("the {what} of the {unit} has no Bases form"));
                global(f, vec![string(unit)])
            }
        }
    }

    fn var(&mut self, name: &str, pos: usize) -> Res<B> {
        if let Some((_, to)) = self.lambda.iter().rev().find(|(n, _)| n == name) {
            return Ok(ident(to));
        }
        if name == "file" || name == "this" {
            return Ok(ident(name));
        }
        if self.task {
            if let Some(map) = task_field(name) {
                return match map {
                    TaskMap::Prop(p) => Ok(member(ident("task"), p)),
                    TaskMap::StatusIs(t) => Ok(binary(
                        BinaryOp::Eq,
                        member(ident("task"), "status"),
                        string(t),
                    )),
                    TaskMap::StatusIsNot(t) => Ok(binary(
                        BinaryOp::Ne,
                        member(ident("task"), "status"),
                        string(t),
                    )),
                    TaskMap::Unsupported(why) => Err(self.err(pos, why)),
                };
            }
        }
        Ok(if bases_ident(name) && !NAMESPACES.contains(&name) {
            ident(name)
        } else {
            B::Index(Box::new(ident("note")), Box::new(string(name)))
        })
    }

    fn field(&mut self, obj: &Expr, name: &str) -> Res<B> {
        // `file.x`, `this.file.x`, `rows.file.x`: the implicit file fields
        let on_file = match obj {
            Expr::Var { name: n, .. } => {
                n == "file" && !self.lambda.iter().any(|(l, _)| l == "file")
            }
            Expr::Field(_, n) => n == "file",
            _ => false,
        };
        let at = pos_of(obj);
        let recv = self.emit(obj)?;
        if on_file {
            return self.file_field(recv, name, at);
        }
        Ok(if bases_ident(name) {
            member(recv, name)
        } else {
            B::Index(Box::new(recv), Box::new(string(name)))
        })
    }

    fn file_field(&mut self, file: B, name: &str, pos: usize) -> Res<B> {
        Ok(match name {
            "name" => member(file, "basename"),
            "path" | "folder" | "ext" | "size" | "ctime" | "mtime" => member(file, name),
            "cday" => method(member(file, "ctime"), "date", vec![]),
            "mday" => method(member(file, "mtime"), "date", vec![]),
            "link" => as_link(file),
            "inlinks" => member(file, "backlinks"),
            "outlinks" => member(file, "links"),
            "aliases" => ident("aliases"),
            "frontmatter" => member(file, "properties"),
            "tags" | "etags" | "day" | "tasks" | "lists" | "starred" => {
                self.flag(format!("file.{name} has no Bases form"));
                member(file, name)
            }
            other => {
                return Err(self.err(pos, format!("unknown file field \"file.{other}\"")));
            }
        })
    }

    /// A lambda argument as a Bases list expression over `value`, `index` (and `acc`).
    fn lambda_arg(&mut self, arg: &Expr, names: &[&'static str], pos: usize, f: &str) -> Res<B> {
        let Expr::Lambda { params, body } = arg else {
            return Err(self.err(pos, format!("{f}() needs a lambda such as (x) => x.field")));
        };
        if !self.lambda.is_empty() {
            return Err(self.err(pos, "lambdas nested in lambdas are not supported"));
        }
        if params.len() > names.len() {
            return Err(self.err(
                pos,
                format!("{f}() passes at most {} arguments", names.len()),
            ));
        }
        for (p, n) in params.iter().zip(names) {
            self.lambda.push((p.clone(), n));
        }
        let out = self.emit(body);
        self.lambda.clear();
        out
    }

    fn call(&mut self, callee: &Expr, args: &[Expr], pos: usize) -> Res<B> {
        let Expr::Var { name, .. } = callee else {
            return Err(self.err(pos, "only named functions can be called"));
        };
        let arity = |min: usize, max: usize| -> Res<()> {
            if args.len() < min || args.len() > max {
                let want = if min == max {
                    min.to_string()
                } else {
                    format!("{min} to {max}")
                };
                Err(self.err(
                    pos,
                    format!("{name}() takes {want} argument(s), found {}", args.len()),
                ))
            } else {
                Ok(())
            }
        };
        macro_rules! a {
            ($i:expr) => {
                self.emit(&args[$i])?
            };
        }
        macro_rules! rest {
            ($from:expr) => {
                args[$from..]
                    .iter()
                    .map(|x| self.emit(x))
                    .collect::<Res<Vec<B>>>()?
            };
        }
        Ok(match name.as_str() {
            "contains" => {
                arity(2, 2)?;
                method(a!(0), "contains", vec![a!(1)])
            }
            "length" => {
                arity(1, 1)?;
                member(a!(0), "length")
            }
            "lower" => {
                arity(1, 1)?;
                method(a!(0), "lower", vec![])
            }
            "replace" => {
                arity(3, 3)?;
                method(a!(0), "replace", vec![a!(1), a!(2)])
            }
            "split" => {
                arity(2, 3)?;
                method(a!(0), "split", rest!(1))
            }
            "startswith" => {
                arity(2, 2)?;
                method(a!(0), "startsWith", vec![a!(1)])
            }
            "endswith" => {
                arity(2, 2)?;
                method(a!(0), "endsWith", vec![a!(1)])
            }
            "substring" => {
                arity(2, 3)?;
                method(a!(0), "slice", rest!(1))
            }
            "round" => {
                arity(1, 2)?;
                method(a!(0), "round", rest!(1))
            }
            "floor" | "ceil" | "abs" => {
                arity(1, 1)?;
                method(a!(0), name, vec![])
            }
            "min" | "max" => {
                arity(1, usize::MAX)?;
                if args.len() == 1 {
                    method(a!(0), name, vec![])
                } else {
                    global(name, rest!(0))
                }
            }
            "sum" => {
                arity(1, 1)?;
                method(a!(0), "sum", vec![])
            }
            "average" => {
                arity(1, 1)?;
                method(a!(0), "mean", vec![])
            }
            "reverse" | "flat" => {
                arity(1, 1)?;
                method(a!(0), name, vec![])
            }
            "sort" => {
                arity(1, 1)?;
                method(a!(0), "sort", vec![])
            }
            "join" => {
                arity(1, 2)?;
                let sep = if args.len() == 2 { a!(1) } else { string(", ") };
                method(a!(0), "join", vec![sep])
            }
            "slice" => {
                arity(2, 3)?;
                method(a!(0), "slice", rest!(1))
            }
            "map" | "filter" => {
                arity(2, 2)?;
                let list = a!(0);
                let body = self.lambda_arg(&args[1], &["value", "index"], pos, name)?;
                method(list, name, vec![body])
            }
            "reduce" => {
                arity(3, 3)?;
                let list = a!(0);
                let body = self.lambda_arg(&args[1], &["acc", "value"], pos, name)?;
                method(list, "reduce", vec![body, a!(2)])
            }
            "choice" => {
                arity(3, 3)?;
                global("if", rest!(0))
            }
            "default" => {
                arity(2, 2)?;
                let value = a!(0);
                global(
                    "if",
                    vec![binary(BinaryOp::Eq, value.clone(), B::Null), a!(1), value],
                )
            }
            "number" => {
                arity(1, 1)?;
                global("number", vec![a!(0)])
            }
            "string" => {
                arity(1, 1)?;
                method(a!(0), "toString", vec![])
            }
            "date" => {
                arity(1, 1)?;
                global("date", vec![a!(0)])
            }
            "dur" => {
                arity(1, 1)?;
                global("duration", vec![a!(0)])
            }
            "link" => {
                arity(1, 2)?;
                global("link", rest!(0))
            }
            "striptime" => {
                arity(1, 1)?;
                method(a!(0), "date", vec![])
            }
            "list" | "array" => B::List(rest!(0)),
            other => {
                if crate::bases::dialect::has_function(other) {
                    self.flag(format!("{other}() has no Bases form"));
                    global(other, rest!(0))
                } else {
                    return Err(self.err(pos, format!("unknown function \"{other}\"")));
                }
            }
        })
    }

    // ----- sources -------------------------------------------------------------

    fn file(&self) -> B {
        ident("file")
    }

    fn source_expr(&self, s: &Source) -> B {
        match s {
            Source::Tag(t) => method(self.file(), "hasTag", vec![string(t)]),
            Source::Path(p) => {
                let p = p.trim().trim_matches('/');
                let path = || member(self.file(), "path");
                let eq = |x: String| binary(BinaryOp::Eq, path(), B::Str(x));
                binary(
                    BinaryOp::Or,
                    binary(
                        BinaryOp::Or,
                        method(self.file(), "inFolder", vec![string(p)]),
                        eq(p.to_string()),
                    ),
                    eq(format!("{p}.md")),
                )
            }
            Source::Incoming(p) => method(self.file(), "hasLink", vec![string(p)]),
            Source::Outgoing(p) => method(
                member(self.file(), "backlinks"),
                "contains",
                vec![global("link", vec![string(p)])],
            ),
            Source::Not(inner) => B::Unary(UnaryOp::Not, Box::new(self.source_expr(inner))),
            Source::And(l, r) => binary(BinaryOp::And, self.source_expr(l), self.source_expr(r)),
            Source::Or(l, r) => binary(BinaryOp::Or, self.source_expr(l), self.source_expr(r)),
        }
    }

    // ----- properties and formulas ------------------------------------------------

    /// The property id of an expression: itself when it is a plain property, else a formula.
    fn id_for(&mut self, b: &B, prefix: &str) -> String {
        let plain = match b {
            B::Ident(n) if !NAMESPACES.contains(&n.as_str()) => Some(n.clone()),
            B::Member(o, n) => match &**o {
                B::Ident(ns) if ns == "file" || ns == "task" => Some(format!("{ns}.{n}")),
                _ => None,
            },
            B::Index(o, k) => match (&**o, &**k) {
                (B::Ident(ns), B::Str(k))
                    if ns == "note"
                        && !k.starts_with("file.")
                        && !k.starts_with("note.")
                        && !k.starts_with("formula.") =>
                {
                    Some(k.clone())
                }
                _ => None,
            },
            _ => None,
        };
        if let Some(id) = plain {
            return id;
        }
        let src = source(b);
        if let Some((name, _)) = self.formulas.iter().find(|(_, s)| *s == src) {
            return format!("formula.{name}");
        }
        let name = format!("{prefix}{}", self.formulas.len() + 1);
        self.formulas.push((name.clone(), src));
        format!("formula.{name}")
    }

    fn title(&mut self, id: &str, name: &str) {
        let cfg = PropertyConfig {
            display_name: Some(name.to_string()),
            extra: Vec::new(),
        };
        match self.props.iter_mut().find(|(k, _)| k == id) {
            Some(slot) => slot.1 = cfg,
            None => self.props.push((id.to_string(), cfg)),
        }
    }

    /// A column for `field`, titled with its name; returns its id.
    fn column(&mut self, field: &NamedField) -> Res<String> {
        self.flags.clear();
        let b = self.emit(&field.expr)?;
        let id = self.id_for(&b, "c");
        self.title(&id, &field.name);
        let clause = if self.flags.is_empty() { "" } else { "TABLE" };
        self.close_clause(clause, field.pos);
        Ok(id)
    }

    fn file_link_column(&mut self) -> String {
        let id = self.id_for(&as_link(self.file()), "f");
        self.title(&id, "File");
        id
    }

    // ----- the query -----------------------------------------------------------------

    fn run(mut self, q: &Query) -> Res<Lowered> {
        self.task = matches!(q.header, Header::Task);
        let mut filters: Vec<String> = Vec::new();
        if !self.task {
            filters.push(source(&binary(
                BinaryOp::Eq,
                member(self.file(), "ext"),
                string("md"),
            )));
        }
        if let Some(from) = &q.from {
            filters.push(source(&self.source_expr(from)));
        }

        // LIMIT runs last here: one before another clause would change the result
        let last = q
            .clauses
            .iter()
            .rposition(|c| !matches!(c, Clause::Limit { .. }));
        for (i, c) in q.clauses.iter().enumerate() {
            if matches!(c, Clause::Limit { .. }) && last.is_some_and(|l| i < l) {
                return Err(self.err(
                    c.pos(),
                    "LIMIT must come after WHERE, SORT, GROUP BY and FLATTEN",
                ));
            }
        }

        let mut flatten: Vec<FlattenL> = Vec::new();
        let mut sorts: Vec<(String, bool)> = Vec::new();
        let mut group: Option<GroupL> = None;
        let mut limit: Option<u64> = None;

        for c in &q.clauses {
            self.flags.clear();
            match c {
                Clause::Where { expr, pos } => {
                    let src = source(&self.emit(expr)?);
                    match (&mut group, flatten.last_mut()) {
                        (Some(g), _) => {
                            if self.task {
                                return Err(self.err(
                                    *pos,
                                    "WHERE after GROUP BY is not supported in a TASK query",
                                ));
                            }
                            g.wheres.push(src);
                            self.flag(
                                "a clause after GROUP BY filters groups, which a base cannot",
                            );
                        }
                        (None, Some(f)) => f.wheres.push(src),
                        (None, None) => filters.push(src),
                    }
                }
                Clause::Sort { keys, pos } => {
                    let mut ids = Vec::new();
                    for (e, desc) in keys {
                        let b = self.emit(e)?;
                        ids.push((self.id_for(&b, "s"), *desc));
                    }
                    match &mut group {
                        Some(g) => {
                            if self.task {
                                return Err(self.err(
                                    *pos,
                                    "SORT after GROUP BY is not supported in a TASK query",
                                ));
                            }
                            // a later SORT outranks the earlier ones
                            ids.extend(std::mem::take(&mut g.sorts));
                            g.sorts = ids;
                            self.flag("a clause after GROUP BY sorts groups, which a base cannot");
                        }
                        None => {
                            ids.extend(std::mem::take(&mut sorts));
                            sorts = ids;
                        }
                    }
                }
                Clause::Limit { expr, pos } => {
                    let Expr::Number(n) = expr else {
                        return Err(self.err(*pos, "LIMIT takes a number"));
                    };
                    if *n < 0.0 || n.fract() != 0.0 {
                        return Err(self.err(*pos, "LIMIT takes a whole number"));
                    }
                    limit = Some(limit.map_or(*n as u64, |l| l.min(*n as u64)));
                }
                Clause::Flatten { field, pos } => {
                    if group.is_some() {
                        return Err(self.err(*pos, "FLATTEN after GROUP BY is not supported"));
                    }
                    let expr = source(&self.emit(&field.expr)?);
                    flatten.push(FlattenL {
                        expr,
                        name: field.name.clone(),
                        wheres: Vec::new(),
                    });
                    self.flag("FLATTEN has no Bases form");
                }
                Clause::Group { field, pos } => {
                    if group.is_some() {
                        return Err(self.err(*pos, "only one GROUP BY is supported"));
                    }
                    let b = self.emit(&field.expr)?;
                    let id = self.id_for(&b, "g");
                    group = Some(GroupL {
                        name: field.name.clone(),
                        id,
                        wheres: Vec::new(),
                        sorts: Vec::new(),
                    });
                    if !self.task {
                        self.flag("a grouped query has one row per group, a base groups its rows");
                    }
                }
            }
            self.close_clause(c.keyword(), c.pos());
        }

        // columns, in group mode when the query groups
        let (kind, view_type, view_name, order, extra) = self.header(q, &group)?;

        let mut view = View::default_table();
        view.view_type = view_type.to_string();
        view.name = view_name.to_string();
        view.order = Some(order);
        view.sort = sorts
            .iter()
            .map(|(id, desc)| SortKey {
                property: id.clone(),
                direction: if *desc {
                    Direction::Desc
                } else {
                    Direction::Asc
                },
                extra: Vec::new(),
            })
            .collect();
        view.limit = limit;
        view.extra = extra;
        if !flatten.is_empty() {
            view.extra.push((
                "flatten".into(),
                Node::Seq(
                    flatten
                        .iter()
                        .map(|f| {
                            let mut m = vec![
                                ("expr".to_string(), Node::Str(f.expr.clone())),
                                ("as".to_string(), Node::Str(f.name.clone())),
                            ];
                            if !f.wheres.is_empty() {
                                m.push(("where".to_string(), strs(&f.wheres)));
                            }
                            Node::Map(m)
                        })
                        .collect(),
                ),
            ));
        }
        if let Some(g) = &group {
            view.group_by = Some(GroupBy {
                property: g.id.clone(),
                direction: Direction::Asc,
                extra: Vec::new(),
            });
            if !self.task {
                let mut m = vec![("as".to_string(), Node::Str(g.name.clone()))];
                if !g.wheres.is_empty() {
                    m.push(("where".to_string(), strs(&g.wheres)));
                }
                if !g.sorts.is_empty() {
                    m.push((
                        "sort".to_string(),
                        Node::Seq(
                            g.sorts
                                .iter()
                                .map(|(id, desc)| {
                                    Node::Map(vec![
                                        ("property".to_string(), Node::Str(id.clone())),
                                        (
                                            "direction".to_string(),
                                            Node::Str(if *desc { "DESC" } else { "ASC" }.into()),
                                        ),
                                    ])
                                })
                                .collect(),
                        ),
                    ));
                }
                view.extra.push(("dqlGroup".into(), Node::Map(m)));
            }
        } else if self.task {
            // Dataview shows tasks grouped under their file
            let id = self.file_link_column_for_group();
            view.group_by = Some(GroupBy {
                property: id,
                direction: Direction::Asc,
                extra: Vec::new(),
            });
        }

        let mut doc = Document::default();
        doc.filters = Some(Filter::And(filters.into_iter().map(Filter::Expr).collect()));
        doc.formulas = self.formulas;
        doc.properties = self.props;
        doc.views = vec![view];
        if self.task {
            doc.rows = crate::bases::document::RowKind::Tasks;
        }
        Ok(Lowered {
            document: doc,
            kind,
            unmapped: self.unmapped,
        })
    }

    fn file_link_column_for_group(&mut self) -> String {
        self.id_for(&as_link(self.file()), "f")
    }

    #[allow(clippy::type_complexity)]
    fn header(
        &mut self,
        q: &Query,
        group: &Option<GroupL>,
    ) -> Res<(
        Kind,
        &'static str,
        &'static str,
        Vec<String>,
        Vec<(String, Node)>,
    )> {
        let mut order: Vec<String> = Vec::new();
        let mut extra: Vec<(String, Node)> = Vec::new();
        // the first column: the file, or the group key
        let first = |this: &mut Self, show: bool, order: &mut Vec<String>| {
            if !show {
                return;
            }
            if group.is_some() && !this.task {
                this.title("key", "Group");
                order.push("key".to_string());
            } else {
                order.push(this.file_link_column());
            }
        };
        let out = match &q.header {
            Header::Table { without_id, fields } => {
                first(self, !without_id, &mut order);
                for f in fields {
                    order.push(self.column(f)?);
                }
                (Kind::Table, "table", "Table")
            }
            Header::List { without_id, format } => {
                first(self, !without_id, &mut order);
                if let Some(e) = format {
                    self.flags.clear();
                    let b = self.emit(e)?;
                    let id = self.id_for(&b, "c");
                    self.close_clause("LIST", 0);
                    if !without_id {
                        extra.push(("separator".into(), Node::Str(": ".into())));
                    }
                    order.push(id);
                }
                if order.is_empty() {
                    order.push(self.file_link_column());
                }
                (Kind::List, "list", "List")
            }
            Header::Task => {
                order.push("task.description".to_string());
                (Kind::Task, "list", "Tasks")
            }
            Header::Calendar(field) => {
                first(self, true, &mut order);
                let date = self.column(field)?;
                extra.push(("dateProperty".into(), Node::Str(date.clone())));
                order.push(date);
                (Kind::Calendar, "calendar", "Calendar")
            }
        };
        Ok((out.0, out.1, out.2, order, extra))
    }
}

/// Where an expression starts, for an error that has nothing better to point at.
fn pos_of(e: &Expr) -> usize {
    match e {
        Expr::Var { pos, .. } | Expr::Call { pos, .. } => *pos,
        Expr::Field(o, _) | Expr::Index(o, _) => pos_of(o),
        _ => 0,
    }
}

fn strs(v: &[String]) -> Node {
    Node::Seq(v.iter().map(|s| Node::Str(s.clone())).collect())
}
