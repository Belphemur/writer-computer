//! Link updates for `move` and `rename`: rewrite wikilinks, embeds and
//! markdown links that point at the moved file, keeping each link's style
//! (bare name stays a bare name while that still resolves to the file, path
//! style stays path style, relative stays relative), its `#heading` and its
//! `|alias`. Links inside code spans and fenced blocks are never touched
//! (same scanner as the index). Pure text transforms; the commands do the I/O.

use crate::index::frontmatter::fm_span;
use crate::index::markdown::{
    fence_closes, fence_open, mask_code_spans, percent_decode, scan_links, LinkKind, ParsedLink,
};
use crate::index::resolve::PathIndex;

pub struct Move<'a> {
    pub old: &'a str,
    pub new: &'a str,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Rewrite {
    pub text: String,
    pub changed: usize,
    /// Links that point at the file but whose text could not be located.
    pub skipped: usize,
}

fn folder_of(path: &str) -> &str {
    path.rfind('/').map_or("", |i| &path[..i])
}

fn name_of(path: &str) -> &str {
    path.rfind('/').map_or(path, |i| &path[i + 1..])
}

fn is_md(path: &str) -> bool {
    path.to_ascii_lowercase().ends_with(".md")
}

fn strip_md(s: &str) -> &str {
    if is_md(s) {
        &s[..s.len() - 3]
    } else {
        s
    }
}

pub fn relative_path(from_dir: &str, to: &str) -> String {
    let f: Vec<&str> = from_dir.split('/').filter(|s| !s.is_empty()).collect();
    let t: Vec<&str> = to.split('/').filter(|s| !s.is_empty()).collect();
    let max = t.len().saturating_sub(1);
    let common = f
        .iter()
        .zip(t.iter())
        .take(max)
        .take_while(|(a, b)| a == b)
        .count();
    let mut parts: Vec<&str> = vec![".."; f.len() - common];
    parts.extend(&t[common..]);
    parts.join("/")
}

fn encode_md_path(p: &str) -> String {
    let mut out = String::with_capacity(p.len());
    for c in p.chars() {
        match c {
            ' ' => out.push_str("%20"),
            '%' => out.push_str("%25"),
            '(' => out.push_str("%28"),
            ')' => out.push_str("%29"),
            '<' => out.push_str("%3C"),
            '>' => out.push_str("%3E"),
            c => out.push(c),
        }
    }
    out
}

/// Every link of `text` with absolute byte spans: frontmatter strings first,
/// then body lines outside code.
fn collect_links(text: &str) -> Vec<ParsedLink> {
    let mut out = Vec::new();
    let mut body_start = if text.starts_with('\u{feff}') { 3 } else { 0 };
    if let Some(span) = fm_span(text) {
        for mut l in scan_links(&text[span.fm_start..span.fm_end]) {
            l.span = (l.span.0 + span.fm_start, l.span.1 + span.fm_start);
            out.push(l);
        }
        body_start = text[span.fm_end..]
            .find('\n')
            .map_or(text.len(), |i| span.fm_end + i + 1);
    }
    let mut offset = body_start;
    let mut fence: Option<(char, usize)> = None;
    for raw_line in text[body_start..].split_inclusive('\n') {
        let line = raw_line.trim_end_matches(['\n', '\r']);
        let start = offset;
        offset += raw_line.len();
        if let Some((ch, len)) = fence {
            if fence_closes(line, ch, len) {
                fence = None;
            }
            continue;
        }
        if let Some(open) = fence_open(line) {
            fence = Some(open);
            continue;
        }
        let masked = mask_code_spans(line);
        for mut l in scan_links(&masked) {
            l.span = (l.span.0 + start, l.span.1 + start);
            out.push(l);
        }
    }
    out
}

#[derive(PartialEq)]
enum Style {
    Bare,
    Path,
    Relative,
}

fn style_of(raw: &str) -> Style {
    if raw.starts_with("./") || raw.starts_with("../") {
        Style::Relative
    } else if raw.contains('/') {
        Style::Path
    } else {
        Style::Bare
    }
}

