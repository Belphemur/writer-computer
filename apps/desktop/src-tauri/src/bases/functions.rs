//! The function and method registry. One table, `FUNCTIONS`, holds every
//! documented global function and every method per receiver type; adding the
//! next function is one entry here (see `docs/consolidation.md`).
//!
//! Surface is exactly the public docs
//! (https://obsidian.md/help/bases/functions) plus the list statistics noted as
//! U13 in [`super::choices`]. Unknown names are error values (U4).

use super::ast::Expr;
use super::choices;
use super::context::file_folder;
use super::datetime;
use super::interp::{Interp, Scope};
use super::value::{
    compare_for_sort, format_number, ErrorKind, ErrorValue, FileValue, LinkValue, RegexpValue, Ty,
    Value,
};

type Res = Result<Value, ErrorValue>;

pub enum Recv {
    /// A free function: `date(...)`.
    Global,
    /// A method available on every value: `x.toString()`.
    Any,
    /// A method of the listed receiver types.
    On(&'static [Ty]),
}

pub enum Imp {
    /// Arguments are evaluated first (errors propagate before the call).
    Eager(fn(&Interp, &Value, &[Value]) -> Res),
    /// Receives the argument expressions and the scope; used by `if` and the
    /// list functions whose argument is an expression over `value`/`index`/`acc`.
    Lazy(fn(&Interp, &Scope, &Value, &[Expr]) -> Res),
}

pub struct FnDef {
    pub name: &'static str,
    pub recv: Recv,
    pub min: usize,
    pub max: usize,
    pub imp: Imp,
    pub doc: &'static str,
}

const VAR: usize = usize::MAX;

macro_rules! f {
    ($name:expr, $recv:expr, $min:expr, $max:expr, $imp:expr, $doc:expr) => {
        FnDef {
            name: $name,
            recv: $recv,
            min: $min,
            max: $max,
            imp: $imp,
            doc: $doc,
        }
    };
}

use Imp::{Eager, Lazy};
use Recv::{Any, Global, On};

const STR: &[Ty] = &[Ty::String];
const NUM: &[Ty] = &[Ty::Number];
const DATE: &[Ty] = &[Ty::Date];
const LIST: &[Ty] = &[Ty::List];
const LINK: &[Ty] = &[Ty::Link];
const FILE: &[Ty] = &[Ty::File];
const OBJ: &[Ty] = &[Ty::Object];
const RE: &[Ty] = &[Ty::Regexp];
const EMPTYABLE: &[Ty] = &[
    Ty::Null,
    Ty::String,
    Ty::Number,
    Ty::Date,
    Ty::List,
    Ty::Object,
];

pub static FUNCTIONS: &[FnDef] = &[
    // ----- global ----------------------------------------------------------
    f!(
        "escapeHTML",
        Global,
        1,
        1,
        Eager(g_escape_html),
        "escapeHTML(html): string"
    ),
    f!("date", Global, 1, 1, Eager(g_date), "date(string): date"),
    f!(
        "duration",
        Global,
        1,
        1,
        Eager(g_duration),
        "duration(string): duration"
    ),
    f!(
        "file",
        Global,
        1,
        1,
        Eager(g_file),
        "file(path | file | link): file"
    ),
    f!("html", Global, 1, 1, Eager(g_html), "html(string): html"),
    f!(
        "if",
        Global,
        2,
        3,
        Lazy(g_if),
        "if(condition, trueResult, falseResult?)"
    ),
    f!(
        "image",
        Global,
        1,
        1,
        Eager(g_image),
        "image(path | file | url): image"
    ),
    f!("icon", Global, 1, 1, Eager(g_icon), "icon(name): icon"),
    f!(
        "link",
        Global,
        1,
        2,
        Eager(g_link),
        "link(path | file, display?): link"
    ),
    f!("list", Global, 1, 1, Eager(g_list), "list(element): list"),
    f!(
        "max",
        Global,
        1,
        VAR,
        Eager(g_max),
        "max(...numbers): number"
    ),
    f!(
        "min",
        Global,
        1,
        VAR,
        Eager(g_min),
        "min(...numbers): number"
    ),
    f!("now", Global, 0, 0, Eager(g_now), "now(): date"),
    f!(
        "number",
        Global,
        1,
        1,
        Eager(g_number),
        "number(value): number"
    ),
    f!("random", Global, 0, 0, Eager(g_random), "random(): number"),
    f!("today", Global, 0, 0, Eager(g_today), "today(): date"),
    // ----- any -------------------------------------------------------------
    f!(
        "isTruthy",
        Any,
        0,
        0,
        Eager(a_is_truthy),
        "any.isTruthy(): boolean"
    ),
    f!(
        "isType",
        Any,
        1,
        1,
        Eager(a_is_type),
        "any.isType(type): boolean"
    ),
    f!(
        "toString",
        Any,
        0,
        0,
        Eager(a_to_string),
        "any.toString(): string"
    ),
    f!(
        "isEmpty",
        On(EMPTYABLE),
        0,
        0,
        Eager(a_is_empty),
        "isEmpty(): boolean"
    ),
    // ----- string ----------------------------------------------------------
    f!(
        "contains",
        On(STR),
        1,
        1,
        Eager(s_contains),
        "string.contains(value): boolean"
    ),
    f!(
        "containsAll",
        On(STR),
        1,
        VAR,
        Eager(s_contains_all),
        "string.containsAll(...values): boolean"
    ),
    f!(
        "containsAny",
        On(STR),
        1,
        VAR,
        Eager(s_contains_any),
        "string.containsAny(...values): boolean"
    ),
    f!(
        "endsWith",
        On(STR),
        1,
        1,
        Eager(s_ends_with),
        "string.endsWith(query): boolean"
    ),
    f!(
        "lower",
        On(STR),
        0,
        0,
        Eager(s_lower),
        "string.lower(): string"
    ),
    f!(
        "replace",
        On(STR),
        2,
        2,
        Eager(s_replace),
        "string.replace(pattern, replacement): string"
    ),
    f!(
        "repeat",
        On(STR),
        1,
        1,
        Eager(s_repeat),
        "string.repeat(count): string"
    ),
    f!(
        "reverse",
        On(STR),
        0,
        0,
        Eager(s_reverse),
        "string.reverse(): string"
    ),
    f!(
        "slice",
        On(STR),
        1,
        2,
        Eager(s_slice),
        "string.slice(start, end?): string"
    ),
    f!(
        "split",
        On(STR),
        1,
        2,
        Eager(s_split),
        "string.split(separator, n?): list"
    ),
    f!(
        "startsWith",
        On(STR),
        1,
        1,
        Eager(s_starts_with),
        "string.startsWith(query): boolean"
    ),
    f!(
        "title",
        On(STR),
        0,
        0,
        Eager(s_title),
        "string.title(): string"
    ),
    f!(
        "trim",
        On(STR),
        0,
        0,
        Eager(s_trim),
        "string.trim(): string"
    ),
    // ----- number ----------------------------------------------------------
    f!("abs", On(NUM), 0, 0, Eager(n_abs), "number.abs(): number"),
    f!(
        "ceil",
        On(NUM),
        0,
        0,
        Eager(n_ceil),
        "number.ceil(): number"
    ),
    f!(
        "floor",
        On(NUM),
        0,
        0,
        Eager(n_floor),
        "number.floor(): number"
    ),
    f!(
        "round",
        On(NUM),
        0,
        1,
        Eager(n_round),
        "number.round(digits?): number"
    ),
    f!(
        "toFixed",
        On(NUM),
        1,
        1,
        Eager(n_to_fixed),
        "number.toFixed(precision): string"
    ),
    // ----- date ------------------------------------------------------------
    f!("date", On(DATE), 0, 0, Eager(d_date), "date.date(): date"),
    f!(
        "format",
        On(DATE),
        1,
        1,
        Eager(d_format),
        "date.format(format): string"
    ),
    f!("time", On(DATE), 0, 0, Eager(d_time), "date.time(): string"),
    f!(
        "relative",
        On(DATE),
        0,
        0,
        Eager(d_relative),
        "date.relative(): string"
    ),
    // ----- list ------------------------------------------------------------
    f!(
        "contains",
        On(LIST),
        1,
        1,
        Eager(l_contains),
        "list.contains(value): boolean"
    ),
    f!(
        "containsAll",
        On(LIST),
        1,
        VAR,
        Eager(l_contains_all),
        "list.containsAll(...values): boolean"
    ),
    f!(
        "containsAny",
        On(LIST),
        1,
        VAR,
        Eager(l_contains_any),
        "list.containsAny(...values): boolean"
    ),
    f!(
        "filter",
        On(LIST),
        1,
        1,
        Lazy(l_filter),
        "list.filter(expression): list"
    ),
    f!("flat", On(LIST), 0, 0, Eager(l_flat), "list.flat(): list"),
    f!(
        "join",
        On(LIST),
        1,
        1,
        Eager(l_join),
        "list.join(separator): string"
    ),
    f!(
        "map",
        On(LIST),
        1,
        1,
        Lazy(l_map),
        "list.map(expression): list"
    ),
    f!(
        "reduce",
        On(LIST),
        2,
        2,
        Lazy(l_reduce),
        "list.reduce(expression, initial): any"
    ),
    f!(
        "reverse",
        On(LIST),
        0,
        0,
        Eager(l_reverse),
        "list.reverse(): list"
    ),
    f!(
        "slice",
        On(LIST),
        1,
        2,
        Eager(l_slice),
        "list.slice(start, end?): list"
    ),
    f!("sort", On(LIST), 0, 0, Eager(l_sort), "list.sort(): list"),
    f!(
        "unique",
        On(LIST),
        0,
        0,
        Eager(l_unique),
        "list.unique(): list"
    ),
    // U13: not on the functions page, but used by the docs' summary example
    f!(
        "sum",
        On(LIST),
        0,
        0,
        Eager(l_sum),
        "list.sum(): number (U13)"
    ),
    f!(
        "mean",
        On(LIST),
        0,
        0,
        Eager(l_mean),
        "list.mean(): number (U13)"
    ),
    f!(
        "median",
        On(LIST),
        0,
        0,
        Eager(l_median),
        "list.median(): number (U13)"
    ),
    f!(
        "min",
        On(LIST),
        0,
        0,
        Eager(l_min),
        "list.min(): number (U13)"
    ),
    f!(
        "max",
        On(LIST),
        0,
        0,
        Eager(l_max),
        "list.max(): number (U13)"
    ),
    f!(
        "stddev",
        On(LIST),
        0,
        0,
        Eager(l_stddev),
        "list.stddev(): number (U13)"
    ),
    // ----- link / file / object / regexp -------------------------------------
    f!(
        "asFile",
        On(LINK),
        0,
        0,
        Eager(k_as_file),
        "link.asFile(): file"
    ),
    f!(
        "linksTo",
        On(LINK),
        1,
        1,
        Eager(k_links_to),
        "link.linksTo(file): boolean"
    ),
    f!(
        "asLink",
        On(FILE),
        0,
        1,
        Eager(fl_as_link),
        "file.asLink(display?): link"
    ),
    f!(
        "hasLink",
        On(FILE),
        1,
        1,
        Eager(fl_has_link),
        "file.hasLink(file | string): boolean"
    ),
    f!(
        "hasProperty",
        On(FILE),
        1,
        1,
        Eager(fl_has_property),
        "file.hasProperty(name): boolean"
    ),
    f!(
        "hasTag",
        On(FILE),
        1,
        VAR,
        Eager(fl_has_tag),
        "file.hasTag(...tags): boolean"
    ),
    f!(
        "inFolder",
        On(FILE),
        1,
        1,
        Eager(fl_in_folder),
        "file.inFolder(folder): boolean"
    ),
    f!("keys", On(OBJ), 0, 0, Eager(o_keys), "object.keys(): list"),
    f!(
        "values",
        On(OBJ),
        0,
        0,
        Eager(o_values),
        "object.values(): list"
    ),
    f!(
        "matches",
        On(RE),
        1,
        1,
        Eager(r_matches),
        "regexp.matches(string): boolean"
    ),
];

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

pub fn call_global(interp: &Interp, name: &str, args: &[Expr], sc: &Scope) -> Value {
    let def = FUNCTIONS
        .iter()
        .find(|d| matches!(d.recv, Global) && d.name == name);
    match def {
        Some(d) => run(interp, sc, d, &Value::Null, args),
        None => Value::err(
            ErrorKind::UnknownFunction,
            format!("unknown function \"{name}\""),
        ),
    }
}

pub fn call_method(interp: &Interp, recv: Value, name: &str, args: &[Expr], sc: &Scope) -> Value {
    let ty = recv.ty();
    let def = FUNCTIONS
        .iter()
        .find(|d| d.name == name && matches!(&d.recv, On(tys) if tys.contains(&ty)))
        .or_else(|| {
            FUNCTIONS
                .iter()
                .find(|d| d.name == name && matches!(d.recv, Any))
        });
    match def {
        Some(d) => run(interp, sc, d, &recv, args),
        None => {
            let known = FUNCTIONS
                .iter()
                .any(|d| d.name == name && !matches!(d.recv, Global));
            if recv.is_null() && choices::NULL_PROPAGATES && known {
                Value::Null
            } else if known {
                Value::err(
                    ErrorKind::UnknownMethod,
                    format!("a {} has no method \"{name}\"", recv.type_name()),
                )
            } else {
                Value::err(
                    ErrorKind::UnknownMethod,
                    format!("unknown method \"{name}\""),
                )
            }
        }
    }
}

fn run(interp: &Interp, sc: &Scope, def: &FnDef, recv: &Value, args: &[Expr]) -> Value {
    if args.len() < def.min || args.len() > def.max {
        let expected = if def.max == VAR {
            format!("at least {}", def.min)
        } else if def.min == def.max {
            def.min.to_string()
        } else {
            format!("{} to {}", def.min, def.max)
        };
        return Value::err(
            ErrorKind::Arity,
            format!(
                "{}() takes {expected} argument(s), got {}",
                def.name,
                args.len()
            ),
        );
    }
    let out = match &def.imp {
        Eager(f) => {
            let mut vals = Vec::with_capacity(args.len());
            for a in args {
                let v = interp.eval(a, sc);
                if let Value::Error(_) = v {
                    return v;
                }
                vals.push(v);
            }
            f(interp, recv, &vals)
        }
        Lazy(f) => f(interp, sc, recv, args),
    };
    match out {
        Ok(v) => v,
        Err(e) => Value::Error(e),
    }
}

// ---------------------------------------------------------------------------
// Argument helpers
// ---------------------------------------------------------------------------

fn type_err<T>(msg: String) -> Result<T, ErrorValue> {
    Err(ErrorValue::type_err(msg))
}

fn arg_str<'a>(args: &'a [Value], i: usize, f: &str) -> Result<&'a str, ErrorValue> {
    match args.get(i) {
        Some(Value::String(s)) => Ok(s),
        Some(v) => type_err(format!(
            "{f}() expects a string for argument {}, found a {}",
            i + 1,
            v.type_name()
        )),
        None => type_err(format!("{f}() is missing argument {}", i + 1)),
    }
}

