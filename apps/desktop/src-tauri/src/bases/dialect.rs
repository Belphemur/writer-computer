//! The DQL dialect of the Bases interpreter: everything Dataview's query language needs that
//! Bases lacks, behind [`Dialect::Dql`](super::interp::Dialect) so a Bases document never
//! sees any of it (`tests::dialect_never_changes_bases_results`).
//!
//! A DQL query is lowered to a Bases document (`crate::dql::lower`) that carries `dialect: dql`;
//! the executor then evaluates its expressions with this module's hooks:
//!
//! - [`truthy`]: an empty list, object and string are falsy;
//! - [`note_value`]: inline fields and Dataview's canonical field names (`Due Date` is also
//!   `due-date`) next to the frontmatter;
//! - [`file_field`]: the implicit `file.*` fields Bases has no counterpart for (`tags` with their
//!   `#` and every parent tag, `etags`, `day`, `tasks`, `lists`, `starred`); the names that do
//!   exist in Bases are renamed by the lowering instead (`file.name` -> `file.basename`);
//! - [`call`]: the DQL functions with no Bases form (the table [`FUNCTIONS`]; the lowering
//!   rewrites the ones that have one);
//! - [`page_object`]: a row as a Dataview page object (`file` plus its fields), what `rows`
//!   holds after `GROUP BY`.
//!
//! Spec: `SPECs/dataview-spec.md`. Function semantics follow Dataview's public documentation.

use super::ast::Expr;
use super::context::RowContext;
use super::datetime;
use super::interp::{Interp, Scope};
use super::value::{ErrorKind, ErrorValue, FileValue, RegexpValue, Value};
use std::rc::Rc;

type Res = Result<Value, ErrorValue>;

/// DQL truthiness: null, false, 0, NaN, empty text, empty list and empty object are false.
pub fn truthy(v: &Value) -> bool {
    match v {
        Value::Null | Value::Error(_) => false,
        Value::Bool(b) => *b,
        Value::Number(n) => *n != 0.0 && !n.is_nan(),
        Value::String(s) | Value::Html(s) => !s.is_empty(),
        Value::List(l) => !l.is_empty(),
        Value::Object(o) => !o.is_empty(),
        _ => true,
    }
}

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

/// A field the frontmatter lookup did not find: an inline field by its key, or any field by its
/// canonical key. `None` leaves the lookup to the Bases path (exact frontmatter, dotted maps).
pub fn note_value(interp: &Interp, ctx: &Rc<dyn RowContext>, key: &str) -> Option<Value> {
    if ctx.property(key).is_some() {
        return None;
    }
    let inline = ctx.inline_fields();
    if let Some((_, v)) = inline.iter().find(|(k, _)| k == key) {
        return Some(interp.coerce_property(ctx, v.clone()));
    }
    let canonical = ctx
        .properties()
        .into_iter()
        .find(|(k, _)| crate::index::inline_fields::canonical_key(k) == key)
        .map(|(_, v)| v);
    canonical.map(|v| interp.coerce_property(ctx, v))
}

fn with_hash(tags: impl IntoIterator<Item = String>) -> Value {
    let mut all: Vec<String> = tags.into_iter().map(|t| format!("#{t}")).collect();
    all.sort();
    all.dedup();
    Value::List(all.into_iter().map(Value::String).collect())
}

/// `YYYY-MM-DD` or `YYYYMMDD` inside a file name, as a date.
fn date_in_name(name: &str) -> Option<Value> {
    let b: Vec<char> = name.chars().collect();
    let digits = |s: &[char]| s.iter().all(char::is_ascii_digit);
    for i in 0..b.len() {
        if i + 10 <= b.len() && digits(&b[i..i + 4]) && b[i + 4] == '-' && b[i + 7] == '-' {
            let s: String = b[i..i + 10].iter().collect();
            if let Some((ms, _)) = datetime::parse_date(&s, 0) {
                return Some(Value::date(ms, false));
            }
        }
    }
    for i in 0..b.len() {
        if i + 8 <= b.len() && digits(&b[i..i + 8]) {
            let s: String = b[i..i + 8].iter().collect();
            let iso = format!("{}-{}-{}", &s[..4], &s[4..6], &s[6..]);
            if let Some((ms, _)) = datetime::parse_date(&iso, 0) {
                return Some(Value::date(ms, false));
            }
        }
    }
    None
}

fn is_task(v: &Value) -> bool {
    matches!(v, Value::Object(o) if o.iter().any(|(k, x)| k == "task" && matches!(x, Value::Bool(true))))
}

