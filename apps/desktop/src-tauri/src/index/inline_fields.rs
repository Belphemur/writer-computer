//! Dataview inline fields (`key:: value`, `[key:: value]`, `(key:: value)`): the scanner the core
//! index fills `inline_fields` with, and the one place that reads them. Pure; no I/O.
//!
//! The scanner follows Dataview's public algorithm (MIT; Dataview `src/data-import/inline-field.ts`
//! and `src/util/normalize.ts`, adapted, see `THIRD_PARTY_NOTICES.md`): the wrappers `[` and `(`
//! are tried in turn, a `::` separator ends the key, the value runs to the matching closer
//! (nesting counted, `\` escapes), fields that overlap an earlier one are dropped, and a line with
//! no wrapped field may be a whole-line `Key:: value`. Keys are canonicalised like Dataview does
//! (`Some Key` -> `some-key`). Values parse as null, boolean, number, date, duration, link, tag,
//! quoted text or a comma list of those; anything else stays text. Spec: `SPECs/dataview-spec.md`;
//! pinned by `shared/inline-field-vectors.json`.
//!
//! [`scan_line`] is public on purpose: the Tasks feature reads the Dataview task format
//! (`[due:: 2024-01-01]`) through it rather than keeping its own scanner.

use crate::bases::datetime;
use crate::bases::value::Value;

/// One field found in a line. Offsets are byte offsets into the scanned line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InlineField {
    /// The key as written (trimmed).
    pub key: String,
    /// The raw value text (trimmed).
    pub value: String,
    pub start: usize,
    pub start_value: usize,
    pub end: usize,
    /// `[` or `(` for a wrapped field, `None` for a whole-line field.
    pub wrapping: Option<char>,
}

const WRAPPERS: [(char, char); 2] = [('[', ']'), ('(', ')')];

/// The closer matching an already-open wrapper, respecting nesting and `\` escapes.
fn find_closing(line: &str, start: usize, open: char, close: char) -> Option<(String, usize)> {
    let mut nesting = 0i32;
    let mut escaped = false;
    for (off, c) in line[start..].char_indices() {
        if c == '\\' {
            escaped = !escaped;
            continue;
        }
        if escaped {
            escaped = false;
            continue;
        }
        if c == open {
            nesting += 1;
        } else if c == close {
            nesting -= 1;
        }
        if nesting < 0 {
            let at = start + off;
            return Some((line[start..at].trim().to_string(), at + c.len_utf8()));
        }
    }
    None
}

fn find_separator(line: &str, start: usize) -> Option<(String, usize)> {
    let sep = start + line[start..].find("::")?;
    Some((line[start..sep].trim().to_string(), sep + 2))
}

fn find_specific(line: &str, start: usize) -> Option<InlineField> {
    let open = line[start..].chars().next()?;
    let close = WRAPPERS.iter().find(|(o, _)| *o == open)?.1;
    let (key, value_index) = find_separator(line, start + open.len_utf8())?;
    if key.contains(['[', '(', ']', ')']) {
        return None;
    }
    let (value, end) = find_closing(line, value_index, open, close)?;
    Some(InlineField {
        key,
        value,
        start,
        start_value: value_index,
        end,
        wrapping: Some(open),
    })
}

/// `[key:: value]` and `(key:: value)` fields of one line, in order, overlaps dropped.
pub fn extract_inline_fields(line: &str) -> Vec<InlineField> {
    let mut fields = Vec::new();
    for (wrapper, _) in WRAPPERS {
        let mut from = 0;
        while let Some(rel) = line[from..].find(wrapper) {
            let at = from + rel;
            match find_specific(line, at) {
                Some(f) => {
                    from = f.end.max(at + 1);
                    fields.push(f);
                }
                None => from = at + wrapper.len_utf8(),
            }
        }
    }
    fields.sort_by_key(|f| f.start);
    let mut kept: Vec<InlineField> = Vec::new();
    for f in fields {
        if kept.last().is_none_or(|last| last.end < f.start) {
            kept.push(f);
        }
    }
    kept
}

