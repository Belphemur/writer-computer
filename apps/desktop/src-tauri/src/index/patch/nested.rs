//! Nested property edits: one key inside a property's map (`metadata.version`), up to two levels
//! (`metadata.flags.beta`). Spec `SPECs/properties-types-spec.md` "Object", ADR
//! `2026-11-18-add-an-object-property-type-edited-as-indented-rows-up-to-two-levels`.
//!
//! The same byte-minimal rule as the top level (`super`): an edit changes only the lines of the
//! key it names. A set replaces that key's lines, an add appends lines after the map's last entry,
//! a remove drops the key's lines, a rename replaces the key token. Comments, order and every
//! other key stay byte-identical. The one exception is the map's own line: an emptied map becomes
//! `key: {}` and the first key added to `key: {}` turns it into a block (a trailing comment on that
//! line stays). Each result is re-parsed and compared with what the edit should have produced; a
//! mismatch refuses the edit instead of writing it.
//!
//! Only block maps with plain keys are edited. A flow map (`{a: 1}`), an anchored or aliased map, a
//! key inside a list item and anything deeper than two levels are refused with
//! [`PatchError::Unsupported`], never rewritten. The TS panel splicer
//! (`src/lib/frontmatter-nested.ts`) is pinned to this code by
//! `shared/nested-property-vectors.json`, which both test suites read.

use super::{
    key_lines, key_prefix_len, render, scan, text_scalar, trailing_comment, trimmed_range,
    validate_name, KeyAt, PatchError, ValueType,
};
use crate::index::frontmatter::{self, fm_span, FmSpan};
use serde_json::Value as Json;
use std::ops::Range;

/// A path addresses `[property, key]` or `[property, key, key]`.
const MIN_PATH: usize = 2;
const MAX_PATH: usize = 3;

fn unsupported(path: &[String], why: &str) -> PatchError {
    PatchError::Unsupported(path.join("."), why.to_string())
}

/// The frontmatter's JSON, or the reason it cannot be edited.
fn fm_json(fm: &str) -> Result<Json, PatchError> {
    let data = frontmatter::parse_frontmatter(fm);
    if let Some(e) = data.error {
        return Err(PatchError::Unparsable(e));
    }
    match data.json.as_deref().map(serde_json::from_str::<Json>) {
        Some(Ok(j @ Json::Object(_))) => Ok(j),
        _ => Ok(Json::Object(Default::default())),
    }
}

fn json_get<'a>(root: &'a Json, path: &[String]) -> Option<&'a Json> {
    path.iter().try_fold(root, |j, k| j.as_object()?.get(k))
}

fn json_get_mut<'a>(root: &'a mut Json, path: &[String]) -> Option<&'a mut Json> {
    path.iter()
        .try_fold(root, |j, k| j.as_object_mut()?.get_mut(k))
}

/// The path a dotted `name` addresses, when it is a nested one: `name` is not itself a top-level
/// key (an exact name always wins), and its first part is a property holding a map.
pub(in crate::index) fn target(text: &str, name: &str) -> Option<Vec<String>> {
    if !name.contains('.') {
        return None;
    }
    let span = fm_span(text)?;
    let json = fm_json(&text[span.fm_start..span.fm_end]).ok()?;
    if json.as_object()?.contains_key(name) {
        return None;
    }
    let path: Vec<String> = name.split('.').map(str::to_string).collect();
    if path.iter().any(|p| p.trim().is_empty()) {
        return None;
    }
    json.as_object()?.get(&path[0])?.is_object().then_some(path)
}

/// The value at a dotted `name`, an exact top-level name first (any depth: reading is not limited
/// to the editable levels). `None` when there is no such property.
pub(in crate::index) fn read(text: &str, name: &str) -> Result<Option<Json>, PatchError> {
    let Some(span) = fm_span(text) else {
        return Ok(None);
    };
    let json = fm_json(&text[span.fm_start..span.fm_end])?;
    if let Some(v) = json.as_object().and_then(|m| m.get(name)) {
        return Ok(Some(v.clone()));
    }
    if !name.contains('.') {
        return Ok(None);
    }
    let path: Vec<String> = name.split('.').map(str::to_string).collect();
    Ok(json_get(&json, &path).cloned())
}

/// A parsed note: the frontmatter, its keys and line starts.
struct Open<'a> {
    text: &'a str,
    span: FmSpan,
    fm: &'a str,
    starts: Vec<usize>,
    all: Vec<KeyAt>,
    json: Json,
    eol: &'static str,
}

