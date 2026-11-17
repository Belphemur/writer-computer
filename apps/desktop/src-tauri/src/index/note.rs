//! Pure markdown note parsing: content in, rows out. No I/O.

use super::frontmatter::{self, ItemRow, PropRow};
use super::fts::{space_cjk, FtsDoc, FTS_MAX_BODY_BYTES};
use super::markdown::{self, Heading, ParsedLink, TaskItem};
use sha2::{Digest, Sha256};

/// A tag row: lowercased tag and where it came from.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct TagRow {
    pub tag: String,
    pub source: &'static str,
}

/// A link of a note with its origin, in document order (frontmatter first).
#[derive(Debug, Clone, PartialEq)]
pub struct LinkRow {
    pub link: ParsedLink,
    pub in_fm: bool,
    /// Frontmatter links: the property key (see [`frontmatter::FmLink::label`]); body links: None.
    pub label: Option<String>,
    /// 1-based line in the file, when known.
    pub line: Option<u32>,
    /// Nearest heading text at or above a body link; None for frontmatter links.
    pub section: Option<String>,
}

/// The first frontmatter line after the opening fence.
const FM_FIRST_LINE: u32 = 2;

#[derive(Debug, Default)]
pub struct ParsedNote {
    pub fm_json: Option<String>,
    pub fm_error: Option<String>,
    pub props: Vec<PropRow>,
    pub items: Vec<ItemRow>,
    pub tags: Vec<TagRow>,
    pub links: Vec<LinkRow>,
    pub tasks: Vec<TaskItem>,
    pub headings: Vec<Heading>,
    pub words: u32,
    pub chars: u32,
    /// Text columns for the full-text index.
    pub fts: FtsDoc,
}

/// Stable 63-bit content hash (first 8 bytes of SHA-256).
pub fn content_hash(bytes: &[u8]) -> i64 {
    let digest = Sha256::digest(bytes);
    let mut b = [0u8; 8];
    b.copy_from_slice(&digest[..8]);
    (u64::from_be_bytes(b) >> 1) as i64
}

pub fn parse_note(content: &str) -> ParsedNote {
    let split = frontmatter::split(content);
    let mut note = ParsedNote::default();
    let mut seen_tags = std::collections::HashSet::new();
    let mut push_tags = |note: &mut ParsedNote, tag: &str, source: &'static str| {
        for t in markdown::with_ancestors(tag) {
            let row = TagRow { tag: t, source };
            if seen_tags.insert(row.clone()) {
                note.tags.push(row);
            }
        }
    };

    if let Some(fm) = split.fm {
        let data = frontmatter::parse_frontmatter(fm);
        note.fm_json = data.json;
        note.fm_error = data.error;
        note.props = data.props;
        note.items = data.items;
        for raw in &data.tags {
            if let Some(tag) = markdown::normalize_tag(raw) {
                push_tags(&mut note, &tag, "frontmatter");
            }
        }
        note.links.extend(data.links.into_iter().map(|l| LinkRow {
            link: l.link,
            in_fm: true,
            label: l.label,
            line: l.line.map(|n| n + FM_FIRST_LINE - 1),
            section: None,
        }));
    }

    let body = &content[split.body_start..];
    let scan = markdown::scan_body(body, split.body_first_line);
    for tag in &scan.tags {
        push_tags(&mut note, tag, "body");
    }
    note.links.extend(scan.links.into_iter().map(|l| LinkRow {
        link: l.link,
        in_fm: false,
        label: None,
        line: Some(l.line),
        section: l.section,
    }));
    note.tasks = scan.tasks;
    note.headings = scan.headings;
    note.words = scan.words;
    note.chars = scan.chars;
    note.fts = fts_doc(&note, body);
    note
}