fn is_emoji(c: char) -> bool {
    let n = c as u32;
    n >= 0x1F000 || (0x2600..=0x27BF).contains(&n) || (0x2B00..=0x2BFF).contains(&n)
}

fn is_word(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// A whole-line `Key:: value` (the line is the field). The key may carry leading punctuation and
/// trailing markdown emphasis (`**Key**:: v`), both dropped.
pub fn extract_full_line_field(text: &str) -> Option<InlineField> {
    let (raw_key, value_index) = find_separator(text, 0)?;
    let rest = raw_key.trim_start_matches(|c: char| !is_word(c));
    let key_end = rest
        .find(|c: char| !(is_word(c) || c.is_whitespace() || c == '/' || c == '-' || is_emoji(c)))
        .unwrap_or(rest.len());
    let (key, tail) = rest.split_at(key_end);
    if key.is_empty() || !tail.chars().all(|c| matches!(c, '_' | '*' | '~' | '`')) {
        return None;
    }
    Some(InlineField {
        key: key.to_string(),
        value: text[value_index..].trim().to_string(),
        start: 0,
        start_value: value_index,
        end: text.len(),
        wrapping: None,
    })
}

/// Dataview's variable-name canonicalisation: letters, digits, `_` and `-` lowercased, white
/// space to `-`, emoji kept, everything else dropped.
pub fn canonical_key(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut in_space = false;
    for c in name.chars() {
        let space = c.is_whitespace();
        if space {
            if !in_space {
                out.push('-');
            }
        } else if c.is_alphanumeric() || c == '_' || c == '-' {
            out.extend(c.to_lowercase());
        } else if is_emoji(c) {
            out.push(c);
        }
        in_space = space;
    }
    out
}

/// The list marker and checkbox of a line, `(rest, is_task)`: `- [ ] text` -> `("text", true)`.
fn strip_list_prefix(line: &str) -> (&str, bool) {
    let t = line.trim_start();
    let after_marker = if let Some(r) = t.strip_prefix(['-', '*', '+']) {
        r.strip_prefix(' ').or_else(|| r.strip_prefix('\t'))
    } else {
        let digits = t.bytes().take_while(u8::is_ascii_digit).count();
        t.get(digits..)
            .filter(|_| digits > 0)
            .and_then(|r| r.strip_prefix(['.', ')']))
            .and_then(|r| r.strip_prefix(' '))
    };
    let Some(body) = after_marker else {
        return (t, false);
    };
    let body = body.trim_start();
    let b = body.as_bytes();
    if b.len() >= 3 && b[0] == b'[' && b[2] == b']' && body.is_char_boundary(3) {
        return (body[3..].trim_start(), true);
    }
    (body, false)
}

/// Every field of one body line (no frontmatter, not inside a fenced code block): the wrapped
/// fields, or else a whole-line field (not on a task line, as in Dataview).
pub fn scan_line(line: &str) -> Vec<InlineField> {
    if !line.contains("::") {
        return Vec::new();
    }
    let fields = extract_inline_fields(line);
    if !fields.is_empty() {
        return fields;
    }
    let (text, is_task) = strip_list_prefix(line);
    if is_task {
        return Vec::new();
    }
    extract_full_line_field(text).into_iter().collect()
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/// A parsed field value. `Date` and `Duration` hold normalised text the Bases datetime module
/// turns into values; `Link` is the `[[...]]` text and `Tag` the `#tag`.
#[derive(Debug, Clone, PartialEq)]
pub enum FieldValue {
    Null,
    Bool(bool),
    Number(f64),
    Text(String),
    /// `YYYY-MM-DD[THH:mm[:ss[.SSS]]][zone]`, year-month expanded to day 1.
    Date(String),
    /// Bases duration text (`1 days 2 hours`).
    Duration(String),
    Link(String),
    Tag(String),
    List(Vec<FieldValue>),
}

struct Cursor<'a> {
    s: &'a str,
    pos: usize,
}

impl<'a> Cursor<'a> {
    fn rest(&self) -> &'a str {
        &self.s[self.pos..]
    }
    fn eat_digits(&mut self, n: usize) -> Option<&'a str> {
        let r = self.rest();
        let b = r.as_bytes();
        (b.len() >= n && b[..n].iter().all(u8::is_ascii_digit)).then(|| {
            self.pos += n;
            &r[..n]
        })
    }
    fn eat(&mut self, lit: &str) -> bool {
        let ok = self.rest().starts_with(lit);
        if ok {
            self.pos += lit.len();
        }
        ok
    }
    fn skip_ws(&mut self) {
        while self.rest().starts_with(char::is_whitespace) {
            self.pos += self.rest().chars().next().map_or(1, char::len_utf8);
        }
    }
}