impl<'a> Open<'a> {
    fn new(text: &'a str, path: &[String]) -> Result<Open<'a>, PatchError> {
        if !(MIN_PATH..=MAX_PATH).contains(&path.len()) {
            return Err(unsupported(
                path,
                "only two levels of a property's map can be edited",
            ));
        }
        for part in path {
            validate_name(part)?;
        }
        let span = fm_span(text).ok_or_else(|| PatchError::NotFound(path.join(".")))?;
        let fm = &text[span.fm_start..span.fm_end];
        let json = fm_json(fm)?;
        let all = scan(fm)?.all;
        Ok(Open {
            text,
            span,
            fm,
            starts: super::line_starts(fm),
            all,
            json,
            eol: super::detect_eol(text, span.open_start),
        })
    }

    /// Index of the key at `path`; more than one is refused.
    fn find(&self, path: &[String]) -> Result<Option<usize>, PatchError> {
        let mut hits = self
            .all
            .iter()
            .enumerate()
            .filter(|(_, k)| k.path == path)
            .map(|(i, _)| i);
        let first = hits.next();
        if hits.next().is_some() {
            return Err(unsupported(path, "the key appears more than once"));
        }
        Ok(first)
    }

    fn line(&self, i: usize) -> &'a str {
        self.fm[self.starts[i]..self.starts[i + 1]].trim_end_matches(['\r', '\n'])
    }

    /// Lines `[start, end)` of the entry of key `idx`: through its last line, without the blank and
    /// comment lines that precede the next key at the same or a shallower level.
    fn range(&self, idx: usize) -> Range<usize> {
        let depth = self.all[idx].path.len();
        let next = self.all[idx + 1..]
            .iter()
            .find(|k| k.path.len() <= depth)
            .map_or(usize::MAX, |k| k.line);
        trimmed_range(self.fm, &self.starts, self.all[idx].line, next, true)
    }

    /// `(indent, length through the colon)` of key `idx`'s line.
    fn key_line(&self, idx: usize) -> Result<(usize, usize), PatchError> {
        let key = &self.all[idx];
        let line = self.line(key.line);
        let indent = line.len() - line.trim_start_matches(' ').len();
        let name = key.path.last().map_or("", String::as_str);
        key_prefix_len(&line[indent..], name)
            .map(|plen| (indent, indent + plen))
            .ok_or_else(|| {
                unsupported(
                    &key.path,
                    "its key line has a layout this editor does not rewrite (flow mapping or multi-key line)",
                )
            })
    }

    /// What follows the colon of `line`, without a trailing comment.
    fn value_text(rest: &str) -> &str {
        match trailing_comment(rest) {
            Some(c) => rest[..rest.rfind(c).unwrap_or(rest.len())].trim(),
            None => rest.trim(),
        }
    }

    /// Splice `lines` over the whole lines `range` of the frontmatter.
    fn replace_lines(&self, range: Range<usize>, lines: &[String]) -> String {
        let mut out = String::with_capacity(self.text.len() + 64);
        out.push_str(&self.text[..self.span.fm_start + self.starts[range.start]]);
        for l in lines {
            out.push_str(l);
            out.push_str(self.eol);
        }
        out.push_str(&self.text[self.span.fm_start + self.starts[range.end]..]);
        out
    }

    /// The re-parsed frontmatter of `out`, which must equal `expected`.
    fn verify(&self, out: String, path: &[String], expected: Json) -> Result<String, PatchError> {
        let span = fm_span(&out).ok_or_else(|| refused(path))?;
        let new = fm_json(&out[span.fm_start..span.fm_end]).map_err(|_| refused(path))?;
        if new == expected {
            Ok(out)
        } else {
            Err(refused(path))
        }
    }
}

fn refused(path: &[String]) -> PatchError {
    unsupported(
        path,
        "the change could not be applied without altering other properties",
    )
}

/// How a parent map is written, which decides where a new key goes.
enum Parent {
    /// `key:` followed by indented entries.
    Block,
    /// `key: {}`.
    EmptyFlow,
}