/// The DQL `file.<name>` fields with no Bases counterpart.
pub fn file_field(
    _interp: &Interp,
    ctx: &Rc<dyn RowContext>,
    path: &str,
    name: &str,
) -> Option<Value> {
    Some(match name {
        "tags" => with_hash(
            ctx.tags()
                .iter()
                .flat_map(|t| crate::index::markdown::with_ancestors(t)),
        ),
        "etags" => with_hash(ctx.tags()),
        "day" => match ctx.property("date") {
            Some(d @ Value::Date(_)) => d,
            _ => date_in_name(super::context::file_basename(path)).unwrap_or(Value::Null),
        },
        "tasks" => Value::List(ctx.list_items().into_iter().filter(is_task).collect()),
        "lists" => Value::List(ctx.list_items()),
        "starred" => Value::Bool(false),
        _ => return None,
    })
}

/// A row as a Dataview page object: `file` plus every field (frontmatter wins over an inline
/// field of the same key).
pub fn page_object(interp: &Interp) -> Value {
    let ctx = interp.row.clone();
    let mut fields: Vec<(String, Value)> = vec![(
        "file".to_string(),
        Value::File(FileValue { path: ctx.path() }),
    )];
    for (k, v) in ctx.properties() {
        fields.push((k, interp.coerce_property(&ctx, v)));
    }
    for (k, v) in ctx.inline_fields() {
        if !fields.iter().any(|(n, _)| *n == k) {
            fields.push((k, interp.coerce_property(&ctx, v)));
        }
    }
    Value::Object(fields)
}

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

struct Fn {
    name: &'static str,
    min: usize,
    max: usize,
    imp: fn(&Interp, &[Value]) -> Res,
}

const VAR: usize = usize::MAX;

/// The DQL functions with no Bases form. Every name here is `Unmapped` for "Convert to Base".
static FUNCTIONS: &[Fn] = &[
    Fn {
        name: "icontains",
        min: 2,
        max: 2,
        imp: f_icontains,
    },
    Fn {
        name: "econtains",
        min: 2,
        max: 2,
        imp: f_econtains,
    },
    Fn {
        name: "containsword",
        min: 2,
        max: 2,
        imp: f_containsword,
    },
    Fn {
        name: "upper",
        min: 1,
        max: 1,
        imp: f_upper,
    },
    Fn {
        name: "regextest",
        min: 2,
        max: 2,
        imp: f_regextest,
    },
    Fn {
        name: "regexmatch",
        min: 2,
        max: 2,
        imp: f_regexmatch,
    },
    Fn {
        name: "regexreplace",
        min: 3,
        max: 3,
        imp: f_regexreplace,
    },
    Fn {
        name: "truncate",
        min: 2,
        max: 3,
        imp: f_truncate,
    },
    Fn {
        name: "padleft",
        min: 2,
        max: 3,
        imp: f_padleft,
    },
    Fn {
        name: "padright",
        min: 2,
        max: 3,
        imp: f_padright,
    },
    Fn {
        name: "trunc",
        min: 1,
        max: 1,
        imp: f_trunc,
    },
    Fn {
        name: "product",
        min: 1,
        max: 1,
        imp: f_product,
    },
    Fn {
        name: "all",
        min: 1,
        max: VAR,
        imp: f_all,
    },
    Fn {
        name: "any",
        min: 1,
        max: VAR,
        imp: f_any,
    },
    Fn {
        name: "none",
        min: 1,
        max: VAR,
        imp: f_none,
    },
    Fn {
        name: "nonnull",
        min: 1,
        max: VAR,
        imp: f_nonnull,
    },
    Fn {
        name: "firstvalue",
        min: 1,
        max: VAR,
        imp: f_firstvalue,
    },
    Fn {
        name: "typeof",
        min: 1,
        max: 1,
        imp: f_typeof,
    },
    Fn {
        name: "dateformat",
        min: 2,
        max: 2,
        imp: f_dateformat,
    },
    Fn {
        name: "localtime",
        min: 1,
        max: 1,
        imp: f_localtime,
    },
    Fn {
        name: "object",
        min: 0,
        max: VAR,
        imp: f_object,
    },
    Fn {
        name: "startof",
        min: 1,
        max: 1,
        imp: f_startof,
    },
    Fn {
        name: "endof",
        min: 1,
        max: 1,
        imp: f_endof,
    },
];

