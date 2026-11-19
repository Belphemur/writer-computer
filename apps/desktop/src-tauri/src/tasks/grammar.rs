//! The task line grammar: list-item prefixes, the Tasks plugin's emoji signifiers and the
//! Dataview `[due:: …]` inline fields, both read at all times, and the byte-minimal line edits.
//!
//! Reading follows the plugin's deserialiser (`src/TaskSerializer/DefaultTaskSerializer.ts` and
//! `DataviewTaskSerializer.ts`, MIT, see `THIRD_PARTY_NOTICES.md`): a trailing block id (`^id`) is
//! taken off first, then the signifiers are removed from the end of the line in any order (up to
//! 20 passes), trailing `#tags` interleaved with them go back into the description. Unlike the
//! plugin this keeps where each token sat, so an edit changes the bytes of one token and never
//! rewrites the line (`ParsedTask::set_*`).
//!
//! The Dataview task format (`[due:: 2024-01-01]`) is read with the index's inline-field scanner
//! (`index::inline_fields`), not a scanner of its own.

use super::date::Day;
use crate::index::inline_fields;
use std::ops::Range;

pub const VARIATION_SELECTOR: char = '\u{FE0F}';
const MAX_PASSES: usize = 20;

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Priority {
    Highest,
    High,
    Medium,
    Low,
    Lowest,
}

impl Priority {
    pub const ALL: [Priority; 5] = [
        Priority::Highest,
        Priority::High,
        Priority::Medium,
        Priority::Low,
        Priority::Lowest,
    ];

    pub const fn name(self) -> &'static str {
        match self {
            Priority::Highest => "highest",
            Priority::High => "high",
            Priority::Medium => "medium",
            Priority::Low => "low",
            Priority::Lowest => "lowest",
        }
    }

    pub fn parse(s: &str) -> Option<Priority> {
        let s = s.trim().to_ascii_lowercase();
        Priority::ALL.into_iter().find(|p| p.name() == s)
    }

    pub const fn emoji(self) -> &'static str {
        match self {
            Priority::Highest => "🔺",
            Priority::High => "⏫",
            Priority::Medium => "🔼",
            Priority::Low => "🔽",
            Priority::Lowest => "⏬",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Format {
    Emoji,
    Dataview,
}

impl Format {
    pub fn parse(s: &str) -> Option<Format> {
        match s.trim().to_ascii_lowercase().as_str() {
            "emoji" | "taskspluginemoji" => Some(Format::Emoji),
            "dataview" => Some(Format::Dataview),
            _ => None,
        }
    }
}

/// One signifier of a task line.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Field {
    Priority,
    Done,
    Cancelled,
    Due,
    Scheduled,
    Start,
    Created,
    Recurrence,
    OnCompletion,
    Id,
    DependsOn,
}

/// Run order of one pass (the plugin's).
const ORDER: [Field; 11] = [
    Field::Priority,
    Field::Done,
    Field::Cancelled,
    Field::Due,
    Field::Scheduled,
    Field::Start,
    Field::Created,
    Field::Recurrence,
    Field::OnCompletion,
    Field::Id,
    Field::DependsOn,
];

impl Field {
    /// The emoji a field is written with, followed by the ones also read for it.
    const fn emojis(self) -> &'static [&'static str] {
        match self {
            Field::Priority => &["🔺", "⏫", "🔼", "🔽", "⏬"],
            Field::Done => &["✅"],
            Field::Cancelled => &["❌"],
            Field::Due => &["📅", "📆", "🗓"],
            Field::Scheduled => &["⏳", "⌛"],
            Field::Start => &["🛫"],
            Field::Created => &["➕"],
            Field::Recurrence => &["🔁"],
            Field::OnCompletion => &["🏁"],
            Field::Id => &["🆔"],
            Field::DependsOn => &["⛔"],
        }
    }

    /// The key of the Dataview inline field.
    const fn key(self) -> &'static str {
        match self {
            Field::Priority => "priority",
            Field::Done => "completion",
            Field::Cancelled => "cancelled",
            Field::Due => "due",
            Field::Scheduled => "scheduled",
            Field::Start => "start",
            Field::Created => "created",
            Field::Recurrence => "repeat",
            Field::OnCompletion => "onCompletion",
            Field::Id => "id",
            Field::DependsOn => "dependsOn",
        }
    }

    fn is_date(self) -> bool {
        matches!(
            self,
            Field::Done
                | Field::Cancelled
                | Field::Due
                | Field::Scheduled
                | Field::Start
                | Field::Created
        )
    }
}