impl Open<'_> {
    fn parent(&self, parent_path: &[String]) -> Result<(usize, Parent), PatchError> {
        let idx = self
            .find(parent_path)?
            .ok_or_else(|| PatchError::NotFound(parent_path.join(".")))?;
        let Some(Json::Object(map)) = json_get(&self.json, parent_path) else {
            return Err(unsupported(parent_path, "is not a map"));
        };
        let (_, colon_end) = self.key_line(idx)?;
        let body = Self::value_text(&self.line(self.all[idx].line)[colon_end..]);
        let has_children = self
            .all
            .iter()
            .any(|k| k.path.len() == parent_path.len() + 1 && k.path.starts_with(parent_path));
        match (body, map.is_empty(), has_children) {
            ("", false, true) => Ok((idx, Parent::Block)),
            ("{}", true, _) => Ok((idx, Parent::EmptyFlow)),
            _ => Err(unsupported(
                parent_path,
                "is a flow map or has an anchor; edit it in Source",
            )),
        }
    }
}

/// Set the key at `path` (`[property, key]` or `[property, key, key]`) to a scalar or a list of
/// scalars, or add it at the end of its map when it does not exist yet. A key holding a map is not
/// replaced.
pub fn set_nested(
    text: &str,
    path: &[String],
    value: &Json,
    hint: Option<ValueType>,
) -> Result<String, PatchError> {
    if value.is_object()
        || matches!(value, Json::Array(a) if a.iter().any(|i| i.is_object() || i.is_array()))
    {
        return Err(PatchError::InvalidValue(
            "a nested key holds a scalar or a list of scalars; set a map's keys one by one".into(),
        ));
    }
    let open = Open::new(text, path)?;
    let (name, parent_path) = path.split_last().expect("path has two or three parts");
    let (inline, block) = render(value, hint)?;
    let child = open.find(path)?;
    let out = match child {
        Some(ci) => {
            if json_get(&open.json, path).is_some_and(Json::is_object) {
                return Err(unsupported(path, "is a map; set its keys one by one"));
            }
            open.parent(parent_path)?;
            let (indent, colon_end) = open.key_line(ci)?;
            let range = open.range(ci);
            let first = open.line(open.all[ci].line);
            let comment = (range.len() == 1)
                .then(|| trailing_comment(&first[colon_end..]))
                .flatten();
            let lines = key_lines(
                &first[..colon_end - 1],
                &inline,
                &indented(&block, indent),
                comment,
            );
            open.replace_lines(range, &lines)
        }
        None => {
            validate_name(name)?;
            add_key(&open, parent_path, name, &inline, &block)?
        }
    };
    let mut expected = open.json.clone();
    let slot = json_get_mut(&mut expected, parent_path).and_then(Json::as_object_mut);
    // what the key holds afterwards is whatever the new text says; everything else must not move
    let after = open.verify_value(&out, path)?;
    slot.expect("the parent is a map")
        .insert(name.clone(), after);
    open.verify(out, path, expected)
}

impl Open<'_> {
    /// The value at `path` in the re-parsed `out`.
    fn verify_value(&self, out: &str, path: &[String]) -> Result<Json, PatchError> {
        let span = fm_span(out).ok_or_else(|| refused(path))?;
        let new = fm_json(&out[span.fm_start..span.fm_end]).map_err(|_| refused(path))?;
        json_get(&new, path).cloned().ok_or_else(|| refused(path))
    }
}

fn indented(block: &[String], indent: usize) -> Vec<String> {
    let pad = " ".repeat(indent);
    block.iter().map(|l| format!("{pad}{l}")).collect()
}

/// `out` with the new key `name` at the end of the map at `parent_path`.
fn add_key(
    open: &Open,
    parent_path: &[String],
    name: &str,
    inline: &str,
    block: &[String],
) -> Result<String, PatchError> {
    let (pi, kind) = open.parent(parent_path)?;
    let (parent_indent, colon_end) = open.key_line(pi)?;
    match kind {
        Parent::Block => {
            let children: Vec<usize> = open
                .all
                .iter()
                .enumerate()
                .filter(|(_, k)| {
                    k.path.len() == parent_path.len() + 1 && k.path.starts_with(parent_path)
                })
                .map(|(i, _)| i)
                .collect();
            let first = open.all[children[0]].line;
            let line = open.line(first);
            let indent = line.len() - line.trim_start_matches(' ').len();
            let end = open
                .range(*children.last().expect("a block map has children"))
                .end;
            let lines = key_lines(
                &format!("{}{}", " ".repeat(indent), text_scalar(name)),
                inline,
                &indented(block, indent),
                None,
            );
            Ok(open.replace_lines(end..end, &lines))
        }
        Parent::EmptyFlow => {
            let line = open.line(open.all[pi].line);
            let rest = &line[colon_end..];
            let brace = rest.find("{}").expect("an empty flow map has braces");
            let head = format!(
                "{}{}{}",
                &line[..colon_end],
                rest[..brace].trim_end(),
                &rest[brace + 2..]
            );
            let indent = parent_indent + 2;
            let child = key_lines(
                &format!("{}{}", " ".repeat(indent), text_scalar(name)),
                inline,
                &indented(block, indent),
                None,
            );
            let mut lines = vec![head];
            lines.extend(child);
            let at = open.all[pi].line;
            Ok(open.replace_lines(at..at + 1, &lines))
        }
    }
}