/// `YYYY-MM[-DD[THH[:mm[:ss[.SSS]]]]][zone]`, each stage optional like Dataview's `chainOpt`.
fn date_atom(c: &mut Cursor) -> Option<String> {
    let save = c.pos;
    let y = c.eat_digits(4)?;
    let fail = |c: &mut Cursor| {
        c.pos = save;
        None
    };
    if !c.eat("-") {
        return fail(c);
    }
    let Some(m) = c.eat_digits(2) else {
        return fail(c);
    };
    let mut out = format!("{y}-{m}");
    let mut day = "01";
    let mut time = String::new();
    let mut zone = String::new();
    let mut p = c.pos;
    let stage = |c: &mut Cursor, p: &mut usize, lit: &str, n: usize| -> Option<String> {
        c.pos = *p;
        if c.eat(lit) {
            if let Some(d) = c.eat_digits(n) {
                *p = c.pos;
                return Some(d.to_string());
            }
        }
        c.pos = *p;
        None
    };
    let dd = stage(c, &mut p, "-", 2);
    if let Some(d) = &dd {
        day = d;
    }
    out.push('-');
    out.push_str(day);
    if dd.is_some() {
        if let Some(h) = stage(c, &mut p, "T", 2) {
            let mi = stage(c, &mut p, ":", 2).unwrap_or_else(|| "00".into());
            time = format!("T{h}:{mi}");
            // seconds, then milliseconds, then the zone: each only after the one before it
            if let Some(s) = stage(c, &mut p, ":", 2) {
                time.push(':');
                time.push_str(&s);
                if let Some(ms) = stage(c, &mut p, ".", 3) {
                    time.push('.');
                    time.push_str(&ms);
                }
                c.pos = p;
                if c.eat("Z") {
                    zone = "Z".into();
                    p = c.pos;
                } else if let Some(sign) = ["+", "-"].into_iter().find(|s| c.rest().starts_with(s))
                {
                    c.pos += 1;
                    let digits = c.rest().bytes().take_while(u8::is_ascii_digit).count();
                    if (1..=2).contains(&digits) {
                        let hh = &c.rest()[..digits];
                        c.pos += digits;
                        let mut z = format!("{sign}{hh:0>2}:00");
                        let q = c.pos;
                        if c.eat(":") {
                            match c.eat_digits(2) {
                                Some(mm) => z = format!("{sign}{hh:0>2}:{mm}"),
                                None => c.pos = q,
                            }
                        }
                        zone = z;
                        p = c.pos;
                    }
                }
            }
        }
    }
    c.pos = p;
    out.push_str(&time);
    out.push_str(&zone);
    // the date must be real
    datetime::parse_date(&out, 0).map(|_| out)
}

fn unit_name(u: &str) -> Option<&'static str> {
    Some(match u {
        "year" | "years" | "yr" | "yrs" => "years",
        "month" | "months" | "mo" | "mos" => "months",
        "week" | "weeks" | "wk" | "wks" | "w" => "weeks",
        "day" | "days" | "d" => "days",
        "hour" | "hours" | "hr" | "hrs" | "h" => "hours",
        "minute" | "minutes" | "min" | "mins" | "m" => "minutes",
        "second" | "seconds" | "sec" | "secs" | "s" => "seconds",
        _ => return None,
    })
}

