//! The expression interpreter. Pure: all outside knowledge comes through the
//! injected [`Clock`] and [`RowContext`]. Failures are `Value::Error`, never
//! panics (U4); the semantics chosen where the docs are silent are listed in
//! [`super::choices`].

use super::ast::{BinaryOp, Expr, PropertyId, UnaryOp};
use super::choices;
use super::context::{file_basename, file_ext, file_folder, file_name, Clock, RowContext};
use super::datetime::{self, DurationValue};
use super::functions;
use super::lexer::ParseError;
use super::parser;
use super::value::{DateValue, ErrorKind, ErrorValue, FileValue, LinkValue, RegexpValue, Value};
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;

const MAX_FORMULA_NESTING: usize = 48;
const MAX_EVAL_DEPTH: usize = 384;

/// Parsed formulas of a base (name -> compiled expression). A formula with a
/// syntax error keeps its error and only fails where it is used (U20).
#[derive(Debug, Default)]
pub struct FormulaSet {
    defs: Vec<(String, Result<Expr, ParseError>)>,
}

impl FormulaSet {
    pub fn compile(pairs: &[(String, String)]) -> FormulaSet {
        FormulaSet {
            defs: pairs
                .iter()
                .map(|(n, src)| (n.clone(), parser::parse(src)))
                .collect(),
        }
    }

    pub fn get(&self, name: &str) -> Option<&Result<Expr, ParseError>> {
        self.defs.iter().find(|(n, _)| n == name).map(|(_, e)| e)
    }

    pub fn names(&self) -> impl Iterator<Item = &str> {
        self.defs.iter().map(|(n, _)| n.as_str())
    }
}

/// Lambda variables (`value`, `index`, `acc`, `values`) layered over the row.
pub struct Scope<'a> {
    vars: Vec<(&'static str, Value)>,
    parent: Option<&'a Scope<'a>>,
}

impl<'a> Scope<'a> {
    pub fn root() -> Scope<'static> {
        Scope {
            vars: Vec::new(),
            parent: None,
        }
    }

    pub fn child(&'a self, vars: Vec<(&'static str, Value)>) -> Scope<'a> {
        Scope {
            vars,
            parent: Some(self),
        }
    }

    pub fn get(&self, name: &str) -> Option<&Value> {
        self.vars
            .iter()
            .rev()
            .find(|(n, _)| *n == name)
            .map(|(_, v)| v)
            .or_else(|| self.parent.and_then(|p| p.get(name)))
    }
}

/// Evaluates expressions against one row. Cheap to build; the query executor
/// builds one per row so formula results are memoized per row.
pub struct Interp<'a> {
    pub clock: &'a dyn Clock,
    pub row: Rc<dyn RowContext>,
    pub this: Option<Rc<dyn RowContext>>,
    formulas: &'a FormulaSet,
    memo: RefCell<HashMap<String, Value>>,
    active: RefCell<Vec<String>>,
    rng: Cell<u64>,
    depth: Cell<usize>,
}