/// The data of a task line, with no positions.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TaskFields {
    /// What is left of the text once the signifiers are taken out (trailing tags kept).
    pub description: String,
    pub priority: Option<Priority>,
    pub due: Option<Day>,
    pub scheduled: Option<Day>,
    pub start: Option<Day>,
    pub created: Option<Day>,
    pub done: Option<Day>,
    pub cancelled: Option<Day>,
    /// The recurrence phrase as written (`every 2 weeks when done`).
    pub recurrence: Option<String>,
    pub on_completion: Option<String>,
    pub id: Option<String>,
    pub depends_on: Vec<String>,
    /// Lowercase, without `#`.
    pub tags: Vec<String>,
    /// The block id without `^`.
    pub block_id: Option<String>,
}

impl TaskFields {
    /// The date of a date field.
    pub fn date(&self, f: Field) -> Option<Day> {
        match f {
            Field::Done => self.done,
            Field::Cancelled => self.cancelled,
            Field::Due => self.due,
            Field::Scheduled => self.scheduled,
            Field::Start => self.start,
            Field::Created => self.created,
            _ => None,
        }
    }

    /// The dates the next occurrence keeps relative to the reference date (due, scheduled, start).
    pub fn reference_date(&self) -> Option<Day> {
        self.due.or(self.scheduled).or(self.start)
    }
}

// ---------------------------------------------------------------------------
// The list item prefix
// ---------------------------------------------------------------------------

/// A line that is a list item: where its pieces are.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ListLine {
    /// Columns of leading whitespace after any blockquote `>` prefix (a tab counts 4).
    pub indent: u32,
    /// Byte range of the marker (`-`, `*`, `+`, `12.`, `3)`).
    pub marker: Range<usize>,
    /// `Some((byte offset, symbol))` of `[x]` when the item is a task.
    pub checkbox: Option<(usize, char)>,
    /// Byte offset where the item's text starts (after the marker or the checkbox, spaces skipped).
    pub text_start: usize,
}

/// Parse the prefix of a list item (`- `, `* `, `+ `, `1. `, `1) `, inside blockquotes), with an
/// optional `[x]` checkbox. The same rule the index has always used: the marker needs a space or
/// tab after it, a checkbox is one character and needs a space after it.
pub fn list_line(line: &str) -> Option<ListLine> {
    let mut pos = 0;
    let indent = loop {
        let rest = &line[pos..];
        let trimmed = rest.trim_start_matches([' ', '\t']);
        let lead = &rest[..rest.len() - trimmed.len()];
        pos += lead.len();
        match trimmed.strip_prefix('>') {
            Some(_) => pos += 1,
            None => {
                break lead
                    .chars()
                    .map(|c| if c == '\t' { 4 } else { 1 })
                    .sum::<u32>()
            }
        }
    };
    let rest = &line[pos..];
    // `- - -` and `* * *` are thematic breaks, not items
    let is_break = |c: char| {
        rest.starts_with(c)
            && rest.chars().all(|x| x == c || x == ' ' || x == '\t')
            && rest.chars().filter(|x| *x == c).count() >= 3
    };
    if ['-', '*', '_'].into_iter().any(is_break) {
        return None;
    }
    let marker_len = if rest.starts_with(['-', '*', '+']) {
        1
    } else {
        let digits = rest.chars().take_while(char::is_ascii_digit).count();
        if digits == 0 || digits > 9 || !rest[digits..].starts_with(['.', ')']) {
            return None;
        }
        digits + 1
    };
    let marker = pos..pos + marker_len;
    let after = &rest[marker_len..];
    let ws = after.len() - after.trim_start_matches([' ', '\t']).len();
    if ws == 0 {
        // `-` alone on a line is an empty item; a marker glued to text is not a list item
        return after.is_empty().then_some(ListLine {
            indent,
            marker,
            checkbox: None,
            text_start: line.len(),
        });
    }
    let text_at = pos + marker_len + ws;
    let mut checkbox = None;
    let mut text_start = text_at;
    if let Some(inner) = line[text_at..].strip_prefix('[') {
        let mut it = inner.chars();
        if let (Some(sym), Some(']')) = (it.next(), it.next()) {
            let after_box = text_at + 1 + sym.len_utf8() + 1;
            let tail = &line[after_box..];
            if tail.is_empty() || tail.starts_with([' ', '\t']) {
                checkbox = Some((text_at + 1, sym));
                text_start = after_box + (tail.len() - tail.trim_start_matches([' ', '\t']).len());
            }
        }
    }
    Some(ListLine {
        indent,
        marker,
        checkbox,
        text_start,
    })
}

