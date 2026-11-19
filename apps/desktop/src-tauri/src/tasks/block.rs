//! The Tasks plugin's ```` ```tasks ```` query block, lowered to a `rows: tasks` base
//! (SPECs/tasks-spec.md 7). Blocks are not executed in place: the editor shows a card with
//! "Convert to Base", and this module turns the block text into the base's text, or names every
//! instruction it cannot express (the block is then left as is).
//!
//! The instruction grammar is read from the plugin's public docs (MIT, `docs/Queries/*`, see
//! `THIRD_PARTY_NOTICES.md`). What maps: status, dates (absolute and `today`/`in 3 days`
//! phrases), priority, recurrence, text fields, tags, `exclude sub-items`, boolean combinations
//! in parentheses (folded left to right), `sort by`, `group by` (one level), `limit` and the
//! column layout. What does not (`filter by function`, `happens`, date ranges such as
//! `this week`, `is blocked`, presets, several `group by`, `show tree`...) is reported by line.

use crate::bases::document::{Direction, Document, Filter, GroupBy, RowKind, SortKey, View};

/// One instruction that cannot be lowered.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, specta::Type)]
pub struct Unmapped {
    /// 1-based line of the block (a continued line counts from its first physical line).
    pub line: u32,
    pub text: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Conversion {
    /// The `.base` text, when every instruction mapped.
    pub base: Option<String>,
    pub unmapped: Vec<Unmapped>,
}

fn quote(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// Join `\`-continued lines, drop blanks and `#` comments; keep each instruction's first line.
fn instructions(source: &str) -> Vec<(u32, String)> {
    let mut out: Vec<(u32, String)> = Vec::new();
    let mut pending: Option<(u32, String)> = None;
    for (i, raw) in source.lines().enumerate() {
        let line_no = i as u32 + 1;
        let t = raw.trim();
        let (start, mut text) = pending.take().unwrap_or((line_no, String::new()));
        if text.is_empty() && (t.is_empty() || t.starts_with('#')) {
            continue;
        }
        if let Some(cont) = t.strip_suffix('\\') {
            text.push_str(cont.trim_end());
            text.push(' ');
            pending = Some((start, text));
            continue;
        }
        text.push_str(t);
        out.push((start, text));
    }
    if let Some((start, text)) = pending {
        out.push((start, text.trim_end().to_string()));
    }
    out
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

fn number_word(w: &str) -> Option<u32> {
    const WORDS: [&str; 12] = [
        "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven",
        "twelve",
    ];
    w.parse().ok().or_else(|| {
        WORDS
            .iter()
            .position(|x| *x == w)
            .map(|i| i as u32 + 1)
            .or((w == "a").then_some(1))
    })
}

/// A date of a filter as a Bases expression: `today`, `tomorrow`, `yesterday`, `YYYY-MM-DD`,
/// `in 3 days`, `2 weeks ago`.
fn date_expr(text: &str) -> Option<String> {
    let t = text.trim().to_lowercase();
    match t.as_str() {
        "today" => return Some("today()".into()),
        "tomorrow" => return Some("today() + \"1 day\"".into()),
        "yesterday" => return Some("today() - \"1 day\"".into()),
        _ => {}
    }
    if super::date::Day::parse(&t).is_some() {
        return Some(format!("date({})", quote(&t)));
    }
    let words: Vec<&str> = t.split_whitespace().collect();
    let unit = |w: &str| {
        let w = w.strip_suffix('s').unwrap_or(w);
        matches!(w, "day" | "week" | "month" | "year").then_some(w.to_string())
    };
    match words.as_slice() {
        ["in", n, u] => Some(format!("today() + \"{} {}\"", number_word(n)?, unit(u)?)),
        [n, u, "ago"] => Some(format!("today() - \"{} {}\"", number_word(n)?, unit(u)?)),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

const DATE_FIELDS: [(&str, &str); 7] = [
    ("due", "due"),
    ("scheduled", "scheduled"),
    ("start", "start"),
    ("starts", "start"),
    ("created", "created"),
    ("done", "done"),
    ("cancelled", "cancelled"),
];

fn date_field(word: &str) -> Option<&'static str> {
    DATE_FIELDS
        .iter()
        .find(|(w, _)| *w == word)
        .map(|(_, f)| *f)
}

/// `due before today`, `scheduled on or after 2024-01-01`, `due in 2024-01-01 2024-01-31`.
fn date_filter(field: &str, rest: &str) -> Result<String, String> {
    let p = format!("task.{field}");
    let has = format!("{p} != null");
    let rest = rest.trim();
    let (op, tail) = [
        ("on or before ", "<="),
        ("on or after ", ">="),
        ("in or before ", "<="),
        ("in or after ", ">="),
        ("before ", "<"),
        ("after ", ">"),
        ("on ", "=="),
        ("in ", "in"),
    ]
    .iter()
    .find_map(|(w, o)| rest.strip_prefix(w).map(|t| (*o, t)))
    .unwrap_or(("==", rest));
    // two absolute dates are a range
    let parts: Vec<&str> = tail.split_whitespace().collect();
    if let [a, b] = parts.as_slice() {
        if let (Some(a), Some(b)) = (date_expr(a), date_expr(b)) {
            return Ok(match op {
                "<" => format!("{has} && {p} < {a}"),
                ">" => format!("{has} && {p} > {b}"),
                "<=" => format!("{has} && {p} <= {b}"),
                ">=" => format!("{has} && {p} >= {a}"),
                _ => format!("{has} && {p} >= {a} && {p} <= {b}"),
            });
        }
    }
    let d = date_expr(tail).ok_or_else(|| {
        format!("the date \"{tail}\" is not one of: YYYY-MM-DD, today, tomorrow, yesterday, in N days, N days ago")
    })?;
    let op = if op == "in" { "==" } else { op };
    Ok(format!("{has} && {p} {op} {d}"))
}

const PRIORITIES: [&str; 6] = ["highest", "high", "medium", "none", "low", "lowest"];

fn priority_is(level: &str) -> String {
    if level == "none" {
        "task.priority == null".into()
    } else {
        format!("task.priority == {}", quote(level))
    }
}

fn priority_filter(rest: &str) -> Result<String, String> {
    let words: Vec<&str> = rest.split_whitespace().collect();
    let known = |w: &str| PRIORITIES.contains(&w).then_some(w.to_string());
    let bad = || {
        "priority needs is, is not, above or below and one of highest, high, medium, none, low, lowest".to_string()
    };
    let (kind, level) = match words.as_slice() {
        ["is", "not", l] => ("not", known(l).ok_or_else(bad)?),
        ["is", l] | [l] => ("is", known(l).ok_or_else(bad)?),
        ["not", l] => ("not", known(l).ok_or_else(bad)?),
        ["above", l] => ("above", known(l).ok_or_else(bad)?),
        ["below", l] => ("below", known(l).ok_or_else(bad)?),
        _ => return Err(bad()),
    };
    let at = PRIORITIES.iter().position(|p| *p == level).unwrap_or(0);
    let any = |levels: &[&str]| -> String {
        let parts: Vec<String> = levels.iter().map(|l| priority_is(l)).collect();
        if parts.is_empty() {
            "false".into()
        } else {
            format!("({})", parts.join(" || "))
        }
    };
    Ok(match kind {
        "is" => priority_is(&level),
        "not" => format!("!({})", priority_is(&level)),
        "above" => any(&PRIORITIES[..at]),
        _ => any(&PRIORITIES[at + 1..]),
    })
}

/// `includes` / `does not include` / `regex matches` / `regex does not match` over `subject`.
fn text_filter(subject: &str, rest: &str) -> Result<String, String> {
    let rest = rest.trim();
    for (word, negate, regex) in [
        ("does not include ", true, false),
        ("includes ", false, false),
        ("regex does not match ", true, true),
        ("regex matches ", false, true),
    ] {
        let Some(arg) = rest.strip_prefix(word) else {
            continue;
        };
        let arg = arg.trim();
        let test = if regex {
            if !(arg.starts_with('/') && arg.rfind('/').is_some_and(|i| i > 0)) {
                return Err("a regular expression is written /like this/".into());
            }
            format!("{arg}.matches({subject})")
        } else {
            format!("{subject}.lower().contains({})", quote(&arg.to_lowercase()))
        };
        return Ok(if negate { format!("!({test})") } else { test });
    }
    Err("expected includes, does not include, regex matches or regex does not match".into())
}

fn tag_of(arg: &str) -> String {
    arg.trim().trim_start_matches('#').to_lowercase()
}

/// One non-boolean filter instruction as a Bases expression.
fn simple_filter(text: &str) -> Result<String, String> {
    let t = text.trim();
    let lower = t.to_lowercase();
    match lower.as_str() {
        "done" => return Ok("task.checked".into()),
        "not done" => return Ok("!task.checked".into()),
        "is recurring" => return Ok("task.recurrence != null".into()),
        "is not recurring" => return Ok("task.recurrence == null".into()),
        "no tags" => return Ok("task.tags.isEmpty()".into()),
        "has tags" => return Ok("!task.tags.isEmpty()".into()),
        "exclude sub-items" => return Ok("task.parent == null".into()),
        "no id" => return Ok("task.id == null".into()),
        "has id" => return Ok("task.id != null".into()),
        _ => {}
    }
    for (prefix, has) in [("no ", false), ("has ", true)] {
        if let Some(f) = lower
            .strip_prefix(prefix)
            .and_then(|r| r.strip_suffix(" date"))
            .and_then(date_field)
        {
            return Ok(format!("task.{f} {} null", if has { "!=" } else { "==" }));
        }
    }
    let (head, rest) = lower.split_once(' ').unwrap_or((lower.as_str(), ""));
    let original_rest = t.get(head.len()..).unwrap_or("").trim_start();
    if let Some(f) = date_field(head) {
        return date_filter(f, rest);
    }
    match head {
        "priority" => priority_filter(rest),
        "description" => text_filter("task.description", original_rest),
        "path" => text_filter("file.path", original_rest),
        "folder" => text_filter("file.folder", original_rest),
        "filename" => text_filter("file.name", original_rest),
        "heading" => text_filter("(if(task.heading, task.heading, \"\"))", original_rest),
        "tags" | "tag" => {
            for (word, neg) in [
                ("do not include ", true),
                ("include ", false),
                ("does not include ", true),
                ("includes ", false),
            ] {
                if let Some(arg) = lower
                    .strip_prefix("tags ")
                    .or(lower.strip_prefix("tag "))
                    .and_then(|r| r.strip_prefix(word))
                {
                    let c = format!("task.tags.contains({})", quote(&tag_of(arg)));
                    return Ok(if neg { format!("!{c}") } else { c });
                }
            }
            Err("expected `tags include #tag` or `tags do not include #tag`".into())
        }
        "status.type" => {
            let words: Vec<&str> = rest.split_whitespace().collect();
            let (neg, ty) = match words.as_slice() {
                ["is", "not", ty] => (true, *ty),
                ["is", ty] => (false, *ty),
                _ => return Err("expected `status.type is TODO` (or is not)".into()),
            };
            let ty = super::status::StatusType::parse(ty)
                .ok_or_else(|| format!("{ty} is not a status type"))?;
            Ok(format!(
                "task.status {} {}",
                if neg { "!=" } else { "==" },
                quote(ty.as_str())
            ))
        }
        "filter" if lower.starts_with("filter by function") => {
            Err("`filter by function` runs JavaScript, which Writer never runs".into())
        }
        "happens" => Err("`happens` has no equivalent; use due, scheduled or start".into()),
        "is" if lower == "is blocked" || lower == "is blocking" => {
            Err("task dependencies are not queryable yet".into())
        }
        "depends" | "id" => Err("task dependencies are not queryable yet".into()),
        _ => Err("this instruction has no Bases equivalent".into()),
    }
}

// ---- boolean combinations -------------------------------------------------

#[derive(Debug, PartialEq)]
enum Tok {
    Open,
    Close,
    Word(String),
}

fn tokenize(s: &str) -> Vec<Tok> {
    let mut out = Vec::new();
    let mut word = String::new();
    let flush = |word: &mut String, out: &mut Vec<Tok>| {
        if !word.trim().is_empty() {
            out.push(Tok::Word(word.trim().to_string()));
        }
        word.clear();
    };
    for c in s.chars() {
        match c {
            '(' => {
                flush(&mut word, &mut out);
                out.push(Tok::Open);
            }
            ')' => {
                flush(&mut word, &mut out);
                out.push(Tok::Close);
            }
            c => word.push(c),
        }
    }
    flush(&mut word, &mut out);
    out
}

fn is_operator(w: &str) -> Option<&'static str> {
    Some(match w.to_ascii_uppercase().as_str() {
        "AND" => "&&",
        "OR" => "||",
        "XOR" => "xor",
        "AND NOT" => "&& !",
        "OR NOT" => "|| !",
        _ => return None,
    })
}

/// `NOT? (a) OP (b) …`, parentheses nesting, folded left to right.
fn boolean(tokens: &[Tok], at: &mut usize) -> Result<String, String> {
    let mut acc: Option<String> = None;
    let mut pending: Option<&'static str> = None;
    while *at < tokens.len() {
        let negate = matches!(&tokens[*at], Tok::Word(w) if w.eq_ignore_ascii_case("not"));
        if negate {
            *at += 1;
        }
        let term = match tokens.get(*at) {
            Some(Tok::Open) => {
                *at += 1;
                let inner = boolean_or_simple(tokens, at)?;
                if tokens.get(*at) != Some(&Tok::Close) {
                    return Err("a parenthesis is not closed".into());
                }
                *at += 1;
                inner
            }
            _ => return Err("each filter in a combination is wrapped in parentheses".into()),
        };
        let term = if negate { format!("!({term})") } else { term };
        acc = Some(match (acc, pending.take()) {
            (None, _) => term,
            (Some(a), Some("xor")) => format!("(({a}) != ({term}))"),
            (Some(a), Some(op)) if op.ends_with('!') => {
                let op = op.trim_end_matches([' ', '!']);
                format!("(({a}) {op} !({term}))")
            }
            (Some(a), Some(op)) => format!("(({a}) {op} ({term}))"),
            (Some(_), None) => return Err("two filters need AND, OR or XOR between them".into()),
        });
        match tokens.get(*at) {
            Some(Tok::Word(w)) if is_operator(w).is_some() => {
                pending = is_operator(w);
                *at += 1;
            }
            _ => break,
        }
    }
    acc.ok_or_else(|| "empty combination".into())
}

/// The inside of one pair of parentheses: another combination or one instruction.
fn boolean_or_simple(tokens: &[Tok], at: &mut usize) -> Result<String, String> {
    match tokens.get(*at) {
        Some(Tok::Word(w)) if !w.eq_ignore_ascii_case("not") && is_operator(w).is_none() => {
            let text = w.clone();
            *at += 1;
            simple_filter(&text)
        }
        _ => boolean(tokens, at),
    }
}

fn filter_line(text: &str) -> Result<String, String> {
    if !text.contains('(') {
        return simple_filter(text);
    }
    let tokens = tokenize(text);
    let mut at = 0;
    let out = boolean(&tokens, &mut at)?;
    if at != tokens.len() {
        return Err("unexpected text after the combination".into());
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Sort, group, layout
// ---------------------------------------------------------------------------

/// A sort or group key: a property and the formulas it needs.
struct Key {
    property: String,
    desc: bool,
    formula: Option<(String, String)>,
}

fn date_key(f: &str) -> Key {
    Key {
        property: format!("formula.{f}_order"),
        desc: false,
        formula: Some((
            format!("{f}_order"),
            format!("if(task.{f} != null, task.{f}, date(\"9999-12-31\"))"),
        )),
    }
}

fn plain(property: &str, desc: bool) -> Key {
    Key {
        property: property.into(),
        desc,
        formula: None,
    }
}

fn sort_key(spec: &str) -> Result<Key, String> {
    let (field, reverse) = match spec.strip_suffix(" reverse") {
        Some(f) => (f.trim(), true),
        None => (spec.trim(), false),
    };
    let mut k = match field {
        f if date_field(f).is_some() => date_key(date_field(f).unwrap_or("due")),
        "priority" => Key {
            property: "formula.priority_order".into(),
            desc: false,
            formula: Some((
                "priority_order".into(),
                "if(task.priority == \"highest\", 0, if(task.priority == \"high\", 1, if(task.priority == \"medium\", 2, if(task.priority == \"low\", 4, if(task.priority == \"lowest\", 5, 3)))))".into(),
            )),
        },
        "urgency" => plain("task.urgency", true),
        "description" => plain("task.description", false),
        "path" => plain("file.path", false),
        "filename" => plain("file.name", false),
        "heading" => plain("task.heading", false),
        "status" => plain("task.checked", false),
        "status.type" => plain("task.status", false),
        "id" => plain("task.id", false),
        "function" | "random" | "happens" | "tag" | "recurring" | "backlink" => {
            return Err(format!("`sort by {field}` has no Bases equivalent"))
        }
        f if f.starts_with("function") => {
            return Err("`sort by function` runs JavaScript, which Writer never runs".into())
        }
        other => return Err(format!("cannot sort by {other}")),
    };
    k.desc ^= reverse;
    Ok(k)
}

fn group_key(spec: &str) -> Result<Key, String> {
    let (field, reverse) = match spec.strip_suffix(" reverse") {
        Some(f) => (f.trim(), true),
        None => (spec.trim(), false),
    };
    let property = match field {
        f if date_field(f).is_some() => format!("task.{}", date_field(f).unwrap_or("due")),
        "priority" => "task.priority".into(),
        "urgency" => "task.urgency".into(),
        "path" => "file.path".into(),
        "folder" => "file.folder".into(),
        "filename" => "file.name".into(),
        "heading" => "task.heading".into(),
        "status" => "task.checked".into(),
        "status.type" => "task.status".into(),
        f if f.starts_with("function") => {
            return Err("`group by function` runs JavaScript, which Writer never runs".into())
        }
        other => return Err(format!("cannot group by {other}")),
    };
    Ok(plain(&property, reverse))
}

/// Layout elements and the column each shows.
const ELEMENTS: [(&str, &str); 13] = [
    ("priority", "task.priority"),
    ("due date", "task.due"),
    ("scheduled date", "task.scheduled"),
    ("start date", "task.start"),
    ("created date", "task.created"),
    ("done date", "task.done"),
    ("cancelled date", "task.cancelled"),
    ("recurrence rule", "task.recurrence"),
    ("tags", "task.tags"),
    ("id", "task.id"),
    ("depends on", "task.depends_on"),
    ("on completion", "task.on_completion"),
    ("urgency", "task.urgency"),
];

/// Chrome of the plugin's results that a base view has no counterpart for (or draws itself).
const IGNORED_ELEMENTS: [&str; 7] = [
    "toolbar",
    "edit button",
    "postpone button",
    "nested backlink",
    "task count",
    "group count",
    "backlink",
];

pub const DEFAULT_COLUMNS: [&str; 8] = [
    "task.checked",
    "task.description",
    "task.priority",
    "task.due",
    "task.scheduled",
    "task.start",
    "task.recurrence",
    "file.name",
];

fn layout(columns: &mut Vec<String>, show: bool, element: &str) -> Result<(), String> {
    if IGNORED_ELEMENTS.contains(&element) && element != "backlink" {
        return Ok(());
    }
    let column = if element == "backlink" {
        "file.name"
    } else {
        ELEMENTS
            .iter()
            .find(|(e, _)| *e == element)
            .map(|(_, c)| *c)
            .ok_or_else(|| {
                if element == "tree" {
                    "`tree` (nested tasks) has no Bases equivalent yet".to_string()
                } else {
                    format!("`{element}` is not a task element")
                }
            })?
    };
    columns.retain(|c| c != column);
    if show {
        columns.push(column.to_string());
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// The conversion
// ---------------------------------------------------------------------------

/// Lower a tasks block (its inner text) to a `rows: tasks` base.
pub fn convert(source: &str) -> Conversion {
    let mut unmapped: Vec<Unmapped> = Vec::new();
    let mut filters: Vec<String> = Vec::new();
    let mut sorts: Vec<Key> = Vec::new();
    let mut groups: Vec<Key> = Vec::new();
    let mut limit: Option<u64> = None;
    let mut columns: Vec<String> = DEFAULT_COLUMNS.iter().map(|c| c.to_string()).collect();
    for (line, text) in instructions(source) {
        let lower = text.trim().to_lowercase();
        let result: Result<(), String> = (|| {
            if matches!(
                lower.as_str(),
                "ignore global query" | "explain" | "short mode" | "full mode" | "short" | "full"
            ) {
                return Ok(());
            }
            if let Some(spec) = lower.strip_prefix("sort by ") {
                sorts.push(sort_key(spec)?);
            } else if let Some(spec) = lower.strip_prefix("group by ") {
                if !groups.is_empty() {
                    return Err(
                        "Bases groups by one property; this is the second `group by`".into(),
                    );
                }
                groups.push(group_key(spec)?);
            } else if let Some(rest) = lower.strip_prefix("limit groups") {
                let _ = rest;
                return Err("`limit groups` has no Bases equivalent".into());
            } else if let Some(n) = lower
                .strip_prefix("limit to ")
                .or(lower.strip_prefix("limit "))
            {
                let n = n
                    .trim()
                    .trim_end_matches(" tasks")
                    .trim_end_matches(" task")
                    .trim();
                limit = Some(n.parse().map_err(|_| format!("{n:?} is not a number"))?);
            } else if let Some(el) = lower.strip_prefix("hide ") {
                layout(&mut columns, false, el.trim())?;
            } else if let Some(el) = lower.strip_prefix("show ") {
                layout(&mut columns, true, el.trim())?;
            } else if lower.starts_with("preset ") {
                return Err("presets live in the Tasks plugin's settings".into());
            } else {
                filters.push(filter_line(&text)?);
            }
            Ok(())
        })();
        if let Err(reason) = result {
            unmapped.push(Unmapped {
                line,
                text: text.trim().to_string(),
                reason,
            });
        }
    }
    if !unmapped.is_empty() {
        return Conversion {
            base: None,
            unmapped,
        };
    }
    let mut formulas: Vec<(String, String)> = Vec::new();
    for k in sorts.iter().chain(&groups) {
        if let Some(f) = &k.formula {
            if !formulas.iter().any(|(n, _)| *n == f.0) {
                formulas.push(f.clone());
            }
        }
    }
    let mut sort: Vec<SortKey> = sorts
        .iter()
        .map(|k| SortKey {
            property: k.property.clone(),
            direction: if k.desc {
                Direction::Desc
            } else {
                Direction::Asc
            },
            extra: Vec::new(),
        })
        .collect();
    if sort.is_empty() {
        // the plugin's default order: open before closed, most urgent first, then by file
        sort = [
            ("task.checked", false),
            ("task.urgency", true),
            ("file.path", false),
        ]
        .iter()
        .map(|(p, desc)| SortKey {
            property: (*p).into(),
            direction: if *desc {
                Direction::Desc
            } else {
                Direction::Asc
            },
            extra: Vec::new(),
        })
        .collect();
    }
    let mut view = View::default_table();
    view.name = "Tasks".into();
    view.order = Some(columns);
    view.sort = sort;
    view.limit = limit;
    view.group_by = groups.first().map(|k| GroupBy {
        property: k.property.clone(),
        direction: if k.desc {
            Direction::Desc
        } else {
            Direction::Asc
        },
        extra: Vec::new(),
    });
    let mut doc = Document::empty(RowKind::Tasks);
    doc.filters =
        (!filters.is_empty()).then(|| Filter::And(filters.into_iter().map(Filter::Expr).collect()));
    doc.formulas = formulas;
    doc.views = vec![view];
    Conversion {
        base: Some(doc.to_yaml()),
        unmapped,
    }
}
