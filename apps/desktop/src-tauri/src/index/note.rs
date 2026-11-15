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

#[derive(Debug, Clone, PartialEq)]
pub struct LinkRow {
    pub link: ParsedLink,
    pub in_fm: bool,
}

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
        note.links.extend(
            data.links
                .into_iter()
                .map(|link| LinkRow { link, in_fm: true }),
        );
    }

    let body = &content[split.body_start..];
    let scan = markdown::scan_body(body, split.body_first_line);
    for tag in &scan.tags {
        push_tags(&mut note, tag, "body");
    }
    note.links.extend(
        scan.links
            .into_iter()
            .map(|link| LinkRow { link, in_fm: false }),
    );
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
        assert_eq!(n.tasks[0].line, 6);
        assert_eq!(n.words, 4);
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