/// Is `name` a DQL function this module implements (the lowering checks it)?
pub fn has_function(name: &str) -> bool {
    FUNCTIONS.iter().any(|f| f.name == name)
}

/// Run a dialect function; `None` when `name` is not one (the Bases global of that name, if any,
/// then runs).
pub fn call(interp: &Interp, name: &str, args: &[Expr], sc: &Scope) -> Option<Value> {
    let def = FUNCTIONS.iter().find(|f| f.name == name)?;
    if args.len() < def.min || args.len() > def.max {
        return Some(Value::err(
            ErrorKind::Arity,
            format!("{name}() got {} argument(s)", args.len()),
        ));
    }
    let mut vals = Vec::with_capacity(args.len());
    for a in args {
        let v = interp.eval(a, sc);
        if let Value::Error(_) = v {
            return Some(v);
        }
        vals.push(v);
    }
    Some(match (def.imp)(interp, &vals) {
        Ok(v) => v,
        Err(e) => Value::Error(e),
    })
}

fn s(v: &Value) -> Option<&str> {
    match v {
        Value::String(s) => Some(s),
        _ => None,
    }
}

fn type_err<T>(msg: impl Into<String>) -> Result<T, ErrorValue> {
    Err(ErrorValue::type_err(msg))
}

fn bool_v(b: bool) -> Res {
    Ok(Value::Bool(b))
}

fn f_icontains(_: &Interp, a: &[Value]) -> Res {
    let needle = a[1].display().to_lowercase();
    match &a[0] {
        Value::String(h) => bool_v(h.to_lowercase().contains(&needle)),
        Value::List(l) => bool_v(l.iter().any(|x| x.display().to_lowercase() == needle)),
        Value::Object(o) => bool_v(o.iter().any(|(k, _)| k.to_lowercase() == needle)),
        _ => bool_v(false),
    }
}

fn f_econtains(_: &Interp, a: &[Value]) -> Res {
    match &a[0] {
        Value::String(h) => bool_v(s(&a[1]).is_some_and(|n| h.contains(n))),
        Value::List(l) => bool_v(l.iter().any(|x| x.equals(&a[1]))),
        Value::Object(o) => bool_v(s(&a[1]).is_some_and(|k| o.iter().any(|(n, _)| n == k))),
        _ => bool_v(false),
    }
}

fn f_containsword(_: &Interp, a: &[Value]) -> Res {
    let (Some(h), Some(w)) = (s(&a[0]), s(&a[1])) else {
        return bool_v(false);
    };
    let escaped: String = w
        .chars()
        .flat_map(|c| {
            if c.is_alphanumeric() || c == '_' {
                vec![c]
            } else {
                vec!['\\', c]
            }
        })
        .collect();
    let re = RegexpValue::new(&format!(r"(^|\W){escaped}(\W|$)"), "i")?;
    bool_v(re.re.is_match(h))
}

fn f_upper(_: &Interp, a: &[Value]) -> Res {
    match &a[0] {
        Value::String(x) => Ok(Value::String(x.to_uppercase())),
        Value::Null => Ok(Value::Null),
        v => type_err(format!("upper() expects text, found a {}", v.type_name())),
    }
}

fn regex_arg(v: &Value) -> Result<RegexpValue, ErrorValue> {
    match v {
        Value::String(p) => RegexpValue::new(p, ""),
        Value::Regexp(r) => Ok(r.clone()),
        other => type_err(format!("expected a pattern, found a {}", other.type_name())),
    }
}

fn f_regextest(_: &Interp, a: &[Value]) -> Res {
    let re = regex_arg(&a[0])?;
    bool_v(s(&a[1]).is_some_and(|t| re.re.is_match(t)))
}

fn f_regexmatch(_: &Interp, a: &[Value]) -> Res {
    let (Value::String(p), Some(t)) = (&a[0], s(&a[1])) else {
        return bool_v(false);
    };
    let re = RegexpValue::new(&format!("^(?:{p})$"), "")?;
    bool_v(re.re.is_match(t))
}

fn f_regexreplace(_: &Interp, a: &[Value]) -> Res {
    let (Some(t), Some(rep)) = (s(&a[0]), s(&a[2])) else {
        return Ok(Value::Null);
    };
    let re = regex_arg(&a[1])?;
    Ok(Value::String(re.re.replace_all(t, rep).into_owned()))
}

fn int_arg(v: &Value, f: &str) -> Result<usize, ErrorValue> {
    match v {
        Value::Number(n) if *n >= 0.0 => Ok(*n as usize),
        other => type_err(format!(
            "{f}() expects a count, found a {}",
            other.type_name()
        )),
    }
}

