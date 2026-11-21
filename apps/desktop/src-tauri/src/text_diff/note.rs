//! The rendered diff of a note: its front matter as property rows and its body as blocks
//! (headings, paragraphs, list items, quotes, code, rules) with word-level marks, the data of the
//! "Rendered" view of the shared diff component. Pure; the blocks are aligned with the shared
//! line diff core ([`super::lines`]) and the words of a changed block with [`super::words`].
//!
//! A block's text is what the editor shows, not the Markdown source: wiki links and embeds read as
//! their labels, links as their text. Emphasis marks stay (a change to them is a change).

use super::lines::{diff_lines, Edit};
use super::words::{diff_words, similarity, DiffOp, DiffPart};
use crate::index::{
    frontmatter,
    yaml::{self, YNode},
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum DiffBlockStyle {
    Paragraph,
    Heading,
    ListItem,
    Quote,
    Code,
    Rule,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum DiffBlockChange {
    Same,
    Added,
    Removed,
    Changed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct DiffBlock {
    pub style: DiffBlockStyle,
    /// Heading level (1 to 6) or list depth (0 for the first).
    pub level: u8,
    pub change: DiffBlockChange,
    /// One `eq` part for an unchanged block, one `ins` or `del` part for an added or removed one,
    /// the word diff for a changed one.
    pub parts: Vec<DiffPart>,
}

/// One front matter property: `before` is `None` when it was added, `after` when it was removed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct DiffProp {
    pub name: String,
    pub before: Option<String>,
    pub after: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct NoteDiff {
    /// Only the properties that changed.
    pub front: Vec<DiffProp>,
    pub blocks: Vec<DiffBlock>,
}

struct Raw {
    style: DiffBlockStyle,
    level: u8,
    text: String,
}

impl Raw {
    fn key(&self) -> String {
        format!("{:?}:{}:{}", self.style, self.level, self.text)
    }
}

/// `[[Note|label]]` and `![[embed]]` read as their label, `[text](url)` as its text.
fn display(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find(['[', '!']) {
        out.push_str(&rest[..i]);
        let tail = &rest[i..];
        let bang = tail.starts_with('!');
        let inner = if bang { &tail[1..] } else { tail };
        if let Some(body) = inner.strip_prefix("[[") {
            if let Some(end) = body.find("]]") {
                let link = &body[..end];
                let label = link.rsplit_once('|').map_or(link, |(_, alias)| alias);
                out.push_str(label.trim());
                rest = &body[end + 2..];
                continue;
            }
        } else if let Some(body) = inner.strip_prefix('[') {
            if let Some(close) = body.find("](") {
                if let Some(end) = body[close + 2..].find(')') {
                    let label = &body[..close];
                    out.push_str(if label.is_empty() && bang {
                        "image"
                    } else {
                        label
                    });
                    rest = &body[close + 2 + end + 1..];
                    continue;
                }
            }
        }
        out.push_str(&tail[..1]);
        rest = &tail[1..];
    }
    out.push_str(rest);
    // runs of spaces and line breaks render as one space
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn is_rule(t: &str) -> bool {
    let t = t.trim();
    t.len() >= 3
        && ["-", "*", "_"]
            .iter()
            .any(|c| t.chars().all(|x| c.starts_with(x) || x == ' ') && t.matches(*c).count() >= 3)
}

fn heading(t: &str) -> Option<(u8, &str)> {
    let hashes = t.chars().take_while(|&c| c == '#').count();
    let rest = t.get(hashes..)?;
    ((1..=6).contains(&hashes) && (rest.is_empty() || rest.starts_with(' ')))
        .then(|| (hashes as u8, rest.trim().trim_end_matches('#').trim_end()))
}

fn list_item(line: &str) -> Option<(u8, &str)> {
    let indent: usize = line
        .chars()
        .take_while(|c| *c == ' ' || *c == '\t')
        .map(|c| if c == '\t' { 4 } else { 1 })
        .sum();
    let t = line.trim_start();
    let body = if let Some(r) = t.strip_prefix(['-', '*', '+']) {
        r.strip_prefix(' ')?
    } else {
        let digits = t.chars().take_while(char::is_ascii_digit).count();
        let r = t.get(digits..)?;
        if digits == 0 {
            return None;
        }
        r.strip_prefix(['.', ')'])?.strip_prefix(' ')?
    };
    Some(((indent / 2).min(8) as u8, body.trim()))
}

fn task_marks(s: &str) -> String {
    if let Some(r) = s.strip_prefix("[ ] ") {
        format!("\u{2610} {r}")
    } else if let Some(r) = s.strip_prefix("[x] ").or_else(|| s.strip_prefix("[X] ")) {
        format!("\u{2611} {r}")
    } else {
        s.to_string()
    }
}

fn blocks_of(body: &str) -> Vec<Raw> {
    let mut out: Vec<Raw> = Vec::new();
    let mut para: Vec<String> = Vec::new();
    let flush = |para: &mut Vec<String>, out: &mut Vec<Raw>| {
        if !para.is_empty() {
            out.push(Raw {
                style: DiffBlockStyle::Paragraph,
                level: 0,
                text: display(&para.join(" ")),
            });
            para.clear();
        }
    };
    let mut lines = body.lines().peekable();
    while let Some(line) = lines.next() {
        let line = line.strip_suffix('\r').unwrap_or(line);
        let t = line.trim();
        if t.is_empty() {
            flush(&mut para, &mut out);
        } else if t.starts_with("```") || t.starts_with("~~~") {
            flush(&mut para, &mut out);
            let fence = &t[..3];
            let mut code = Vec::new();
            for next in lines.by_ref() {
                if next.trim().starts_with(fence) {
                    break;
                }
                code.push(next.strip_suffix('\r').unwrap_or(next));
            }
            out.push(Raw {
                style: DiffBlockStyle::Code,
                level: 0,
                text: code.join("\n"),
            });
        } else if let Some((level, text)) = heading(t) {
            flush(&mut para, &mut out);
            out.push(Raw {
                style: DiffBlockStyle::Heading,
                level,
                text: display(text),
            });
        } else if is_rule(t) {
            flush(&mut para, &mut out);
            out.push(Raw {
                style: DiffBlockStyle::Rule,
                level: 0,
                text: String::new(),
            });
        } else if let Some(quoted) = t.strip_prefix('>') {
            flush(&mut para, &mut out);
            let quoted = display(quoted.trim());
            match out.last_mut() {
                Some(q) if q.style == DiffBlockStyle::Quote => {
                    q.text.push(' ');
                    q.text.push_str(&quoted);
                }
                _ => out.push(Raw {
                    style: DiffBlockStyle::Quote,
                    level: 0,
                    text: quoted,
                }),
            }
        } else if let Some((level, text)) = list_item(line) {
            flush(&mut para, &mut out);
            out.push(Raw {
                style: DiffBlockStyle::ListItem,
                level,
                text: display(&task_marks(text)),
            });
        } else if t.starts_with('|') {
            // a table row stands alone, so one changed cell marks one row
            flush(&mut para, &mut out);
            out.push(Raw {
                style: DiffBlockStyle::Paragraph,
                level: 0,
                text: display(t),
            });
        } else if line.starts_with([' ', '\t'])
            && matches!(out.last(), Some(l) if l.style == DiffBlockStyle::ListItem)
            && para.is_empty()
        {
            // a continuation line of the list item above
            let item = out.last_mut().expect("checked above");
            item.text.push(' ');
            item.text.push_str(&display(t));
        } else {
            para.push(t.to_string());
        }
    }
    flush(&mut para, &mut out);
    out
}

fn part(op: DiffOp, text: &str) -> Vec<DiffPart> {
    if text.is_empty() {
        return Vec::new();
    }
    vec![DiffPart {
        op,
        text: text.to_string(),
    }]
}

fn block(raw: &Raw, change: DiffBlockChange, parts: Vec<DiffPart>) -> DiffBlock {
    DiffBlock {
        style: raw.style,
        level: raw.level,
        change,
        parts,
    }
}

fn blocks_diff(old: &str, new: &str) -> Vec<DiffBlock> {
    let (a, b) = (blocks_of(old), blocks_of(new));
    let (ka, kb): (Vec<String>, Vec<String>) = (
        a.iter().map(Raw::key).collect(),
        b.iter().map(Raw::key).collect(),
    );
    let (ra, rb): (Vec<&str>, Vec<&str>) = (
        ka.iter().map(String::as_str).collect(),
        kb.iter().map(String::as_str).collect(),
    );
    let mut out = Vec::new();
    let (mut dels, mut adds): (Vec<usize>, Vec<usize>) = (Vec::new(), Vec::new());
    let settle = |dels: &mut Vec<usize>, adds: &mut Vec<usize>, out: &mut Vec<DiffBlock>| {
        let mut cursor = 0;
        for &j in adds.iter() {
            let found = (cursor..dels.len()).find(|&k| {
                let (x, y) = (&a[dels[k]], &b[j]);
                x.style == DiffBlockStyle::Code && y.style == DiffBlockStyle::Code
                    || similarity(&x.text, &y.text) >= 0.3
            });
            match found {
                Some(k) => {
                    for &d in &dels[cursor..k] {
                        out.push(block(
                            &a[d],
                            DiffBlockChange::Removed,
                            part(DiffOp::Del, &a[d].text),
                        ));
                    }
                    let (x, y) = (&a[dels[k]], &b[j]);
                    out.push(block(
                        y,
                        DiffBlockChange::Changed,
                        diff_words(&x.text, &y.text),
                    ));
                    cursor = k + 1;
                }
                None => out.push(block(
                    &b[j],
                    DiffBlockChange::Added,
                    part(DiffOp::Ins, &b[j].text),
                )),
            }
        }
        for &d in &dels[cursor..] {
            out.push(block(
                &a[d],
                DiffBlockChange::Removed,
                part(DiffOp::Del, &a[d].text),
            ));
        }
        dels.clear();
        adds.clear();
    };
    for e in diff_lines(&ra, &rb) {
        match e {
            Edit::Del(i) => dels.push(i),
            Edit::Add(j) => adds.push(j),
            Edit::Equal(_, j) => {
                settle(&mut dels, &mut adds, &mut out);
                out.push(block(
                    &b[j],
                    DiffBlockChange::Same,
                    part(DiffOp::Eq, &b[j].text),
                ));
            }
        }
    }
    settle(&mut dels, &mut adds, &mut out);
    out
}

fn shown(v: &YNode) -> String {
    match v {
        YNode::Seq(items) => items.iter().map(shown).collect::<Vec<_>>().join(", "),
        YNode::Null => String::new(),
        YNode::Map(_) => v.to_json().to_string(),
        other => match other.to_json() {
            serde_json::Value::String(s) => s,
            j => j.to_string(),
        },
    }
}

fn properties(fm: Option<&str>) -> Vec<(String, String)> {
    let Some(Ok(Some(YNode::Map(pairs)))) = fm.map(yaml::parse) else {
        // not a mapping, or broken: shown as one raw row so the change is still visible
        return match fm {
            Some(raw) if !raw.trim().is_empty() => vec![(String::new(), raw.trim().to_string())],
            _ => Vec::new(),
        };
    };
    pairs.iter().map(|(k, v)| (k.clone(), shown(v))).collect()
}

fn front_diff(old: Option<&str>, new: Option<&str>) -> Vec<DiffProp> {
    let (a, b) = (properties(old), properties(new));
    let mut out = Vec::new();
    for (name, before) in &a {
        match b.iter().find(|(n, _)| n == name) {
            Some((_, after)) if after == before => {}
            Some((_, after)) => out.push(DiffProp {
                name: name.clone(),
                before: Some(before.clone()),
                after: Some(after.clone()),
            }),
            None => out.push(DiffProp {
                name: name.clone(),
                before: Some(before.clone()),
                after: None,
            }),
        }
    }
    for (name, after) in &b {
        if !a.iter().any(|(n, _)| n == name) {
            out.push(DiffProp {
                name: name.clone(),
                before: None,
                after: Some(after.clone()),
            });
        }
    }
    out
}

pub fn diff_note(old: &str, new: &str) -> NoteDiff {
    let (so, sn) = (frontmatter::split(old), frontmatter::split(new));
    NoteDiff {
        front: front_diff(so.fm, sn.fm),
        blocks: blocks_diff(&old[so.body_start..], &new[sn.body_start..]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn changes(d: &NoteDiff) -> Vec<DiffBlockChange> {
        d.blocks.iter().map(|b| b.change).collect()
    }

    #[test]
    fn blocks_have_styles_and_links_read_as_labels() {
        let d = diff_note(
            "",
            "# Title\n\nSee [[Plan|the plan]] and ![[Pic.png]] or [site](https://x.test).\n\n- [ ] todo\n  more\n  - nested\n\n> quote\n\n---\n\n```\ncode\n```\n",
        );
        let styles: Vec<_> = d.blocks.iter().map(|b| (b.style, b.level)).collect();
        assert_eq!(
            styles,
            vec![
                (DiffBlockStyle::Heading, 1),
                (DiffBlockStyle::Paragraph, 0),
                (DiffBlockStyle::ListItem, 0),
                (DiffBlockStyle::ListItem, 1),
                (DiffBlockStyle::Quote, 0),
                (DiffBlockStyle::Rule, 0),
                (DiffBlockStyle::Code, 0),
            ]
        );
        assert_eq!(
            d.blocks[1].parts[0].text,
            "See the plan and Pic.png or site."
        );
        assert_eq!(d.blocks[2].parts[0].text, "\u{2610} todo more");
        assert!(d.blocks.iter().all(|b| b.change == DiffBlockChange::Added));
    }

    #[test]
    fn a_reworded_paragraph_is_one_changed_block_with_word_marks() {
        let d = diff_note(
            "# T\n\nThe cat sat on the mat.\n\nKeep.\n",
            "# T\n\nThe cat slept on the mat.\n\nKeep.\n",
        );
        assert_eq!(
            changes(&d),
            vec![
                DiffBlockChange::Same,
                DiffBlockChange::Changed,
                DiffBlockChange::Same
            ]
        );
        let ops: Vec<_> = d.blocks[1].parts.iter().map(|p| p.op).collect();
        assert!(ops.contains(&DiffOp::Del) && ops.contains(&DiffOp::Ins));
    }

    #[test]
    fn an_unrelated_paragraph_is_a_removal_and_an_addition() {
        let d = diff_note("alpha beta gamma\n", "totally new text here\n");
        assert_eq!(
            changes(&d),
            vec![DiffBlockChange::Added, DiffBlockChange::Removed]
        );
    }

    #[test]
    fn line_breaks_and_spaces_do_not_make_a_change() {
        let d = diff_note("one two\nthree\n\nnext\n", "one two three\n\n\n\nnext\n");
        assert!(d.blocks.iter().all(|b| b.change == DiffBlockChange::Same));
    }

    #[test]
    fn front_matter_changes_are_property_rows() {
        let old = "---\ntitle: Plan\ntags: [a, b]\nstatus: draft\n---\nBody\n";
        let new = "---\ntitle: Plan\ntags: [a, b, c]\nowner: Ada\n---\nBody\n";
        let d = diff_note(old, new);
        assert_eq!(
            d.front,
            vec![
                DiffProp {
                    name: "tags".into(),
                    before: Some("a, b".into()),
                    after: Some("a, b, c".into())
                },
                DiffProp {
                    name: "status".into(),
                    before: Some("draft".into()),
                    after: None
                },
                DiffProp {
                    name: "owner".into(),
                    before: None,
                    after: Some("Ada".into())
                },
            ]
        );
        assert_eq!(changes(&d), vec![DiffBlockChange::Same]);
    }

    #[test]
    fn a_note_gaining_front_matter_lists_every_property_as_added() {
        let d = diff_note("Body\n", "---\na: 1\n---\nBody\n");
        assert_eq!(d.front.len(), 1);
        assert_eq!(d.front[0].before, None);
        assert_eq!(d.front[0].after.as_deref(), Some("1"));
    }
}