// ---------------------------------------------------------------------------
// Reading a task line
// ---------------------------------------------------------------------------

/// A token of the line that carries one field: its whole range and the range of its value.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FieldSpan {
    pub field: Field,
    pub range: Range<usize>,
    pub value: Range<usize>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedTask {
    pub status: char,
    /// Byte offset of the status character.
    pub status_at: usize,
    /// Byte range of the text after the checkbox (trimmed both ends).
    pub body: Range<usize>,
    pub fields: TaskFields,
    spans: Vec<FieldSpan>,
    block: Option<Range<usize>>,
}

fn is_tag_char(c: char) -> bool {
    !matches!(
        c,
        ' ' | '!'
            | '@'
            | '#'
            | '$'
            | '%'
            | '^'
            | '&'
            | '*'
            | '('
            | ')'
            | ','
            | '.'
            | '?'
            | '"'
            | ':'
            | '{'
            | '}'
            | '|'
            | '<'
            | '>'
    ) && !c.is_whitespace()
}

fn is_id_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '-' || c == '_'
}

/// A tag at the very end of `s` (`(^|\s)#tag$`): its start.
fn trailing_tag(s: &str) -> Option<usize> {
    let start = s
        .rfind(char::is_whitespace)
        .map_or(0, |i| i + s[i..].chars().next().map_or(1, char::len_utf8));
    let tok = &s[start..];
    let name = tok.strip_prefix('#')?;
    (!name.is_empty() && name.chars().all(is_tag_char)).then_some(start)
}

/// Every `#tag` of a text, lowercase, without `#`, in order.
pub fn tags_of(text: &str) -> Vec<String> {
    text.split_whitespace()
        .filter_map(|tok| {
            let name = tok.strip_prefix('#')?;
            let name: String = name.chars().take_while(|c| is_tag_char(*c)).collect();
            (!name.is_empty()).then(|| name.to_lowercase())
        })
        .collect()
}

/// A trailing ` ^block-id`.
fn trailing_block(s: &str) -> Option<usize> {
    let i = s.rfind(" ^")?;
    let id = &s[i + 2..];
    (!id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')).then_some(i)
}

/// What an end-anchored matcher found in `s` (positions relative to `s`).
struct Hit {
    start: usize,
    value: Range<usize>,
    /// What was captured (a date, the priority emoji or name, a phrase, an id list).
    text: String,
}

fn emoji_hit(field: Field, s: &str) -> Option<Hit> {
    let emojis = field.emojis();
    let find_emoji = |head: &str| {
        let head = head.strip_suffix(VARIATION_SELECTOR).unwrap_or(head);
        emojis
            .iter()
            .find(|e| head.ends_with(**e))
            .map(|e| (head.len() - e.len(), *e))
    };
    match field {
        Field::Priority => {
            let (start, e) = find_emoji(s)?;
            Some(Hit {
                start,
                value: start..start + e.len(),
                text: e.to_string(),
            })
        }
        f if f.is_date() => {
            let at = s.len().checked_sub(10).filter(|i| s.is_char_boundary(*i))?;
            let date = &s[at..];
            Day::parse(date)?;
            let head = s[..at].trim_end_matches(' ');
            let (start, _) = find_emoji(head)?;
            Some(Hit {
                start,
                value: at..s.len(),
                text: date.to_string(),
            })
        }
        _ => {
            // phrase fields: every occurrence of the emoji, leftmost first, whose tail fits
            let e = emojis[0];
            s.match_indices(e).find_map(|(i, _)| {
                let mut rest = &s[i + e.len()..];
                rest = rest.strip_prefix(VARIATION_SELECTOR).unwrap_or(rest);
                let value_at = s.len() - rest.len();
                let fits = !rest.is_empty()
                    && match field {
                        Field::Recurrence => rest
                            .chars()
                            .all(|c| c.is_ascii_alphanumeric() || matches!(c, ',' | ' ' | '!')),
                        Field::OnCompletion => {
                            rest.trim_start_matches(' ')
                                .chars()
                                .all(|c| c.is_ascii_alphabetic())
                                && !rest.trim_start_matches(' ').is_empty()
                        }
                        Field::Id => {
                            rest.trim_start_matches(' ').chars().all(is_id_char)
                                && !rest.trim_start_matches(' ').is_empty()
                        }
                        Field::DependsOn => depends_ids(rest.trim_start_matches(' ')).is_some(),
                        _ => false,
                    };
                fits.then(|| Hit {
                    start: i,
                    value: value_at + (rest.len() - rest.trim_start_matches(' ').len())..s.len(),
                    text: rest.trim().to_string(),
                })
            })
        }
    }
}

/// `id( *, *id *)*`, all of `s`.
fn depends_ids(s: &str) -> Option<Vec<String>> {
    let ids: Vec<String> = s.split(',').map(|p| p.trim().to_string()).collect();
    ids.iter()
        .all(|i| !i.is_empty() && i.chars().all(is_id_char))
        .then_some(ids)
}

/// A Dataview inline field at the end of `s`: `[key:: value]` or `(key:: value)`, a trailing
/// comma allowed. Found by the index's inline-field scanner (`index::inline_fields`), the one
/// reader of that syntax.
fn dataview_trailing(field: Field, s: &str) -> Option<Hit> {
    let mut end = s.trim_end().len();
    if s[..end].ends_with(',') {
        end = s[..end - 1].trim_end().len();
    }
    let found = inline_fields::scan_line(s)
        .into_iter()
        .rev()
        .find(|f| f.wrapping.is_some() && f.end == end)?;
    if found.key != field.key() {
        return None;
    }
    let start = found.start;
    // `end - 1` drops the closer; the value starts after the separator and any spaces
    let raw = &s[found.start_value..end - 1];
    let value_at = found.start_value + (raw.len() - raw.trim_start().len());
    let value_trim = found.value.as_str();
    let ok = match field {
        f if f.is_date() => Day::parse(value_trim).is_some(),
        Field::Priority => Priority::parse(value_trim).is_some(),
        Field::Recurrence => {
            !value_trim.is_empty()
                && value_trim
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, ',' | ' ' | '!'))
        }
        Field::OnCompletion => {
            !value_trim.is_empty() && value_trim.chars().all(|c| c.is_ascii_alphabetic())
        }
        Field::Id => !value_trim.is_empty() && value_trim.chars().all(is_id_char),
        Field::DependsOn => depends_ids(value_trim).is_some(),
        _ => false,
    };
    if !ok {
        return None;
    }
    Some(Hit {
        start,
        value: value_at..value_at + value_trim.len(),
        text: value_trim.to_string(),
    })
}