impl<'a> Interp<'a> {
    pub fn new(
        clock: &'a dyn Clock,
        formulas: &'a FormulaSet,
        row: Rc<dyn RowContext>,
        this: Option<Rc<dyn RowContext>>,
    ) -> Interp<'a> {
        Interp {
            clock,
            row,
            this,
            formulas,
            memo: RefCell::new(HashMap::new()),
            active: RefCell::new(Vec::new()),
            // deterministic: derived from the injected clock
            rng: Cell::new((clock.now_utc_ms() as u64) ^ 0x9E37_79B9_7F4A_7C15),
            depth: Cell::new(0),
        }
    }

    pub fn set_seed(&self, seed: u64) {
        self.rng.set(seed | 1);
    }

    /// Next pseudo-random number in `[0, 1)` (xorshift64*).
    pub fn next_random(&self) -> f64 {
        let mut x = self.rng.get();
        if x == 0 {
            x = 0x2545_F491_4F6C_DD1D;
        }
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.rng.set(x);
        let r = x.wrapping_mul(0x2545_F491_4F6C_DD1D);
        (r >> 11) as f64 / (1u64 << 53) as f64
    }

    pub fn offset(&self) -> i32 {
        self.clock.utc_offset_minutes()
    }

    /// Parse and evaluate; a syntax error becomes an error value.
    pub fn eval_source(&self, src: &str) -> Value {
        match parser::parse(src) {
            Ok(e) => self.eval(&e, &Scope::root()),
            Err(pe) => syntax_value(&pe),
        }
    }

    // ----- row access ------------------------------------------------------

    pub fn ctx_for(&self, path: &str) -> Option<Rc<dyn RowContext>> {
        if self.row.path() == path {
            return Some(self.row.clone());
        }
        self.row.context_for_path(path)
    }

    /// A frontmatter value with wikilink strings turned into links (U19).
    pub fn note_value(&self, ctx: &Rc<dyn RowContext>, key: &str) -> Value {
        match ctx.property(key) {
            Some(v) => self.coerce_property(ctx, v),
            None => Value::Null,
        }
    }

    pub fn coerce_property(&self, ctx: &Rc<dyn RowContext>, v: Value) -> Value {
        match v {
            Value::String(s) => match LinkValue::parse_wikilink(&s) {
                Some((target, display)) => {
                    let resolved = ctx.resolve_link(&target);
                    Value::Link(LinkValue {
                        target,
                        display,
                        resolved,
                    })
                }
                None => Value::String(s),
            },
            Value::List(l) => Value::List(
                l.into_iter()
                    .map(|x| self.coerce_property(ctx, x))
                    .collect(),
            ),
            Value::Object(o) => Value::Object(
                o.into_iter()
                    .map(|(k, x)| (k, self.coerce_property(ctx, x)))
                    .collect(),
            ),
            other => other,
        }
    }

    fn properties_object(&self, ctx: &Rc<dyn RowContext>) -> Value {
        Value::Object(
            ctx.properties()
                .into_iter()
                .map(|(k, v)| {
                    let v = self.coerce_property(ctx, v);
                    (k, v)
                })
                .collect(),
        )
    }

    fn link_list(links: Vec<LinkValue>) -> Value {
        Value::List(links.into_iter().map(Value::Link).collect())
    }

    /// `file.<name>` for the file at `path`. Unknown names are errors.
    pub fn file_field(&self, path: &str, name: &str) -> Value {
        let Some(ctx) = self.ctx_for(path) else {
            return Value::err(ErrorKind::Runtime, format!("file not found: {path}"));
        };
        let meta = ctx.meta();
        match name {
            "name" => Value::str(file_name(path)),
            "basename" => Value::str(file_basename(path)),
            "path" => Value::str(path),
            "folder" => Value::str(file_folder(path)),
            "ext" => Value::str(file_ext(path)),
            "size" => Value::Number(meta.size as f64),
            "ctime" => Value::date(meta.ctime_ms, true),
            "mtime" => Value::date(meta.mtime_ms, true),
            "tags" => Value::List(ctx.tags().into_iter().map(Value::String).collect()),
            "links" => Self::link_list(ctx.links()),
            "embeds" => Self::link_list(ctx.embeds()),
            "backlinks" => Value::List(
                ctx.backlinks()
                    .into_iter()
                    .map(|p| {
                        Value::Link(LinkValue {
                            target: p.clone(),
                            display: None,
                            resolved: Some(p),
                        })
                    })
                    .collect(),
            ),
            "properties" => self.properties_object(&ctx),
            "file" => Value::File(FileValue {
                path: path.to_string(),
            }),
            other => Value::err(
                ErrorKind::UnknownField,
                format!("unknown file property \"{other}\""),
            ),
        }
    }

    /// `this.<name>` (U15): file fields first, then note properties.
    fn this_member(&self, name: &str) -> Value {
        let Some(ctx) = self.this.clone().or_else(|| Some(self.row.clone())) else {
            return Value::Null;
        };
        let path = ctx.path();
        if name == "note" {
            return self.properties_object(&ctx);
        }
        match self.file_field(&path, name) {
            Value::Error(e) if e.kind == ErrorKind::UnknownField => self.note_value(&ctx, name),
            v => v,
        }
    }

    fn this_value(&self) -> Value {
        match &self.this {
            Some(c) => Value::File(FileValue { path: c.path() }),
            None => Value::Null,
        }
    }

    // ----- formulas --------------------------------------------------------

    pub fn eval_formula(&self, name: &str) -> Value {
        if let Some(v) = self.memo.borrow().get(name) {
            return v.clone();
        }
        let Some(def) = self.formulas.get(name) else {
            return Value::err(
                ErrorKind::UnknownFormula,
                format!("unknown formula \"{name}\""),
            );
        };
        if self.active.borrow().iter().any(|n| n == name) {
            return Value::err(
                ErrorKind::Circular,
                format!("formula \"{name}\" refers to itself"),
            );
        }
        if self.active.borrow().len() >= MAX_FORMULA_NESTING {
            return Value::err(ErrorKind::Runtime, "formulas nested too deeply");
        }
        let v = match def {
            Err(pe) => syntax_value(pe),
            Ok(expr) => {
                self.active.borrow_mut().push(name.to_string());
                let v = self.eval(expr, &Scope::root());
                self.active.borrow_mut().pop();
                v
            }
        };
        self.memo.borrow_mut().insert(name.to_string(), v.clone());
        v
    }

    /// Value of a property id for the current row (a table cell).
    pub fn eval_property(&self, id: &PropertyId) -> Value {
        match id {
            PropertyId::Note(k) => self.note_value(&self.row.clone(), k),
            PropertyId::File(f) => self.file_field(&self.row.path(), f),
            PropertyId::Formula(n) => self.eval_formula(n),
        }
    }

    // ----- evaluation ------------------------------------------------------

    pub fn eval(&self, e: &Expr, sc: &Scope) -> Value {
        // Bounds the real recursion depth (nested expressions, lambdas and
        // formula references together), whatever the AST looks like.
        let d = self.depth.get();
        if d >= MAX_EVAL_DEPTH {
            return Value::err(ErrorKind::Runtime, "expression too deep");
        }
        self.depth.set(d + 1);
        let v = self.eval_node(e, sc);
        self.depth.set(d);
        v
    }

    fn eval_node(&self, e: &Expr, sc: &Scope) -> Value {
        match e {
            Expr::Null => Value::Null,
            Expr::Bool(b) => Value::Bool(*b),
            Expr::Number(n) => Value::Number(*n),
            Expr::Str(s) => Value::String(s.clone()),
            Expr::Regex { source, flags } => match RegexpValue::new(source, flags) {
                Ok(r) => Value::Regexp(r),
                Err(e) => Value::Error(e),
            },
            Expr::List(items) => {
                let mut out = Vec::with_capacity(items.len());
                for i in items {
                    let v = self.eval(i, sc);
                    if let Value::Error(_) = v {
                        return v;
                    }
                    out.push(v);
                }
                Value::List(out)
            }
            Expr::Ident(name) => self.ident(name, sc),
            Expr::Member(obj, name) => {
                if let Expr::Ident(ns) = &**obj {
                    if sc.get(ns).is_none() {
                        match ns.as_str() {
                            "formula" => return self.eval_formula(name),
                            "this" => return self.this_member(name),
                            "note" => return self.note_value(&self.row.clone(), name),
                            _ => {}
                        }
                    }
                }
                let recv = self.eval(obj, sc);
                self.get_field(recv, name)
            }
            Expr::Index(obj, idx) => {
                let key = self.eval(idx, sc);
                if let Value::Error(_) = key {
                    return key;
                }
                if let (Expr::Ident(ns), Value::String(k)) = (&**obj, &key) {
                    if sc.get(ns).is_none() {
                        match ns.as_str() {
                            "formula" => return self.eval_formula(k),
                            "this" => return self.this_member(k),
                            "note" => return self.note_value(&self.row.clone(), k),
                            _ => {}
                        }
                    }
                }
                let recv = self.eval(obj, sc);
                self.index(recv, key)
            }
            Expr::Call(callee, args) => match &**callee {
                Expr::Ident(name) => functions::call_global(self, name, args, sc),
                Expr::Member(obj, name) => {
                    let recv = self.eval(obj, sc);
                    if let Value::Error(_) = recv {
                        return recv;
                    }
                    functions::call_method(self, recv, name, args, sc)
                }
                _ => Value::err(ErrorKind::Type, "this expression is not a function"),
            },
            Expr::Unary(op, inner) => {
                let v = self.eval(inner, sc);
                if let Value::Error(_) = v {
                    return v;
                }
                match op {
                    UnaryOp::Not => Value::Bool(!v.truthy()),
                    UnaryOp::Neg => match v {
                        Value::Number(n) => Value::Number(-n),
                        Value::Duration(d) => Value::Duration(d.neg()),
                        other => Value::err(
                            ErrorKind::Type,
                            format!("cannot negate a {}", other.type_name()),
                        ),
                    },
                }
            }
            Expr::Binary(op, l, r) => self.binary(*op, l, r, sc),
        }
    }

    fn ident(&self, name: &str, sc: &Scope) -> Value {
        if let Some(v) = sc.get(name) {
            return v.clone();
        }
        match name {
            "file" => Value::File(FileValue {
                path: self.row.path(),
            }),
            "note" => self.properties_object(&self.row.clone()),
            "this" => self.this_value(),
            "formula" => Value::err(
                ErrorKind::Type,
                "\"formula\" must be followed by a formula name",
            ),
            _ => self.note_value(&self.row.clone(), name),
        }
    }

    pub fn get_field(&self, recv: Value, name: &str) -> Value {
        match recv {
            Value::Error(_) => recv,
            Value::Null => {
                if choices::NULL_PROPAGATES {
                    Value::Null
                } else {
                    Value::err(ErrorKind::Type, format!("cannot read \"{name}\" of null"))
                }
            }
            Value::String(ref s) if name == "length" => Value::Number(s.chars().count() as f64),
            Value::List(ref l) if name == "length" => Value::Number(l.len() as f64),
            Value::Object(o) => o
                .into_iter()
                .find(|(k, _)| k == name)
                .map(|(_, v)| v)
                .unwrap_or(Value::Null),
            Value::Date(d) => date_field(&d, name),
            Value::Duration(d) => duration_field(&d, name),
            Value::File(f) => self.file_field(&f.path, name),
            other => Value::err(
                ErrorKind::UnknownField,
                format!("a {} has no property \"{name}\"", other.type_name()),
            ),
        }
    }

    fn index(&self, recv: Value, key: Value) -> Value {
        match (&recv, &key) {
            (Value::Error(_), _) => recv,
            (Value::Null, _) => Value::Null,
            (Value::List(l), Value::Number(n)) => {
                if n.fract() != 0.0 || *n < 0.0 {
                    return Value::Null;
                }
                l.get(*n as usize).cloned().unwrap_or(Value::Null)
            }
            (
                Value::Object(_) | Value::File(_) | Value::Date(_) | Value::Duration(_),
                Value::String(k),
            ) => self.get_field(recv.clone(), k),
            (r, k) => Value::err(
                ErrorKind::Type,
                format!("cannot index a {} with a {}", r.type_name(), k.type_name()),
            ),
        }
    }

    fn binary(&self, op: BinaryOp, l: &Expr, r: &Expr, sc: &Scope) -> Value {
        match op {
            BinaryOp::And => {
                let a = self.eval(l, sc);
                if let Value::Error(_) = a {
                    return a;
                }
                if !a.truthy() {
                    return Value::Bool(false);
                }
                let b = self.eval(r, sc);
                if let Value::Error(_) = b {
                    return b;
                }
                Value::Bool(b.truthy())
            }
            BinaryOp::Or => {
                let a = self.eval(l, sc);
                if let Value::Error(_) = a {
                    return a;
                }
                if a.truthy() {
                    return Value::Bool(true);
                }
                let b = self.eval(r, sc);
                if let Value::Error(_) = b {
                    return b;
                }
                Value::Bool(b.truthy())
            }
            _ => {
                let a = self.eval(l, sc);
                if let Value::Error(_) = a {
                    return a;
                }
                let b = self.eval(r, sc);
                if let Value::Error(_) = b {
                    return b;
                }
                apply_binary(op, a, b)
            }
        }
    }
}

