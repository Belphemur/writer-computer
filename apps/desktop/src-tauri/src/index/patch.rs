//! Surgical frontmatter edits (Bases spec phase 3, 4.3.3).
//!
//! `set_property` and `remove_property` change only the lines of the target
//! key; every other byte (comments, key order, quoting, flow lists, CRLF, BOM,
//! the body) is preserved. A note whose frontmatter does not parse is never
//! touched: the call fails with [`PatchError::Unparsable`]. Pure text in, text
//! out; file I/O lives in `vault_ops.rs`, shared by the Tauri commands and the
//! `writer` CLI.
//!
//! Rules (spec 7.6 defaults): a missing frontmatter block is created; lists are
//! written as block YAML lists, booleans as `true`/`false`, numbers bare, dates
//! as `YYYY-MM-DD` / ISO datetimes, text is quoted only when YAML needs it (or
//! when the bare form would read back as another type). The only comment kept
//! across an edit is a trailing `# comment` on a single-line value that is
//! replaced by another single-line value; comments inside a replaced block are
//! part of the key's lines and go with it.

use super::frontmatter::{self, fm_span};
use super::yaml::{self, YNode};
use serde_json::Value as Json;
use std::ops::Range;
use yaml_rust2::parser::{Event, MarkedEventReceiver, Parser};
use yaml_rust2::scanner::Marker;

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum PatchError {
    #[error("the frontmatter cannot be parsed ({0}); fix it before editing properties")]
    Unparsable(String),
    #[error("invalid property name: {0}")]
    InvalidName(String),
    #[error("invalid value: {0}")]
    InvalidValue(String),
    #[error("property not found: {0}")]
    NotFound(String),
    #[error("cannot edit property \"{0}\": {1}")]
    Unsupported(String, String),
}

/// Property types a caller can force (Obsidian's `type=` parameter).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ValueType {
    Text,
    List,
    Number,
    Checkbox,
    Date,
    DateTime,
}

impl ValueType {
    pub fn parse(s: &str) -> Option<ValueType> {
        Some(match s.trim().to_ascii_lowercase().as_str() {
            "text" => ValueType::Text,
            "list" => ValueType::List,
            "number" => ValueType::Number,
            "checkbox" => ValueType::Checkbox,
            "date" => ValueType::Date,
            "datetime" => ValueType::DateTime,
            _ => return None,
        })
    }

    pub fn name(self) -> &'static str {
        match self {
            ValueType::Text => "text",
            ValueType::List => "list",
            ValueType::Number => "number",
            ValueType::Checkbox => "checkbox",
            ValueType::Date => "date",
            ValueType::DateTime => "datetime",
        }
    }

    /// Map an index `vtype` (`text`, `bool`, `link`, ...) to a hint.
    pub fn from_index_type(vtype: &str) -> Option<ValueType> {
        Some(match vtype {
            "text" | "link" => ValueType::Text,
            "number" => ValueType::Number,
            "bool" => ValueType::Checkbox,
            "date" => ValueType::Date,
            "datetime" => ValueType::DateTime,
            "list" => ValueType::List,
            _ => return None,
        })
    }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/// One frontmatter property as written: name, plain JSON value, index type.
#[derive(Debug, Clone, PartialEq)]
pub struct NoteProperty {
    pub name: String,
    pub value: Json,
    pub vtype: &'static str,
}

/// Frontmatter properties in file order. No frontmatter gives an empty list;
/// unparsable frontmatter is an error.
pub fn read_properties(text: &str) -> Result<Vec<NoteProperty>, PatchError> {
    let Some(span) = fm_span(text) else {
        return Ok(Vec::new());
    };
    let data = frontmatter::parse_frontmatter(&text[span.fm_start..span.fm_end]);
    if let Some(e) = data.error {
        return Err(PatchError::Unparsable(e));
    }
    let map = match data.json.as_deref().map(serde_json::from_str::<Json>) {
        Some(Ok(Json::Object(m))) => m,
        _ => return Ok(Vec::new()),
    };
    Ok(data
        .props
        .into_iter()
        .map(|p| NoteProperty {
            value: map.get(&p.key).cloned().unwrap_or(Json::Null),
            name: p.key,
            vtype: p.vtype,
        })
        .collect())
}