fn number_text(c: &mut Cursor) -> Option<String> {
    let start = c.pos;
    c.eat("-");
    let int = c.rest().bytes().take_while(u8::is_ascii_digit).count();
    if int == 0 {
        c.pos = start;
        return None;
    }
    c.pos += int;
    let q = c.pos;
    if c.eat(".") {
        let frac = c.rest().bytes().take_while(u8::is_ascii_digit).count();
        if frac == 0 {
            c.pos = q;
        } else {
            c.pos += frac;
        }
    }
    Some(c.s[start..c.pos].to_string())
}

/// `4 hours`, `1d 2h`, `1 day, 2 hours`: the units Dataview knows, summed (as Bases text).
fn duration_atom(c: &mut Cursor) -> Option<String> {
    let save = c.pos;
    let mut parts: Vec<String> = Vec::new();
    loop {
        let before = c.pos;
        let Some(n) = number_text(c) else {
            c.pos = before;
            break;
        };
        c.skip_ws();
        let letters = c.rest().chars().take_while(|ch| ch.is_alphabetic()).count();
        let word: String = c.rest().chars().take(letters).collect();
        // the longest unit name the text starts with (`1hr`, `4min2sec` read unit by unit)
        let unit = (1..=word.chars().count())
            .rev()
            .find_map(|k| {
                let w: String = word.chars().take(k).collect();
                unit_name(&w).map(|u| (u, w.len()))
            })
            .filter(|_| letters > 0);
        let Some((unit, used)) = unit else {
            c.pos = before;
            break;
        };
        c.pos += used;
        parts.push(format!("{n} {unit}"));
        // separator: comma and/or white space, only if another duration follows
        let after_unit = c.pos;
        c.skip_ws();
        c.eat(",");
        c.skip_ws();
        let ahead = Cursor { s: c.s, pos: c.pos };
        if !ahead
            .rest()
            .starts_with(|ch: char| ch.is_ascii_digit() || ch == '-')
        {
            c.pos = after_unit;
            break;
        }
    }
    if parts.is_empty() {
        c.pos = save;
        return None;
    }
    Some(parts.join(" "))
}

fn string_atom(c: &mut Cursor) -> Option<String> {
    if !c.rest().starts_with('"') {
        return None;
    }
    let mut out = String::new();
    let mut it = c.rest()[1..].char_indices();
    while let Some((i, ch)) = it.next() {
        match ch {
            '"' => {
                c.pos += 1 + i + 1;
                return Some(out);
            }
            '\\' => match it.next() {
                Some((_, '"')) => out.push('"'),
                Some((_, '\\')) => out.push('\\'),
                Some((_, other)) => {
                    out.push('\\');
                    out.push(other);
                }
                None => return None,
            },
            other => out.push(other),
        }
    }
    None
}

fn tag_atom(c: &mut Cursor) -> Option<String> {
    if !c.rest().starts_with('#') {
        return None;
    }
    let body: String = c.rest()[1..]
        .chars()
        .take_while(|ch| {
            !(ch.is_whitespace()
                || matches!(
                    ch,
                    '\'' | '!'
                        | '"'
                        | '#'
                        | '$'
                        | '%'
                        | '&'
                        | '('
                        | ')'
                        | '*'
                        | '+'
                        | ','
                        | '.'
                        | ':'
                        | ';'
                        | '<'
                        | '='
                        | '>'
                        | '?'
                        | '@'
                        | '^'
                        | '`'
                        | '{'
                        | '|'
                        | '}'
                        | '~'
                        | '['
                        | ']'
                        | '\\'
                )
                || ('\u{2000}'..='\u{206F}').contains(ch)
                || ('\u{2E00}'..='\u{2E7F}').contains(ch))
        })
        .collect();
    c.pos += 1 + body.len();
    Some(format!("#{body}"))
}

fn link_atom(c: &mut Cursor) -> Option<String> {
    let r = c.rest();
    let skip = usize::from(r.starts_with('!'));
    let inner = r[skip..].strip_prefix("[[")?;
    let close = inner.find("]]")?;
    if inner[..close].contains(['[', ']']) {
        return None;
    }
    let text = format!("[[{}]]", &inner[..close]);
    c.pos += skip + 2 + close + 2;
    Some(text)
}