/// Remove the key at `path` (its lines only). Removing a map's last key leaves `key: {}`.
pub fn remove_nested(text: &str, path: &[String]) -> Result<String, PatchError> {
    let open = Open::new(text, path)?;
    let parent_path = &path[..path.len() - 1];
    let ci = open
        .find(path)?
        .ok_or_else(|| PatchError::NotFound(path.join(".")))?;
    let (pi, _) = open.parent(parent_path)?;
    open.key_line(ci)?;
    let range = open.range(ci);
    let mut out = open.replace_lines(range, &[]);
    let siblings = json_get(&open.json, parent_path)
        .and_then(Json::as_object)
        .map_or(0, |m| m.len());
    if siblings == 1 {
        // the map is empty now: `key:` would read as null, so say `key: {}`
        let (_, colon_end) = open.key_line(pi)?;
        let at = open.span.fm_start + open.starts[open.all[pi].line] + colon_end;
        out.insert_str(at, " {}");
    }
    let mut expected = open.json.clone();
    json_get_mut(&mut expected, parent_path)
        .and_then(Json::as_object_mut)
        .expect("the parent is a map")
        .remove(path.last().expect("path is not empty"));
    open.verify(out, path, expected)
}

/// Rename the key at `path` to `to`, replacing only the key token.
pub fn rename_nested_key(text: &str, path: &[String], to: &str) -> Result<String, PatchError> {
    validate_name(to)?;
    let open = Open::new(text, path)?;
    let (name, parent_path) = path.split_last().expect("path has two or three parts");
    if name == to {
        return Ok(text.to_string());
    }
    let ci = open
        .find(path)?
        .ok_or_else(|| PatchError::NotFound(path.join(".")))?;
    open.parent(parent_path)?;
    let Some(Json::Object(map)) = json_get(&open.json, parent_path) else {
        return Err(unsupported(parent_path, "is not a map"));
    };
    if map.contains_key(to) {
        return Err(PatchError::InvalidName(format!("\"{to}\" already exists")));
    }
    let (indent, colon_end) = open.key_line(ci)?;
    let line = open.line(open.all[ci].line);
    let key_end = indent + line[indent..colon_end - 1].trim_end_matches(' ').len();
    let at = open.span.fm_start + open.starts[open.all[ci].line];
    let mut out = String::with_capacity(text.len() + to.len());
    out.push_str(&text[..at + indent]);
    out.push_str(&text_scalar(to));
    out.push_str(&text[at + key_end..]);
    let mut expected = open.json.clone();
    let m = json_get_mut(&mut expected, parent_path)
        .and_then(Json::as_object_mut)
        .expect("the parent is a map");
    let rebuilt: serde_json::Map<String, Json> = std::mem::take(m)
        .into_iter()
        .map(|(k, v)| (if k == *name { to.to_string() } else { k }, v))
        .collect();
    *m = rebuilt;
    open.verify(out, path, expected)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn p(path: &str) -> Vec<String> {
        path.split('.').map(str::to_string).collect()
    }

    fn wrap(fm: &str) -> String {
        format!("---\n{fm}\n---\n# Body\n")
    }

    fn unwrap(note: &str) -> String {
        note.strip_prefix("---\n")
            .and_then(|n| n.strip_suffix("\n---\n# Body\n"))
            .unwrap_or_else(|| panic!("frontmatter lost its fences: {note:?}"))
            .to_string()
    }

    /// Every case of the shared file, through the one public write path of this side.
    #[test]
    fn matches_the_shared_vectors() {
        let v: Json = serde_json::from_str(include_str!(
            "../../../../shared/nested-property-vectors.json"
        ))
        .unwrap();
        let cases = v["cases"].as_array().unwrap();
        assert!(cases.len() >= 20, "the vectors went missing");
        for c in cases {
            let name = c["name"].as_str().unwrap();
            let note = wrap(c["frontmatter"].as_str().unwrap());
            let path: Vec<String> = c["path"]
                .as_array()
                .unwrap()
                .iter()
                .map(|s| s.as_str().unwrap().to_string())
                .collect();
            let got = match c["op"].as_str().unwrap() {
                "set" | "add" => set_nested(&note, &path, &c["value"], None),
                "remove" => remove_nested(&note, &path),
                "rename-key" => rename_nested_key(&note, &path, c["to"].as_str().unwrap()),
                op => panic!("{name}: unknown op {op}"),
            };
            match c["expected"].as_str() {
                Some(want) => assert_eq!(
                    unwrap(&got.unwrap_or_else(|e| panic!("{name}: {e}"))),
                    want,
                    "{name}"
                ),
                None => assert!(got.is_err(), "{name}: must be refused, got {got:?}"),
            }
        }
    }

    #[test]
    fn dotted_names_follow_the_exact_name_first_rule() {
        let note = wrap("metadata:\n  version: 1\nmetadata.version: top");
        assert_eq!(
            target(&note, "metadata.version"),
            None,
            "an exact name wins"
        );
        let note = wrap("metadata:\n  version: 1");
        assert_eq!(
            target(&note, "metadata.version"),
            Some(p("metadata.version"))
        );
        assert_eq!(target(&note, "metadata"), None);
        assert_eq!(target(&note, "other.version"), None, "no such map");
        assert_eq!(target(&note, "metadata."), None);
        let scalar = wrap("metadata: x");
        assert_eq!(target(&scalar, "metadata.version"), None, "not a map");
    }

    #[test]
    fn reads_nested_values_and_prefers_the_exact_name() {
        let note = wrap("metadata:\n  version: 1\n  flags:\n    beta: true\nmetadata.version: top");
        assert_eq!(read(&note, "metadata.version").unwrap(), Some(json!("top")));
        assert_eq!(
            read(&note, "metadata.flags.beta").unwrap(),
            Some(json!(true))
        );
        assert_eq!(read(&note, "metadata.nope").unwrap(), None);
        assert_eq!(read(&note, "nope").unwrap(), None);
    }

    #[test]
    fn crlf_is_kept_and_other_lines_do_not_move() {
        let note = "---\r\nname: x\r\nmetadata:\r\n  a: 1\r\n  b: 2\r\nlast: y\r\n---\r\nbody\r\n";
        let out = set_nested(note, &p("metadata.c"), &json!(3), None).unwrap();
        assert_eq!(
            out,
            "---\r\nname: x\r\nmetadata:\r\n  a: 1\r\n  b: 2\r\n  c: 3\r\nlast: y\r\n---\r\nbody\r\n"
        );
        let out = remove_nested(note, &p("metadata.a")).unwrap();
        assert_eq!(
            out,
            "---\r\nname: x\r\nmetadata:\r\n  b: 2\r\nlast: y\r\n---\r\nbody\r\n"
        );
    }

    #[test]
    fn a_hint_types_the_value_like_the_top_level_does() {
        let note = wrap("metadata:\n  version: 1\n  tags: [a]");
        let out = set_nested(
            &note,
            &p("metadata.version"),
            &json!("2"),
            Some(ValueType::Number),
        )
        .unwrap();
        assert_eq!(unwrap(&out), "metadata:\n  version: 2\n  tags: [a]");
        let out = set_nested(
            &note,
            &p("metadata.tags"),
            &json!("x, y"),
            Some(ValueType::List),
        )
        .unwrap();
        assert_eq!(
            unwrap(&out),
            "metadata:\n  version: 1\n  tags:\n    - x\n    - y"
        );
        assert!(set_nested(
            &note,
            &p("metadata.version"),
            &json!("two"),
            Some(ValueType::Number)
        )
        .is_err());
    }

    #[test]
    fn maps_and_deep_paths_are_refused_and_nothing_is_written() {
        let note = wrap("a:\n  b:\n    c:\n      d: 1");
        // a key inside a level-3 map is not addressable
        assert!(set_nested(&note, &p("a.b.c.d"), &json!(2), None).is_err());
        // a map value is not replaced by a scalar
        assert!(set_nested(&note, &p("a.b.c"), &json!(2), None).is_err());
        assert!(set_nested(&note, &p("a.b"), &json!({"x": 1}), None).is_err());
        assert!(
            set_nested(&note, &p("a"), &json!(1), None).is_err(),
            "one part is not nested"
        );
        // a list value that holds a map
        assert!(set_nested(&note, &p("a.x"), &json!([{"k": 1}]), None).is_err());
    }
}
