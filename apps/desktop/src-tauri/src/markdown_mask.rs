//! The one Markdown scanner: which characters of a note are prose a checker may look at, and
//! how the note splits into blocks (ADR 2026-11-18, point 4). Both providers consume it: Harper
//! through a `Masker` over a block's allowed ranges, the Hunspell provider by tokenizing only
//! inside them.
//!
//! Masked, never checked: front matter, fenced and indented code, math blocks and inline math,
//! inline code, HTML blocks and tags, `<!-- -->` and `%%` comments, URLs and e-mail addresses,
//! `[[wiki links]]` and `![[embeds]]`, the destination part of a Markdown link (its text is
//! prose), footnote and reference definitions, `#tags`, block ids, list, quote and heading
//! markers, callout headers, table rules, emphasis delimiters and character entities.
//!
//! The same scan also reports where the Obsidian-only syntax sits ([`obsidian_syntax`]): front
//! matter, wiki links and embeds, callout header lines, block ids and `%%` comments. The spellcheck
//! reads the prose, the Markdown linter (`crate::lint`) keeps its findings and fixes off that syntax;
//! there is no second scanner.
//!
//! Everything is in `char` offsets, so a masked range maps back to the note exactly. The scan is
//! line based and forgiving: an unclosed construct masks nothing past its line or block, so a
//! stray backtick never hides a page.

use std::ops::Range;

/// A run of prose: one paragraph, heading, list item, quote paragraph or table row. `start..end`
/// are `char` offsets in the document; `allowed` ranges are relative to `start`, sorted and
/// disjoint. A block with nothing left to check is never returned.
#[derive(Debug, Clone, PartialEq)]
pub struct Block {
    pub start: usize,
    pub end: usize,
    pub allowed: Vec<Range<usize>>,
}

impl Block {
    /// The block's source text.
    pub fn text(&self, chars: &[char]) -> String {
        chars[self.start..self.end].iter().collect()
    }

    /// The allowed text only, masked parts dropped (what language detection reads).
    pub fn prose(&self, chars: &[char]) -> String {
        let src = &chars[self.start..self.end];
        self.allowed
            .iter()
            .flat_map(|r| src[r.clone()].iter())
            .collect()
    }
}

/// The note's blocks, in order.
pub fn blocks(chars: &[char]) -> Vec<Block> {
    scan(chars).blocks
}

/// The `char` ranges of the Obsidian-only syntax, sorted and merged: front matter, `[[wiki
/// links]]` and `![[embeds]]`, callout header lines (`> [!note]+ Title`), block ids (`^abc`) and
/// `%%` comments. Inside code (a fence, a span) such text is code, not syntax, and is not listed.
pub fn obsidian_syntax(chars: &[char]) -> Vec<Range<usize>> {
    let mut ranges = scan(chars).syntax;
    ranges.sort_by_key(|r| (r.start, r.end));
    let mut merged: Vec<Range<usize>> = Vec::new();
    for r in ranges {
        match merged.last_mut() {
            Some(last) if r.start <= last.end => last.end = last.end.max(r.end),
            _ => merged.push(r),
        }
    }
    merged
}

/// What one pass over the note finds.
struct Scan {
    blocks: Vec<Block>,
    syntax: Vec<Range<usize>>,
}

