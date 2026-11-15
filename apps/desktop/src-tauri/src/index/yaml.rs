//! Lenient YAML front-end for frontmatter.
//!
//! `yaml-rust2`'s own `Yaml` tree loses whether a scalar was quoted, and the
//! index must tell `date: 2024-01-05` (a date) from `date: "2024-01-05"` (text).
//! So this module drives the event parser directly and builds a small typed
//! tree ([`YNode`]) with its own scalar resolution (YAML 1.2 core schema plus
//! ISO dates/datetimes, the subset Obsidian properties distinguish).

use serde_json::{Map, Number, Value};
use yaml_rust2::parser::{Event, MarkedEventReceiver, Parser, Tag};
use yaml_rust2::scanner::{Marker, TScalarStyle};

/// Hard cap on materialised nodes; protects against alias bombs.
const MAX_NODES: usize = 200_000;

#[derive(Debug, Clone, PartialEq)]
pub enum YNode {
    Null,
    Bool(bool),
    Int(i64),
    Float(f64),
    /// `quoted` is true for single/double quoted and block scalars.
    Str {
        s: String,
        quoted: bool,
    },
    /// Unquoted `YYYY-MM-DD`. `ms` is naive milliseconds since the Unix epoch
    /// (the wall-clock date read as UTC midnight).
    Date {
        raw: String,
        ms: i64,
    },
    /// Unquoted ISO datetime. Naive wall-clock ms unless the text carries an
    /// offset, in which case it is converted to UTC.
    DateTime {
        raw: String,
        ms: i64,
    },
    Seq(Vec<YNode>),
    Map(Vec<(String, YNode)>),
}

impl YNode {
    pub fn to_json(&self) -> Value {
        match self {
            YNode::Null => Value::Null,
            YNode::Bool(b) => Value::Bool(*b),
            YNode::Int(i) => Value::Number((*i).into()),
            YNode::Float(f) => Number::from_f64(*f).map_or(Value::Null, Value::Number),
            YNode::Str { s, .. } | YNode::Date { raw: s, .. } | YNode::DateTime { raw: s, .. } => {
                Value::String(s.clone())
            }
            YNode::Seq(items) => Value::Array(items.iter().map(YNode::to_json).collect()),
            YNode::Map(pairs) => {
                let mut map = Map::new();
                for (k, v) in pairs {
                    map.insert(k.clone(), v.to_json());
                }
                Value::Object(map)
            }
        }
    }
}

enum Frame {
    Seq(Vec<YNode>, usize),
    Map(Vec<(String, YNode)>, Option<String>, usize),
}

#[derive(Default)]
struct Builder {
    stack: Vec<Frame>,
    anchors: std::collections::HashMap<usize, YNode>,
    root: Option<YNode>,
    nodes: usize,
    error: Option<String>,
}

impl Builder {
    fn fail(&mut self, msg: impl Into<String>) {
        if self.error.is_none() {
            self.error = Some(msg.into());
        }
    }

    fn attach(&mut self, node: YNode, anchor: usize) {
        if anchor > 0 {
            self.anchors.insert(anchor, node.clone());
        }
        match self.stack.last_mut() {
            None => self.root = Some(node),
            Some(Frame::Seq(items, _)) => items.push(node),
            Some(Frame::Map(pairs, pending, _)) => match pending.take() {
                None => {
                    let key = key_string(&node);
                    *pending = Some(key);
                }
                Some(key) => {
                    // Duplicate keys: last one wins, keeping first position.
                    if let Some(slot) = pairs.iter_mut().find(|(k, _)| *k == key) {
                        slot.1 = node;
                    } else {
                        pairs.push((key, node));
                    }
                }
            },
        }
    }
}

fn key_string(node: &YNode) -> String {
    match node {
        YNode::Null => "null".to_string(),
        YNode::Bool(b) => b.to_string(),
        YNode::Int(i) => i.to_string(),
        YNode::Float(f) => f.to_string(),
        YNode::Str { s, .. } | YNode::Date { raw: s, .. } | YNode::DateTime { raw: s, .. } => {
            s.clone()
        }
        other => other.to_json().to_string(),
    }
}