fn new_raw(
    link: &ParsedLink,
    retargeted: bool,
    src_after: &str,
    target_after: &str,
    after: &PathIndex,
) -> Option<String> {
    let markdown_kind = matches!(link.kind, LinkKind::Markdown | LinkKind::MarkdownEmbed);
    let style = style_of(&link.raw);
    if markdown_kind {
        if link.raw.starts_with('/') {
            return retargeted.then(|| format!("/{target_after}"));
        }
        return Some(relative_path(folder_of(src_after), target_after));
    }
    let keep_ext = link.raw.to_ascii_lowercase().ends_with(".md") || !is_md(target_after);
    let trim = |s: &str| {
        if keep_ext {
            s.to_string()
        } else {
            strip_md(s).to_string()
        }
    };
    match style {
        Style::Relative => {
            let rel = relative_path(folder_of(src_after), target_after);
            let rel = if rel.starts_with("../") || !link.raw.starts_with("./") {
                rel
            } else {
                format!("./{rel}")
            };
            Some(trim(&rel))
        }
        _ if !retargeted => None,
        Style::Path => Some(trim(target_after)),
        Style::Bare => {
            let bare = trim(name_of(target_after));
            if after.resolve(src_after, &bare, link.kind).as_deref() == Some(target_after) {
                Some(bare)
            } else {
                Some(trim(target_after))
            }
        }
    }
}

/// Byte range of the target text inside the link's span in `text`.
fn target_range(text: &str, link: &ParsedLink) -> Option<(usize, usize)> {
    let (s, e) = link.span;
    let t = text.get(s..e)?;
    match link.kind {
        LinkKind::Wikilink | LinkKind::Embed => {
            let prefix = if t.starts_with("![[") { 3 } else { 2 };
            let inner = t.get(prefix..)?;
            let at = inner.find(&link.raw)?;
            Some((s + prefix + at, s + prefix + at + link.raw.len()))
        }
        LinkKind::Markdown | LinkKind::MarkdownEmbed => {
            let open = t.find("](")? + 2;
            let rest = &t[open..];
            let (skip, end) = if rest.starts_with('<') {
                (1, rest.find('>')?)
            } else {
                (
                    0,
                    rest.find([')', ' ', '\t', '#', '\n']).unwrap_or(rest.len()),
                )
            };
            let dest = rest.get(skip..end)?;
            (percent_decode(dest) == link.raw).then_some((s + open + skip, s + open + end))
        }
    }
}