fn scan(chars: &[char]) -> Scan {
    let mut syntax: Vec<Range<usize>> = Vec::new();
    let lines = split_lines(chars);
    let mut masked = vec![false; chars.len()];
    let mut out: Vec<Block> = Vec::new();
    let mut open: Option<(usize, usize)> = None; // (first line, last line) of the open block
    let mut open_is_quote = false;

    let mut i = 0;
    // Front matter: the first line is `---` and a later line is `---` or `...`.
    if lines.first().is_some_and(|l| trimmed(chars, l) == "---") {
        if let Some(close) =
            (1..lines.len()).find(|&k| matches!(trimmed(chars, &lines[k]).as_str(), "---" | "..."))
        {
            mask_range(&mut masked, lines[0].start..lines[close].end);
            syntax.push(lines[0].start..lines[close].end);
            i = close + 1;
        }
    }

    let mut list_context = false;
    let mut prev_blank = true;
    let flush = |open: &mut Option<(usize, usize)>,
                 out: &mut Vec<Block>,
                 masked: &mut Vec<bool>,
                 syntax: &mut Vec<Range<usize>>| {
        if let Some((a, b)) = open.take() {
            finish_block(chars, masked, lines[a].start, lines[b].end, out, syntax);
        }
    };

    while i < lines.len() {
        let line = &lines[i];
        let text = line_text(chars, line);
        let trim = text.trim();
        if trim.is_empty() {
            flush(&mut open, &mut out, &mut masked, &mut syntax);
            prev_blank = true;
            i += 1;
            continue;
        }
        let indent = leading_columns(&text);

        // Fenced code.
        if let Some((fence_char, n)) = fence_open(&text) {
            flush(&mut open, &mut out, &mut masked, &mut syntax);
            let close = (i + 1..lines.len())
                .find(|&k| fence_closes(&line_text(chars, &lines[k]), fence_char, n));
            let last = close.unwrap_or(lines.len() - 1);
            mask_range(&mut masked, line.start..lines[last].end);
            i = last + 1;
            prev_blank = false;
            continue;
        }
        // Math block `$$ ... $$`.
        if trim.starts_with("$$") {
            flush(&mut open, &mut out, &mut masked, &mut syntax);
            let single = trim.len() > 2 && trim.ends_with("$$");
            let last = if single {
                i
            } else {
                (i + 1..lines.len())
                    .find(|&k| line_text(chars, &lines[k]).contains("$$"))
                    .unwrap_or(lines.len() - 1)
            };
            mask_range(&mut masked, line.start..lines[last].end);
            i = last + 1;
            prev_blank = false;
            continue;
        }
        // Multi-line comments: `<!-- ... -->` and `%% ... %%`.
        if let Some(last) = comment_end(chars, &lines, i, trim) {
            flush(&mut open, &mut out, &mut masked, &mut syntax);
            mask_range(&mut masked, line.start..lines[last].end);
            if trim.starts_with("%%") {
                syntax.push(line.start..lines[last].end);
            }
            i = last + 1;
            prev_blank = false;
            continue;
        }
        // HTML block (a block-level tag line) ends at the next blank line.
        if indent < 4 && is_html_block_start(trim) {
            flush(&mut open, &mut out, &mut masked, &mut syntax);
            let mut last = i;
            while last + 1 < lines.len() && !line_text(chars, &lines[last + 1]).trim().is_empty() {
                last += 1;
            }
            mask_range(&mut masked, line.start..lines[last].end);
            i = last + 1;
            prev_blank = false;
            continue;
        }
        // Indented code: four columns after a blank line, outside a list.
        if indent >= 4 && prev_blank && !list_context && open.is_none() {
            let mut last = i;
            while last + 1 < lines.len() {
                let t = line_text(chars, &lines[last + 1]);
                if t.trim().is_empty() {
                    // blank lines stay in the block only when more indented code follows
                    match (last + 2 < lines.len())
                        .then(|| line_text(chars, &lines[last + 2]))
                        .filter(|n| leading_columns(n) >= 4 && !n.trim().is_empty())
                    {
                        Some(_) => last += 1,
                        None => break,
                    }
                } else if leading_columns(&t) >= 4 {
                    last += 1;
                } else {
                    break;
                }
            }
            mask_range(&mut masked, line.start..lines[last].end);
            i = last + 1;
            prev_blank = false;
            continue;
        }
        // Everything below is text: classify the line, then extend or start a block.
        let kind = classify(&text, indent);
        match kind {
            LineKind::Rule | LineKind::SetextUnderline => {
                // a thematic break or the underline of a heading; the text above stays a block
                flush(&mut open, &mut out, &mut masked, &mut syntax);
                mask_range(&mut masked, line.start..line.end);
                list_context = false;
            }
            LineKind::LinkDefinition => {
                flush(&mut open, &mut out, &mut masked, &mut syntax);
                mask_range(&mut masked, line.start..line.end);
            }
            LineKind::Heading(prefix) => {
                flush(&mut open, &mut out, &mut masked, &mut syntax);
                mask_range(&mut masked, line.start..line.start + prefix);
                // a closing run of `#` is part of the marker
                let mut e = line.end;
                while e > line.start + prefix && chars[e - 1] == ' ' {
                    e -= 1;
                }
                let hashes = (line.start + prefix..e)
                    .rev()
                    .take_while(|&k| chars[k] == '#')
                    .count();
                if hashes > 0 && e - hashes > line.start + prefix && chars[e - hashes - 1] == ' ' {
                    mask_range(&mut masked, e - hashes..e);
                }
                open = Some((i, i));
                flush(&mut open, &mut out, &mut masked, &mut syntax);
                list_context = false;
            }
            LineKind::ListItem(prefix) | LineKind::Quote(prefix) | LineKind::QuoteStart(prefix) => {
                let continues_quote =
                    matches!(kind, LineKind::Quote(_)) && open.is_some() && open_is_quote;
                if !continues_quote {
                    flush(&mut open, &mut out, &mut masked, &mut syntax);
                    open_is_quote = !matches!(kind, LineKind::ListItem(_));
                }
                mask_range(&mut masked, line.start..line.start + prefix);
                if matches!(kind, LineKind::QuoteStart(_)) {
                    // the callout header `[!note]` and its fold marker `+` or `-`
                    let at = line.start + prefix;
                    let skip = (at..line.end).take_while(|&k| chars[k] == ' ').count();
                    if chars.get(at + skip) == Some(&'[') {
                        if chars.get(at + skip + 1) == Some(&'!') {
                            syntax.push(line.start..line.end);
                        }
                        if let Some(close) = (at + skip..line.end).find(|&k| chars[k] == ']') {
                            let end = close
                                + 1
                                + usize::from(matches!(chars.get(close + 1), Some('+' | '-')));
                            mask_range(&mut masked, at + skip..end);
                        }
                    }
                }
                match &mut open {
                    Some((_, last)) if continues_quote => *last = i,
                    _ => open = Some((i, i)),
                }
                if matches!(kind, LineKind::ListItem(_)) {
                    list_context = true;
                }
            }
            LineKind::TableRow => {
                // every cell is its own run of prose; the pipes and the rule row are markup
                flush(&mut open, &mut out, &mut masked, &mut syntax);
                for k in line.start..line.end {
                    if chars[k] == '|' {
                        masked[k] = true;
                    }
                }
                open = Some((i, i));
                flush(&mut open, &mut out, &mut masked, &mut syntax);
            }
            LineKind::Text => {
                // the indentation of a continuation line is not prose
                let indent_chars = (line.start..line.end)
                    .take_while(|&k| chars[k] == ' ' || chars[k] == '\t')
                    .count();
                mask_range(&mut masked, line.start..line.start + indent_chars);
                match &mut open {
                    Some((_, last)) => *last = i,
                    None => open = Some((i, i)),
                }
                if indent == 0 {
                    list_context = false;
                }
            }
        }
        prev_blank = false;
        i += 1;
    }
    flush(&mut open, &mut out, &mut masked, &mut syntax);
    Scan {
        blocks: out,
        syntax,
    }
}