fn atom(c: &mut Cursor) -> Option<FieldValue> {
    if let Some(d) = date_atom(c) {
        return Some(FieldValue::Date(d));
    }
    if let Some(d) = duration_atom(c) {
        return Some(FieldValue::Duration(d));
    }
    if let Some(s) = string_atom(c) {
        return Some(FieldValue::Text(s));
    }
    if let Some(t) = tag_atom(c) {
        return Some(FieldValue::Tag(t));
    }
    if let Some(l) = link_atom(c) {
        return Some(FieldValue::Link(l));
    }
    for (lit, v) in [
        ("true", true),
        ("false", false),
        ("True", true),
        ("False", false),
    ] {
        if c.eat(lit) {
            return Some(FieldValue::Bool(v));
        }
    }
    if let Some(n) = number_text(c) {
        return n.parse().ok().map(FieldValue::Number);
    }
    c.eat("null").then_some(FieldValue::Null)
}

/// The date literal at the start of `text` (`YYYY-MM[-DD[THH[:mm[:ss[.SSS]]]]]`), as normalised
/// text and the byte length it covers: the DQL parser reads `date(2024-01-15)` with it.
pub fn date_prefix(text: &str) -> Option<(String, usize)> {
    let mut c = Cursor { s: text, pos: 0 };
    date_atom(&mut c).map(|d| (d, c.pos))
}

/// The duration literal at the start of `text` (`4 hours`, `1d 2h`) as Bases duration text and
/// the byte length it covers.
pub fn duration_prefix(text: &str) -> Option<(String, usize)> {
    let mut c = Cursor { s: text, pos: 0 };
    duration_atom(&mut c).map(|d| (d, c.pos))
}

/// A field's raw text as a value (Dataview's `parseInlineValue`): empty is null, a comma list of
/// atoms is a list, a single atom is itself, anything else is the text unchanged.
pub fn parse_value(raw: &str) -> FieldValue {
    if raw.trim().is_empty() {
        return FieldValue::Null;
    }
    let text = FieldValue::Text(raw.to_string());
    let mut c = Cursor { s: raw, pos: 0 };
    let Some(first) = atom(&mut c) else {
        return text;
    };
    let mut items = vec![first];
    let mut listed = false;
    loop {
        let before = c.pos;
        c.skip_ws();
        if !c.eat(",") {
            c.pos = before;
            break;
        }
        c.skip_ws();
        match atom(&mut c) {
            Some(a) => {
                items.push(a);
                listed = true;
            }
            None => {
                c.pos = before;
                break;
            }
        }
    }
    if c.pos != raw.len() {
        return text;
    }
    if listed {
        FieldValue::List(items)
    } else {
        items.remove(0)
    }
}

/// The Bases value of a parsed field. `offset` is the local UTC offset in minutes (dates with
/// a zone are placed on the local wall clock like every date in the engine). Links and tags
/// stay strings: the interpreter turns whole wikilinks into links when it reads them.
pub fn to_value(v: &FieldValue, offset: i32) -> Value {
    match v {
        FieldValue::Null => Value::Null,
        FieldValue::Bool(b) => Value::Bool(*b),
        FieldValue::Number(n) => Value::Number(*n),
        FieldValue::Text(s) | FieldValue::Link(s) | FieldValue::Tag(s) => Value::String(s.clone()),
        FieldValue::Date(d) => match datetime::parse_date(d, offset) {
            Some((ms, has_time)) => Value::date(ms, has_time),
            None => Value::String(d.clone()),
        },
        FieldValue::Duration(d) => match datetime::parse_duration(d) {
            Some(d) => Value::Duration(d),
            None => Value::String(d.clone()),
        },
        FieldValue::List(items) => Value::List(items.iter().map(|i| to_value(i, offset)).collect()),
    }
}

/// A stored row's value: [`parse_value`] then [`to_value`].
pub fn raw_to_value(raw: &str, offset: i32) -> Value {
    to_value(&parse_value(raw), offset)
}