// ---------------------------------------------------------------------------
// Locating keys
// ---------------------------------------------------------------------------

#[derive(Default)]
struct KeyScan {
    /// `Some(next_is_key)` for mappings, `None` for sequences.
    stack: Vec<Option<bool>>,
    /// Root-mapping keys with their 0-based line in the scanned text.
    keys: Vec<(String, usize)>,
}

impl KeyScan {
    fn node(&mut self, scalar: Option<&str>, mark: Marker) {
        let depth = self.stack.len();
        if let Some(Some(next_is_key)) = self.stack.last_mut() {
            if *next_is_key && depth == 1 {
                let name = scalar.map_or_else(|| "\u{0}complex".to_string(), str::to_string);
                self.keys.push((name, mark.line().saturating_sub(1)));
            }
            *next_is_key = !*next_is_key;
        }
    }
}

impl MarkedEventReceiver for KeyScan {
    fn on_event(&mut self, ev: Event, mark: Marker) {
        match ev {
            Event::Scalar(v, ..) => self.node(Some(&v), mark),
            Event::SequenceStart(..) => {
                self.node(None, mark);
                self.stack.push(None);
            }
            Event::MappingStart(..) => {
                self.node(None, mark);
                self.stack.push(Some(true));
            }
            Event::SequenceEnd | Event::MappingEnd => {
                self.stack.pop();
            }
            Event::Alias(_) => self.node(None, mark),
            _ => {}
        }
    }
}

fn scan_keys(fm: &str) -> Result<Vec<(String, usize)>, PatchError> {
    match yaml::parse(fm) {
        Err(e) => return Err(PatchError::Unparsable(e)),
        Ok(Some(YNode::Map(_))) | Ok(None) => {}
        Ok(Some(_)) => {
            return Err(PatchError::Unparsable(
                "frontmatter is not a mapping".to_string(),
            ))
        }
    }
    let mut scan = KeyScan::default();
    Parser::new_from_str(fm)
        .load(&mut scan, false)
        .map_err(|e| PatchError::Unparsable(format!("invalid YAML: {e}")))?;
    Ok(scan.keys)
}

/// Byte offset where each line of `text` starts, plus a final `text.len()`.
fn line_starts(text: &str) -> Vec<usize> {
    let mut v = vec![0];
    for (i, b) in text.bytes().enumerate() {
        if b == b'\n' {
            v.push(i + 1);
        }
    }
    if *v.last().unwrap_or(&0) != text.len() {
        v.push(text.len());
    }
    v
}

fn is_separator(line: &str) -> bool {
    let t = line.trim_end_matches(['\r', '\n']);
    t.trim().is_empty() || t.starts_with('#')
}

/// Line range `[start, end)` of the entry of the key on `key_line`.
fn entry_range(fm: &str, starts: &[usize], keys: &[(String, usize)], idx: usize) -> Range<usize> {
    let start = keys[idx].1;
    let total = starts.len() - 1;
    let mut end = keys.get(idx + 1).map_or(total, |k| k.1.min(total));
    while end > start + 1 && is_separator(&fm[starts[end - 1]..starts[end]]) {
        end -= 1;
    }
    start..end.max(start + 1)
}

/// Length of `key:` (through the colon) at the start of `line`, verified to
/// spell `name`.
fn key_prefix_len(line: &str, name: &str) -> Option<usize> {
    let b = line.as_bytes();
    let (key_end, colon) = match *b.first()? {
        b'"' => {
            let mut i = 1;
            while i < b.len() && b[i] != b'"' {
                i += if b[i] == b'\\' { 2 } else { 1 };
            }
            (i + 1, true)
        }
        b'\'' => {
            let mut i = 1;
            while i < b.len() {
                if b[i] == b'\'' {
                    if b.get(i + 1) == Some(&b'\'') {
                        i += 2;
                        continue;
                    }
                    break;
                }
                i += 1;
            }
            (i + 1, true)
        }
        b' ' | b'\t' => return None,
        _ => {
            let mut i = 0;
            loop {
                let c = line[i..].find(':')? + i;
                match b.get(c + 1) {
                    None | Some(b' ') | Some(b'\t') | Some(b'\r') | Some(b'\n') => {
                        break (c, false)
                    }
                    _ => i = c + 1,
                }
            }
        }
    };
    if key_end > b.len() {
        return None;
    }
    let colon_at = if colon {
        let mut j = key_end;
        while b.get(j) == Some(&b' ') {
            j += 1;
        }
        if b.get(j) != Some(&b':') {
            return None;
        }
        j
    } else {
        key_end
    };
    let key_text = &line[..key_end];
    let ok = match yaml::parse(key_text) {
        Ok(Some(YNode::Map(_))) | Ok(Some(YNode::Seq(_))) | Err(_) | Ok(None) => false,
        Ok(Some(node)) => match node.to_json() {
            Json::String(s) => s == name,
            other => *other.to_string() == *name,
        },
    };
    ok.then_some(colon_at + 1)
}