struct Line {
    start: usize,
    /// End without the line break (and without a `\r` before it).
    end: usize,
}

fn split_lines(chars: &[char]) -> Vec<Line> {
    let mut lines = Vec::new();
    let mut start = 0;
    for (i, c) in chars.iter().enumerate() {
        if *c == '\n' {
            let end = if i > start && chars[i - 1] == '\r' {
                i - 1
            } else {
                i
            };
            lines.push(Line { start, end });
            start = i + 1;
        }
    }
    if start < chars.len() {
        lines.push(Line {
            start,
            end: chars.len(),
        });
    }
    lines
}

fn line_text(chars: &[char], l: &Line) -> String {
    chars[l.start..l.end].iter().collect()
}

fn trimmed(chars: &[char], l: &Line) -> String {
    line_text(chars, l).trim_end().to_string()
}

/// Leading width of a line, a tab counting as four columns.
fn leading_columns(s: &str) -> usize {
    let mut n = 0;
    for c in s.chars() {
        match c {
            ' ' => n += 1,
            '\t' => n += 4,
            _ => break,
        }
    }
    n
}

fn mask_range(masked: &mut [bool], r: Range<usize>) {
    for m in &mut masked[r] {
        *m = true;
    }
}

/// The last line of a comment that opens on line `i` and does not close on it, or `None` when
/// the line starts no multi-line comment. An unclosed comment runs to the end of the note.
fn comment_end(chars: &[char], lines: &[Line], i: usize, trim: &str) -> Option<usize> {
    [("<!--", "-->"), ("%%", "%%")]
        .iter()
        .find_map(|(open, close)| {
            (trim.starts_with(open) && !trim[open.len()..].contains(close)).then(|| {
                (i + 1..lines.len())
                    .find(|&k| line_text(chars, &lines[k]).contains(close))
                    .unwrap_or(lines.len() - 1)
            })
        })
}

fn fence_open(line: &str) -> Option<(char, usize)> {
    if leading_columns(line) > 3 + 8 {
        return None; // far too indented to be a fence: indented code containing backticks
    }
    let t = line.trim_start();
    let c = t.chars().next()?;
    if c != '`' && c != '~' {
        return None;
    }
    let n = t.chars().take_while(|&x| x == c).count();
    if n < 3 {
        return None;
    }
    // an info string of a backtick fence cannot contain a backtick (else it is inline code)
    if c == '`' && t.chars().skip(n).any(|x| x == '`') {
        return None;
    }
    Some((c, n))
}