fn arg_num(args: &[Value], i: usize, f: &str) -> Result<f64, ErrorValue> {
    match args.get(i) {
        Some(Value::Number(n)) => Ok(*n),
        Some(v) => type_err(format!(
            "{f}() expects a number for argument {}, found a {}",
            i + 1,
            v.type_name()
        )),
        None => type_err(format!("{f}() is missing argument {}", i + 1)),
    }
}

fn recv_str<'a>(r: &'a Value, f: &str) -> Result<&'a str, ErrorValue> {
    match r {
        Value::String(s) => Ok(s),
        _ => type_err(format!("{f}() needs a string receiver")),
    }
}

fn recv_list<'a>(r: &'a Value, f: &str) -> Result<&'a [Value], ErrorValue> {
    match r {
        Value::List(l) => Ok(l),
        _ => type_err(format!("{f}() needs a list receiver")),
    }
}

fn recv_num(r: &Value, f: &str) -> Result<f64, ErrorValue> {
    match r {
        Value::Number(n) => Ok(*n),
        _ => type_err(format!("{f}() needs a number receiver")),
    }
}

fn recv_file<'a>(r: &'a Value, f: &str) -> Result<&'a str, ErrorValue> {
    match r {
        Value::File(FileValue { path }) => Ok(path),
        _ => type_err(format!("{f}() needs a file receiver")),
    }
}

