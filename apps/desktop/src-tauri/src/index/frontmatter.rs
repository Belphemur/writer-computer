//! Frontmatter extraction and typed property rows.

use super::markdown::{self, LinkKind, ParsedLink};
use super::yaml::{self, YNode};

pub struct Split<'a> {
    /// Text between the fences, without the fences (None: no frontmatter).
    pub fm: Option<&'a str>,
    /// Byte offset where the body starts.
    pub body_start: usize,
    /// 1-based line number of the first body line.
    pub body_first_line: u32,
}

fn is_fence(line: &str, closing: bool) -> bool {
    let t = line.trim_end_matches(['\r', ' ', '\t']);
    t == "---" || (closing && t == "...")
}

/// Split `content` into frontmatter and body. A leading BOM is skipped and CRLF
/// is tolerated. The block must open with `---` on the first line and close
/// with a `---` (or `...`) line; an unterminated block is not frontmatter
/// (a leading horizontal rule is common).
pub fn split(content: &str) -> Split<'_> {
    let bom = if content.starts_with('\u{feff}') {
        3
    } else {
        0
    };
    let text = &content[bom..];
    let none = Split {
        fm: None,
        body_start: bom,
        body_first_line: 1,
    };
    let first_end = text.find('\n').unwrap_or(text.len());
    if !is_fence(&text[..first_end], false) {
        return none;
    }
    let mut offset = first_end + 1;
    let mut line_no = 2u32;
    while offset <= text.len() {
        let rest = &text[offset.min(text.len())..];
        if rest.is_empty() {
            return none;
        }
        let end = rest.find('\n').unwrap_or(rest.len());
        let line = &rest[..end];
        if is_fence(line, true) {
            let fm = &text[first_end + 1..offset];
            let body_start = bom + (offset + end + 1).min(text.len());
            return Split {
                fm: Some(fm),
                body_start,
                body_first_line: line_no + 1,
            };
        }
        offset += end + 1;
        line_no += 1;
    }
    none
}

/// Byte layout of a frontmatter block, for surgical edits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FmSpan {
    /// Offset of the opening fence line (after a BOM).
    pub open_start: usize,
    /// First byte of the frontmatter content (after the opening fence line).
    pub fm_start: usize,
    /// First byte of the closing fence line (= end of the content).
    pub fm_end: usize,
}

/// Locate the frontmatter block with the same rules as [`split`].
pub fn fm_span(content: &str) -> Option<FmSpan> {
    let bom = if content.starts_with('\u{feff}') {
        3
    } else {
        0
    };
    let text = &content[bom..];
    let first_end = text.find('\n').unwrap_or(text.len());
    if !is_fence(&text[..first_end], false) {
        return None;
    }
    let mut offset = first_end + 1;
    while offset < text.len() {
        let rest = &text[offset..];
        let end = rest.find('\n').unwrap_or(rest.len());
        if is_fence(&rest[..end], true) {
            return Some(FmSpan {
                open_start: bom,
                fm_start: bom + first_end + 1,
                fm_end: bom + offset,
            });
        }
        offset += end + 1;
    }
    None
}

#[derive(Debug, Clone, PartialEq)]
pub struct PropRow {
    pub key: String,
    pub vtype: &'static str,
    pub v_text: Option<String>,
    pub v_num: Option<f64>,
    pub v_date: Option<i64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ItemRow {
    pub key: String,
    pub idx: u32,
    pub vtype: &'static str,
    pub v_text: Option<String>,
    pub link_target: Option<String>,
}

#[derive(Debug, Default)]
pub struct FrontmatterData {
    pub json: Option<String>,
    pub error: Option<String>,
    pub props: Vec<PropRow>,
    pub items: Vec<ItemRow>,
    /// Raw `tags` strings (before normalisation).
    pub tags: Vec<String>,
    pub links: Vec<ParsedLink>,
}

pub fn vtype(node: &YNode) -> &'static str {
    match node {
        YNode::Null => "null",
        YNode::Bool(_) => "bool",
        YNode::Int(_) | YNode::Float(_) => "number",
        YNode::Date { .. } => "date",
        YNode::DateTime { .. } => "datetime",
        YNode::Seq(_) => "list",
        YNode::Map(_) => "object",
        YNode::Str { s, .. } => {
            if whole_wikilink(s).is_some() {
                "link"
            } else {
                "text"
            }
        }
    }
}

/// `[[target|display#sub]]` as the entire (trimmed) string.
fn whole_wikilink(s: &str) -> Option<ParsedLink> {
    let t = s.trim();
    if !t.starts_with("[[") || !t.ends_with("]]") || t.len() < 5 {
        return None;
    }
    let links = markdown::scan_links(t);
    let link = links.into_iter().next()?;
    (link.kind == LinkKind::Wikilink && link.span == (0, t.len())).then_some(link)
}

fn scalar_text(node: &YNode) -> Option<String> {
    match node {
        YNode::Null | YNode::Seq(_) | YNode::Map(_) => None,
        YNode::Bool(b) => Some(b.to_string()),
        YNode::Int(i) => Some(i.to_string()),
        YNode::Float(f) => Some(f.to_string()),
        YNode::Str { s, .. } | YNode::Date { raw: s, .. } | YNode::DateTime { raw: s, .. } => {
            Some(s.clone())
        }
    }
}

fn scalar_num(node: &YNode) -> Option<f64> {
    match node {
        YNode::Int(i) => Some(*i as f64),
        YNode::Float(f) => Some(*f),
        _ => None,
    }
}