/// The fields of one note as `(key, value)` pairs ready for a row: the raw key and, when it
/// differs, the canonical key (Dataview exposes both); a repeated key becomes a list.
pub fn merge_fields(rows: &[(String, String, String)], offset: i32) -> Vec<(String, Value)> {
    let mut out: Vec<(String, Value)> = Vec::new();
    let mut put = |key: &str, v: Value| match out.iter_mut().find(|(k, _)| k == key) {
        Some((_, existing)) => {
            let prev = std::mem::replace(existing, Value::Null);
            *existing = match prev {
                Value::List(mut l) => {
                    l.push(v);
                    Value::List(l)
                }
                other => Value::List(vec![other, v]),
            };
        }
        None => out.push((key.to_string(), v)),
    };
    for (key, canonical, raw) in rows {
        let v = raw_to_value(raw, offset);
        put(key, v.clone());
        if canonical != key && !canonical.is_empty() {
            put(canonical, v);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value as Json;

    fn vectors() -> Json {
        serde_json::from_str(include_str!("../../../shared/inline-field-vectors.json")).unwrap()
    }

    fn wrapping(f: &InlineField) -> Json {
        f.wrapping
            .map_or(Json::Null, |c| Json::String(c.to_string()))
    }

    #[test]
    fn scan_vectors() {
        for case in vectors()["scan"].as_array().unwrap() {
            let line = case["line"].as_str().unwrap();
            let got: Vec<Json> = scan_line(line)
                .iter()
                .map(|f| serde_json::json!({"key": f.key, "value": f.value, "wrapping": wrapping(f)}))
                .collect();
            assert_eq!(
                Json::Array(got),
                case["fields"],
                "line {line:?}: {}",
                case["why"]
            );
        }
    }

    #[test]
    fn canonical_key_vectors() {
        for case in vectors()["canonical"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            assert_eq!(canonical_key(name), case["key"].as_str().unwrap(), "{name}");
        }
    }

    fn describe(v: &FieldValue) -> Json {
        use serde_json::json;
        match v {
            FieldValue::Null => json!({"type": "null"}),
            FieldValue::Bool(b) => json!({"type": "bool", "value": b}),
            FieldValue::Number(n) => json!({"type": "number", "value": n}),
            FieldValue::Text(s) => json!({"type": "text", "value": s}),
            FieldValue::Date(s) => json!({"type": "date", "value": s}),
            FieldValue::Duration(s) => json!({"type": "duration", "value": s}),
            FieldValue::Link(s) => json!({"type": "link", "value": s}),
            FieldValue::Tag(s) => json!({"type": "tag", "value": s}),
            FieldValue::List(l) => {
                json!({"type": "list", "items": l.iter().map(describe).collect::<Vec<_>>()})
            }
        }
    }

    #[test]
    fn value_vectors() {
        for case in vectors()["values"].as_array().unwrap() {
            let raw = case["raw"].as_str().unwrap();
            assert_eq!(describe(&parse_value(raw)), case["value"], "raw {raw:?}");
        }
    }

    #[test]
    fn values_become_engine_values() {
        assert_eq!(raw_to_value("12", 0), Value::Number(12.0));
        assert!(matches!(raw_to_value("2024-03-05", 0), Value::Date(_)));
        assert!(matches!(raw_to_value("2 days", 0), Value::Duration(_)));
        assert_eq!(
            raw_to_value("[[Plan]], 2", 0),
            Value::List(vec![Value::str("[[Plan]]"), Value::Number(2.0)])
        );
    }

    #[test]
    fn repeated_keys_become_a_list_and_both_key_forms_exist() {
        let rows = vec![
            (
                "Due Date".to_string(),
                "due-date".to_string(),
                "1".to_string(),
            ),
            (
                "Due Date".to_string(),
                "due-date".to_string(),
                "2".to_string(),
            ),
        ];
        let merged = merge_fields(&rows, 0);
        let find = |k: &str| merged.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone());
        let want = Value::List(vec![Value::Number(1.0), Value::Number(2.0)]);
        assert_eq!(find("Due Date"), Some(want.clone()));
        assert_eq!(find("due-date"), Some(want));
    }
}