pub fn syntax_value(pe: &ParseError) -> Value {
    Value::err(
        ErrorKind::Syntax,
        format!("syntax error at {}: {}", pe.pos, pe.message),
    )
}

fn date_field(d: &DateValue, name: &str) -> Value {
    let c = datetime::civil_from_ms(d.ms);
    match name {
        "year" => Value::Number(c.year as f64),
        "month" => Value::Number(c.month as f64),
        "day" => Value::Number(c.day as f64),
        "hour" => Value::Number(c.hour as f64),
        "minute" => Value::Number(c.minute as f64),
        "second" => Value::Number(c.second as f64),
        "millisecond" => Value::Number(c.milli as f64),
        other => Value::err(
            ErrorKind::UnknownField,
            format!("a date has no property \"{other}\""),
        ),
    }
}

/// U3: fractional totals.
fn duration_field(d: &DurationValue, name: &str) -> Value {
    let ms = d.total_millis();
    let day = datetime::MS_PER_DAY as f64;
    let n = match name {
        "milliseconds" => ms,
        "seconds" => ms / 1_000.0,
        "minutes" => ms / 60_000.0,
        "hours" => ms / 3_600_000.0,
        "days" => ms / day,
        "weeks" => ms / (7.0 * day),
        "months" => ms / (30.4375 * day),
        "years" => ms / (365.25 * day),
        other => {
            return Value::err(
                ErrorKind::UnknownField,
                format!("a duration has no property \"{other}\""),
            )
        }
    };
    Value::Number(n)
}