fn priority_of_emoji(e: &str) -> Option<Priority> {
    Priority::ALL.into_iter().find(|p| p.emoji() == e)
}

fn apply(fields: &mut TaskFields, field: Field, text: &str) {
    let day = || Day::parse(text);
    match field {
        Field::Priority => {
            fields.priority = priority_of_emoji(text).or_else(|| Priority::parse(text))
        }
        Field::Done => fields.done = day(),
        Field::Cancelled => fields.cancelled = day(),
        Field::Due => fields.due = day(),
        Field::Scheduled => fields.scheduled = day(),
        Field::Start => fields.start = day(),
        Field::Created => fields.created = day(),
        Field::Recurrence => fields.recurrence = Some(text.to_string()).filter(|t| !t.is_empty()),
        Field::OnCompletion => fields.on_completion = Some(text.to_ascii_lowercase()),
        Field::Id => fields.id = Some(text.to_string()),
        Field::DependsOn => {
            fields.depends_on = text
                .split(',')
                .map(|i| i.trim().to_string())
                .filter(|i| !i.is_empty())
                .collect()
        }
    }
}

/// Parse a task line (a list item with a checkbox). `None` when the line is not a task.
pub fn parse_task(line: &str) -> Option<ParsedTask> {
    let list = list_line(line)?;
    let (status_at, status) = list.checkbox?;
    Some(parse_body(line, list.text_start, status_at, status))
}