/// JS-style integer argument (truncating); `None` for a missing argument.
fn opt_int(args: &[Value], i: usize, f: &str) -> Result<Option<i64>, ErrorValue> {
    match args.get(i) {
        None => Ok(None),
        Some(Value::Number(n)) if n.is_finite() => Ok(Some(n.trunc() as i64)),
        Some(v) => type_err(format!(
            "{f}() expects a number for argument {}, found a {}",
            i + 1,
            v.type_name()
        )),
    }
}

/// `slice` bounds with JS semantics: negatives count from the end, clamped.
fn slice_range(len: usize, start: i64, end: Option<i64>) -> (usize, usize) {
    let l = len as i64;
    let norm = |x: i64| if x < 0 { (l + x).max(0) } else { x.min(l) };
    let s = norm(start);
    let e = end.map(norm).unwrap_or(l);
    (s as usize, e.max(s) as usize)
}

fn ok(v: Value) -> Res {
    Ok(v)
}

fn boolean(b: bool) -> Res {
    Ok(Value::Bool(b))
}

// ---------------------------------------------------------------------------
// Global functions
// ---------------------------------------------------------------------------

fn g_escape_html(_: &Interp, _: &Value, a: &[Value]) -> Res {
    let s = arg_str(a, 0, "escapeHTML")?;
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c => out.push(c),
        }
    }
    ok(Value::String(out))
}