fn fence_closes(line: &str, c: char, n: usize) -> bool {
    let t = line.trim();
    t.chars().count() >= n && t.chars().all(|x| x == c)
}

const BLOCK_TAGS: &[&str] = &[
    "address",
    "article",
    "aside",
    "blockquote",
    "body",
    "center",
    "dd",
    "details",
    "dialog",
    "div",
    "dl",
    "dt",
    "fieldset",
    "figcaption",
    "figure",
    "footer",
    "form",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "header",
    "hr",
    "html",
    "iframe",
    "li",
    "main",
    "nav",
    "ol",
    "p",
    "pre",
    "script",
    "section",
    "style",
    "summary",
    "table",
    "tbody",
    "td",
    "tfoot",
    "th",
    "thead",
    "tr",
    "ul",
];

fn is_html_block_start(trim: &str) -> bool {
    if trim.starts_with("<!--") || trim.starts_with("<?") || trim.starts_with("<!") {
        return true;
    }
    let Some(rest) = trim.strip_prefix('<') else {
        return false;
    };
    let rest = rest.strip_prefix('/').unwrap_or(rest);
    let name: String = rest
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_lowercase();
    if name.is_empty() {
        return false;
    }
    if BLOCK_TAGS.contains(&name.as_str()) {
        return true;
    }
    // a line that is one complete tag and nothing else
    trim.ends_with('>') && trim.matches('<').count() == 1
}

enum LineKind {
    Rule,
    SetextUnderline,
    LinkDefinition,
    /// `#` marker width including the space.
    Heading(usize),
    /// Marker width in chars from the line start (indent included).
    ListItem(usize),
    /// A `>` continuation line.
    Quote(usize),
    /// A `>` line that starts a callout or a new quote paragraph.
    QuoteStart(usize),
    TableRow,
    Text,
}

fn classify(line: &str, indent: usize) -> LineKind {
    let chars: Vec<char> = line.chars().collect();
    let first = chars.iter().position(|c| !c.is_whitespace()).unwrap_or(0);
    let t: String = chars[first..].iter().collect();
    let t = t.trim_end();

    // thematic break / setext underline
    let compact: String = t.chars().filter(|c| !c.is_whitespace()).collect();
    if compact.len() >= 3 {
        let c = compact.chars().next().unwrap();
        if matches!(c, '-' | '*' | '_') && compact.chars().all(|x| x == c) {
            return LineKind::Rule;
        }
        if c == '=' && compact.chars().all(|x| x == '=') && t.chars().all(|x| x == '=') {
            return LineKind::SetextUnderline;
        }
    }
    if indent < 4 {
        // ATX heading
        let hashes = t.chars().take_while(|&c| c == '#').count();
        if (1..=6).contains(&hashes) && t.chars().nth(hashes).is_none_or(|c| c == ' ' || c == '\t')
        {
            let mut w = first + hashes;
            while chars.get(w).is_some_and(|c| *c == ' ' || *c == '\t') {
                w += 1;
            }
            return LineKind::Heading(w);
        }
    }
    // blockquote and callout
    if t.starts_with('>') {
        let mut w = first;
        while chars.get(w) == Some(&'>') {
            w += 1;
            if chars.get(w) == Some(&' ') {
                w += 1;
            }
        }
        let rest: String = chars[w..].iter().collect();
        return if rest.trim_start().starts_with("[!") {
            LineKind::QuoteStart(w)
        } else {
            LineKind::Quote(w)
        };
    }
    // list item (also after quote markers is handled by the next pass of inline masking)
    if let Some(w) = list_marker_width(&chars, first) {
        return LineKind::ListItem(w);
    }
    // link reference definition `[id]: url` and footnote definition `[^id]: text`
    if t.starts_with('[') {
        if let Some(close) = t.find("]:") {
            let label = &t[1..close];
            if !label.contains(']') && !label.is_empty() {
                if label.starts_with('^') {
                    // the footnote text is prose; only the label is masked by the inline pass
                } else {
                    return LineKind::LinkDefinition;
                }
            }
        }
    }
    // table rows and their rules
    if t.contains('|') && (t.starts_with('|') || t.ends_with('|')) {
        return LineKind::TableRow;
    }
    LineKind::Text
}