fn parse_body(line: &str, text_start: usize, status_at: usize, status: char) -> ParsedTask {
    let mut end = line.trim_end().len().max(text_start);
    let mut fields = TaskFields::default();
    let mut spans: Vec<FieldSpan> = Vec::new();
    let mut block = None;
    if let Some(i) = trailing_block(&line[text_start..end]) {
        let start = text_start + i;
        fields.block_id = Some(line[start + 2..end].to_string());
        block = Some(start..end);
        end = text_start + line[text_start..start].trim_end().len();
    }
    let mut trailing_tags: Vec<String> = Vec::new();
    for _ in 0..=MAX_PASSES {
        let mut matched = false;
        for field in ORDER {
            let s = &line[text_start..end];
            let hit = emoji_hit(field, s).or_else(|| dataview_trailing(field, s));
            let Some(hit) = hit else { continue };
            let abs = |r: Range<usize>| r.start + text_start..r.end + text_start;
            spans.push(FieldSpan {
                field,
                range: text_start + hit.start..end,
                value: abs(hit.value),
            });
            apply(&mut fields, field, &hit.text);
            end = text_start + s[..hit.start].trim_end().len();
            matched = true;
        }
        let s = &line[text_start..end];
        if let Some(start) = trailing_tag(s) {
            trailing_tags.insert(0, s[start..].to_string());
            end = text_start + s[..start].trim_end().len();
            matched = true;
        }
        if !matched {
            break;
        }
    }
    // The pass order puts `tags` between the recurrence fields and the ids; the plugin takes tags
    // off in the same pass, so a tag before `🆔 id` is found on the next pass: same here.
    let mut description = line[text_start..end].to_string();
    if !trailing_tags.is_empty() {
        if !description.is_empty() {
            description.push(' ');
        }
        description.push_str(&trailing_tags.join(" "));
    }
    fields.tags = tags_of(&description);
    fields.description = description;
    ParsedTask {
        status,
        status_at,
        body: text_start..line.trim_end().len().max(text_start),
        fields,
        spans,
        block,
    }
}

// ---------------------------------------------------------------------------
// Editing a task line
// ---------------------------------------------------------------------------

/// A new token with its leading space(s), as the file writes it.
fn token(field: Field, value: &str, format: Format) -> String {
    match format {
        Format::Emoji if field == Field::Priority => format!(" {value}"),
        Format::Emoji => format!(" {} {value}", field.emojis()[0]),
        // two leading spaces, as the plugin writes them (an inline-field rendering quirk)
        Format::Dataview => format!("  [{}:: {value}]", field.key()),
    }
}

/// A new field's value as the file writes it.
fn value_text(field: Field, value: &str, format: Format) -> String {
    match (field, format) {
        (Field::Priority, Format::Emoji) => {
            Priority::parse(value).map_or_else(|| value.to_string(), |p| p.emoji().to_string())
        }
        _ => value.to_string(),
    }
}

impl ParsedTask {
    /// The rightmost-first spans, last extracted last: the one that supplied the field's value.
    fn span(&self, field: Field) -> Option<&FieldSpan> {
        self.spans.iter().rev().find(|s| s.field == field)
    }

    /// Replace the status character: nothing else changes.
    pub fn with_status(&self, line: &str, symbol: char) -> String {
        let mut out = line.to_string();
        out.replace_range(
            self.status_at..self.status_at + self.status.len_utf8(),
            &symbol.to_string(),
        );
        out
    }

    /// Set (`Some`) or remove (`None`) a field. An existing token has only its value replaced
    /// (a date written with a variant emoji, `📆` `🗓` `⌛`, is rewritten with the canonical one); a
    /// new one goes after the text and the other signifiers, before a block id, in `format`.
    pub fn with_field(
        &self,
        line: &str,
        field: Field,
        value: Option<&str>,
        format: Format,
    ) -> String {
        match (self.span(field), value) {
            (Some(span), Some(v)) => {
                let mut out = line.to_string();
                let fmt = format_of(line, span);
                let v = value_text(field, v, fmt);
                let canonical = field.emojis()[0];
                if fmt == Format::Emoji
                    && field.is_date()
                    && !line[span.range.clone()].starts_with(canonical)
                {
                    // `📆`, `🗓` and `⌛` are read as ever and written as `📅` and `⏳`
                    out.replace_range(span.range.clone(), &format!("{canonical} {v}"));
                } else {
                    out.replace_range(span.value.clone(), &v);
                }
                out
            }
            (Some(span), None) => {
                let before = line[..span.range.start].trim_end_matches(' ').len();
                let mut out = line.to_string();
                out.replace_range(before..span.range.end, "");
                out
            }
            (None, Some(v)) => {
                let at = self.insert_at(line);
                let mut out = line.to_string();
                out.insert_str(at, &token(field, &value_text(field, v, format), format));
                out
            }
            (None, None) => line.to_string(),
        }
    }

    pub fn with_date(&self, line: &str, field: Field, day: Option<Day>, format: Format) -> String {
        self.with_field(line, field, day.map(|d| d.to_string()).as_deref(), format)
    }

    /// The line without its block id (a recurring task's next occurrence cannot share one).
    pub fn without_block(&self, line: &str) -> String {
        match &self.block {
            Some(b) => format!("{}{}", &line[..b.start], &line[b.end..]),
            None => line.to_string(),
        }
    }

    /// Where a new signifier goes: the end of the text, before a block id.
    fn insert_at(&self, line: &str) -> usize {
        match &self.block {
            Some(b) => line[..b.start].trim_end().len(),
            None => line.trim_end().len(),
        }
    }