fn g_date(i: &Interp, _: &Value, a: &[Value]) -> Res {
    match &a[0] {
        Value::Date(d) => ok(Value::Date(*d)),
        Value::String(s) => match datetime::parse_date(s, i.offset()) {
            Some((ms, has_time)) => ok(Value::date(ms, has_time)),
            None => Err(ErrorValue::runtime(format!(
                "cannot parse \"{s}\" as a date"
            ))),
        },
        v => type_err(format!(
            "date() expects a string, found a {}",
            v.type_name()
        )),
    }
}

fn g_duration(_: &Interp, _: &Value, a: &[Value]) -> Res {
    match &a[0] {
        Value::Duration(d) => ok(Value::Duration(*d)),
        Value::String(s) => match datetime::parse_duration(s) {
            Some(d) => ok(Value::Duration(d)),
            None => Err(ErrorValue::runtime(format!(
                "cannot parse \"{s}\" as a duration"
            ))),
        },
        v => type_err(format!(
            "duration() expects a string, found a {}",
            v.type_name()
        )),
    }
}

fn g_file(i: &Interp, _: &Value, a: &[Value]) -> Res {
    match &a[0] {
        Value::File(f) => ok(Value::File(f.clone())),
        Value::Link(l) => ok(match &l.resolved {
            Some(p) => Value::File(FileValue { path: p.clone() }),
            None => Value::Null,
        }),
        Value::String(s) => {
            let text = wikilink_or_plain(s);
            ok(match i.row.resolve_link(&text) {
                Some(p) => Value::File(FileValue { path: p }),
                None => Value::Null,
            })
        }
        v => type_err(format!(
            "file() expects a path, file or link, found a {}",
            v.type_name()
        )),
    }
}

fn wikilink_or_plain(s: &str) -> String {
    LinkValue::parse_wikilink(s)
        .map(|(t, _)| t)
        .unwrap_or_else(|| s.to_string())
}

fn g_html(_: &Interp, _: &Value, a: &[Value]) -> Res {
    Ok(Value::Html(arg_str(a, 0, "html")?.to_string()))
}

fn g_image(_: &Interp, _: &Value, a: &[Value]) -> Res {
    match &a[0] {
        Value::String(s) => ok(Value::Image(s.clone())),
        Value::File(f) => ok(Value::Image(f.path.clone())),
        Value::Link(l) => ok(Value::Image(
            l.resolved.clone().unwrap_or_else(|| l.target.clone()),
        )),
        v => type_err(format!(
            "image() expects a path, file or url, found a {}",
            v.type_name()
        )),
    }
}

fn g_icon(_: &Interp, _: &Value, a: &[Value]) -> Res {
    Ok(Value::Icon(arg_str(a, 0, "icon")?.to_string()))
}

fn g_if(i: &Interp, sc: &Scope, _: &Value, args: &[Expr]) -> Res {
    let cond = i.eval(&args[0], sc);
    if let Value::Error(_) = cond {
        return ok(cond);
    }
    if cond.truthy() {
        ok(i.eval(&args[1], sc))
    } else if let Some(e) = args.get(2) {
        ok(i.eval(e, sc))
    } else {
        ok(Value::Null)
    }
}

fn g_link(i: &Interp, _: &Value, a: &[Value]) -> Res {
    let display = match a.get(1) {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(v) => Some(v.display()),
    };
    match &a[0] {
        Value::String(s) => {
            if s.is_empty() {
                return Err(ErrorValue::runtime("link() needs a non-empty path"));
            }
            let (target, wiki_display) = match LinkValue::parse_wikilink(s) {
                Some((t, d)) => (t, d),
                None => (s.clone(), None),
            };
            let resolved = i.row.resolve_link(&target);
            ok(Value::Link(LinkValue {
                target,
                display: display.or(wiki_display),
                resolved,
            }))
        }
        Value::File(f) => ok(Value::Link(LinkValue {
            target: f.path.clone(),
            display,
            resolved: Some(f.path.clone()),
        })),
        Value::Link(l) => {
            let mut l = l.clone();
            if display.is_some() {
                l.display = display;
            }
            ok(Value::Link(l))
        }
        v => type_err(format!(
            "link() expects a path or file, found a {}",
            v.type_name()
        )),
    }
}

fn g_list(_: &Interp, _: &Value, a: &[Value]) -> Res {
    match &a[0] {
        Value::List(l) => ok(Value::List(l.clone())),
        v => ok(Value::List(vec![v.clone()])),
    }
}

fn numbers(a: &[Value], f: &str) -> Result<Vec<f64>, ErrorValue> {
    (0..a.len()).map(|i| arg_num(a, i, f)).collect()
}

fn g_max(_: &Interp, _: &Value, a: &[Value]) -> Res {
    let n = numbers(a, "max")?;
    ok(Value::Number(
        n.into_iter().fold(f64::NEG_INFINITY, f64::max),
    ))
}