impl MarkedEventReceiver for Builder {
    fn on_event(&mut self, ev: Event, _mark: Marker) {
        self.nodes += 1;
        if self.nodes > MAX_NODES {
            self.fail("frontmatter too large or too deeply aliased");
            return;
        }
        match ev {
            Event::Scalar(value, style, anchor, tag) => {
                let node = resolve_scalar(&value, style, tag.as_ref());
                self.attach(node, anchor);
            }
            Event::SequenceStart(anchor, _) => self.stack.push(Frame::Seq(Vec::new(), anchor)),
            Event::MappingStart(anchor, _) => {
                self.stack.push(Frame::Map(Vec::new(), None, anchor));
            }
            Event::SequenceEnd => match self.stack.pop() {
                Some(Frame::Seq(items, anchor)) => self.attach(YNode::Seq(items), anchor),
                _ => self.fail("unbalanced sequence"),
            },
            Event::MappingEnd => match self.stack.pop() {
                Some(Frame::Map(pairs, pending, anchor)) => {
                    if pending.is_some() {
                        self.fail("mapping key without value");
                    }
                    self.attach(YNode::Map(pairs), anchor);
                }
                _ => self.fail("unbalanced mapping"),
            },
            Event::Alias(id) => match self.anchors.get(&id).cloned() {
                Some(node) => self.attach(node, 0),
                None => self.fail("alias to unknown anchor"),
            },
            Event::Nothing
            | Event::StreamStart
            | Event::StreamEnd
            | Event::DocumentStart
            | Event::DocumentEnd => {}
        }
    }
}

/// Parse the first YAML document of `text`. An empty document yields `None`.
pub fn parse(text: &str) -> Result<Option<YNode>, String> {
    let mut builder = Builder::default();
    let mut parser = Parser::new_from_str(text);
    parser
        .load(&mut builder, false)
        .map_err(|e| format!("invalid YAML: {e}"))?;
    if let Some(err) = builder.error {
        return Err(err);
    }
    Ok(builder.root)
}

fn resolve_scalar(s: &str, style: TScalarStyle, tag: Option<&Tag>) -> YNode {
    if style != TScalarStyle::Plain {
        return YNode::Str {
            s: s.to_string(),
            quoted: true,
        };
    }
    if let Some(tag) = tag {
        if tag.suffix == "str" {
            return YNode::Str {
                s: s.to_string(),
                quoted: true,
            };
        }
    }
    resolve_plain(s)
}

pub fn resolve_plain(s: &str) -> YNode {
    match s {
        "" | "~" | "null" | "Null" | "NULL" => return YNode::Null,
        "true" | "True" | "TRUE" => return YNode::Bool(true),
        "false" | "False" | "FALSE" => return YNode::Bool(false),
        _ => {}
    }
    if let Some(n) = parse_number(s) {
        return n;
    }
    if let Some(ms) = parse_date(s) {
        return YNode::Date {
            raw: s.to_string(),
            ms,
        };
    }
    if let Some(ms) = parse_datetime(s) {
        return YNode::DateTime {
            raw: s.to_string(),
            ms,
        };
    }
    YNode::Str {
        s: s.to_string(),
        quoted: false,
    }
}