/// The ` # comment` at the end of a one-line value (quote-aware).
fn trailing_comment(rest: &str) -> Option<&str> {
    let mut quote: Option<char> = None;
    let mut prev_space = true;
    let mut chars = rest.char_indices().peekable();
    while let Some((i, c)) = chars.next() {
        match quote {
            Some('"') => {
                if c == '\\' {
                    chars.next();
                } else if c == '"' {
                    quote = None;
                }
            }
            Some(_) => {
                if c == '\'' {
                    if matches!(chars.peek(), Some((_, '\''))) {
                        chars.next();
                    } else {
                        quote = None;
                    }
                }
            }
            None => {
                if c == '#' && prev_space {
                    return Some(rest[i..].trim_end());
                }
                if (c == '"' || c == '\'') && prev_space {
                    quote = Some(c);
                }
            }
        }
        prev_space = c == ' ' || c == '\t';
    }
    None
}

fn detect_eol(text: &str, from: usize) -> &'static str {
    match text[from..].find('\n') {
        Some(i) if i > 0 && text.as_bytes()[from + i - 1] == b'\r' => "\r\n",
        _ => "\n",
    }
}

// ---------------------------------------------------------------------------
// Rendering values
// ---------------------------------------------------------------------------

fn indicator_start(s: &str) -> bool {
    let mut it = s.chars();
    let Some(first) = it.next() else { return true };
    match first {
        '-' | '?' | ':' => it.next().is_none_or(char::is_whitespace),
        ',' | '[' | ']' | '{' | '}' | '#' | '&' | '*' | '!' | '|' | '>' | '\'' | '"' | '%'
        | '@' | '`' => true,
        _ => false,
    }
}

/// Can `s` be written without quotes and read back as the same string?
fn plain_ok(s: &str) -> bool {
    if s.is_empty() || s.trim() != s || s.chars().any(char::is_control) {
        return false;
    }
    // YAML 1.1 booleans: other readers (and Obsidian's own tooling) may
    // read them as booleans, so they are quoted.
    if matches!(s.to_ascii_lowercase().as_str(), "yes" | "no" | "on" | "off") {
        return false;
    }
    if indicator_start(s) || s.contains(": ") || s.contains(" #") || s.ends_with(':') {
        return false;
    }
    matches!(yaml::resolve_plain(s), YNode::Str { .. })
}

fn text_scalar(s: &str) -> String {
    if plain_ok(s) {
        s.to_string()
    } else {
        // JSON string escapes are valid YAML double-quoted escapes.
        serde_json::to_string(s).unwrap_or_else(|_| format!("\"{s}\""))
    }
}

fn typed_string(s: &str, hint: ValueType) -> Result<String, PatchError> {
    let t = s.trim();
    let bad = |what: &str| PatchError::InvalidValue(format!("\"{s}\" is not a valid {what}"));
    match hint {
        ValueType::Date => yaml::parse_date(t)
            .map(|_| t.to_string())
            .ok_or_else(|| bad("date (YYYY-MM-DD)")),
        ValueType::DateTime => yaml::parse_datetime(t)
            .map(|_| t.to_string())
            .ok_or_else(|| bad("datetime (YYYY-MM-DDTHH:MM[:SS])")),
        ValueType::Number => match yaml::resolve_plain(t) {
            YNode::Int(_) | YNode::Float(_) => Ok(t.to_string()),
            _ => Err(bad("number")),
        },
        ValueType::Checkbox => match t.to_ascii_lowercase().as_str() {
            "true" => Ok("true".into()),
            "false" => Ok("false".into()),
            _ => Err(bad("checkbox value (true or false)")),
        },
        ValueType::Text | ValueType::List => Ok(text_scalar(s)),
    }
}

