//! The Bases value model: the types an expression can produce, with their
//! coercions, equality, ordering, truthiness and display. Choices where the
//! public docs are silent are listed in [`super::choices`] (U7, U9, U12, U18).

use super::choices;
use super::datetime::{self, DurationValue};
use serde::ser::{Serialize, SerializeMap, Serializer};
use serde_json::{json, Value as Json};
use std::cmp::Ordering;

/// Kinds of error a value can carry (U4, U20).
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrorKind {
    Syntax,
    UnknownFunction,
    UnknownMethod,
    UnknownField,
    UnknownFormula,
    Arity,
    Type,
    Circular,
    Runtime,
}

/// An error as a value: it propagates through operators and calls instead of
/// unwinding, so one bad cell never takes down a view.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct ErrorValue {
    pub kind: ErrorKind,
    pub message: String,
}

impl ErrorValue {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        ErrorValue {
            kind,
            message: message.into(),
        }
    }
    pub fn type_err(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Type, message)
    }
    pub fn runtime(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Runtime, message)
    }
}

/// A date with optional time, as local-naive milliseconds (see `datetime`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DateValue {
    pub ms: i64,
    pub has_time: bool,
}

/// A link. Equality (U18): both resolved => same file; otherwise same text.
#[derive(Clone, Debug)]
pub struct LinkValue {
    /// Link text without brackets, heading or alias (`Folder/Note`).
    pub target: String,
    pub display: Option<String>,
    /// Vault path the link resolves to, if the file exists.
    pub resolved: Option<String>,
}

impl LinkValue {
    /// Parse `[[target#heading|alias]]` (or a bare `target|alias`).
    pub fn parse_wikilink(raw: &str) -> Option<(String, Option<String>)> {
        let t = raw.trim();
        let inner = t.strip_prefix("[[")?.strip_suffix("]]")?;
        if inner.is_empty() || inner.contains("[[") || inner.contains("]]") {
            return None;
        }
        let (target_part, display) = match inner.split_once('|') {
            Some((a, b)) => (a, Some(b.trim().to_string())),
            None => (inner, None),
        };
        let target = target_part.split('#').next().unwrap_or("").trim();
        if target.is_empty() {
            return None;
        }
        Some((target.to_string(), display))
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileValue {
    pub path: String,
}

/// A compiled regular expression literal (`/abc/i`). Matching uses
/// `regex-lite`: no lookaround and no backreferences, unlike JavaScript.
#[derive(Clone, Debug)]
pub struct RegexpValue {
    pub source: String,
    pub flags: String,
    pub re: std::sync::Arc<regex_lite::Regex>,
}

impl RegexpValue {
    pub fn new(source: &str, flags: &str) -> Result<RegexpValue, ErrorValue> {
        let mut b = regex_lite::RegexBuilder::new(source);
        for f in flags.chars() {
            match f {
                'i' => {
                    b.case_insensitive(true);
                }
                'm' => {
                    b.multi_line(true);
                }
                's' => {
                    b.dot_matches_new_line(true);
                }
                'g' | 'u' | 'y' | 'd' => {}
                other => {
                    return Err(ErrorValue::runtime(format!(
                        "unsupported regexp flag \"{other}\""
                    )))
                }
            }
        }
        let re = b
            .build()
            .map_err(|e| ErrorValue::runtime(format!("invalid regexp /{source}/: {e}")))?;
        Ok(RegexpValue {
            source: source.to_string(),
            flags: flags.to_string(),
            re: std::sync::Arc::new(re),
        })
    }
    pub fn is_global(&self) -> bool {
        self.flags.contains('g')
    }
}

/// Type tags, used by `isType()` and for dispatch.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ty {
    Null,
    Bool,
    Number,
    String,
    Date,
    Duration,
    List,
    Object,
    Link,
    File,
    Regexp,
    Html,
    Image,
    Icon,
    Error,
}

impl Ty {
    pub fn name(self) -> &'static str {
        match self {
            Ty::Null => "null",
            Ty::Bool => "boolean",
            Ty::Number => "number",
            Ty::String => "string",
            Ty::Date => "date",
            Ty::Duration => "duration",
            Ty::List => "list",
            Ty::Object => "object",
            Ty::Link => "link",
            Ty::File => "file",
            Ty::Regexp => "regexp",
            Ty::Html => "html",
            Ty::Image => "image",
            Ty::Icon => "icon",
            Ty::Error => "error",
        }
    }
}