/// Decimal integers and finite floats. Leading-zero integers (`007`) and
/// `.inf`/`.nan` stay text: they are identifiers far more often than numbers.
fn parse_number(s: &str) -> Option<YNode> {
    let body = s.strip_prefix(['+', '-']).unwrap_or(s);
    if body.is_empty() {
        return None;
    }
    let bytes = body.as_bytes();
    if bytes.iter().all(u8::is_ascii_digit) {
        if bytes.len() > 1 && bytes[0] == b'0' {
            return None;
        }
        return s.parse::<i64>().ok().map(YNode::Int);
    }
    let first_ok = bytes[0].is_ascii_digit() || (bytes[0] == b'.' && bytes.len() > 1);
    if !first_ok
        || !bytes
            .iter()
            .all(|b| b.is_ascii_digit() || matches!(b, b'.' | b'e' | b'E' | b'+' | b'-'))
    {
        return None;
    }
    if bytes.len() > 1 && bytes[0] == b'0' && bytes[1].is_ascii_digit() {
        return None;
    }
    let f: f64 = s.parse().ok()?;
    f.is_finite().then_some(YNode::Float(f))
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn is_leap(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

fn valid_ymd(y: i64, m: i64, d: i64) -> bool {
    let dim = match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap(y) => 29,
        2 => 28,
        _ => return false,
    };
    (1..=dim).contains(&d)
}

fn digits(s: &str) -> Option<i64> {
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse().ok()
}

fn parse_ymd(s: &str) -> Option<(i64, i64, i64)> {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let (y, m, d) = (digits(&s[0..4])?, digits(&s[5..7])?, digits(&s[8..10])?);
    valid_ymd(y, m, d).then_some((y, m, d))
}

pub fn parse_date(s: &str) -> Option<i64> {
    let (y, m, d) = parse_ymd(s)?;
    Some(days_from_civil(y, m, d) * 86_400_000)
}

/// `YYYY-MM-DD[T ]HH:MM[:SS[.fff]][ ]?[Z|+hh[:mm]|-hh[:mm]]`.
pub fn parse_datetime(s: &str) -> Option<i64> {
    if s.len() < 16 || !s.is_char_boundary(10) {
        return None;
    }
    let (y, m, d) = parse_ymd(&s[..10])?;
    let rest = &s[10..];
    let rest = rest.strip_prefix(['T', 't', ' '])?;
    let (time, offset) = split_offset(rest);
    let mut parts = time.split(':');
    let hh = digits(parts.next()?)?;
    let mm = digits(parts.next()?)?;
    let (ss, frac_ms) = match parts.next() {
        None => (0, 0),
        Some(sec) => {
            let (whole, frac) = sec.split_once('.').unwrap_or((sec, ""));
            let frac_ms = if frac.is_empty() {
                0
            } else {
                let padded: String = frac.chars().chain("000".chars()).take(3).collect();
                digits(&padded)?
            };
            (digits(whole)?, frac_ms)
        }
    };
    if parts.next().is_some() || hh > 23 || mm > 59 || ss > 60 {
        return None;
    }
    let mut ms =
        days_from_civil(y, m, d) * 86_400_000 + ((hh * 60 + mm) * 60 + ss) * 1000 + frac_ms;
    if let Some(off) = offset {
        ms -= off;
    }
    Some(ms)
}

/// Returns the time part and the offset in milliseconds (positive east).
fn split_offset(rest: &str) -> (&str, Option<i64>) {
    let rest = rest.trim_end();
    if let Some(t) = rest.strip_suffix(['Z', 'z']) {
        return (t.trim_end(), Some(0));
    }
    if let Some(pos) = rest.rfind(['+', '-']) {
        let (t, o) = rest.split_at(pos);
        let sign = if o.starts_with('-') { -1 } else { 1 };
        let o = &o[1..];
        let digits_only: String = o.chars().filter(|c| *c != ':').collect();
        if let Some(n) = digits(&digits_only) {
            let (h, m) = match digits_only.len() {
                2 => (n, 0),
                4 => (n / 100, n % 100),
                _ => return (rest, None),
            };
            return (t.trim_end(), Some(sign * (h * 60 + m) * 60_000));
        }
    }
    (rest, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scalars_resolve_by_style() {
        let n = parse("a: 2024-01-05\nb: \"2024-01-05\"\nc: 2024-01-05T10:30:00\nd: 12\ne: '12'\nf:\ng: ~\nh: true\ni: \"true\"\nj: 1.5")
            .unwrap()
            .unwrap();
        let YNode::Map(m) = n else { panic!() };
        let get = |k: &str| m.iter().find(|(key, _)| key == k).unwrap().1.clone();
        assert!(matches!(get("a"), YNode::Date { .. }));
        assert!(matches!(get("b"), YNode::Str { quoted: true, .. }));
        assert!(matches!(get("c"), YNode::DateTime { .. }));
        assert_eq!(get("d"), YNode::Int(12));
        assert!(matches!(get("e"), YNode::Str { quoted: true, .. }));
        assert_eq!(get("f"), YNode::Null);
        assert_eq!(get("g"), YNode::Null);
        assert_eq!(get("h"), YNode::Bool(true));
        assert!(matches!(get("i"), YNode::Str { .. }));
        assert_eq!(get("j"), YNode::Float(1.5));
    }

    #[test]
    fn date_math() {
        assert_eq!(parse_date("1970-01-02"), Some(86_400_000));
        assert_eq!(parse_date("2024-02-30"), None);
        assert_eq!(parse_datetime("1970-01-01T00:00:01Z"), Some(1000));
        assert_eq!(parse_datetime("1970-01-01T01:00:00+01:00"), Some(0));
        assert_eq!(parse_datetime("1970-01-01 00:00"), Some(0));
        assert_eq!(parse_datetime("1970-01-01T25:00"), None);
    }

    #[test]
    fn numbers_stay_conservative() {
        assert_eq!(
            resolve_plain("007"),
            YNode::Str {
                s: "007".into(),
                quoted: false
            }
        );
        assert_eq!(resolve_plain("-3"), YNode::Int(-3));
        assert!(matches!(resolve_plain(".inf"), YNode::Str { .. }));
        assert!(matches!(resolve_plain("1.2.3"), YNode::Str { .. }));
    }

    #[test]
    fn broken_yaml_is_an_error() {
        assert!(parse("key: [unclosed").is_err());
        assert!(parse("a: b: c").is_err());
        assert_eq!(parse("").unwrap(), None);
    }

    #[test]
    fn anchors_and_duplicates() {
        let n = parse("a: &x [1, 2]\nb: *x\nk: 1\nk: 2").unwrap().unwrap();
        let YNode::Map(m) = n else { panic!() };
        assert_eq!(m.len(), 3);
        assert_eq!(m[1].1, m[0].1);
        assert_eq!(m[2].1, YNode::Int(2));
    }
}