    /// The line as the file writes `format` for a field already on it (a Dataview token on a
    /// line is replaced as a Dataview token whatever the setting says).
    #[cfg(test)]
    pub fn spans(&self) -> &[FieldSpan] {
        &self.spans
    }
}

/// The format a token on the line is written in (its value is replaced in that format).
fn format_of(line: &str, span: &FieldSpan) -> Format {
    if line[span.range.clone()].starts_with(['[', '(']) {
        Format::Dataview
    } else {
        Format::Emoji
    }
}

/// A new task line: `- [ ] text`.
pub fn new_task_line(text: &str) -> String {
    format!("- [ ] {}", text.trim())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(s: &str) -> Day {
        Day::parse(s).unwrap()
    }

    #[test]
    fn list_prefixes() {
        let l = list_line("  - [x] hi").unwrap();
        assert_eq!((l.indent, l.checkbox, l.text_start), (2, Some((5, 'x')), 8));
        assert_eq!(list_line("1. a").unwrap().marker, 0..2);
        assert_eq!(list_line("\t- a").unwrap().indent, 4);
        assert_eq!(
            list_line("> - [ ] q").unwrap().checkbox.map(|c| c.1),
            Some(' ')
        );
        assert!(list_line("-a").is_none());
        assert!(list_line("text").is_none());
        // a checkbox needs one character and a space after it
        assert!(list_line("- [xx] no").unwrap().checkbox.is_none());
        assert!(list_line("- [x]no").unwrap().checkbox.is_none());
        assert!(parse_task("- plain").is_none());
    }

    #[test]
    fn emoji_fields_in_any_order() {
        let t = parse_task("- [ ] Write 📅 2024-03-15 ⏫ 🔁 every week ⏳ 2024-03-10").unwrap();
        assert_eq!(t.fields.description, "Write");
        assert_eq!(t.fields.due, Some(d("2024-03-15")));
        assert_eq!(t.fields.scheduled, Some(d("2024-03-10")));
        assert_eq!(t.fields.priority, Some(Priority::High));
        assert_eq!(t.fields.recurrence.as_deref(), Some("every week"));
        // a field that is not at the end stays in the description
        let t = parse_task("- [ ] a 📅 2024-03-15 b").unwrap();
        assert_eq!(t.fields.due, None);
        assert_eq!(t.fields.description, "a 📅 2024-03-15 b");
    }

    #[test]
    fn variants_and_variation_selectors() {
        let t = parse_task("- [ ] x 📆 2024-01-02 ⌛ 2024-01-01").unwrap();
        assert_eq!(t.fields.due, Some(d("2024-01-02")));
        assert_eq!(t.fields.scheduled, Some(d("2024-01-01")));
        let t = parse_task("- [ ] x 🗓\u{FE0F} 2024-01-02 ⏫\u{FE0F}").unwrap();
        assert_eq!(t.fields.due, Some(d("2024-01-02")));
        assert_eq!(t.fields.priority, Some(Priority::High));
        assert_eq!(t.fields.description, "x");
    }

    #[test]
    fn every_signifier() {
        let t = parse_task(
            "- [x] job 🔺 🆔 abc ⛔ x1, y2 🏁 delete ➕ 2024-01-01 🛫 2024-01-02 ⏳ 2024-01-03 📅 2024-01-04 ❌ 2024-01-05 ✅ 2024-01-06",
        )
        .unwrap();
        let f = &t.fields;
        assert_eq!(f.priority, Some(Priority::Highest));
        assert_eq!(f.id.as_deref(), Some("abc"));
        assert_eq!(f.depends_on, ["x1", "y2"]);
        assert_eq!(f.on_completion.as_deref(), Some("delete"));
        assert_eq!(f.created, Some(d("2024-01-01")));
        assert_eq!(f.start, Some(d("2024-01-02")));
        assert_eq!(f.scheduled, Some(d("2024-01-03")));
        assert_eq!(f.due, Some(d("2024-01-04")));
        assert_eq!(f.cancelled, Some(d("2024-01-05")));
        assert_eq!(f.done, Some(d("2024-01-06")));
        assert_eq!(f.description, "job");
        for (sym, p) in [
            ("⏫", Priority::High),
            ("🔼", Priority::Medium),
            ("🔽", Priority::Low),
            ("⏬", Priority::Lowest),
        ] {
            assert_eq!(
                parse_task(&format!("- [ ] a {sym}"))
                    .unwrap()
                    .fields
                    .priority,
                Some(p)
            );
        }
    }

    #[test]
    fn tags_and_block_ids() {
        let t = parse_task("- [ ] Plan #work 📅 2024-03-15 #home ^blk-1").unwrap();
        assert_eq!(t.fields.description, "Plan #work #home");
        assert_eq!(t.fields.tags, ["work", "home"]);
        assert_eq!(t.fields.block_id.as_deref(), Some("blk-1"));
        assert_eq!(t.fields.due, Some(d("2024-03-15")));
        // a URL fragment is not a tag
        assert!(parse_task("- [ ] see http://x/y#frag")
            .unwrap()
            .fields
            .tags
            .is_empty());
    }

    #[test]
    fn dataview_fields() {
        let t = parse_task(
            "- [ ] Report  [due:: 2024-03-15]  [priority:: high] (repeat:: every week)  [created:: 2024-01-01],",
        )
        .unwrap();
        assert_eq!(t.fields.description, "Report");
        assert_eq!(t.fields.due, Some(d("2024-03-15")));
        assert_eq!(t.fields.priority, Some(Priority::High));
        assert_eq!(t.fields.recurrence.as_deref(), Some("every week"));
        assert_eq!(t.fields.created, Some(d("2024-01-01")));
        // an unknown key or a bad value is text
        let t = parse_task("- [ ] a [mood:: good] [due:: tomorrow]").unwrap();
        assert_eq!(t.fields.due, None);
        assert_eq!(t.fields.description, "a [mood:: good] [due:: tomorrow]");
    }

    #[test]
    fn twenty_passes_is_enough_and_bounded() {
        let mut line = String::from("- [ ] t");
        for _ in 0..30 {
            line.push_str(" ⏫");
        }
        // terminates; the text holds the signifiers the cap left
        let t = parse_task(&line).unwrap();
        assert!(t.fields.description.starts_with('t'));
    }

    #[test]
    fn edits_change_one_token() {
        let line = "- [ ] Write 📅 2024-03-15 ⏫ #a ^id";
        let t = parse_task(line).unwrap();
        // only the date changes
        assert_eq!(
            t.with_date(line, Field::Due, Some(d("2024-04-01")), Format::Emoji),
            "- [ ] Write 📅 2024-04-01 ⏫ #a ^id"
        );
        // a variant emoji is normalised when its date is written
        let variant = "- [ ] Write 📆 2024-03-15 ⌛ 2024-03-01";
        let t = parse_task(variant).unwrap();
        assert_eq!(
            t.with_date(variant, Field::Due, Some(d("2024-04-01")), Format::Emoji),
            "- [ ] Write 📅 2024-04-01 ⌛ 2024-03-01"
        );
        assert_eq!(
            t.with_date(
                variant,
                Field::Scheduled,
                Some(d("2024-03-02")),
                Format::Emoji
            ),
            "- [ ] Write 📆 2024-03-15 ⏳ 2024-03-02"
        );
        let t = parse_task(line).unwrap();
        // removal takes the token and its leading space
        assert_eq!(
            t.with_date(line, Field::Due, None, Format::Emoji),
            "- [ ] Write ⏫ #a ^id"
        );
        // a new field goes before the block id
        assert_eq!(
            t.with_date(line, Field::Done, Some(d("2024-03-16")), Format::Emoji),
            "- [ ] Write 📅 2024-03-15 ⏫ #a ✅ 2024-03-16 ^id"
        );
        assert_eq!(
            t.with_status(line, 'x'),
            "- [x] Write 📅 2024-03-15 ⏫ #a ^id"
        );
        // priority replaced by name
        assert_eq!(
            t.with_field(line, Field::Priority, Some("low"), Format::Emoji),
            "- [ ] Write 📅 2024-03-15 🔽 #a ^id"
        );
    }

    #[test]
    fn new_fields_follow_the_format() {
        let line = "- [ ] Plan";
        let t = parse_task(line).unwrap();
        assert_eq!(
            t.with_date(line, Field::Due, Some(d("2024-03-15")), Format::Emoji),
            "- [ ] Plan 📅 2024-03-15"
        );
        assert_eq!(
            t.with_date(line, Field::Due, Some(d("2024-03-15")), Format::Dataview),
            "- [ ] Plan  [due:: 2024-03-15]"
        );
        assert_eq!(
            t.with_field(line, Field::Priority, Some("high"), Format::Dataview),
            "- [ ] Plan  [priority:: high]"
        );
        assert_eq!(
            t.with_field(line, Field::Recurrence, Some("every day"), Format::Emoji),
            "- [ ] Plan 🔁 every day"
        );
        // an existing Dataview token is replaced as Dataview whatever the setting says
        let line = "- [ ] Plan [due:: 2024-01-01]";
        let t = parse_task(line).unwrap();
        assert_eq!(
            t.with_date(line, Field::Due, Some(d("2024-02-02")), Format::Emoji),
            "- [ ] Plan [due:: 2024-02-02]"
        );
    }
}

