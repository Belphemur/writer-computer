//! Single-pass markdown body scanner: links, tags, tasks, headings, counts.
//!
//! Scope notes (deliberate simplifications, kept explicit):
//! - Fenced code blocks (``` and ~~~) and single-line inline code spans are
//!   skipped for links, tags, tasks and headings. Multi-line code spans and
//!   indented code blocks are not recognised.
//! - Only ATX headings (`# Title`) are recognised, not setext underlines.
//! - `%%comments%%`, `$$math$$` and HTML comments are not special-cased.
//! - Tags: `#` must start the line or follow whitespace or one of `([{,;:"'`,
//!   the tag body is Unicode alphanumerics plus `_ - /`, and must contain at
//!   least one non-digit (`#1984` is not a tag). Tags are stored lowercased
//!   (Obsidian matches tags case-insensitively), and a nested tag `a/b/c` also
//!   yields the ancestors `a` and `a/b`.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkKind {
    Wikilink,
    Embed,
    Markdown,
    MarkdownEmbed,
}

impl LinkKind {
    pub fn as_str(self) -> &'static str {
        match self {
            LinkKind::Wikilink => "wikilink",
            LinkKind::Embed => "embed",
            LinkKind::Markdown => "markdown",
            LinkKind::MarkdownEmbed => "markdown_embed",
        }
    }

    /// Whether the link embeds its target (`![[x]]`, `![](x)`).
    pub fn is_embed(self) -> bool {
        matches!(self, LinkKind::Embed | LinkKind::MarkdownEmbed)
    }

    /// Whether it was written as a markdown link (`[t](x)`) rather than a wikilink.
    pub fn is_markdown(self) -> bool {
        matches!(self, LinkKind::Markdown | LinkKind::MarkdownEmbed)
    }

    /// Inverse of ([`Self::is_embed`], [`Self::is_markdown`]).
    pub fn from_parts(embed: bool, markdown: bool) -> Self {
        match (embed, markdown) {
            (false, false) => LinkKind::Wikilink,
            (true, false) => LinkKind::Embed,
            (false, true) => LinkKind::Markdown,
            (true, true) => LinkKind::MarkdownEmbed,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedLink {
    /// Target path text as written, without display or subpath (decoded for
    /// markdown links). Empty for same-file links like `[[#Heading]]`.
    pub raw: String,
    pub kind: LinkKind,
    pub display: Option<String>,
    pub subpath: Option<String>,
    /// Byte span of the whole link in the scanned text.
    pub span: (usize, usize),
}

/// A body link with where it sits: the 1-based file line and the text of the nearest heading at
/// or above it (None before the first heading), untruncated.
#[derive(Debug, Clone, PartialEq)]
pub struct LocatedLink {
    pub link: ParsedLink,
    pub line: u32,
    pub section: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TaskItem {
    pub line: u32,
    pub status: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Heading {
    pub level: u8,
    pub text: String,
    pub line: u32,
}

#[derive(Debug, Default)]
pub struct BodyScan {
    pub links: Vec<LocatedLink>,
    /// Normalised (lowercase) tags exactly as written; ancestors are added by
    /// [`with_ancestors`].
    pub tags: Vec<String>,
    pub tasks: Vec<TaskItem>,
    pub headings: Vec<Heading>,
    pub words: u32,
    pub chars: u32,
}

/// Lowercase and validate a raw tag (leading `#` optional). `None` if it is
/// not a valid tag.
pub fn normalize_tag(raw: &str) -> Option<String> {
    let t = raw.trim().trim_start_matches('#').trim_end_matches('/');
    if t.is_empty() || t.starts_with('/') || t.contains("//") {
        return None;
    }
    if !t.chars().all(is_tag_char) || !t.chars().any(|c| !c.is_ascii_digit()) {
        return None;
    }
    Some(t.to_lowercase())
}

fn is_tag_char(c: char) -> bool {
    c.is_alphanumeric() || matches!(c, '_' | '-' | '/')
}

/// `a/b/c` -> `a`, `a/b`, `a/b/c`.
pub fn with_ancestors(tag: &str) -> Vec<String> {
    let mut out = Vec::new();
    for (i, c) in tag.char_indices() {
        if c == '/' {
            out.push(tag[..i].to_string());
        }
    }
    out.push(tag.to_string());
    out
}

pub(crate) fn percent_decode(s: &str) -> String {
    if !s.contains('%') {
        return s.to_string();
    }
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let hex = std::str::from_utf8(&b[i + 1..i + 3]).ok();
            if let Some(v) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| s.to_string())
}

fn has_scheme(s: &str) -> bool {
    let Some(colon) = s.find(':') else {
        return false;
    };
    let scheme = &s[..colon];
    // Single letter: a Windows drive, not a URL scheme.
    scheme.len() > 1
        && scheme
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic())
        && scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
}

fn parse_wikilink(inner: &str, embed: bool, span: (usize, usize)) -> Option<ParsedLink> {
    // `\|` is how a pipe is written inside a table cell.
    let inner = inner.replace("\\|", "|");
    let (target, display) = match inner.split_once('|') {
        Some((t, d)) => (t, Some(d.trim().to_string()).filter(|d| !d.is_empty())),
        None => (inner.as_str(), None),
    };
    let (path, subpath) = match target.split_once('#') {
        Some((p, s)) => (p, Some(s.trim().to_string()).filter(|s| !s.is_empty())),
        None => (target, None),
    };
    let path = path.trim();
    if path.is_empty() && subpath.is_none() {
        return None;
    }
    Some(ParsedLink {
        raw: path.to_string(),
        kind: if embed {
            LinkKind::Embed
        } else {
            LinkKind::Wikilink
        },
        display,
        subpath,
        span,
    })
}

/// Find all wikilinks, embeds and markdown links in `text` (a line or a
/// frontmatter string). Code spans are NOT masked here; callers mask first.
pub fn scan_links(text: &str) -> Vec<ParsedLink> {
    let b = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'\\' {
            i += 2;
            continue;
        }
        if b[i] != b'[' {
            i += 1;
            continue;
        }
        let embed = i > 0 && b[i - 1] == b'!';
        let start = if embed { i - 1 } else { i };
        if b.get(i + 1) == Some(&b'[') {
            if let Some(rel) = text[i + 2..].find("]]") {
                let end = i + 2 + rel + 2;
                let inner = &text[i + 2..i + 2 + rel];
                if !inner.contains("[[") {
                    if let Some(link) = parse_wikilink(inner, embed, (start, end)) {
                        out.push(link);
                    }
                    i = end;
                    continue;
                }
            }
            i += 2;
            continue;
        }
        // Markdown link: [text](dest)
        let Some(close) = find_matching_bracket(b, i) else {
            i += 1;
            continue;
        };
        if b.get(close + 1) != Some(&b'(') {
            i += 1;
            continue;
        }
        let label = &text[i + 1..close];
        if label.starts_with('^') {
            i = close + 1;
            continue;
        }
        if let Some((dest, end)) = parse_destination(text, close + 2) {
            if !dest.is_empty() && !has_scheme(&dest) && !dest.starts_with("//") {
                let decoded = percent_decode(&dest);
                let (path, subpath) = match decoded.split_once('#') {
                    Some((p, s)) => (p.to_string(), Some(s.to_string()).filter(|s| !s.is_empty())),
                    None => (decoded, None),
                };
                out.push(ParsedLink {
                    raw: path.trim().to_string(),
                    kind: if embed {
                        LinkKind::MarkdownEmbed
                    } else {
                        LinkKind::Markdown
                    },
                    display: Some(label.trim().to_string()).filter(|d| !d.is_empty()),
                    subpath,
                    span: (start, end),
                });
            }
            i = end;
            continue;
        }
        i += 1;
    }
    out
}

fn find_matching_bracket(b: &[u8], open: usize) -> Option<usize> {
    let mut depth = 0usize;
    let mut i = open;
    while i < b.len() {
        match b[i] {
            b'\\' => i += 1,
            b'[' => depth += 1,
            b']' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// Parse `dest` or `<dest with spaces>` optionally followed by a title, up to
/// the closing `)`. Returns the destination and the byte index after `)`.
fn parse_destination(text: &str, from: usize) -> Option<(String, usize)> {
    let b = text.as_bytes();
    let mut i = from;
    let dest;
    if b.get(i) == Some(&b'<') {
        let rel = text[i + 1..].find('>')?;
        dest = text[i + 1..i + 1 + rel].to_string();
        i = i + 1 + rel + 1;
    } else {
        let start = i;
        let mut depth = 0usize;
        while i < b.len() {
            match b[i] {
                b'\\' => i += 1,
                b'(' => depth += 1,
                b')' => {
                    if depth == 0 {
                        break;
                    }
                    depth -= 1;
                }
                c if c.is_ascii_whitespace() => break,
                _ => {}
            }
            i += 1;
        }
        dest = text.get(start..i)?.to_string();
    }
    // Optional title, then the closing paren.
    let rest = text.get(i..)?;
    let close = rest.find(')')?;
    let between = rest[..close].trim();
    let is_title = between.is_empty()
        || ((between.starts_with('"') || between.starts_with('\''))
            && between.len() >= 2
            && between.ends_with(between.chars().next()?));
    if !is_title {
        return None;
    }
    Some((dest, i + close + 1))
}

/// Replace inline code spans (same-line backtick runs) with spaces, keeping
/// byte offsets stable.
pub(crate) fn mask_code_spans(line: &str) -> String {
    if !line.contains('`') {
        return line.to_string();
    }
    let b = line.as_bytes();
    let mut out = b.to_vec();
    let mut i = 0;
    while i < b.len() {
        if b[i] != b'`' {
            i += 1;
            continue;
        }
        let start = i;
        while i < b.len() && b[i] == b'`' {
            i += 1;
        }
        let run = i - start;
        let mut j = i;
        let mut closed = None;
        while j < b.len() {
            if b[j] == b'`' {
                let s = j;
                while j < b.len() && b[j] == b'`' {
                    j += 1;
                }
                if j - s == run {
                    closed = Some(j);
                    break;
                }
            } else {
                j += 1;
            }
        }
        if let Some(end) = closed {
            for byte in &mut out[start..end] {
                *byte = b' ';
            }
            i = end;
        }
    }
    String::from_utf8(out).unwrap_or_else(|_| line.to_string())
}

fn mask_ranges(line: &str, ranges: &[(usize, usize)]) -> String {
    let mut out = line.as_bytes().to_vec();
    for &(s, e) in ranges {
        for byte in &mut out[s..e.min(line.len())] {
            *byte = b' ';
        }
    }
    String::from_utf8(out).unwrap_or_else(|_| line.to_string())
}

fn mask_urls(line: &str) -> String {
    let mut ranges = Vec::new();
    let mut from = 0;
    while let Some(pos) = line[from..].find("://") {
        let at = from + pos;
        let start = line[..at]
            .rfind(|c: char| !c.is_ascii_alphanumeric() && !matches!(c, '+' | '.' | '-'))
            .map_or(0, |p| p + 1);
        let end = line[at..]
            .find(char::is_whitespace)
            .map_or(line.len(), |p| at + p);
        ranges.push((start, end));
        from = end.max(at + 3);
    }
    if ranges.is_empty() {
        line.to_string()
    } else {
        mask_ranges(line, &ranges)
    }
}

fn scan_tags(line: &str, links: &[ParsedLink], out: &mut Vec<String>) {
    if !line.contains('#') {
        return;
    }
    // Blank wikilinks entirely and markdown destinations, then bare URLs.
    let mut ranges = Vec::new();
    for l in links {
        match l.kind {
            LinkKind::Wikilink | LinkKind::Embed => ranges.push(l.span),
            LinkKind::Markdown | LinkKind::MarkdownEmbed => {
                if let Some(p) = line[l.span.0..l.span.1].rfind("](") {
                    ranges.push((l.span.0 + p + 1, l.span.1));
                }
            }
        }
    }
    let masked = mask_urls(&mask_ranges(line, &ranges));
    let mut prev: Option<char> = None;
    let mut chars = masked.char_indices().peekable();
    while let Some((idx, c)) = chars.next() {
        if c == '#' && prev.is_none_or(|p| p.is_whitespace() || "([{,;:\"'".contains(p)) {
            let rest = &masked[idx + 1..];
            let len = rest
                .char_indices()
                .find(|(_, ch)| !is_tag_char(*ch))
                .map_or(rest.len(), |(p, _)| p);
            if let Some(tag) = normalize_tag(&rest[..len]) {
                out.push(tag);
            }
            // Skip over the consumed tag body.
            let consumed_to = idx + 1 + len;
            while chars.peek().is_some_and(|(p, _)| *p < consumed_to) {
                chars.next();
            }
            prev = rest[..len].chars().last().or(Some('#'));
            continue;
        }
        prev = Some(c);
    }
}

pub(crate) fn fence_open(line: &str) -> Option<(char, usize)> {
    let t = line.trim_start();
    let ch = t.chars().next()?;
    if ch != '`' && ch != '~' {
        return None;
    }
    let run = t.chars().take_while(|c| *c == ch).count();
    if run < 3 {
        return None;
    }
    // Backtick fence info strings cannot contain backticks.
    if ch == '`' && t[run..].contains('`') {
        return None;
    }
    Some((ch, run))
}

pub(crate) fn fence_closes(line: &str, ch: char, len: usize) -> bool {
    let t = line.trim();
    let run = t.chars().take_while(|c| *c == ch).count();
    run >= len && t[run * ch.len_utf8()..].trim().is_empty()
}

pub(crate) fn heading(line: &str, line_no: u32) -> Option<Heading> {
    let indent = line.len() - line.trim_start_matches(' ').len();
    if indent > 3 {
        return None;
    }
    let t = &line[indent..];
    let level = t.chars().take_while(|c| *c == '#').count();
    if !(1..=6).contains(&level) {
        return None;
    }
    let rest = &t[level..];
    if !rest.is_empty() && !rest.starts_with([' ', '\t']) {
        return None;
    }
    let mut text = rest.trim();
    let stripped = text.trim_end_matches('#');
    if stripped.len() != text.len() && (stripped.is_empty() || stripped.ends_with([' ', '\t'])) {
        text = stripped.trim_end();
    }
    Some(Heading {
        level: level as u8,
        text: text.to_string(),
        line: line_no,
    })
}

pub(crate) fn task(line: &str, line_no: u32) -> Option<TaskItem> {
    let mut t = line.trim_start();
    while let Some(rest) = t.strip_prefix('>') {
        t = rest.trim_start();
    }
    let t = if let Some(rest) = t.strip_prefix(['-', '*', '+']) {
        rest
    } else {
        let digits = t.chars().take_while(char::is_ascii_digit).count();
        if digits == 0 || digits > 9 {
            return None;
        }
        t[digits..].strip_prefix(['.', ')'])?
    };
    let t = t.strip_prefix([' ', '\t'])?.trim_start();
    let inner = t.strip_prefix('[')?;
    let mut it = inner.chars();
    let status = it.next()?;
    if it.next()? != ']' {
        return None;
    }
    let rest = &inner[status.len_utf8() + 1..];
    if !rest.is_empty() && !rest.starts_with([' ', '\t']) {
        return None;
    }
    Some(TaskItem {
        line: line_no,
        status: status.to_string(),
        text: rest.trim().to_string(),
    })
}

fn count_words(line: &str) -> u32 {
    line.split_whitespace()
        .filter(|w| w.chars().any(char::is_alphanumeric))
        .count() as u32
}

/// Scan a markdown body. `first_line` is the 1-based line number of its first
/// line in the original file.
pub fn scan_body(body: &str, first_line: u32) -> BodyScan {
    let mut scan = BodyScan::default();
    let mut fence: Option<(char, usize)> = None;
    let mut section: Option<String> = None;
    for (i, raw_line) in body.split('\n').enumerate() {
        let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
        let line_no = first_line + i as u32;
        scan.words += count_words(line);
        scan.chars += line.chars().count() as u32;
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
        if let Some(h) = heading(line, line_no) {
            section = Some(h.text.clone());
            scan.headings.push(h);
        }
        if let Some(t) = task(line, line_no) {
            scan.tasks.push(t);
        }
        let masked = mask_code_spans(line);
        let links = scan_links(&masked);
        scan_tags(&masked, &links, &mut scan.tags);
        scan.links.extend(links.into_iter().map(|link| LocatedLink {
            link,
            line: line_no,
            section: section.clone(),
        }));
    }
    scan
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raws(s: &str) -> Vec<(String, LinkKind, Option<String>, Option<String>)> {
        scan_links(s)
            .into_iter()
            .map(|l| (l.raw, l.kind, l.display, l.subpath))
            .collect()
    }

    #[test]
    fn wikilinks_embeds_and_markdown() {
        let r = raws("a [[Note#Head|Shown]] b ![[img.png]] c [t](dir/My%20Note.md#sec) d ![alt](pic.png) [[#Same]] [e](https://x.y) [f](mailto:a@b.c)");
        assert_eq!(r.len(), 5);
        assert_eq!(
            r[0],
            (
                "Note".into(),
                LinkKind::Wikilink,
                Some("Shown".into()),
                Some("Head".into())
            )
        );
        assert_eq!(r[1].1, LinkKind::Embed);
        assert_eq!(
            r[2],
            (
                "dir/My Note.md".into(),
                LinkKind::Markdown,
                Some("t".into()),
                Some("sec".into())
            )
        );
        assert_eq!(r[3].1, LinkKind::MarkdownEmbed);
        assert_eq!(
            r[4],
            ("".into(), LinkKind::Wikilink, None, Some("Same".into()))
        );
    }

    #[test]
    fn table_pipe_escape() {
        let r = raws(r"| [[A\|alias]] |");
        assert_eq!(r[0].0, "A");
        assert_eq!(r[0].2.as_deref(), Some("alias"));
    }

    #[test]
    fn tags_rules() {
        let s = scan_body(
            "# Heading\ntext #Alpha and #beta/Gamma, (#delta) #1984 C#sharp [[n#frag]] [l](#anchor) https://x.y/#nope `#code`\n```\n#fenced [[no]]\n```\n#top\n",
            1,
        );
        assert_eq!(s.tags, vec!["alpha", "beta/gamma", "delta", "top"]);
        assert_eq!(s.links.len(), 2); // [[n#frag]] and [l](#anchor); fenced/code excluded
        assert_eq!(s.headings.len(), 1);
    }

    #[test]
    fn ancestors_and_normalise() {
        assert_eq!(with_ancestors("a/b/c"), vec!["a", "a/b", "a/b/c"]);
        assert_eq!(normalize_tag("#Foo/"), Some("foo".into()));
        assert_eq!(normalize_tag("123"), None);
        assert_eq!(normalize_tag("a//b"), None);
    }

    #[test]
    fn tasks_headings_counts() {
        let s = scan_body(
            "## Plan ##\n- [ ] one\n  * [x] two\n1. [/] three\n- [] no\n> - [-] quoted\n- [ ]no\nplain words here\n",
            10,
        );
        let t: Vec<_> = s
            .tasks
            .iter()
            .map(|t| (t.line, t.status.as_str(), t.text.as_str()))
            .collect();
        assert_eq!(
            t,
            vec![
                (11, " ", "one"),
                (12, "x", "two"),
                (13, "/", "three"),
                (15, "-", "quoted")
            ]
        );
        assert_eq!(
            s.headings[0],
            Heading {
                level: 2,
                text: "Plan".into(),
                line: 10
            }
        );
        assert!(s.words >= 8);
    }

    #[test]
    fn crlf_lines() {
        let s = scan_body("# A\r\n- [ ] t\r\n#tag\r\n", 1);
        assert_eq!(s.tasks[0].text, "t");
        assert_eq!(s.tags, vec!["tag"]);
        assert_eq!(s.headings[0].text, "A");
    }
}