/// Full-text columns: the body without frontmatter (frontmatter *values* go
/// to `props` instead, so keys and YAML punctuation never rank), headings,
/// tags and property text.
// `..default()` fills the test-only `skip` field; without it the update has no effect.
#[allow(clippy::needless_update)]
fn fts_doc(note: &ParsedNote, body: &str) -> FtsDoc {
    let join =
        |parts: &mut dyn Iterator<Item = &str>| space_cjk(&parts.collect::<Vec<_>>().join("\n"));
    let skipped = body.len() > FTS_MAX_BODY_BYTES;
    FtsDoc {
        headings: join(&mut note.headings.iter().map(|h| h.text.as_str())),
        tags: join(&mut note.tags.iter().map(|t| t.tag.as_str())),
        props: join(
            &mut note
                .props
                .iter()
                .filter_map(|p| p.v_text.as_deref())
                .chain(note.items.iter().filter_map(|i| i.v_text.as_deref())),
        ),
        body: if skipped {
            String::new()
        } else {
            space_cjk(body)
        },
        body_skipped: skipped,
        ..FtsDoc::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn combines_frontmatter_and_body() {
        let n = parse_note(
            "---\ntags: [Project/Alpha, \"#x\"]\nrel: \"[[Other]]\"\n---\nBody #y/z [[Link|d]]\n- [ ] todo\n",
        );
        let tags: Vec<_> = n.tags.iter().map(|t| (t.tag.as_str(), t.source)).collect();
        assert_eq!(
            tags,
            vec![
                ("project", "frontmatter"),
                ("project/alpha", "frontmatter"),
                ("x", "frontmatter"),
                ("y", "body"),
                ("y/z", "body")
            ]
        );
        assert_eq!(n.links.len(), 2);
        assert!(n.links[0].in_fm && !n.links[1].in_fm);
        assert_eq!(n.links[0].label.as_deref(), Some("rel"));
        assert_eq!(n.tasks[0].line, 6);
        assert_eq!(n.words, 4);
    }

    #[test]
    fn property_links_carry_their_key_and_line() {
        let n = parse_note(
            "---\nmanager: \"[[Daniel]]\"\nteam:\n  - \"[[Ana]]\"\n  - \"[[Ben|b]]\"\nmeta:\n  lead: \"[[Cho]]\"\nnote: see [[Dee]] and [[Eve]]\n---\nbody [[Fay]]\n",
        );
        let got: Vec<_> = n
            .links
            .iter()
            .map(|l| (l.link.raw.as_str(), l.label.as_deref(), l.line))
            .collect();
        assert_eq!(
            got,
            vec![
                ("Daniel", Some("manager"), Some(2)),
                ("Ana", Some("team"), Some(3)),
                ("Ben", Some("team"), Some(3)),
                ("Cho", Some("meta.lead"), Some(6)),
                ("Dee", Some("note"), Some(8)),
                ("Eve", Some("note"), Some(8)),
                ("Fay", None, Some(10)),
            ]
        );
    }

    #[test]
    fn body_links_carry_line_and_nearest_heading() {
        let n = parse_note(
            "first [[A]]\n# One\ntext [[B]]\n```\n[[no]]\n```\n## Two\n[[C]]\n\n[[D]] x\n",
        );
        let got: Vec<_> = n
            .links
            .iter()
            .map(|l| (l.link.raw.as_str(), l.line, l.section.as_deref()))
            .collect();
        assert_eq!(
            got,
            vec![
                ("A", Some(1), None),
                ("B", Some(3), Some("One")),
                ("C", Some(8), Some("Two")),
                ("D", Some(10), Some("Two")),
            ]
        );
    }

    #[test]
    fn broken_frontmatter_links_are_labelled_by_the_nearest_key() {
        let n = parse_note("---\nkey: [oops\nboss: : [[Boss]]\n---\n[[Body]]\n");
        assert!(n.fm_error.is_some());
        let got: Vec<_> = n
            .links
            .iter()
            .map(|l| (l.link.raw.as_str(), l.label.as_deref(), l.line))
            .collect();
        assert_eq!(
            got,
            vec![("Boss", Some("boss"), Some(3)), ("Body", None, Some(5))]
        );
    }

    #[test]
    fn broken_frontmatter_still_indexes_body() {
        let n = parse_note("---\nkey: [oops\n---\n# Title\nSee [[A]] #t\n");
        assert!(n.fm_error.is_some());
        assert!(n.fm_json.is_none());
        assert_eq!(n.headings.len(), 1);
        assert_eq!(n.tags.len(), 1);
        assert_eq!(n.links.len(), 1);
    }
}