#[cfg(test)]
mod vector_tests {
    use super::*;
    use serde_json::Value as Json;

    fn vectors() -> Json {
        serde_json::from_str(include_str!("../../../shared/task-vectors.json")).unwrap()
    }

    fn field(name: &str) -> Field {
        crate::tasks::edit::parse_field(name).unwrap_or_else(|| panic!("field {name}"))
    }

    /// `shared/task-vectors.json` pins the grammar (the TypeScript helpers read the same file).
    #[test]
    fn task_vectors_parse() {
        for v in vectors()["parse"].as_array().unwrap() {
            let line = v["line"].as_str().unwrap();
            let t = parse_task(line).unwrap_or_else(|| panic!("{line} is a task"));
            let want = &v["fields"];
            let f = &t.fields;
            let s = |k: &str| want[k].as_str().map(str::to_string);
            let day = |d: Option<Day>| d.map(|d| d.to_string());
            let list = |k: &str| -> Vec<String> {
                want[k]
                    .as_array()
                    .map(|a| a.iter().map(|x| x.as_str().unwrap().to_string()).collect())
                    .unwrap_or_default()
            };
            assert_eq!(
                t.status.to_string(),
                v["status"].as_str().unwrap(),
                "{line}"
            );
            assert_eq!(f.description, s("description").unwrap(), "{line}");
            assert_eq!(day(f.due), s("due"), "{line}");
            assert_eq!(day(f.scheduled), s("scheduled"), "{line}");
            assert_eq!(day(f.start), s("start"), "{line}");
            assert_eq!(day(f.created), s("created"), "{line}");
            assert_eq!(day(f.done), s("done"), "{line}");
            assert_eq!(day(f.cancelled), s("cancelled"), "{line}");
            assert_eq!(
                f.priority.map(|p| p.name().to_string()),
                s("priority"),
                "{line}"
            );
            assert_eq!(f.recurrence, s("recurrence"), "{line}");
            assert_eq!(f.on_completion, s("on_completion"), "{line}");
            assert_eq!(f.id, s("id"), "{line}");
            assert_eq!(f.block_id, s("block_id"), "{line}");
            assert_eq!(f.depends_on, list("depends_on"), "{line}");
            assert_eq!(f.tags, list("tags"), "{line}");
            // re-serialised: setting every field to what it already is changes nothing
            let mut line2 = line.to_string();
            for name in [
                "due",
                "scheduled",
                "start",
                "created",
                "done",
                "cancelled",
                "priority",
                "recurrence",
            ] {
                if let Some(value) = s(name) {
                    let p = parse_task(&line2).unwrap();
                    let fmt = if line.contains("::") {
                        Format::Dataview
                    } else {
                        Format::Emoji
                    };
                    line2 = p.with_field(&line2, field(name), Some(&value), fmt);
                }
            }
            let normalised = line.replace(['📆', '🗓'], "📅").replace('⌛', "⏳");
            assert_eq!(line2, normalised, "{line}");
        }
    }

    #[test]
    fn task_vectors_write() {
        for v in vectors()["write"].as_array().unwrap() {
            let line = v["line"].as_str().unwrap();
            let fmt = Format::parse(v["format"].as_str().unwrap()).unwrap();
            let p = parse_task(line).unwrap();
            let got = p.with_field(
                line,
                field(v["field"].as_str().unwrap()),
                v["value"].as_str(),
                fmt,
            );
            assert_eq!(got, v["result"].as_str().unwrap(), "{line}");
        }
    }

    #[test]
    fn task_vectors_toggle() {
        use crate::tasks::{edit::toggle_line, settings::TaskSettings};
        for v in vectors()["toggle"].as_array().unwrap() {
            let line = v["line"].as_str().unwrap();
            let today = Day::parse(v["today"].as_str().unwrap()).unwrap();
            let got = toggle_line(line, 1, &TaskSettings::default(), today).unwrap();
            let want: Vec<String> = v["result"]
                .as_array()
                .unwrap()
                .iter()
                .map(|x| x.as_str().unwrap().to_string())
                .collect();
            assert_eq!(got, want, "{line}");
        }
    }
}