/// Width (from line start) of a list marker and the whitespace after it, plus a task box.
fn list_marker_width(chars: &[char], first: usize) -> Option<usize> {
    let c = *chars.get(first)?;
    let mut w = first;
    if matches!(c, '-' | '*' | '+') {
        w += 1;
    } else if c.is_ascii_digit() {
        let digits = chars[first..]
            .iter()
            .take_while(|c| c.is_ascii_digit())
            .count();
        if digits > 9 || !matches!(chars.get(first + digits), Some('.') | Some(')')) {
            return None;
        }
        w = first + digits + 1;
    } else {
        return None;
    }
    if !chars.get(w).is_some_and(|c| *c == ' ' || *c == '\t') {
        return None;
    }
    while chars.get(w).is_some_and(|c| *c == ' ' || *c == '\t') {
        w += 1;
    }
    // task box `[ ]` `[x]`
    if chars.get(w) == Some(&'[')
        && chars.get(w + 2) == Some(&']')
        && chars
            .get(w + 1)
            .is_some_and(|c| *c == ' ' || c.is_ascii_alphanumeric())
        && chars.get(w + 3).is_none_or(|c| *c == ' ')
    {
        w += 3;
        while chars.get(w) == Some(&' ') {
            w += 1;
        }
    }
    Some(w)
}

/// Runs the inline pass over a text block and turns what is left into its allowed ranges.
fn finish_block(
    chars: &[char],
    masked: &mut [bool],
    start: usize,
    end: usize,
    out: &mut Vec<Block>,
    syntax: &mut Vec<Range<usize>>,
) {
    inline_pass(chars, masked, start, end, syntax);
    let mut allowed: Vec<Range<usize>> = Vec::new();
    let mut i = start;
    while i < end {
        if masked[i] {
            i += 1;
            continue;
        }
        let s = i;
        while i < end && !masked[i] {
            i += 1;
        }
        allowed.push(s - start..i - start);
    }
    // a block of only whitespace and punctuation has nothing to check
    if allowed.iter().all(|r| {
        chars[start + r.start..start + r.end]
            .iter()
            .all(|c| !c.is_alphabetic())
    }) {
        return;
    }
    out.push(Block {
        start,
        end,
        allowed,
    });
}

fn is_word_char(c: char) -> bool {
    c.is_alphanumeric()
}