#[derive(Clone, Debug)]
pub enum Value {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Date(DateValue),
    Duration(DurationValue),
    List(Vec<Value>),
    /// Insertion-ordered key/value pairs.
    Object(Vec<(String, Value)>),
    Link(LinkValue),
    File(FileValue),
    Regexp(RegexpValue),
    Html(String),
    Image(String),
    Icon(String),
    Error(ErrorValue),
}

impl Value {
    pub fn str(s: impl Into<String>) -> Value {
        Value::String(s.into())
    }
    pub fn num(n: impl Into<f64>) -> Value {
        Value::Number(n.into())
    }
    pub fn err(kind: ErrorKind, message: impl Into<String>) -> Value {
        Value::Error(ErrorValue::new(kind, message))
    }
    pub fn date(ms: i64, has_time: bool) -> Value {
        Value::Date(DateValue { ms, has_time })
    }

    pub fn ty(&self) -> Ty {
        match self {
            Value::Null => Ty::Null,
            Value::Bool(_) => Ty::Bool,
            Value::Number(_) => Ty::Number,
            Value::String(_) => Ty::String,
            Value::Date(_) => Ty::Date,
            Value::Duration(_) => Ty::Duration,
            Value::List(_) => Ty::List,
            Value::Object(_) => Ty::Object,
            Value::Link(_) => Ty::Link,
            Value::File(_) => Ty::File,
            Value::Regexp(_) => Ty::Regexp,
            Value::Html(_) => Ty::Html,
            Value::Image(_) => Ty::Image,
            Value::Icon(_) => Ty::Icon,
            Value::Error(_) => Ty::Error,
        }
    }