fn has_time_after(ms: i64, was_time: bool) -> bool {
    was_time || ms.rem_euclid(datetime::MS_PER_DAY) != 0
}

fn shift_date(d: &DateValue, dur: &DurationValue) -> Value {
    match dur.add_to(d.ms) {
        Some(ms) => Value::date(ms, has_time_after(ms, d.has_time)),
        None => Value::err(ErrorKind::Runtime, "date out of range"),
    }
}

fn duration_arg(v: &Value) -> Result<DurationValue, Value> {
    match v {
        Value::Duration(d) => Ok(*d),
        Value::String(s) => datetime::parse_duration(s)
            .ok_or_else(|| Value::err(ErrorKind::Runtime, format!("invalid duration \"{s}\""))),
        other => Err(Value::err(
            ErrorKind::Type,
            format!("expected a duration, found a {}", other.type_name()),
        )),
    }
}

/// Arithmetic and comparison on two evaluated, non-error operands.
pub fn apply_binary(op: BinaryOp, a: Value, b: Value) -> Value {
    use BinaryOp::*;
    match op {
        Eq => Value::Bool(a.equals(&b)),
        Ne => Value::Bool(!a.equals(&b)),
        Lt | Gt | Le | Ge => match a.compare(&b) {
            Some(o) => Value::Bool(match op {
                Lt => o.is_lt(),
                Gt => o.is_gt(),
                Le => o.is_le(),
                _ => o.is_ge(),
            }),
            None => {
                if choices::MIXED_COMPARE_IS_ERROR && !a.is_null() && !b.is_null() {
                    type_error(op, &a, &b)
                } else {
                    Value::Bool(false)
                }
            }
        },
        Add => match (&a, &b) {
            (Value::Number(x), Value::Number(y)) => Value::Number(x + y),
            (Value::Date(d), Value::Duration(u)) | (Value::Duration(u), Value::Date(d)) => {
                shift_date(d, u)
            }
            (Value::Date(d), Value::String(_)) => match duration_arg(&b) {
                Ok(u) => shift_date(d, &u),
                Err(e) => e,
            },
            (Value::Duration(x), Value::Duration(y)) => Value::Duration(x.add(y)),
            (Value::String(x), other) if concat_ok(other) => {
                Value::String(format!("{x}{}", other.display()))
            }
            (other, Value::String(y)) if concat_ok(other) => {
                Value::String(format!("{}{y}", other.display()))
            }
            _ => type_error(op, &a, &b),
        },
        Sub => match (&a, &b) {
            (Value::Number(x), Value::Number(y)) => Value::Number(x - y),
            (Value::Date(x), Value::Date(y)) => {
                Value::Duration(DurationValue::from_millis(x.ms.saturating_sub(y.ms)))
            }
            (Value::Date(d), Value::Duration(_) | Value::String(_)) => match duration_arg(&b) {
                Ok(u) => shift_date(d, &u.neg()),
                Err(e) => e,
            },
            (Value::Duration(x), Value::Duration(y)) => Value::Duration(x.add(&y.neg())),
            _ => type_error(op, &a, &b),
        },
        Mul => match (&a, &b) {
            (Value::Number(x), Value::Number(y)) => Value::Number(x * y),
            (Value::Duration(d), Value::Number(k)) => Value::Duration(d.scale(*k)),
            (Value::Number(_), Value::Duration(_)) => Value::err(
                ErrorKind::Type,
                "a duration must come first when multiplying: duration * number",
            ),
            _ => type_error(op, &a, &b),
        },
        Div => match (&a, &b) {
            (Value::Number(_), Value::Number(y)) | (Value::Duration(_), Value::Number(y))
                if *y == 0.0 =>
            {
                Value::err(ErrorKind::Runtime, "division by zero")
            }
            (Value::Number(x), Value::Number(y)) => Value::Number(x / y),
            (Value::Duration(d), Value::Number(k)) => Value::Duration(d.scale(1.0 / k)),
            _ => type_error(op, &a, &b),
        },
        Mod => match (&a, &b) {
            (Value::Number(_), Value::Number(y)) if *y == 0.0 => {
                Value::err(ErrorKind::Runtime, "division by zero")
            }
            (Value::Number(x), Value::Number(y)) => Value::Number(x % y),
            _ => type_error(op, &a, &b),
        },
        And | Or => Value::err(ErrorKind::Runtime, "logical operators are evaluated lazily"),
    }
}

fn concat_ok(v: &Value) -> bool {
    !matches!(v, Value::Null | Value::Error(_) | Value::Regexp(_))
}

fn type_error(op: BinaryOp, a: &Value, b: &Value) -> Value {
    Value::err(
        ErrorKind::Type,
        format!(
            "cannot apply \"{}\" to a {} and a {}",
            op.symbol(),
            a.type_name(),
            b.type_name()
        ),
    )
}

pub fn err_value(e: ErrorValue) -> Value {
    Value::Error(e)
}