/// Masks the inline constructs of one block. `masked` already holds the block's line prefixes.
fn inline_pass(
    chars: &[char],
    masked: &mut [bool],
    start: usize,
    end: usize,
    syntax: &mut Vec<Range<usize>>,
) {
    let line_end =
        |from: usize| -> usize { (from..end).find(|&k| chars[k] == '\n').unwrap_or(end) };
    let find_seq = |from: usize, limit: usize, seq: &[char]| -> Option<usize> {
        (from..limit.saturating_sub(seq.len() - 1)).find(|&k| &chars[k..k + seq.len()] == seq)
    };
    // open `[` positions (and whether an `!` precedes) for link text
    let mut brackets: Vec<usize> = Vec::new();
    let mut i = start;
    while i < end {
        if masked[i] {
            i += 1;
            continue;
        }
        let c = chars[i];
        let prev = if i > start { Some(chars[i - 1]) } else { None };
        let next = chars.get(i + 1).copied().filter(|_| i + 1 < end);
        match c {
            '\\' => {
                i += 2; // an escaped character is text
                continue;
            }
            '`' => {
                let n = chars[i..end].iter().take_while(|&&x| x == '`').count();
                let ticks: Vec<char> = vec!['`'; n];
                let mut k = i + n;
                let mut close = None;
                while let Some(p) = find_seq(k, end, &ticks) {
                    let run = chars[p..end].iter().take_while(|&&x| x == '`').count();
                    if run == n {
                        close = Some(p + n);
                        break;
                    }
                    k = p + run;
                }
                match close {
                    Some(e) => {
                        mask_range(masked, i..e);
                        i = e;
                    }
                    None => i += n,
                }
                continue;
            }
            '$' => {
                if next == Some('$') {
                    if let Some(p) = find_seq(i + 2, end, &['$', '$']) {
                        mask_range(masked, i..p + 2);
                        i = p + 2;
                        continue;
                    }
                } else if next.is_some_and(|n| !n.is_whitespace()) {
                    // inline math: closing `$` on the same line, not after a space, not before a digit
                    let le = line_end(i);
                    let close = (i + 2..le).find(|&k| {
                        chars[k] == '$'
                            && !chars[k - 1].is_whitespace()
                            && chars.get(k + 1).is_none_or(|n| !n.is_ascii_digit())
                    });
                    if let Some(p) = close {
                        mask_range(masked, i..p + 1);
                        i = p + 1;
                        continue;
                    }
                }
            }
            '%' if next == Some('%') => {
                if let Some(p) = find_seq(i + 2, end, &['%', '%']) {
                    mask_range(masked, i..p + 2);
                    syntax.push(i..p + 2);
                    i = p + 2;
                    continue;
                }
            }
            '<' => {
                if chars[i..end.min(i + 4)] == ['<', '!', '-', '-'] {
                    if let Some(p) = find_seq(i + 4, end, &['-', '-', '>']) {
                        mask_range(masked, i..p + 3);
                        i = p + 3;
                        continue;
                    }
                }
                // an autolink, an inline tag or a closing tag, on one line
                if next.is_some_and(|n| n.is_ascii_alphabetic() || n == '/' || n == '!') {
                    let le = line_end(i);
                    if let Some(p) = (i + 1..le).find(|&k| chars[k] == '>') {
                        mask_range(masked, i..p + 1);
                        i = p + 1;
                        continue;
                    }
                }
            }
            '&' => {
                let le = line_end(i);
                let semi = (i + 1..le.min(i + 12)).find(|&k| chars[k] == ';');
                if let Some(p) = semi {
                    if p > i + 1
                        && chars[i + 1..p]
                            .iter()
                            .all(|c| c.is_ascii_alphanumeric() || *c == '#')
                    {
                        mask_range(masked, i..p + 1);
                        i = p + 1;
                        continue;
                    }
                }
            }
            '[' => {
                // `[[wiki link]]`, `![[embed]]`, `[^footnote]`
                if next == Some('[') {
                    let le = line_end(i);
                    if let Some(p) = find_seq(i + 2, le, &[']', ']']) {
                        let from = if prev == Some('!') { i - 1 } else { i };
                        mask_range(masked, from..p + 2);
                        syntax.push(from..p + 2);
                        i = p + 2;
                        continue;
                    }
                }
                if next == Some('^') {
                    let le = line_end(i);
                    if let Some(p) = (i + 2..le).find(|&k| chars[k] == ']') {
                        // a footnote definition `[^1]:` at the start of a line takes its colon
                        let definition =
                            (i == start || chars[i - 1] == '\n') && chars.get(p + 1) == Some(&':');
                        let to = p + 1 + usize::from(definition);
                        mask_range(masked, i..to);
                        i = to;
                        continue;
                    }
                }
                brackets.push(i);
            }
            ']' => {
                // `](destination)` or `][reference]` closes a link whose text stays prose
                if let Some(open) = brackets.pop() {
                    let le = line_end(i);
                    let close = match next {
                        Some('(') => (i + 2..le).find(|&k| chars[k] == ')'),
                        Some('[') => (i + 2..le).find(|&k| chars[k] == ']'),
                        _ => None,
                    };
                    if let Some(p) = close {
                        mask_range(masked, i..p + 1);
                        masked[open] = true;
                        if open > start && chars[open - 1] == '!' {
                            masked[open - 1] = true;
                        }
                        i = p + 1;
                        continue;
                    }
                }
            }
            '*' | '~' | '=' => {
                // emphasis, strikethrough and highlight delimiters; a lone `=` or `~` is text
                let n = chars[i..end].iter().take_while(|&&x| x == c).count();
                if c == '*' || n >= 2 {
                    mask_range(masked, i..i + n);
                }
                i += n;
                continue;
            }
            '_' => {
                let n = chars[i..end].iter().take_while(|&&x| x == '_').count();
                let before = prev.is_some_and(is_word_char);
                let after = chars
                    .get(i + n)
                    .copied()
                    .filter(|_| i + n < end)
                    .is_some_and(is_word_char);
                if !(before && after) {
                    mask_range(masked, i..i + n);
                }
                i += n;
                continue;
            }
            '#' => {
                // `#tag`, `#nested/tag`: a hash glued to letters, at a word start
                if prev.is_none_or(|p| !is_word_char(p) && p != '&')
                    && next.is_some_and(|n| n.is_alphanumeric() || n == '_')
                {
                    let mut p = i + 1;
                    while p < end
                        && (chars[p].is_alphanumeric() || matches!(chars[p], '_' | '-' | '/'))
                    {
                        p += 1;
                    }
                    mask_range(masked, i..p);
                    i = p;
                    continue;
                }
            }
            '^' => {
                // a block id at the end of a line: ` ^abc123`
                if prev.is_none_or(|p| p == ' ') {
                    let le = line_end(i);
                    let id = &chars[i + 1..le];
                    if !id.is_empty() && id.iter().all(|c| c.is_ascii_alphanumeric() || *c == '-') {
                        mask_range(masked, i..le);
                        syntax.push(i..le);
                        i = le;
                        continue;
                    }
                }
            }
            _ => {}
        }
        // bare URLs and e-mail addresses
        if (c == 'h' || c == 'w' || c == 'f') && prev.is_none_or(|p| !is_word_char(p)) {
            if let Some(len) = url_len(&chars[i..end]) {
                mask_range(masked, i..i + len);
                i += len;
                continue;
            }
        }
        if c == '@' && i > start && is_word_char(chars[i - 1]) {
            // an e-mail address: widen over the local part and the domain
            let mut s = i;
            while s > start
                && (is_word_char(chars[s - 1]) || matches!(chars[s - 1], '.' | '_' | '-' | '+'))
            {
                s -= 1;
            }
            let mut e = i + 1;
            while e < end && (is_word_char(chars[e]) || matches!(chars[e], '.' | '-')) {
                e += 1;
            }
            while e > i + 1 && chars[e - 1] == '.' {
                e -= 1;
            }
            if e > i + 1 {
                mask_range(masked, s..e);
                i = e;
                continue;
            }
        }
        i += 1;
    }
}