fn scalar_date(node: &YNode) -> Option<i64> {
    match node {
        YNode::Date { ms, .. } | YNode::DateTime { ms, .. } => Some(*ms),
        _ => None,
    }
}

fn collect_strings<'a>(node: &'a YNode, out: &mut Vec<&'a str>) {
    match node {
        YNode::Str { s, .. } => out.push(s),
        YNode::Seq(items) => items.iter().for_each(|n| collect_strings(n, out)),
        YNode::Map(pairs) => pairs.iter().for_each(|(_, n)| collect_strings(n, out)),
        _ => {}
    }
}

/// Split a `tags` value into raw tag strings. Accepts a list or a comma/space
/// separated string; leading `#` is stripped by the caller.
fn raw_tags(node: &YNode) -> Vec<String> {
    let mut out = Vec::new();
    match node {
        YNode::Seq(items) => {
            for item in items {
                if let Some(t) = scalar_text(item) {
                    out.extend(split_tag_string(&t));
                }
            }
        }
        other => {
            if let Some(t) = scalar_text(other) {
                out.extend(split_tag_string(&t));
            }
        }
    }
    out
}

fn split_tag_string(s: &str) -> Vec<String> {
    s.split(|c: char| c == ',' || c.is_whitespace())
        .filter(|t| !t.is_empty())
        .map(str::to_string)
        .collect()
}

pub fn parse_frontmatter(text: &str) -> FrontmatterData {
    let mut data = FrontmatterData::default();
    let node = match yaml::parse(text) {
        Ok(None) => YNode::Map(Vec::new()),
        Ok(Some(n)) => n,
        Err(e) => {
            data.error = Some(e);
            // Best effort so links in a broken block still count.
            data.links = markdown::scan_links(text);
            return data;
        }
    };
    let YNode::Map(pairs) = &node else {
        data.error = Some("frontmatter is not a mapping".to_string());
        return data;
    };
    data.json = Some(node.to_json().to_string());

    for (key, value) in pairs {
        let vt = vtype(value);
        let mut row = PropRow {
            key: key.clone(),
            vtype: vt,
            v_text: None,
            v_num: scalar_num(value),
            v_date: scalar_date(value),
        };
        match value {
            YNode::Seq(items) => {
                for (idx, item) in items.iter().enumerate() {
                    let item_type = vtype(item);
                    let link_target = match item {
                        YNode::Str { s, .. } => whole_wikilink(s).map(|l| l.raw),
                        _ => None,
                    };
                    let v_text = match item {
                        YNode::Seq(_) | YNode::Map(_) => Some(item.to_json().to_string()),
                        other => scalar_text(other),
                    };
                    data.items.push(ItemRow {
                        key: key.clone(),
                        idx: idx as u32,
                        vtype: item_type,
                        v_text,
                        link_target,
                    });
                }
            }
            YNode::Map(_) => row.v_text = Some(value.to_json().to_string()),
            other => row.v_text = scalar_text(other),
        }
        data.props.push(row);

        if key.eq_ignore_ascii_case("tags") || key.eq_ignore_ascii_case("tag") {
            data.tags.extend(raw_tags(value));
        }
    }

    let mut strings = Vec::new();
    collect_strings(&node, &mut strings);
    for s in strings {
        data.links.extend(markdown::scan_links(s));
    }
    data
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_handles_bom_crlf_and_missing_close() {
        let s = split("\u{feff}---\r\ntitle: a\r\n---\r\nbody\r\n");
        assert_eq!(s.fm.unwrap().trim(), "title: a");
        assert_eq!(
            &"\u{feff}---\r\ntitle: a\r\n---\r\nbody\r\n"[s.body_start..],
            "body\r\n"
        );
        assert_eq!(s.body_first_line, 4);
        assert!(split("---\ntitle: a\nbody").fm.is_none());
        assert!(split("no fm\n---\na\n---\n").fm.is_none());
        let empty = split("---\n---\ntext");
        assert_eq!(empty.fm, Some(""));
        assert_eq!(empty.body_first_line, 3);
        assert!(split("").fm.is_none());
    }

    #[test]
    fn props_are_typed() {
        let d = parse_frontmatter(
            "status: done\nn: 3\nd: 2024-01-05\nq: \"2024-01-05\"\nlink: \"[[A|x]]\"\nrel:\n  - \"[[B]]\"\n  - plain\n  - 4\nobj:\n  a: 1\nempty:\ntags: a, b/c\n",
        );
        let ty = |k: &str| d.props.iter().find(|p| p.key == k).unwrap().vtype;
        assert_eq!(ty("status"), "text");
        assert_eq!(ty("n"), "number");
        assert_eq!(ty("d"), "date");
        assert_eq!(ty("q"), "text");
        assert_eq!(ty("link"), "link");
        assert_eq!(ty("rel"), "list");
        assert_eq!(ty("obj"), "object");
        assert_eq!(ty("empty"), "null");
        let items: Vec<_> = d.items.iter().filter(|i| i.key == "rel").collect();
        assert_eq!(items[0].link_target.as_deref(), Some("B"));
        assert_eq!(items[0].vtype, "link");
        assert_eq!(items[1].vtype, "text");
        assert_eq!(items[2].vtype, "number");
        assert_eq!(d.tags, vec!["a", "b/c"]);
        assert_eq!(d.links.len(), 2);
    }
}