/// Rewrite the links of one note. `src_before`/`src_after` differ when the
/// note itself is the file being moved (its relative links must follow).
pub fn rewrite_text(
    text: &str,
    src_before: &str,
    src_after: &str,
    mv: &Move,
    before: &PathIndex,
    after: &PathIndex,
) -> Rewrite {
    let src_moved = src_before != src_after;
    let mut edits: Vec<(usize, usize, String)> = Vec::new();
    let mut skipped = 0;
    for link in collect_links(text) {
        if link.raw.is_empty() {
            continue;
        }
        let Some(resolved) = before.resolve(src_before, &link.raw, link.kind) else {
            continue;
        };
        let retargeted = resolved == mv.old;
        let relative = matches!(link.kind, LinkKind::Markdown | LinkKind::MarkdownEmbed)
            || style_of(&link.raw) == Style::Relative;
        if !retargeted && !(src_moved && relative) {
            continue;
        }
        let target_after = if retargeted {
            mv.new
        } else {
            resolved.as_str()
        };
        let Some(replacement) = new_raw(&link, retargeted, src_after, target_after, after) else {
            continue;
        };
        if replacement == link.raw {
            continue;
        }
        let replacement = if matches!(link.kind, LinkKind::Markdown | LinkKind::MarkdownEmbed) {
            encode_md_path(&replacement)
        } else {
            replacement
        };
        match target_range(text, &link) {
            Some((s, e)) => edits.push((s, e, replacement)),
            None => skipped += 1,
        }
    }
    edits.sort_by_key(|e| e.0);
    let changed = edits.len();
    let mut out = text.to_string();
    for (s, e, r) in edits.into_iter().rev() {
        out.replace_range(s..e, &r);
    }
    Rewrite {
        text: out,
        changed,
        skipped,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn idx(paths: &[&str]) -> PathIndex {
        PathIndex::from_paths(paths.iter().map(|s| s.to_string()))
    }

    fn after_of(before: &PathIndex, old: &str, new: &str) -> PathIndex {
        let mut a = before.clone();
        a.remove(old);
        a.insert(new.to_string());
        a
    }

    fn run(
        text: &str,
        src: &str,
        src_after: &str,
        paths: &[&str],
        old: &str,
        new: &str,
    ) -> Rewrite {
        let before = idx(paths);
        let after = after_of(&before, old, new);
        rewrite_text(text, src, src_after, &Move { old, new }, &before, &after)
    }

    #[test]
    fn relative_paths() {
        assert_eq!(relative_path("a/b", "a/c.md"), "../c.md");
        assert_eq!(relative_path("", "a/c.md"), "a/c.md");
        assert_eq!(relative_path("a", "a/c.md"), "c.md");
        assert_eq!(relative_path("a/b", "x.md"), "../../x.md");
    }

    #[test]
    fn rename_keeps_bare_style_alias_heading_and_embed() {
        let r = run(
            "see [[Old]] and [[Old#Sec|shown]] and ![[Old]] and [[Other]]\n",
            "Home.md",
            "Home.md",
            &["Home.md", "Old.md", "Other.md"],
            "Old.md",
            "New Name.md",
        );
        assert_eq!(
            r.text,
            "see [[New Name]] and [[New Name#Sec|shown]] and ![[New Name]] and [[Other]]\n"
        );
        assert_eq!(r.changed, 3);
        assert_eq!(r.skipped, 0);
    }

    #[test]
    fn move_keeps_bare_links_that_still_resolve_and_rewrites_path_links() {
        let r = run(
            "[[Note]] [[Folder/Note]] [[Folder/Note.md]]\n",
            "Home.md",
            "Home.md",
            &["Home.md", "Folder/Note.md"],
            "Folder/Note.md",
            "Archive/Note.md",
        );
        assert_eq!(r.text, "[[Note]] [[Archive/Note]] [[Archive/Note.md]]\n");
        assert_eq!(r.changed, 2);
    }

    #[test]
    fn ambiguous_bare_name_falls_back_to_the_full_path() {
        // after the move there are two Note.md files, nearest-folder wins for
        // a source in `B`, so a bare link from `Home` would be ambiguous.
        let r = run(
            "[[Note]]\n",
            "Home.md",
            "Home.md",
            &["Home.md", "A/Note.md", "B/Note.md", "C/Z.md"],
            "A/Note.md",
            "C/Note.md",
        );
        // bare name resolves (shortest path, then lexicographic) to B/Note.md
        // after the move, so the link needs the path form.
        assert_eq!(r.text, "[[C/Note]]\n");
    }

    #[test]
    fn markdown_links_are_relative_and_encoded() {
        let r = run(
            "[a](../docs/My%20Note.md#top) ![i](../docs/pic.png) [w](https://x.y/z.md)\n",
            "notes/Src.md",
            "notes/Src.md",
            &["notes/Src.md", "docs/My Note.md", "docs/pic.png"],
            "docs/My Note.md",
            "archive/My Note.md",
        );
        assert_eq!(
            r.text,
            "[a](../archive/My%20Note.md#top) ![i](../docs/pic.png) [w](https://x.y/z.md)\n"
        );
    }

    #[test]
    fn frontmatter_links_are_updated_and_code_is_not() {
        let text = "---\nrel: \"[[Old]]\"\nlist:\n  - \"[[Old|x]]\"\n---\nbody [[Old]] `[[Old]]`\n```\n[[Old]]\n```\n";
        let r = run(
            text,
            "Home.md",
            "Home.md",
            &["Home.md", "Old.md"],
            "Old.md",
            "New.md",
        );
        assert_eq!(
            r.text,
            "---\nrel: \"[[New]]\"\nlist:\n  - \"[[New|x]]\"\n---\nbody [[New]] `[[Old]]`\n```\n[[Old]]\n```\n"
        );
        assert_eq!(r.changed, 3);
    }

    #[test]
    fn the_moved_note_keeps_its_own_relative_links_valid() {
        // Src moves from notes/ to deep/er/; it links to docs/spec.md with a
        // markdown link (relative) and to a sibling with ./
        let before = idx(&["notes/Src.md", "docs/spec.md", "notes/Side.md"]);
        let (old, new) = ("notes/Src.md", "deep/er/Src.md");
        let after = after_of(&before, old, new);
        let text = "[s](../docs/spec.md) [[./Side]] [[docs/spec]] [[Side]]\n";
        let r = rewrite_text(text, old, new, &Move { old, new }, &before, &after);
        assert_eq!(
            r.text,
            "[s](../../docs/spec.md) [[../../notes/Side]] [[docs/spec]] [[Side]]\n"
        );
    }

    #[test]
    fn unrelated_text_is_untouched_byte_for_byte() {
        let text = "\u{feff}---\r\ntitle: x\r\n---\r\nno links here [[Other]]\r\n";
        let r = run(
            text,
            "A.md",
            "A.md",
            &["A.md", "Old.md", "Other.md"],
            "Old.md",
            "New.md",
        );
        assert_eq!(r.text, text);
        assert_eq!(r.changed, 0);
    }

    #[test]
    fn table_pipe_alias_and_nonmarkdown_targets() {
        let r = run(
            "| [[Old\\|al]] | ![[pic.png]] |\n",
            "A.md",
            "A.md",
            &["A.md", "Old.md", "img/pic.png"],
            "img/pic.png",
            "img/photo.png",
        );
        assert_eq!(r.text, "| [[Old\\|al]] | ![[photo.png]] |\n");
    }
}