/// Length of a bare URL at the start of `s` (`http://`, `https://`, `ftp://`, `www.`), without
/// the punctuation that ends a sentence, or `None`.
fn url_len(s: &[char]) -> Option<usize> {
    let starts = |p: &str| {
        let p: Vec<char> = p.chars().collect();
        s.len() > p.len()
            && s[..p.len()]
                .iter()
                .zip(&p)
                .all(|(a, b)| a.eq_ignore_ascii_case(b))
    };
    if !(starts("http://") || starts("https://") || starts("ftp://") || starts("www.")) {
        return None;
    }
    let mut n = s
        .iter()
        .take_while(|c| !c.is_whitespace() && !matches!(c, '<' | '>' | '"'))
        .count();
    while n > 0
        && matches!(
            s[n - 1],
            '.' | ',' | ';' | ':' | '!' | '?' | ')' | ']' | '\'' | '*' | '_'
        )
    {
        n -= 1;
    }
    (n > 4).then_some(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chars(s: &str) -> Vec<char> {
        s.chars().collect()
    }

    /// The prose of every block, joined by `|`, so a test reads what survives the mask.
    fn prose(s: &str) -> String {
        let c = chars(s);
        blocks(&c)
            .iter()
            .map(|b| b.prose(&c))
            .collect::<Vec<_>>()
            .join("|")
    }

    #[test]
    fn plain_paragraphs_split_on_blank_lines_and_soft_wraps_stay_together() {
        assert_eq!(
            prose("One two\nthree four.\n\nFive six."),
            "One two\nthree four.|Five six."
        );
    }

    #[test]
    fn front_matter_is_never_checked() {
        assert_eq!(
            prose("---\ntitle: Smth wrong\nlang: fr\n---\nHello there."),
            "Hello there."
        );
        // `---` that never closes is a rule, not front matter
        assert_eq!(prose("---\nHello there."), "Hello there.");
    }

    #[test]
    fn fenced_and_indented_code_and_math_blocks_are_skipped() {
        assert_eq!(
            prose("Before\n\n```rust\nlet speling = 1;\n```\n\nAfter"),
            "Before|After"
        );
        assert_eq!(prose("~~~\nx wrng\n~~~\nAfter"), "After");
        assert_eq!(
            prose("Before\n\n    indented wrng\n\nAfter"),
            "Before|After"
        );
        assert_eq!(prose("Before\n\n$$\nx wrng\n$$\n\nAfter"), "Before|After");
        // an unclosed fence hides the rest of the note, like a renderer would
        assert_eq!(prose("Before\n```\nhidden"), "Before");
    }

    #[test]
    fn a_list_continuation_is_not_indented_code() {
        assert_eq!(
            prose("- item one\n\n    still item one\n"),
            "item one|still item one"
        );
    }

    #[test]
    fn inline_code_math_links_and_embeds_are_masked() {
        let s = "Use `wrng` and $x wrng$ and [[Wiki Wrng|alias]] and ![[Embd.png]] ok";
        assert_eq!(prose(s), "Use  and  and  and  ok");
        assert_eq!(
            prose("See https://exampl.com/a_b, then www.exampl.org/x. Done"),
            "See , then . Done"
        );
        assert_eq!(prose("Mail me@exampl.com now"), "Mail  now");
        assert_eq!(
            prose("A <span class=\"wrng\">text</span> b &nbsp; c"),
            "A text b  c"
        );
    }

    #[test]
    fn a_markdown_link_keeps_its_text_and_drops_the_destination() {
        assert_eq!(
            prose("Read [the guide](https://x.io/wrng) now"),
            "Read the guide now"
        );
        assert_eq!(prose("![alt text](img/wrng.png)"), "alt text");
        assert_eq!(prose("Read [the guide][ref] now"), "Read the guide now");
        assert_eq!(prose("[ref]: https://x.io/wrng"), "");
    }

    #[test]
    fn markers_are_not_prose() {
        assert_eq!(
            prose("# Title here\n\n- item\n- [ ] task\n1. first\n> quoted words"),
            "Title here|item|task|first|quoted words"
        );
        assert_eq!(prose("## Heading ##"), "Heading ");
        assert_eq!(
            prose("> [!note]- Callout title\n> body text"),
            " Callout title\nbody text"
        );
        assert_eq!(
            prose("**bold** and _italic_ and ~~gone~~ and ==mark=="),
            "bold and italic and gone and mark"
        );
        assert_eq!(prose("snake_case stays"), "snake_case stays");
        assert_eq!(prose("Tagged #project/alpha here ^abc123"), "Tagged  here ");
        assert_eq!(
            prose("Note[^1] text\n\n[^1]: The footnote"),
            "Note text| The footnote"
        );
    }

    #[test]
    fn html_blocks_and_comments_are_masked() {
        assert_eq!(prose("<div>\nwrng\n</div>\n\nAfter"), "After");
        assert_eq!(prose("<!-- wrng\nmore -->\nAfter"), "After");
        assert_eq!(prose("Text %%hidden wrng%% more"), "Text  more");
        assert_eq!(prose("%%\nwrng\n%%\nAfter"), "After");
    }

    #[test]
    fn tables_and_rules_do_not_leak_markup() {
        assert_eq!(
            prose("| Name | Role |\n| --- | --- |\n| Ann | Dev |"),
            " Name  Role | Ann  Dev "
        );
        assert_eq!(prose("Above\n\n---\n\nBelow"), "Above|Below");
        assert_eq!(prose("Title\n=====\nBody"), "Title|Body");
    }

    #[test]
    fn offsets_map_back_exactly_with_accents_and_emoji() {
        let s = "Café 😀 `x` fin";
        let c = chars(s);
        let bs = blocks(&c);
        assert_eq!(bs.len(), 1);
        let b = &bs[0];
        assert_eq!(b.start, 0);
        let allowed: Vec<String> = b
            .allowed
            .iter()
            .map(|r| c[b.start + r.start..b.start + r.end].iter().collect())
            .collect();
        assert_eq!(allowed, vec!["Café 😀 ", " fin"]);
    }

    #[test]
    fn crlf_lines_work_like_lf() {
        assert_eq!(
            prose("One two\r\nthree\r\n\r\nFour"),
            "One two\r\nthree|Four"
        );
    }

    #[test]
    fn a_stray_backtick_or_dollar_masks_nothing_past_its_block() {
        assert_eq!(
            prose("It costs $5 and `tick\n\nNext one"),
            "It costs $5 and `tick|Next one"
        );
    }

    /// The text of every Obsidian-syntax range, joined by `|`.
    fn syntax(s: &str) -> String {
        let c = chars(s);
        obsidian_syntax(&c)
            .iter()
            .map(|r| c[r.clone()].iter().collect::<String>())
            .collect::<Vec<_>>()
            .join("|")
    }

    #[test]
    fn obsidian_syntax_lists_each_construct() {
        assert_eq!(
            syntax("See [[A|b]] and ![[x.png]] now"),
            "[[A|b]]|![[x.png]]"
        );
        assert_eq!(syntax("para text ^abc-1\n"), "^abc-1");
        assert_eq!(syntax("a %%hidden%% b"), "%%hidden%%");
        assert_eq!(syntax("%%\nmulti\nline\n%%\nafter"), "%%\nmulti\nline\n%%");
        assert_eq!(
            syntax("> [!note]- Title here\n> body"),
            "> [!note]- Title here"
        );
        assert_eq!(syntax("---\ntitle: x\n---\nbody"), "---\ntitle: x\n---");
        // a plain quote is not a callout
        assert_eq!(syntax("> just a quote"), "");
    }

    #[test]
    fn obsidian_syntax_skips_code_and_merges_neighbours() {
        assert_eq!(syntax("`[[x]]` and\n\n```\n[[y]]\n```\n"), "");
        assert_eq!(syntax("[[a]][[b]]"), "[[a]][[b]]");
    }
}