    pub fn type_name(&self) -> &'static str {
        self.ty().name()
    }

    pub fn is_null(&self) -> bool {
        matches!(self, Value::Null)
    }

    pub fn as_error(&self) -> Option<&ErrorValue> {
        match self {
            Value::Error(e) => Some(e),
            _ => None,
        }
    }

    /// Truthiness (U12).
    pub fn truthy(&self) -> bool {
        match self {
            Value::Null => false,
            Value::Bool(b) => *b,
            Value::Number(n) => *n != 0.0 && !n.is_nan(),
            Value::String(s) | Value::Html(s) | Value::Image(s) | Value::Icon(s) => !s.is_empty(),
            Value::List(l) => !l.is_empty() || choices::EMPTY_LIST_IS_TRUTHY,
            Value::Object(o) => !o.is_empty() || choices::EMPTY_OBJECT_IS_TRUTHY,
            Value::Error(_) => false,
            _ => true,
        }
    }

    /// `isEmpty()`: null, `""`, `[]`, `{}` are empty; numbers, dates and the
    /// rest never are (docs: number `isEmpty` is "true if it does not exist").
    pub fn is_empty(&self) -> bool {
        match self {
            Value::Null => true,
            Value::String(s) => s.is_empty(),
            Value::List(l) => l.is_empty(),
            Value::Object(o) => o.is_empty(),
            _ => false,
        }
    }

    /// Display / `toString()` form. Null is the empty string (an empty cell).
    pub fn display(&self) -> String {
        match self {
            Value::Null => String::new(),
            Value::Bool(b) => b.to_string(),
            Value::Number(n) => format_number(*n),
            Value::String(s) | Value::Html(s) | Value::Image(s) | Value::Icon(s) => s.clone(),
            Value::Date(d) => datetime::iso_string(d.ms, d.has_time),
            Value::Duration(d) => datetime::format_duration(d),
            Value::List(l) => l.iter().map(|v| v.display()).collect::<Vec<_>>().join(", "),
            Value::Object(o) => format!(
                "{{{}}}",
                o.iter()
                    .map(|(k, v)| format!("{k}: {}", v.display()))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
            Value::Link(l) => l.display.clone().unwrap_or_else(|| l.target.clone()),
            Value::File(f) => f.path.clone(),
            Value::Regexp(r) => format!("/{}/{}", r.source, r.flags),
            Value::Error(e) => format!("Error: {}", e.message),
        }
    }

    /// Equality (U12, U18). No cross-type coercion.
    pub fn equals(&self, other: &Value) -> bool {
        match (self, other) {
            (Value::Null, Value::Null) => true,
            (Value::Bool(a), Value::Bool(b)) => a == b,
            (Value::Number(a), Value::Number(b)) => a == b,
            (Value::String(a), Value::String(b)) => a == b,
            (Value::Html(a), Value::Html(b)) => a == b,
            (Value::Image(a), Value::Image(b)) => a == b,
            (Value::Icon(a), Value::Icon(b)) => a == b,
            (Value::Date(a), Value::Date(b)) => a.ms == b.ms,
            (Value::Duration(a), Value::Duration(b)) => a == b,
            (Value::List(a), Value::List(b)) => {
                a.len() == b.len() && a.iter().zip(b).all(|(x, y)| x.equals(y))
            }
            (Value::Object(a), Value::Object(b)) => {
                a.len() == b.len()
                    && a.iter()
                        .all(|(k, v)| b.iter().any(|(k2, v2)| k == k2 && v.equals(v2)))
            }
            (Value::Link(a), Value::Link(b)) => match (&a.resolved, &b.resolved) {
                (Some(x), Some(y)) => x == y,
                _ => a.target.to_lowercase() == b.target.to_lowercase(),
            },
            (Value::Link(l), Value::File(f)) | (Value::File(f), Value::Link(l)) => {
                l.resolved.as_deref() == Some(f.path.as_str())
            }
            (Value::File(a), Value::File(b)) => a.path == b.path,
            (Value::Regexp(a), Value::Regexp(b)) => a.source == b.source && a.flags == b.flags,
            _ => false,
        }
    }

    /// Ordering for `<`, `>`, `<=`, `>=`: only values of the same orderable
    /// type compare; everything else is `None` (U12).
    pub fn compare(&self, other: &Value) -> Option<Ordering> {
        match (self, other) {
            (Value::Number(a), Value::Number(b)) => a.partial_cmp(b),
            (Value::String(a), Value::String(b)) => Some(cmp_str(a, b)),
            (Value::Bool(a), Value::Bool(b)) => Some(a.cmp(b)),
            (Value::Date(a), Value::Date(b)) => Some(a.ms.cmp(&b.ms)),
            (Value::Duration(a), Value::Duration(b)) => Some(a.cmp_total(b)),
            _ => None,
        }
    }

    /// Convert plain JSON (e.g. frontmatter parsed by the index) to a value.
    /// Strings are kept as strings except exact ISO dates when `sniff_dates`
    /// is set (U9); wikilink strings stay strings here (the interpreter turns
    /// them into links because resolving needs a row context).
    pub fn from_json(j: &Json, sniff_dates: bool, utc_offset_min: i32) -> Value {
        match j {
            Json::Null => Value::Null,
            Json::Bool(b) => Value::Bool(*b),
            Json::Number(n) => Value::Number(n.as_f64().unwrap_or(f64::NAN)),
            Json::String(s) => {
                if sniff_dates && looks_like_iso_date(s) {
                    if let Some((ms, has_time)) = datetime::parse_date(s, utc_offset_min) {
                        return Value::date(ms, has_time);
                    }
                }
                Value::String(s.clone())
            }
            Json::Array(a) => Value::List(
                a.iter()
                    .map(|x| Value::from_json(x, sniff_dates, utc_offset_min))
                    .collect(),
            ),
            Json::Object(o) => Value::Object(
                o.iter()
                    .map(|(k, v)| (k.clone(), Value::from_json(v, sniff_dates, utc_offset_min)))
                    .collect(),
            ),
        }
    }

    /// Tagged JSON form used by `BaseQueryResult`: `{"type": ..., "value": ...}`.
    pub fn to_json(&self) -> Json {
        let t = self.type_name();
        match self {
            Value::Null => json!({ "type": t }),
            Value::Bool(b) => json!({ "type": t, "value": b }),
            Value::Number(n) => json!({ "type": t, "value": n }),
            Value::String(s) | Value::Html(s) | Value::Image(s) | Value::Icon(s) => {
                json!({ "type": t, "value": s })
            }
            Value::Date(d) => json!({
                "type": t,
                "value": datetime::iso_string(d.ms, d.has_time),
                "hasTime": d.has_time
            }),
            Value::Duration(d) => {
                json!({ "type": t, "value": { "months": d.months, "millis": d.millis } })
            }
            Value::List(l) => {
                json!({ "type": t, "value": l.iter().map(Value::to_json).collect::<Vec<_>>() })
            }
            Value::Object(o) => {
                let mut m = serde_json::Map::new();
                for (k, v) in o {
                    m.insert(k.clone(), v.to_json());
                }
                json!({ "type": t, "value": m })
            }
            Value::Link(l) => json!({
                "type": t,
                "value": { "target": l.target, "display": l.display, "resolved": l.resolved }
            }),
            Value::File(f) => json!({ "type": t, "value": f.path }),
            Value::Regexp(r) => {
                json!({ "type": t, "value": { "source": r.source, "flags": r.flags } })
            }
            Value::Error(e) => {
                json!({ "type": t, "value": { "kind": e.kind, "message": e.message } })
            }
        }
    }
}