fn scalar(v: &Json, hint: Option<ValueType>) -> Result<String, PatchError> {
    match (v, hint) {
        (Json::Null, _) => Ok(String::new()),
        (Json::String(s), Some(h)) => typed_string(s, h),
        (Json::String(s), None) => Ok(text_scalar(s)),
        (Json::Bool(b), None | Some(ValueType::Checkbox)) => Ok(b.to_string()),
        (Json::Number(n), None | Some(ValueType::Number)) => Ok(n.to_string()),
        (Json::Bool(b), Some(ValueType::Text)) => Ok(text_scalar(&b.to_string())),
        (Json::Number(n), Some(ValueType::Text)) => Ok(text_scalar(&n.to_string())),
        (other, Some(h)) => Err(PatchError::InvalidValue(format!(
            "{other} is not a valid {} value",
            h.name()
        ))),
        (other, None) => Err(PatchError::InvalidValue(format!(
            "unsupported value {other}"
        ))),
    }
}

fn flow_json(v: &Json) -> String {
    v.to_string()
}

/// `(inline text, block lines)`; with block lines the key line carries no
/// value. Lines are indented relative to the key and have no line ending.
fn render(v: &Json, hint: Option<ValueType>) -> Result<(String, Vec<String>), PatchError> {
    let list_items: Option<Vec<Json>> = match (v, hint) {
        (Json::Array(a), None | Some(ValueType::List)) => Some(a.clone()),
        (Json::String(s), Some(ValueType::List)) => Some(
            s.split(',')
                .map(str::trim)
                .filter(|x| !x.is_empty())
                .map(|x| Json::String(x.to_string()))
                .collect(),
        ),
        (Json::Null, Some(ValueType::List)) => Some(Vec::new()),
        (Json::Bool(_) | Json::Number(_), Some(ValueType::List)) => Some(vec![v.clone()]),
        (Json::Array(_), Some(h)) => {
            return Err(PatchError::InvalidValue(format!(
                "a list is not a valid {} value",
                h.name()
            )))
        }
        _ => None,
    };
    if let Some(items) = list_items {
        if items.is_empty() {
            return Ok(("[]".into(), Vec::new()));
        }
        let mut lines = Vec::with_capacity(items.len());
        for item in &items {
            let text = match item {
                Json::Array(_) | Json::Object(_) => flow_json(item),
                other => scalar(other, None)?,
            };
            lines.push(if text.is_empty() {
                "  -".to_string()
            } else {
                format!("  - {text}")
            });
        }
        return Ok((String::new(), lines));
    }
    if let (Json::Object(m), None) = (v, hint) {
        if m.is_empty() {
            return Ok(("{}".into(), Vec::new()));
        }
        let mut lines = Vec::new();
        for (k, val) in m {
            let text = match val {
                Json::Array(_) | Json::Object(_) => flow_json(val),
                other => scalar(other, None)?,
            };
            lines.push(
                format!("  {}: {}", text_scalar(k), text)
                    .trim_end()
                    .to_string(),
            );
        }
        return Ok((String::new(), lines));
    }
    Ok((scalar(v, hint)?, Vec::new()))
}

/// `name: value` as YAML lines (no line endings), for display.
pub fn render_entry(
    name: &str,
    value: &Json,
    hint: Option<ValueType>,
) -> Result<Vec<String>, PatchError> {
    let (inline, block) = render(value, hint)?;
    Ok(key_lines(&text_scalar(name), &inline, &block, None))
}