fn g_min(_: &Interp, _: &Value, a: &[Value]) -> Res {
    let n = numbers(a, "min")?;
    ok(Value::Number(n.into_iter().fold(f64::INFINITY, f64::min)))
}

fn g_now(i: &Interp, _: &Value, _: &[Value]) -> Res {
    ok(Value::date(i.clock.now_local_ms(), true))
}

fn g_today(i: &Interp, _: &Value, _: &[Value]) -> Res {
    ok(Value::date(
        datetime::start_of_day(i.clock.now_local_ms()),
        false,
    ))
}

fn g_random(i: &Interp, _: &Value, _: &[Value]) -> Res {
    ok(Value::Number(i.next_random()))
}

fn g_number(i: &Interp, _: &Value, a: &[Value]) -> Res {
    match &a[0] {
        Value::Number(n) => ok(Value::Number(*n)),
        Value::Bool(b) => ok(Value::Number(if *b { 1.0 } else { 0.0 })),
        Value::Date(d) => ok(Value::Number(
            d.ms.saturating_sub(i.offset() as i64 * datetime::MS_PER_MINUTE) as f64,
        )),
        Value::String(s) => {
            let t = s.trim();
            match t.parse::<f64>() {
                Ok(n) if n.is_finite() && !t.is_empty() => ok(Value::Number(n)),
                _ => Err(ErrorValue::runtime(format!(
                    "cannot convert \"{s}\" to a number"
                ))),
            }
        }
        v => type_err(format!("number() cannot convert a {}", v.type_name())),
    }
}

// ---------------------------------------------------------------------------
// Any
// ---------------------------------------------------------------------------

fn a_is_truthy(_: &Interp, r: &Value, _: &[Value]) -> Res {
    boolean(r.truthy())
}

fn a_is_type(_: &Interp, r: &Value, a: &[Value]) -> Res {
    let t = arg_str(a, 0, "isType")?;
    boolean(r.type_name() == t)
}

fn a_to_string(_: &Interp, r: &Value, _: &[Value]) -> Res {
    ok(Value::String(r.display()))
}

fn a_is_empty(_: &Interp, r: &Value, _: &[Value]) -> Res {
    boolean(r.is_empty())
}

// ---------------------------------------------------------------------------
// String
// ---------------------------------------------------------------------------

fn s_contains(_: &Interp, r: &Value, a: &[Value]) -> Res {
    boolean(recv_str(r, "contains")?.contains(arg_str(a, 0, "contains")?))
}

fn s_contains_all(_: &Interp, r: &Value, a: &[Value]) -> Res {
    let s = recv_str(r, "containsAll")?;
    for i in 0..a.len() {
        if !s.contains(arg_str(a, i, "containsAll")?) {
            return boolean(false);
        }
    }
    boolean(true)
}

fn s_contains_any(_: &Interp, r: &Value, a: &[Value]) -> Res {
    let s = recv_str(r, "containsAny")?;
    for i in 0..a.len() {
        if s.contains(arg_str(a, i, "containsAny")?) {
            return boolean(true);
        }
    }
    boolean(false)
}

fn s_ends_with(_: &Interp, r: &Value, a: &[Value]) -> Res {
    boolean(recv_str(r, "endsWith")?.ends_with(arg_str(a, 0, "endsWith")?))
}

fn s_starts_with(_: &Interp, r: &Value, a: &[Value]) -> Res {
    boolean(recv_str(r, "startsWith")?.starts_with(arg_str(a, 0, "startsWith")?))
}

fn s_lower(_: &Interp, r: &Value, _: &[Value]) -> Res {
    ok(Value::String(recv_str(r, "lower")?.to_lowercase()))
}

fn s_trim(_: &Interp, r: &Value, _: &[Value]) -> Res {
    ok(Value::String(recv_str(r, "trim")?.trim().to_string()))
}

fn s_title(_: &Interp, r: &Value, _: &[Value]) -> Res {
    let s = recv_str(r, "title")?;
    let mut out = String::with_capacity(s.len());
    let mut start = true;
    for c in s.chars() {
        if c.is_whitespace() {
            start = true;
            out.push(c);
        } else if start {
            out.extend(c.to_uppercase());
            start = false;
        } else {
            out.extend(c.to_lowercase());
        }
    }
    ok(Value::String(out))
}

fn s_reverse(_: &Interp, r: &Value, _: &[Value]) -> Res {
    ok(Value::String(
        recv_str(r, "reverse")?.chars().rev().collect(),
    ))
}

fn s_repeat(_: &Interp, r: &Value, a: &[Value]) -> Res {
    let s = recv_str(r, "repeat")?;
    let n = arg_num(a, 0, "repeat")?;
    if n < 0.0 || !n.is_finite() {
        return Err(ErrorValue::runtime("repeat() needs a count of 0 or more"));
    }
    let n = n.trunc() as usize;
    if s.len().saturating_mul(n) > 1_000_000 {
        return Err(ErrorValue::runtime("repeat() result is too long"));
    }
    ok(Value::String(s.repeat(n)))
}

fn s_slice(_: &Interp, r: &Value, a: &[Value]) -> Res {
    let chars: Vec<char> = recv_str(r, "slice")?.chars().collect();
    let start = opt_int(a, 0, "slice")?.unwrap_or(0);
    let end = opt_int(a, 1, "slice")?;
    let (s, e) = slice_range(chars.len(), start, end);
    ok(Value::String(chars[s..e].iter().collect()))
}