fn f_truncate(_: &Interp, a: &[Value]) -> Res {
    let Some(t) = s(&a[0]) else {
        return Ok(a[0].clone());
    };
    let n = int_arg(&a[1], "truncate")?;
    let suffix = a.get(2).and_then(s).unwrap_or("...");
    if t.chars().count() <= n {
        return Ok(Value::String(t.to_string()));
    }
    let keep = n.saturating_sub(suffix.chars().count());
    Ok(Value::String(format!(
        "{}{suffix}",
        t.chars().take(keep).collect::<String>()
    )))
}

fn pad(a: &[Value], left: bool) -> Res {
    let Some(t) = s(&a[0]) else {
        return Ok(Value::Null);
    };
    let n = int_arg(&a[1], "pad")?;
    let ch = a.get(2).and_then(s).unwrap_or(" ");
    let missing = n.saturating_sub(t.chars().count());
    let fill: String = ch.chars().cycle().take(missing).collect();
    Ok(Value::String(if left {
        format!("{fill}{t}")
    } else {
        format!("{t}{fill}")
    }))
}
fn f_padleft(_: &Interp, a: &[Value]) -> Res {
    pad(a, true)
}
fn f_padright(_: &Interp, a: &[Value]) -> Res {
    pad(a, false)
}

fn f_trunc(_: &Interp, a: &[Value]) -> Res {
    match &a[0] {
        Value::Number(n) => Ok(Value::Number(n.trunc())),
        Value::Null => Ok(Value::Null),
        v => type_err(format!(
            "trunc() expects a number, found a {}",
            v.type_name()
        )),
    }
}

fn f_product(_: &Interp, a: &[Value]) -> Res {
    match &a[0] {
        Value::List(l) => Ok(Value::Number(
            l.iter()
                .filter_map(|v| match v {
                    Value::Number(n) => Some(*n),
                    _ => None,
                })
                .product(),
        )),
        v => type_err(format!(
            "product() expects a list, found a {}",
            v.type_name()
        )),
    }
}

/// `all(list)` or `all(a, b, ...)`: the items to test.
fn items(a: &[Value]) -> Vec<Value> {
    match a {
        [Value::List(l)] => l.clone(),
        _ => a.to_vec(),
    }
}
fn f_all(_: &Interp, a: &[Value]) -> Res {
    bool_v(items(a).iter().all(truthy))
}
fn f_any(_: &Interp, a: &[Value]) -> Res {
    bool_v(items(a).iter().any(truthy))
}
fn f_none(_: &Interp, a: &[Value]) -> Res {
    bool_v(!items(a).iter().any(truthy))
}
fn f_nonnull(_: &Interp, a: &[Value]) -> Res {
    Ok(Value::List(
        items(a).into_iter().filter(|v| !v.is_null()).collect(),
    ))
}
fn f_firstvalue(_: &Interp, a: &[Value]) -> Res {
    Ok(items(a)
        .into_iter()
        .find(|v| !v.is_null())
        .unwrap_or(Value::Null))
}

fn f_typeof(_: &Interp, a: &[Value]) -> Res {
    Ok(Value::str(match &a[0] {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) | Value::Html(_) => "string",
        Value::Date(_) => "date",
        Value::Duration(_) => "duration",
        Value::List(_) => "array",
        Value::Object(_) | Value::File(_) => "object",
        Value::Link(_) => "link",
        _ => "unknown",
    }))
}

/// Luxon format tokens to the Moment tokens `datetime::format_date` knows.
pub fn luxon_to_moment(fmt: &str) -> String {
    let cs: Vec<char> = fmt.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < cs.len() {
        let c = cs[i];
        if c == '\'' {
            let mut j = i + 1;
            let mut lit = String::new();
            while j < cs.len() && cs[j] != '\'' {
                lit.push(cs[j]);
                j += 1;
            }
            if !lit.is_empty() {
                out.push_str(&format!("[{lit}]"));
            }
            i = j + 1;
            continue;
        }
        if !c.is_ascii_alphabetic() {
            out.push(c);
            i += 1;
            continue;
        }
        let n = cs[i..].iter().take_while(|x| **x == c).count();
        let mapped: String = match (c, n) {
            ('y', 2) => "YY".into(),
            ('y', _) => "YYYY".into(),
            ('L' | 'M', n) => "M".repeat(n.min(4)),
            ('d', 1) => "D".into(),
            ('d', _) => "DD".into(),
            ('E', 4) => "dddd".into(),
            ('E', _) => "ddd".into(),
            ('a', _) => "A".into(),
            ('H' | 'h' | 'm' | 's' | 'S' | 'Z', n) => c.to_string().repeat(n),
            ('o', _) => "DDDD".into(),
            ('W', n) => "W".repeat(n.min(2)),
            (other, n) => format!("[{}]", other.to_string().repeat(n)),
        };
        out.push_str(&mapped);
        i += n;
    }
    out
}