impl PartialEq for Value {
    fn eq(&self, other: &Self) -> bool {
        self.equals(other)
    }
}

impl Serialize for Value {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let j = self.to_json();
        let mut m = s.serialize_map(None)?;
        if let Json::Object(o) = &j {
            for (k, v) in o {
                m.serialize_entry(k, v)?;
            }
        }
        m.end()
    }
}

fn looks_like_iso_date(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() >= 10
        && b[..4].iter().all(u8::is_ascii_digit)
        && b[4] == b'-'
        && b[5..7].iter().all(u8::is_ascii_digit)
        && b[7] == b'-'
        && b[8..10].iter().all(u8::is_ascii_digit)
}

/// JS-like number formatting: integers without a fraction, `NaN`, `Infinity`.
pub fn format_number(n: f64) -> String {
    if n.is_nan() {
        "NaN".into()
    } else if n.is_infinite() {
        if n > 0.0 { "Infinity" } else { "-Infinity" }.into()
    } else if n == n.trunc() && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

/// String order used by sort and by `<` (U7): case-insensitive first, then by
/// bytes so the order is total and deterministic.
pub fn cmp_str(a: &str, b: &str) -> Ordering {
    let la = a.to_lowercase();
    let lb = b.to_lowercase();
    la.cmp(&lb).then_with(|| a.cmp(b))
}

fn type_rank(v: &Value) -> u8 {
    match v {
        Value::Null | Value::Error(_) => 0,
        Value::Bool(_) => 1,
        Value::Number(_) => 2,
        Value::Date(_) => 3,
        Value::Duration(_) => 4,
        Value::String(_) | Value::Html(_) | Value::Image(_) | Value::Icon(_) => 5,
        Value::Link(_) => 6,
        Value::File(_) => 7,
        Value::List(_) => 8,
        Value::Object(_) => 9,
        Value::Regexp(_) => 10,
    }
}

/// Total order for sorting and grouping (U7, U8): null lowest, then by type
/// rank, then by value within the type.
pub fn compare_for_sort(a: &Value, b: &Value) -> Ordering {
    let (ra, rb) = (type_rank(a), type_rank(b));
    if ra != rb {
        return ra.cmp(&rb);
    }
    match (a, b) {
        (Value::Bool(x), Value::Bool(y)) => x.cmp(y),
        (Value::Number(x), Value::Number(y)) => x.partial_cmp(y).unwrap_or_else(|| {
            // NaN sorts below every number, equal to itself
            x.is_nan().cmp(&y.is_nan()).reverse()
        }),
        (Value::Date(x), Value::Date(y)) => x.ms.cmp(&y.ms),
        (Value::Duration(x), Value::Duration(y)) => x.cmp_total(y),
        (
            Value::String(x) | Value::Html(x) | Value::Image(x) | Value::Icon(x),
            Value::String(y) | Value::Html(y) | Value::Image(y) | Value::Icon(y),
        ) => cmp_str(x, y),
        (Value::Link(x), Value::Link(y)) => cmp_str(
            x.resolved.as_deref().unwrap_or(&x.target),
            y.resolved.as_deref().unwrap_or(&y.target),
        ),
        (Value::File(x), Value::File(y)) => cmp_str(&x.path, &y.path),
        (Value::List(x), Value::List(y)) => {
            for (p, q) in x.iter().zip(y) {
                let o = compare_for_sort(p, q);
                if o != Ordering::Equal {
                    return o;
                }
            }
            x.len().cmp(&y.len())
        }
        (Value::Object(x), Value::Object(y)) => cmp_str(
            &Value::Object(x.clone()).display(),
            &Value::Object(y.clone()).display(),
        ),
        (Value::Regexp(x), Value::Regexp(y)) => x.source.cmp(&y.source),
        _ => Ordering::Equal,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn equality_is_strict_about_types() {
        assert!(Value::Null.equals(&Value::Null));
        assert!(!Value::num(1).equals(&Value::str("1")));
        assert!(!Value::Bool(true).equals(&Value::num(1)));
        assert!(Value::List(vec![Value::num(1)]).equals(&Value::List(vec![Value::num(1)])));
        assert!(!Value::List(vec![Value::num(1)]).equals(&Value::List(vec![])));
        // date vs datetime at midnight compare by instant
        assert!(Value::date(0, false).equals(&Value::date(0, true)));
        assert!(!Value::date(0, false).equals(&Value::str("1970-01-01")));
    }

    #[test]
    fn links_compare_by_resolution_then_text() {
        let a = LinkValue {
            target: "Note".into(),
            display: None,
            resolved: Some("x/Note.md".into()),
        };
        let b = LinkValue {
            target: "x/Note".into(),
            display: Some("shown".into()),
            resolved: Some("x/Note.md".into()),
        };
        assert!(Value::Link(a.clone()).equals(&Value::Link(b)));
        let c = LinkValue {
            target: "NOTE".into(),
            display: None,
            resolved: None,
        };
        let d = LinkValue {
            target: "note".into(),
            display: None,
            resolved: None,
        };
        assert!(Value::Link(c).equals(&Value::Link(d)));
        assert!(Value::Link(a.clone()).equals(&Value::File(FileValue {
            path: "x/Note.md".into()
        })));
        assert!(!Value::Link(a).equals(&Value::File(FileValue {
            path: "y/Note.md".into()
        })));
    }

    #[test]
    fn truthiness() {
        for (v, t) in [
            (Value::Null, false),
            (Value::Bool(false), false),
            (Value::Bool(true), true),
            (Value::num(0), false),
            (Value::num(2), true),
            (Value::str(""), false),
            (Value::str("a"), true),
            (Value::List(vec![]), true),
            (Value::date(0, false), true),
        ] {
            assert_eq!(v.truthy(), t, "{v:?}");
        }
    }

    #[test]
    fn ordering_total_and_null_lowest() {
        let mut v = [
            Value::str("b"),
            Value::Null,
            Value::num(3),
            Value::str("A"),
            Value::Bool(true),
            Value::num(-1),
            Value::date(5, false),
        ];
        v.sort_by(compare_for_sort);
        let names: Vec<_> = v.iter().map(|x| x.type_name()).collect();
        assert_eq!(
            names,
            ["null", "boolean", "number", "number", "date", "string", "string"]
        );
        assert_eq!(v[5].display(), "A");
        assert_eq!(v[6].display(), "b");
        assert_eq!(Value::num(1).compare(&Value::str("1")), None);
        assert_eq!(Value::Null.compare(&Value::num(1)), None);
    }

    #[test]
    fn display_forms() {
        assert_eq!(Value::num(3).display(), "3");
        assert_eq!(Value::num(-0.0).display(), "0");
        assert_eq!(Value::num(2.5).display(), "2.5");
        assert_eq!(Value::Null.display(), "");
        assert_eq!(
            Value::List(vec![Value::num(1), Value::str("a")]).display(),
            "1, a"
        );
        assert_eq!(Value::date(0, false).display(), "1970-01-01");
        assert_eq!(Value::date(1000, true).display(), "1970-01-01T00:00:01");
    }

    #[test]
    fn wikilink_parse() {
        assert_eq!(
            LinkValue::parse_wikilink("[[A Note#Head|shown]]"),
            Some(("A Note".into(), Some("shown".into())))
        );
        assert_eq!(
            LinkValue::parse_wikilink(" [[Plain]] "),
            Some(("Plain".into(), None))
        );
        assert_eq!(LinkValue::parse_wikilink("[[]]"), None);
        assert_eq!(LinkValue::parse_wikilink("x [[a]] y"), None);
        assert_eq!(LinkValue::parse_wikilink("[[a]] [[b]]"), None);
    }

    #[test]
    fn json_round_trip_shapes() {
        let j = serde_json::json!({"a": [1, "x", null], "d": "2024-01-05"});
        let v = Value::from_json(&j, true, 0);
        match &v {
            Value::Object(o) => {
                assert!(matches!(o[1].1, Value::Date(_)));
                assert!(matches!(o[0].1, Value::List(_)));
            }
            _ => panic!("expected object"),
        }
        let plain = Value::from_json(&j, false, 0);
        assert_eq!(plain.to_json()["value"]["d"]["type"], "string");
        let s = serde_json::to_string(&Value::str("x")).unwrap();
        assert_eq!(s, r#"{"type":"string","value":"x"}"#);
    }

    #[test]
    fn regexp_flags_and_errors() {
        let r = RegexpValue::new("a.c", "i").unwrap();
        assert!(r.re.is_match("xABCx"));
        assert!(RegexpValue::new("(", "").is_err());
        assert!(RegexpValue::new("a", "z").is_err());
    }
}