fn s_split(_: &Interp, r: &Value, a: &[Value]) -> Res {
    let s = recv_str(r, "split")?;
    let limit = opt_int(a, 1, "split")?;
    let mut parts: Vec<String> = match &a[0] {
        Value::String(sep) if sep.is_empty() => s.chars().map(|c| c.to_string()).collect(),
        Value::String(sep) => s.split(sep.as_str()).map(str::to_string).collect(),
        Value::Regexp(re) => re.re.split(s).map(str::to_string).collect(),
        v => {
            return type_err(format!(
                "split() expects a string or regexp, found a {}",
                v.type_name()
            ))
        }
    };
    if let Some(n) = limit {
        parts.truncate(n.max(0) as usize);
    }
    ok(Value::List(parts.into_iter().map(Value::String).collect()))
}

/// JS replacement templates: `$1`..`$9`, `$&`, `$$`.
fn expand_replacement(tpl: &str, caps: &regex_lite::Captures) -> String {
    let chars: Vec<char> = tpl.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '$' && i + 1 < chars.len() {
            match chars[i + 1] {
                '$' => {
                    out.push('$');
                    i += 2;
                    continue;
                }
                '&' => {
                    out.push_str(caps.get(0).map(|m| m.as_str()).unwrap_or(""));
                    i += 2;
                    continue;
                }
                d if d.is_ascii_digit() && d != '0' => {
                    let idx = d as usize - '0' as usize;
                    out.push_str(caps.get(idx).map(|m| m.as_str()).unwrap_or(""));
                    i += 2;
                    continue;
                }
                _ => {}
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

fn s_replace(_: &Interp, r: &Value, a: &[Value]) -> Res {
    let s = recv_str(r, "replace")?;
    let repl = arg_str(a, 1, "replace")?;
    match &a[0] {
        Value::String(p) => ok(Value::String(s.replace(p.as_str(), repl))),
        Value::Regexp(re) => ok(Value::String(regex_replace(re, s, repl))),
        v => type_err(format!(
            "replace() expects a string or regexp pattern, found a {}",
            v.type_name()
        )),
    }
}

fn regex_replace(re: &RegexpValue, s: &str, repl: &str) -> String {
    let mut out = String::new();
    let mut last = 0;
    for caps in re.re.captures_iter(s) {
        let Some(m) = caps.get(0) else { continue };
        out.push_str(&s[last..m.start()]);
        out.push_str(&expand_replacement(repl, &caps));
        last = m.end();
        if !re.is_global() {
            break;
        }
    }
    out.push_str(&s[last..]);
    out
}

// ---------------------------------------------------------------------------
// Number
// ---------------------------------------------------------------------------

fn n_abs(_: &Interp, r: &Value, _: &[Value]) -> Res {
    ok(Value::Number(recv_num(r, "abs")?.abs()))
}

fn n_ceil(_: &Interp, r: &Value, _: &[Value]) -> Res {
    ok(Value::Number(recv_num(r, "ceil")?.ceil()))
}

fn n_floor(_: &Interp, r: &Value, _: &[Value]) -> Res {
    ok(Value::Number(recv_num(r, "floor")?.floor()))
}

/// Rounds half away from zero.
fn n_round(_: &Interp, r: &Value, a: &[Value]) -> Res {
    let n = recv_num(r, "round")?;
    let digits = opt_int(a, 0, "round")?.unwrap_or(0).clamp(-15, 15) as i32;
    let k = 10f64.powi(digits);
    ok(Value::Number((n * k).round() / k))
}

fn n_to_fixed(_: &Interp, r: &Value, a: &[Value]) -> Res {
    let n = recv_num(r, "toFixed")?;
    let p = arg_num(a, 0, "toFixed")?;
    if !(0.0..=100.0).contains(&p) {
        return Err(ErrorValue::runtime("toFixed() precision must be 0 to 100"));
    }
    ok(Value::String(to_fixed(n, p as usize)))
}

/// JS `toFixed`: exact ties round away from zero (Rust's formatter rounds
/// them to even).
pub fn to_fixed(n: f64, p: usize) -> String {
    if !n.is_finite() {
        return format_number(n);
    }
    let scaled = n * 10f64.powi(p as i32);
    if p <= 15 && scaled.abs() < 1e15 && (scaled - scaled.trunc()).abs() == 0.5 {
        let r = scaled.round() as i128;
        let neg = r < 0;
        let mut digits = r.unsigned_abs().to_string();
        while digits.len() <= p {
            digits.insert(0, '0');
        }
        let split = digits.len() - p;
        let (int, frac) = digits.split_at(split);
        let body = if p == 0 {
            int.to_string()
        } else {
            format!("{int}.{frac}")
        };
        return if neg { format!("-{body}") } else { body };
    }
    format!("{n:.p$}")
}

// ---------------------------------------------------------------------------
// Date
// ---------------------------------------------------------------------------

fn recv_date(r: &Value, f: &str) -> Result<super::value::DateValue, ErrorValue> {
    match r {
        Value::Date(d) => Ok(*d),
        _ => type_err(format!("{f}() needs a date receiver")),
    }
}

fn d_date(_: &Interp, r: &Value, _: &[Value]) -> Res {
    let d = recv_date(r, "date")?;
    ok(Value::date(datetime::start_of_day(d.ms), false))
}

fn d_format(i: &Interp, r: &Value, a: &[Value]) -> Res {
    let d = recv_date(r, "format")?;
    ok(Value::String(datetime::format_date(
        d.ms,
        arg_str(a, 0, "format")?,
        i.offset(),
    )))
}

fn d_time(_: &Interp, r: &Value, _: &[Value]) -> Res {
    let d = recv_date(r, "time")?;
    ok(Value::String(datetime::format_date(d.ms, "HH:mm:ss", 0)))
}

fn d_relative(i: &Interp, r: &Value, _: &[Value]) -> Res {
    let d = recv_date(r, "relative")?;
    ok(Value::String(datetime::relative(
        d.ms,
        i.clock.now_local_ms(),
    )))
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

fn l_contains(_: &Interp, r: &Value, a: &[Value]) -> Res {
    boolean(recv_list(r, "contains")?.iter().any(|x| x.equals(&a[0])))
}

fn l_contains_all(_: &Interp, r: &Value, a: &[Value]) -> Res {
    let l = recv_list(r, "containsAll")?;
    boolean(a.iter().all(|w| l.iter().any(|x| x.equals(w))))
}

fn l_contains_any(_: &Interp, r: &Value, a: &[Value]) -> Res {
    let l = recv_list(r, "containsAny")?;
    boolean(a.iter().any(|w| l.iter().any(|x| x.equals(w))))
}

fn l_filter(i: &Interp, sc: &Scope, r: &Value, args: &[Expr]) -> Res {
    let l = recv_list(r, "filter")?;
    let mut out = Vec::new();
    for (idx, v) in l.iter().enumerate() {
        let inner = sc.child(vec![
            ("value", v.clone()),
            ("index", Value::Number(idx as f64)),
        ]);
        let keep = i.eval(&args[0], &inner);
        if let Value::Error(_) = keep {
            return ok(keep);
        }
        if keep.truthy() {
            out.push(v.clone());
        }
    }
    ok(Value::List(out))
}

fn l_map(i: &Interp, sc: &Scope, r: &Value, args: &[Expr]) -> Res {
    let l = recv_list(r, "map")?;
    let mut out = Vec::with_capacity(l.len());
    for (idx, v) in l.iter().enumerate() {
        let inner = sc.child(vec![
            ("value", v.clone()),
            ("index", Value::Number(idx as f64)),
        ]);
        let m = i.eval(&args[0], &inner);
        if let Value::Error(_) = m {
            return ok(m);
        }
        out.push(m);
    }
    ok(Value::List(out))
}

fn l_reduce(i: &Interp, sc: &Scope, r: &Value, args: &[Expr]) -> Res {
    let l = recv_list(r, "reduce")?;
    let mut acc = i.eval(&args[1], sc);
    if let Value::Error(_) = acc {
        return ok(acc);
    }
    for (idx, v) in l.iter().enumerate() {
        let inner = sc.child(vec![
            ("value", v.clone()),
            ("index", Value::Number(idx as f64)),
            ("acc", acc),
        ]);
        acc = i.eval(&args[0], &inner);
        if let Value::Error(_) = acc {
            return ok(acc);
        }
    }
    ok(acc)
}

/// One level, like JS `Array.prototype.flat()`.
fn l_flat(_: &Interp, r: &Value, _: &[Value]) -> Res {
    let mut out = Vec::new();
    for v in recv_list(r, "flat")? {
        match v {
            Value::List(inner) => out.extend(inner.iter().cloned()),
            other => out.push(other.clone()),
        }
    }
    ok(Value::List(out))
}

fn l_join(_: &Interp, r: &Value, a: &[Value]) -> Res {
    let sep = arg_str(a, 0, "join")?;
    ok(Value::String(
        recv_list(r, "join")?
            .iter()
            .map(Value::display)
            .collect::<Vec<_>>()
            .join(sep),
    ))
}

fn l_reverse(_: &Interp, r: &Value, _: &[Value]) -> Res {
    let mut v = recv_list(r, "reverse")?.to_vec();
    v.reverse();
    ok(Value::List(v))
}

fn l_slice(_: &Interp, r: &Value, a: &[Value]) -> Res {
    let l = recv_list(r, "slice")?;
    let start = opt_int(a, 0, "slice")?.unwrap_or(0);
    let end = opt_int(a, 1, "slice")?;
    let (s, e) = slice_range(l.len(), start, end);
    ok(Value::List(l[s..e].to_vec()))
}

fn l_sort(_: &Interp, r: &Value, _: &[Value]) -> Res {
    let mut v = recv_list(r, "sort")?.to_vec();
    v.sort_by(compare_for_sort);
    ok(Value::List(v))
}

fn l_unique(_: &Interp, r: &Value, _: &[Value]) -> Res {
    let mut out: Vec<Value> = Vec::new();
    for v in recv_list(r, "unique")? {
        if !out.iter().any(|x| x.equals(v)) {
            out.push(v.clone());
        }
    }
    ok(Value::List(out))
}

fn nums_of(r: &Value, f: &str) -> Result<Vec<f64>, ErrorValue> {
    Ok(recv_list(r, f)?
        .iter()
        .filter_map(|v| match v {
            Value::Number(n) => Some(*n),
            _ => None,
        })
        .collect())
}

fn l_sum(_: &Interp, r: &Value, _: &[Value]) -> Res {
    ok(Value::Number(nums_of(r, "sum")?.iter().sum()))
}

fn l_mean(_: &Interp, r: &Value, _: &[Value]) -> Res {
    let n = nums_of(r, "mean")?;
    ok(if n.is_empty() {
        Value::Null
    } else {
        Value::Number(n.iter().sum::<f64>() / n.len() as f64)
    })
}

fn l_median(_: &Interp, r: &Value, _: &[Value]) -> Res {
    let mut n = nums_of(r, "median")?;
    n.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    ok(match n.len() {
        0 => Value::Null,
        len if len % 2 == 1 => Value::Number(n[len / 2]),
        len => Value::Number((n[len / 2 - 1] + n[len / 2]) / 2.0),
    })
}

fn l_min(_: &Interp, r: &Value, _: &[Value]) -> Res {
    let n = nums_of(r, "min")?;
    ok(n.into_iter()
        .reduce(f64::min)
        .map(Value::Number)
        .unwrap_or(Value::Null))
}

fn l_max(_: &Interp, r: &Value, _: &[Value]) -> Res {
    let n = nums_of(r, "max")?;
    ok(n.into_iter()
        .reduce(f64::max)
        .map(Value::Number)
        .unwrap_or(Value::Null))
}

/// Population standard deviation.
fn l_stddev(_: &Interp, r: &Value, _: &[Value]) -> Res {
    let n = nums_of(r, "stddev")?;
    if n.is_empty() {
        return ok(Value::Null);
    }
    let mean = n.iter().sum::<f64>() / n.len() as f64;
    let var = n.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / n.len() as f64;
    ok(Value::Number(var.sqrt()))
}

// ---------------------------------------------------------------------------
// Link, file, object, regexp
// ---------------------------------------------------------------------------

fn k_as_file(_: &Interp, r: &Value, _: &[Value]) -> Res {
    match r {
        Value::Link(l) => ok(match &l.resolved {
            Some(p) => Value::File(FileValue { path: p.clone() }),
            None => Value::Null,
        }),
        _ => type_err("asFile() needs a link receiver".into()),
    }
}

fn path_of(v: &Value) -> Option<String> {
    match v {
        Value::File(f) => Some(f.path.clone()),
        Value::Link(l) => l.resolved.clone(),
        _ => None,
    }
}

fn k_links_to(_: &Interp, r: &Value, a: &[Value]) -> Res {
    let Value::Link(l) = r else {
        return type_err("linksTo() needs a link receiver".into());
    };
    match (&l.resolved, path_of(&a[0])) {
        (Some(x), Some(y)) => boolean(*x == y),
        _ => boolean(false),
    }
}

fn fl_as_link(_: &Interp, r: &Value, a: &[Value]) -> Res {
    let path = recv_file(r, "asLink")?;
    let display = match a.first() {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(v) => Some(v.display()),
    };
    ok(Value::Link(LinkValue {
        target: path.to_string(),
        display,
        resolved: Some(path.to_string()),
    }))
}

fn norm_link_text(s: &str) -> String {
    let t = s.trim().to_lowercase();
    t.strip_suffix(".md").unwrap_or(&t).to_string()
}

/// U14.
fn fl_has_link(i: &Interp, r: &Value, a: &[Value]) -> Res {
    let path = recv_file(r, "hasLink")?;
    let Some(ctx) = i.ctx_for(path) else {
        return Err(ErrorValue::runtime(format!("file not found: {path}")));
    };
    let links = ctx.links();
    match &a[0] {
        Value::File(f) => boolean(
            links
                .iter()
                .any(|l| l.resolved.as_deref() == Some(f.path.as_str())),
        ),
        Value::Link(w) => boolean(links.iter().any(|l| match (&l.resolved, &w.resolved) {
            (Some(x), Some(y)) => x == y,
            _ => norm_link_text(&l.target) == norm_link_text(&w.target),
        })),
        Value::String(s) => {
            let text = wikilink_or_plain(s);
            match ctx.resolve_link(&text) {
                Some(p) => boolean(links.iter().any(|l| {
                    l.resolved.as_deref() == Some(p.as_str())
                        || (l.resolved.is_none()
                            && norm_link_text(&l.target) == norm_link_text(&text))
                })),
                None => boolean(
                    links
                        .iter()
                        .any(|l| norm_link_text(&l.target) == norm_link_text(&text)),
                ),
            }
        }
        v => type_err(format!(
            "hasLink() expects a file or string, found a {}",
            v.type_name()
        )),
    }
}

fn fl_has_property(i: &Interp, r: &Value, a: &[Value]) -> Res {
    let path = recv_file(r, "hasProperty")?;
    let name = arg_str(a, 0, "hasProperty")?;
    match i.ctx_for(path) {
        Some(c) => boolean(c.property(name).is_some()),
        None => Err(ErrorValue::runtime(format!("file not found: {path}"))),
    }
}

fn norm_tag(t: &str) -> String {
    t.trim().trim_start_matches('#').to_lowercase()
}

/// U11: any-of, case-insensitive, nested.
fn fl_has_tag(i: &Interp, r: &Value, a: &[Value]) -> Res {
    let path = recv_file(r, "hasTag")?;
    let Some(ctx) = i.ctx_for(path) else {
        return Err(ErrorValue::runtime(format!("file not found: {path}")));
    };
    let tags: Vec<String> = ctx.tags().iter().map(|t| norm_tag(t)).collect();
    for k in 0..a.len() {
        let want = norm_tag(arg_str(a, k, "hasTag")?);
        if want.is_empty() {
            continue;
        }
        let prefix = format!("{want}/");
        if tags.iter().any(|t| *t == want || t.starts_with(&prefix)) {
            return boolean(true);
        }
    }
    boolean(false)
}

fn fl_in_folder(_: &Interp, r: &Value, a: &[Value]) -> Res {
    let path = recv_file(r, "inFolder")?;
    let want = arg_str(a, 0, "inFolder")?.trim().trim_matches('/');
    let folder = file_folder(path);
    boolean(want.is_empty() || folder == want || folder.starts_with(&format!("{want}/")))
}

fn o_keys(_: &Interp, r: &Value, _: &[Value]) -> Res {
    match r {
        Value::Object(o) => ok(Value::List(
            o.iter().map(|(k, _)| Value::String(k.clone())).collect(),
        )),
        _ => type_err("keys() needs an object receiver".into()),
    }
}

fn o_values(_: &Interp, r: &Value, _: &[Value]) -> Res {
    match r {
        Value::Object(o) => ok(Value::List(o.iter().map(|(_, v)| v.clone()).collect())),
        _ => type_err("values() needs an object receiver".into()),
    }
}

fn r_matches(_: &Interp, r: &Value, a: &[Value]) -> Res {
    match r {
        Value::Regexp(re) => boolean(re.re.is_match(arg_str(a, 0, "matches")?)),
        _ => type_err("matches() needs a regexp receiver".into()),
    }
}