fn f_dateformat(i: &Interp, a: &[Value]) -> Res {
    match (&a[0], &a[1]) {
        (Value::Date(d), Value::String(f)) => Ok(Value::String(datetime::format_date(
            d.ms,
            &luxon_to_moment(f),
            i.offset(),
        ))),
        (Value::Null, _) => Ok(Value::Null),
        (v, _) => type_err(format!(
            "dateformat() expects a date, found a {}",
            v.type_name()
        )),
    }
}

fn f_localtime(_: &Interp, a: &[Value]) -> Res {
    Ok(a[0].clone())
}

fn f_object(_: &Interp, a: &[Value]) -> Res {
    if !a.len().is_multiple_of(2) {
        return type_err("object() takes key and value pairs");
    }
    Ok(Value::Object(
        a.chunks(2)
            .map(|p| (p[0].display(), p[1].clone()))
            .collect(),
    ))
}

fn unit_arg(a: &[Value]) -> Result<&str, ErrorValue> {
    s(&a[0]).ok_or_else(|| ErrorValue::type_err("expected a unit name"))
}

/// Start of the current week (Monday, like Luxon), month or year, on the local wall clock.
fn f_startof(i: &Interp, a: &[Value]) -> Res {
    let now = i.clock.now_local_ms();
    let day = datetime::start_of_day(now);
    let c = datetime::civil_from_ms(day);
    let ms = match unit_arg(a)? {
        "week" => day - (datetime::weekday(day) as i64 + 6) % 7 * datetime::MS_PER_DAY,
        "month" => datetime::days_from_civil(c.year, c.month, 1) * datetime::MS_PER_DAY,
        "year" => datetime::days_from_civil(c.year, 1, 1) * datetime::MS_PER_DAY,
        other => return type_err(format!("unknown unit \"{other}\"")),
    };
    Ok(Value::date(ms, true))
}

/// Last millisecond of the current week, month or year.
fn f_endof(i: &Interp, a: &[Value]) -> Res {
    let now = i.clock.now_local_ms();
    let day = datetime::start_of_day(now);
    let c = datetime::civil_from_ms(day);
    let next = match unit_arg(a)? {
        "week" => {
            day - (datetime::weekday(day) as i64 + 6) % 7 * datetime::MS_PER_DAY
                + 7 * datetime::MS_PER_DAY
        }
        "month" => {
            let (y, m) = if c.month == 12 {
                (c.year + 1, 1)
            } else {
                (c.year, c.month + 1)
            };
            datetime::days_from_civil(y, m, 1) * datetime::MS_PER_DAY
        }
        "year" => datetime::days_from_civil(c.year + 1, 1, 1) * datetime::MS_PER_DAY,
        other => return type_err(format!("unknown unit \"{other}\"")),
    };
    Ok(Value::date(next - 1, true))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn luxon_tokens_become_moment_tokens() {
        assert_eq!(luxon_to_moment("yyyy-MM-dd"), "YYYY-MM-DD");
        assert_eq!(
            luxon_to_moment("EEEE, LLLL d 'at' HH:mm"),
            "dddd, MMMM D [at] HH:mm"
        );
        assert_eq!(luxon_to_moment("h:mm a"), "h:mm A");
    }

    #[test]
    fn dql_truthiness() {
        assert!(!truthy(&Value::List(vec![])));
        assert!(!truthy(&Value::str("")));
        assert!(!truthy(&Value::Number(0.0)));
        assert!(truthy(&Value::List(vec![Value::Null])));
        assert!(Value::List(vec![]).truthy(), "Bases keeps its own rule");
    }

    #[test]
    fn dates_in_file_names() {
        assert!(matches!(
            date_in_name("Daily 2024-03-05"),
            Some(Value::Date(_))
        ));
        assert!(matches!(
            date_in_name("20240305 notes"),
            Some(Value::Date(_))
        ));
        assert!(date_in_name("no date").is_none());
    }
}