fn validate_name(name: &str) -> Result<(), PatchError> {
    if name.trim().is_empty() || name.chars().any(|c| c == '\n' || c == '\r') {
        return Err(PatchError::InvalidName(format!("{name:?}")));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

fn key_lines(key_text: &str, inline: &str, block: &[String], comment: Option<&str>) -> Vec<String> {
    let mut first = format!("{key_text}:");
    if !inline.is_empty() {
        first.push(' ');
        first.push_str(inline);
    }
    if let Some(c) = comment {
        if block.is_empty() {
            first.push(' ');
            first.push_str(c);
        }
    }
    let mut lines = vec![first];
    lines.extend(block.iter().cloned());
    lines
}

fn join_lines(lines: &[String], eol: &str) -> String {
    let mut out = String::new();
    for l in lines {
        out.push_str(l);
        out.push_str(eol);
    }
    out
}

/// Set `name` to `value`. `hint` forces the YAML type (`property:set type=`).
pub fn set_property(
    text: &str,
    name: &str,
    value: &Json,
    hint: Option<ValueType>,
) -> Result<String, PatchError> {
    validate_name(name)?;
    let (inline, block) = render(value, hint)?;
    let Some(span) = fm_span(text) else {
        // No frontmatter: create the block (spec 7.6).
        let bom = span_bom(text);
        let eol = detect_eol(text, bom);
        let mut out = String::with_capacity(text.len() + 32);
        out.push_str(&text[..bom]);
        out.push_str(&format!("---{eol}"));
        out.push_str(&join_lines(
            &key_lines(&text_scalar(name), &inline, &block, None),
            eol,
        ));
        out.push_str(&format!("---{eol}"));
        out.push_str(&text[bom..]);
        return Ok(out);
    };
    let fm = &text[span.fm_start..span.fm_end];
    let keys = scan_keys(fm)?;
    let eol = detect_eol(text, span.open_start);
    let matches: Vec<usize> = keys
        .iter()
        .enumerate()
        .filter(|(_, (k, _))| k == name)
        .map(|(i, _)| i)
        .collect();
    match matches.as_slice() {
        [] => {
            let lines = key_lines(&text_scalar(name), &inline, &block, None);
            let mut out = String::with_capacity(text.len() + 32);
            out.push_str(&text[..span.fm_end]);
            out.push_str(&join_lines(&lines, eol));
            out.push_str(&text[span.fm_end..]);
            Ok(out)
        }
        [idx] => {
            let starts = line_starts(fm);
            let range = entry_range(fm, &starts, &keys, *idx);
            let first = &fm[starts[range.start]..starts[range.start + 1]];
            let first = first.trim_end_matches(['\r', '\n']);
            let plen = key_prefix_len(first, name).ok_or_else(|| {
                PatchError::Unsupported(
                    name.to_string(),
                    "its key line has a layout this editor does not rewrite (flow mapping or multi-key line)".into(),
                )
            })?;
            let comment = (range.end - range.start == 1)
                .then(|| trailing_comment(&first[plen..]))
                .flatten();
            let lines = key_lines(&first[..plen - 1], &inline, &block, comment);
            let mut out = String::with_capacity(text.len() + 32);
            out.push_str(&text[..span.fm_start + starts[range.start]]);
            out.push_str(&join_lines(&lines, eol));
            out.push_str(&text[span.fm_start + starts[range.end]..]);
            Ok(out)
        }
        _ => Err(PatchError::Unsupported(
            name.to_string(),
            "the key appears more than once".into(),
        )),
    }
}

fn span_bom(text: &str) -> usize {
    if text.starts_with('\u{feff}') {
        3
    } else {
        0
    }
}

/// Remove `name` (its lines only). Fails with [`PatchError::NotFound`] when the
/// note has no such property.
pub fn remove_property(text: &str, name: &str) -> Result<String, PatchError> {
    validate_name(name)?;
    let Some(span) = fm_span(text) else {
        return Err(PatchError::NotFound(name.to_string()));
    };
    let fm = &text[span.fm_start..span.fm_end];
    let keys = scan_keys(fm)?;
    let matches: Vec<usize> = keys
        .iter()
        .enumerate()
        .filter(|(_, (k, _))| k == name)
        .map(|(i, _)| i)
        .collect();
    let idx = match matches.as_slice() {
        [] => return Err(PatchError::NotFound(name.to_string())),
        [i] => *i,
        _ => {
            return Err(PatchError::Unsupported(
                name.to_string(),
                "the key appears more than once".into(),
            ))
        }
    };
    let starts = line_starts(fm);
    let range = entry_range(fm, &starts, &keys, idx);
    let first = fm[starts[range.start]..starts[range.start + 1]].trim_end_matches(['\r', '\n']);
    if key_prefix_len(first, name).is_none() {
        return Err(PatchError::Unsupported(
            name.to_string(),
            "its key line has a layout this editor does not rewrite (flow mapping or multi-key line)".into(),
        ));
    }
    let mut out = String::with_capacity(text.len());
    out.push_str(&text[..span.fm_start + starts[range.start]]);
    out.push_str(&text[span.fm_start + starts[range.end]..]);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Lines outside `old_lines` (old) and the matching new region are equal.
    fn only_changed(old: &str, new: &str, old_lines: Range<usize>, new_count: usize) {
        let o: Vec<&str> = old.split_inclusive('\n').collect();
        let n: Vec<&str> = new.split_inclusive('\n').collect();
        assert_eq!(&o[..old_lines.start], &n[..old_lines.start], "prefix");
        let tail = o.len() - old_lines.end;
        assert_eq!(&o[old_lines.end..], &n[n.len() - tail..], "suffix");
        assert_eq!(n.len(), o.len() - old_lines.len() + new_count, "count");
    }

    const NOTE: &str = "---\n# top comment\nstatus: draft # keep me\n\n# about due\ndue: 2024-03-01\n\"odd key\": 1\ntags: [a, b]\nrelated:\n  - \"[[X]]\"\n  # inner comment\n  - plain\nlast: end\n---\n# Body\n\ntext --- [[Link]]\n";

    #[test]
    fn marker_lines_are_one_based() {
        let keys = scan_keys("a: 1\nb:\n  c: 2\nd: [x]\n").unwrap();
        assert_eq!(
            keys,
            vec![("a".into(), 0), ("b".into(), 1), ("d".into(), 3)]
        );
    }

    #[test]
    fn replaces_only_the_key_line_and_keeps_inline_comment() {
        let new = set_property(NOTE, "status", &json!("done"), None).unwrap();
        assert!(new.contains("status: done # keep me\n"));
        only_changed(NOTE, &new, 2..3, 1);
    }

    #[test]
    fn replaces_block_list_and_keeps_following_keys() {
        let new = set_property(NOTE, "related", &json!(["[[Y]]", "z w"]), None).unwrap();
        assert!(new.contains("related:\n  - \"[[Y]]\"\n  - z w\nlast: end\n"));
        // old range: lines 8..12 (key, 3 list lines incl. comment) -> 3 lines
        only_changed(NOTE, &new, 8..12, 3);
        assert!(!new.contains("inner comment"));
    }

    #[test]
    fn flow_list_to_scalar_and_quoted_key() {
        let new = set_property(NOTE, "tags", &json!("x"), None).unwrap();
        assert!(new.contains("tags: x\nrelated:"));
        only_changed(NOTE, &new, 7..8, 1);
        let new = set_property(NOTE, "odd key", &json!(2), None).unwrap();
        assert!(new.contains("\"odd key\": 2\n"));
        only_changed(NOTE, &new, 6..7, 1);
    }

    #[test]
    fn comments_and_blank_lines_between_entries_survive() {
        let new = set_property(NOTE, "due", &json!("2024-04-02"), Some(ValueType::Date)).unwrap();
        assert!(new.contains("\n\n# about due\ndue: 2024-04-02\n\"odd key\""));
        only_changed(NOTE, &new, 5..6, 1);
        let removed = remove_property(NOTE, "status").unwrap();
        only_changed(NOTE, &removed, 2..3, 0);
        assert!(removed.contains("# top comment\n\n# about due"));
    }

    #[test]
    fn appends_new_key_before_closing_fence() {
        let new = set_property(NOTE, "added", &json!(true), None).unwrap();
        assert!(new.contains("last: end\nadded: true\n---\n# Body"));
        only_changed(NOTE, &new, 13..13, 1);
    }

    #[test]
    fn crlf_and_bom_are_kept() {
        let src = "\u{feff}---\r\ntitle: A\r\ntags:\r\n  - a\r\n---\r\nBody\r\n";
        let new = set_property(src, "tags", &json!(["a", "b"]), None).unwrap();
        assert_eq!(
            new,
            "\u{feff}---\r\ntitle: A\r\ntags:\r\n  - a\r\n  - b\r\n---\r\nBody\r\n"
        );
        let new = set_property(src, "n", &json!(3), None).unwrap();
        assert_eq!(
            new,
            "\u{feff}---\r\ntitle: A\r\ntags:\r\n  - a\r\nn: 3\r\n---\r\nBody\r\n"
        );
        assert_eq!(
            remove_property(src, "tags").unwrap(),
            "\u{feff}---\r\ntitle: A\r\n---\r\nBody\r\n"
        );
    }

    #[test]
    fn creates_block_when_missing() {
        assert_eq!(
            set_property("Body\n", "a", &json!("b"), None).unwrap(),
            "---\na: b\n---\nBody\n"
        );
        assert_eq!(
            set_property("\u{feff}Body\r\nx\r\n", "a", &json!([1, 2]), None).unwrap(),
            "\u{feff}---\r\na:\r\n  - 1\r\n  - 2\r\n---\r\nBody\r\nx\r\n"
        );
        assert_eq!(
            set_property("", "a", &json!(1), None).unwrap(),
            "---\na: 1\n---\n"
        );
        // An unterminated leading `---` is a horizontal rule, not frontmatter.
        assert_eq!(
            set_property("---\nhr\n", "a", &json!(1), None).unwrap(),
            "---\na: 1\n---\n---\nhr\n"
        );
    }

    #[test]
    fn empty_frontmatter_block_gets_the_key() {
        assert_eq!(
            set_property("---\n---\nx\n", "a", &json!(1), None).unwrap(),
            "---\na: 1\n---\nx\n"
        );
    }

    #[test]
    fn unparsable_frontmatter_is_never_touched() {
        let broken = "---\nkey: [oops\nother: : :\n---\nBody\n";
        assert!(matches!(
            set_property(broken, "a", &json!(1), None),
            Err(PatchError::Unparsable(_))
        ));
        assert!(matches!(
            remove_property(broken, "key"),
            Err(PatchError::Unparsable(_))
        ));
        assert!(matches!(
            set_property("---\n- a\n- b\n---\n", "a", &json!(1), None),
            Err(PatchError::Unparsable(_))
        ));
    }

    #[test]
    fn flow_mapping_and_duplicates_are_explicit_errors() {
        assert!(matches!(
            set_property("---\n{a: 1, b: 2}\n---\n", "a", &json!(2), None),
            Err(PatchError::Unsupported(..))
        ));
        assert!(matches!(
            set_property("---\na: 1\na: 2\n---\n", "a", &json!(3), None),
            Err(PatchError::Unsupported(..))
        ));
    }

    #[test]
    fn remove_missing_is_not_found() {
        assert_eq!(
            remove_property(NOTE, "nope"),
            Err(PatchError::NotFound("nope".into()))
        );
        assert_eq!(
            remove_property("no frontmatter", "a"),
            Err(PatchError::NotFound("a".into()))
        );
    }

    #[test]
    fn removing_the_last_key_keeps_an_empty_block() {
        assert_eq!(
            remove_property("---\na: 1\n---\nx\n", "a").unwrap(),
            "---\n---\nx\n"
        );
    }

    #[test]
    fn value_rendering() {
        let r = |v: Json, h: Option<ValueType>| {
            let out = set_property("---\n---\n", "k", &v, h).unwrap();
            out.trim_start_matches("---\n")
                .trim_end_matches("---\n")
                .to_string()
        };
        assert_eq!(r(json!(true), None), "k: true\n");
        assert_eq!(r(json!(2.5), None), "k: 2.5\n");
        assert_eq!(r(json!("5"), None), "k: \"5\"\n");
        assert_eq!(r(json!("true"), Some(ValueType::Checkbox)), "k: true\n");
        assert_eq!(r(json!("7"), Some(ValueType::Number)), "k: 7\n");
        assert_eq!(r(json!(7), Some(ValueType::Text)), "k: \"7\"\n");
        assert_eq!(
            r(json!("2024-01-05"), Some(ValueType::Date)),
            "k: 2024-01-05\n"
        );
        assert_eq!(r(json!("2024-01-05"), None), "k: \"2024-01-05\"\n");
        assert_eq!(
            r(json!("2024-01-05T10:30:00"), Some(ValueType::DateTime)),
            "k: 2024-01-05T10:30:00\n"
        );
        assert_eq!(
            r(json!("a, b ,c"), Some(ValueType::List)),
            "k:\n  - a\n  - b\n  - c\n"
        );
        assert_eq!(r(json!([]), None), "k: []\n");
        assert_eq!(r(json!(null), None), "k:\n");
        assert_eq!(r(json!("plain words"), None), "k: plain words\n");
        assert_eq!(r(json!("a: b"), None), "k: \"a: b\"\n");
        assert_eq!(r(json!("[[Note]]"), None), "k: \"[[Note]]\"\n");
        assert_eq!(r(json!("#tag"), None), "k: \"#tag\"\n");
        assert_eq!(r(json!(" pad"), None), "k: \" pad\"\n");
        assert_eq!(r(json!("two\nlines"), None), "k: \"two\\nlines\"\n");
        assert_eq!(r(json!(""), None), "k: \"\"\n");
        assert_eq!(r(json!("null"), None), "k: \"null\"\n");
        assert_eq!(r(json!("-x"), None), "k: -x\n");
        assert_eq!(r(json!("Yes"), None), "k: \"Yes\"\n");
        assert_eq!(r(json!("- x"), None), "k: \"- x\"\n");
        assert_eq!(
            r(json!({"a": 1, "b": "x y"}), None),
            "k:\n  a: 1\n  b: x y\n"
        );
    }

    #[test]
    fn invalid_values_are_rejected() {
        let bad = |v: Json, h: ValueType| set_property("", "k", &v, Some(h)).unwrap_err();
        assert!(matches!(
            bad(json!("2024-13-40"), ValueType::Date),
            PatchError::InvalidValue(_)
        ));
        assert!(matches!(
            bad(json!("abc"), ValueType::Number),
            PatchError::InvalidValue(_)
        ));
        assert!(matches!(
            bad(json!("yes"), ValueType::Checkbox),
            PatchError::InvalidValue(_)
        ));
        assert!(matches!(
            bad(json!(["a"]), ValueType::Text),
            PatchError::InvalidValue(_)
        ));
        assert!(matches!(
            set_property("", " ", &json!(1), None),
            Err(PatchError::InvalidName(_))
        ));
    }

    #[test]
    fn set_then_read_round_trips_every_type() {
        let cases: Vec<(Json, Option<ValueType>, &str)> = vec![
            (json!("hello world"), None, "text"),
            (json!("12"), Some(ValueType::Text), "text"),
            (json!(12), None, "number"),
            (json!(true), None, "bool"),
            (json!("2024-02-03"), Some(ValueType::Date), "date"),
            (
                json!("2024-02-03T04:05:06"),
                Some(ValueType::DateTime),
                "datetime",
            ),
            (json!(["a", "b c", "[[L]]"]), None, "list"),
            (json!("[[Note|alias]]"), None, "link"),
        ];
        for (value, hint, vtype) in cases {
            let out = set_property("---\nz: 1\n---\nbody\n", "k", &value, hint).unwrap();
            let props = read_properties(&out).unwrap();
            let p = props.iter().find(|p| p.name == "k").unwrap();
            assert_eq!(p.value, value, "value for {value}");
            assert_eq!(p.vtype, vtype, "type for {value}");
            let back = remove_property(&out, "k").unwrap();
            assert_eq!(back, "---\nz: 1\n---\nbody\n");
        }
    }

    #[test]
    fn read_properties_keeps_file_order() {
        let p = read_properties("---\nb: 1\na: 2\n---\n").unwrap();
        let names: Vec<_> = p.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, ["b", "a"]);
        assert!(read_properties("no fm").unwrap().is_empty());
        assert!(read_properties("---\nk: [oops\n---\n").is_err());
    }
}
