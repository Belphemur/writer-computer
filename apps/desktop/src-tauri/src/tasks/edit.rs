//! Task writes as pure text transforms: toggle (with the done date and the next occurrence of a
//! recurring task), set or clear one field, append a task. Text in, text out; `ops.rs` does the
//! file I/O through `vault_ops`.
//!
//! Byte-minimal: only the lines of the task change, line endings and the rest of the file stay as
//! they are, and an existing token has only its value replaced (`grammar::ParsedTask::with_*`).
//! Behaviour follows the Tasks plugin's `Task.handleNewStatus` (MIT, see `THIRD_PARTY_NOTICES.md`).

use super::date::Day;
use super::grammar::{self, parse_task, Field, ParsedTask, Priority};
use super::recurrence;
use super::settings::TaskSettings;
use super::status::StatusType;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum EditError {
    #[error("the file has no line {0}")]
    NoLine(usize),
    #[error("line {0} is not a task")]
    NotATask(usize),
    #[error("the task changed since it was listed; refresh and try again")]
    Moved,
    #[error("{0}")]
    Invalid(String),
}

/// What a write changed: the file text and the line range now holding the task's lines.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Edited {
    pub text: String,
    /// 1-based line numbers of the replacement lines (empty when the task was removed).
    pub lines: Vec<usize>,
}

/// Split `text` around its `line_no`-th line (1-based): the bytes before, the line without its
/// terminator, the terminator, the bytes after.
fn split_line(text: &str, line_no: usize) -> Option<(&str, &str, &str, &str)> {
    if line_no == 0 {
        return None;
    }
    let mut start = 0;
    for (i, raw) in text.split_inclusive('\n').enumerate() {
        if i + 1 == line_no {
            let body = raw.trim_end_matches(['\n', '\r']);
            return Some((
                &text[..start],
                body,
                &raw[body.len()..],
                &text[start + raw.len()..],
            ));
        }
        start += raw.len();
    }
    None
}

/// Replace one line of `text` by `f(line)`'s lines (none removes it with its terminator).
fn replace_line(
    text: &str,
    line_no: usize,
    f: impl FnOnce(&str) -> Result<Vec<String>, EditError>,
) -> Result<Edited, EditError> {
    let (before, line, eol, after) = split_line(text, line_no).ok_or(EditError::NoLine(line_no))?;
    let new = f(line)?;
    let joiner = if eol.is_empty() { "\n" } else { eol };
    let joiner = if joiner.contains('\r') && eol.is_empty() {
        "\r\n"
    } else {
        joiner
    };
    let mut out = String::with_capacity(text.len() + 32);
    out.push_str(before);
    for (i, l) in new.iter().enumerate() {
        out.push_str(l);
        // the last replacement line keeps the original terminator
        out.push_str(if i + 1 < new.len() { joiner } else { eol });
    }
    out.push_str(after);
    Ok(Edited {
        lines: (line_no..line_no + new.len()).collect(),
        text: out,
    })
}

fn task_at(line: &str, line_no: usize) -> Result<ParsedTask, EditError> {
    parse_task(line).ok_or(EditError::NotATask(line_no))
}

/// Refuse to write when the caller listed a different task than the line holds now.
fn check_expect(p: &ParsedTask, expect: Option<&str>) -> Result<(), EditError> {
    match expect {
        Some(d) if d != p.fields.description => Err(EditError::Moved),
        _ => Ok(()),
    }
}

/// Apply `edit` to a line and reparse it, so chained edits see the positions of the new text.
fn chain(
    line: String,
    n: usize,
    edit: impl FnOnce(&ParsedTask, &str) -> String,
) -> Result<String, EditError> {
    let p = task_at(&line, n)?;
    Ok(edit(&p, &line))
}

/// The dates of the next occurrence of `p` (due, scheduled, start keep their distance to the
/// reference date), or `None` when it has no recurrence or the rule never lands.
fn next_dates(p: &ParsedTask, today: Day) -> Option<[(Field, Option<Day>); 3]> {
    let rule = recurrence::parse(p.fields.recurrence.as_deref()?)?;
    let reference = p.fields.reference_date();
    let next = rule.next(reference.unwrap_or(today), today)?;
    let shift = |d: Option<Day>| d.map(|d| next.add_days(d.0 - reference.map_or(0, |r| r.0)));
    Some([
        (Field::Start, shift(p.fields.start)),
        (Field::Scheduled, shift(p.fields.scheduled)),
        (Field::Due, shift(p.fields.due)),
    ])
}

/// The lines a toggle of `line` leaves in the file.
pub fn toggle_line(
    line: &str,
    n: usize,
    s: &TaskSettings,
    today: Day,
) -> Result<Vec<String>, EditError> {
    let p = task_at(line, n)?;
    set_status_line(line, n, s.statuses.next_symbol(p.status), s, today)
}

/// The lines left when the task is completed (the status `x`, or the first DONE one of the vault):
/// a recurring task writes its next occurrence like a toggle does.
pub fn complete_line(
    line: &str,
    n: usize,
    s: &TaskSettings,
    today: Day,
) -> Result<Vec<String>, EditError> {
    let done = s
        .statuses
        .all()
        .iter()
        .find(|st| st.symbol == 'x' && st.kind == StatusType::Done)
        .or_else(|| {
            s.statuses
                .all()
                .iter()
                .find(|st| st.kind == StatusType::Done)
        })
        .map_or('x', |st| st.symbol);
    set_status_line(line, n, done, s, today)
}

/// The lines left when the task's status becomes `new`: the dates it gains or loses, the next
/// occurrence of a recurring task completed, `on completion: delete`.
pub fn set_status_line(
    line: &str,
    n: usize,
    new: char,
    s: &TaskSettings,
    today: Day,
) -> Result<Vec<String>, EditError> {
    let p = task_at(line, n)?;
    let old = p.status;
    if new == old {
        return Ok(vec![line.to_string()]);
    }
    let (old_kind, new_kind) = (s.statuses.kind_of(old), s.statuses.kind_of(new));
    let fmt = s.format;
    let stamp = |kind: StatusType, field: Field, line: String| -> Result<String, EditError> {
        chain(line, n, |p, l| {
            let date = if new_kind != kind {
                None
            } else if old_kind != kind && s.set_done_date {
                Some(today)
            } else {
                p.fields.date(field)
            };
            p.with_date(l, field, date, fmt)
        })
    };
    let toggled = chain(line.to_string(), n, |p, l| p.with_status(l, new))?;
    let toggled = stamp(StatusType::Done, Field::Done, toggled)?;
    let toggled = stamp(StatusType::Cancelled, Field::Cancelled, toggled)?;

    let completes = new_kind == StatusType::Done && old_kind != StatusType::Done;
    let next = if completes {
        next_dates(&p, today).map(|dates| {
            let mut l = p.with_status(line, s.statuses.recurrence_symbol(new));
            for field in [Field::Done, Field::Cancelled, Field::Id, Field::DependsOn] {
                l = chain(l, n, |q, t| q.with_field(t, field, None, fmt))?;
            }
            for (field, day) in dates {
                if day.is_some() {
                    l = chain(l, n, |q, t| q.with_date(t, field, day, fmt))?;
                }
            }
            chain(l, n, |q, t| q.without_block(t))
        })
    } else {
        None
    };
    let next = next.transpose()?;
    let delete = completes && p.fields.on_completion.as_deref() == Some("delete");
    Ok(match next {
        Some(next) if delete => vec![next],
        Some(next) if s.recurrence_below => vec![toggled, next],
        Some(next) => vec![next, toggled],
        None if delete => Vec::new(),
        None => vec![toggled],
    })
}

/// How the status of a task changes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StatusChange {
    /// To the next status of the cycle.
    Toggle,
    /// To done.
    Complete,
}

impl StatusChange {
    pub fn lines(
        self,
        line: &str,
        n: usize,
        s: &TaskSettings,
        today: Day,
    ) -> Result<Vec<String>, EditError> {
        match self {
            StatusChange::Toggle => toggle_line(line, n, s, today),
            StatusChange::Complete => complete_line(line, n, s, today),
        }
    }
}

/// Change the status of the task on `line_no` of `text`. `expect` is the description the caller
/// listed.
pub fn change_status(
    text: &str,
    line_no: usize,
    expect: Option<&str>,
    change: StatusChange,
    s: &TaskSettings,
    today: Day,
) -> Result<Edited, EditError> {
    replace_line(text, line_no, |line| {
        check_expect(&task_at(line, line_no)?, expect)?;
        change.lines(line, line_no, s, today)
    })
}

/// Toggle the task on `line_no` of `text`.
pub fn toggle(
    text: &str,
    line_no: usize,
    expect: Option<&str>,
    s: &TaskSettings,
    today: Day,
) -> Result<Edited, EditError> {
    change_status(text, line_no, expect, StatusChange::Toggle, s, today)
}

/// Replace the task on `line_no` by the lines `f` makes of it (the caller's own edit).
pub fn edit_text_line(
    text: &str,
    line_no: usize,
    expect: Option<&str>,
    f: impl FnOnce(&str) -> Result<Vec<String>, EditError>,
) -> Result<Edited, EditError> {
    replace_line(text, line_no, |line| {
        check_expect(&task_at(line, line_no)?, expect)?;
        f(line)
    })
}

/// What a field edit sets: a date, a priority, a recurrence phrase or nothing (clear).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FieldValue {
    Clear,
    Set(String),
}

pub fn parse_field(name: &str) -> Option<Field> {
    Some(match name.trim().to_ascii_lowercase().as_str() {
        "due" => Field::Due,
        "scheduled" => Field::Scheduled,
        "start" => Field::Start,
        "created" => Field::Created,
        "done" => Field::Done,
        "cancelled" => Field::Cancelled,
        "priority" => Field::Priority,
        "recurrence" | "repeat" => Field::Recurrence,
        _ => return None,
    })
}

/// A value checked for `field`: dates are real `YYYY-MM-DD` days, priorities one of the five
/// names, a recurrence a phrase the rules read (so a task never gets one it cannot repeat).
fn validate(field: Field, v: &str) -> Result<String, EditError> {
    let v = v.trim();
    let bad = |what: &str| EditError::Invalid(format!("{v:?} is not {what}"));
    match field {
        Field::Priority => Priority::parse(v)
            .map(|p| p.name().to_string())
            .ok_or_else(|| bad("a priority (highest, high, medium, low, lowest)")),
        Field::Recurrence => recurrence::parse(v)
            .map(|_| v.to_string())
            .ok_or_else(|| bad("a recurrence such as \"every week\"")),
        _ => Day::parse(v)
            .map(|d| d.to_string())
            .ok_or_else(|| bad("a date (YYYY-MM-DD)")),
    }
}

/// The line with `field` set or cleared.
pub fn set_field_line(
    line: &str,
    n: usize,
    field: Field,
    value: &FieldValue,
    s: &TaskSettings,
) -> Result<String, EditError> {
    let p = task_at(line, n)?;
    let v = match value {
        FieldValue::Clear => None,
        FieldValue::Set(v) => Some(validate(field, v)?),
    };
    Ok(p.with_field(line, field, v.as_deref(), s.format))
}

pub fn set_field(
    text: &str,
    line_no: usize,
    expect: Option<&str>,
    field: Field,
    value: &FieldValue,
    s: &TaskSettings,
) -> Result<Edited, EditError> {
    replace_line(text, line_no, |line| {
        check_expect(&task_at(line, line_no)?, expect)?;
        Ok(vec![set_field_line(line, line_no, field, value, s)?])
    })
}

/// Append a task line to `text` (a missing final newline is added first). The new task's line
/// number is in `lines`.
pub fn append_task(text: &str, task_line: &str) -> Edited {
    let eol = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let mut out = text.to_string();
    if !out.is_empty() && !out.ends_with('\n') {
        out.push_str(eol);
    }
    let line_no = out.matches('\n').count() + 1;
    out.push_str(task_line);
    out.push_str(eol);
    Edited {
        text: out,
        lines: vec![line_no],
    }
}

/// The text of a new task: `- [ ] text` with the given fields in the vault's format.
pub fn new_task(
    text: &str,
    fields: &[(Field, String)],
    s: &TaskSettings,
) -> Result<String, EditError> {
    let text = text.trim();
    if text.is_empty() {
        return Err(EditError::Invalid("a task needs some text".into()));
    }
    let mut line = grammar::new_task_line(text);
    for (field, value) in fields {
        let v = validate(*field, value)?;
        let p = task_at(&line, 0)?;
        line = p.with_field(&line, *field, Some(&v), s.format);
    }
    Ok(line)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(s: &str) -> Day {
        Day::parse(s).unwrap()
    }

    fn today() -> Day {
        d("2024-03-15")
    }

    fn toggled(line: &str) -> Vec<String> {
        toggle_line(line, 1, &TaskSettings::default(), today()).unwrap()
    }

    #[test]
    fn plain_toggle_stamps_and_clears_the_done_date() {
        assert_eq!(
            toggled("- [ ] a 📅 2024-03-20"),
            ["- [x] a 📅 2024-03-20 ✅ 2024-03-15"]
        );
        assert_eq!(
            toggled("- [x] a 📅 2024-03-20 ✅ 2024-03-15"),
            ["- [ ] a 📅 2024-03-20"]
        );
        // an existing done date is kept when the status stays done
        let s = TaskSettings {
            set_done_date: false,
            ..Default::default()
        };
        assert_eq!(
            toggle_line("- [ ] a", 1, &s, today()).unwrap(),
            ["- [x] a"],
            "no date when the setting is off"
        );
        // in progress goes to done, cancelled gets its own date
        assert_eq!(toggled("- [/] a"), ["- [x] a ✅ 2024-03-15"]);
        assert_eq!(toggled("- [-] a ❌ 2024-01-01"), ["- [ ] a"]);
    }

    use crate::tasks::grammar::Format;

    #[test]
    fn dataview_vaults_get_dataview_tokens() {
        let s = TaskSettings {
            format: Format::Dataview,
            ..Default::default()
        };
        assert_eq!(
            toggle_line("- [ ] a  [due:: 2024-03-20]", 1, &s, today()).unwrap(),
            ["- [x] a  [due:: 2024-03-20]  [completion:: 2024-03-15]"]
        );
    }

    #[test]
    fn recurring_tasks_write_the_next_occurrence_above() {
        assert_eq!(
            toggled("- [ ] water 📅 2024-03-15 🔁 every week #home ^b1"),
            [
                "- [ ] water 📅 2024-03-22 🔁 every week #home",
                "- [x] water 📅 2024-03-15 🔁 every week #home ✅ 2024-03-15 ^b1",
            ]
        );
        // the other dates keep their distance to the due date
        assert_eq!(
            toggled("- [ ] a 🛫 2024-03-10 ⏳ 2024-03-12 📅 2024-03-15 🔁 every 2 days"),
            [
                "- [ ] a 🛫 2024-03-12 ⏳ 2024-03-14 📅 2024-03-17 🔁 every 2 days",
                "- [x] a 🛫 2024-03-10 ⏳ 2024-03-12 📅 2024-03-15 🔁 every 2 days ✅ 2024-03-15",
            ]
        );
        // when done counts from today
        assert_eq!(
            toggled("- [ ] a 📅 2024-03-01 🔁 every week when done")[0],
            "- [ ] a 📅 2024-03-22 🔁 every week when done"
        );
        // a recurrence without any date repeats with none
        assert_eq!(toggled("- [ ] a 🔁 every day")[0], "- [ ] a 🔁 every day");
        // below, when asked
        let s = TaskSettings {
            recurrence_below: true,
            ..Default::default()
        };
        let got = toggle_line("- [ ] a 📅 2024-03-15 🔁 every day", 1, &s, today()).unwrap();
        assert!(got[0].starts_with("- [x]") && got[1].starts_with("- [ ]"));
        // an unreadable rule is a plain toggle
        assert_eq!(toggled("- [ ] a 📅 2024-03-15 🔁 every fortnight").len(), 1);
    }

    #[test]
    fn next_occurrence_drops_ids_and_blocks_and_restarts_the_status() {
        let got = toggled("- [ ] a 📅 2024-03-15 🔁 every day 🆔 abc ⛔ z ^blk");
        assert_eq!(got[0], "- [ ] a 📅 2024-03-16 🔁 every day");
        assert_eq!(
            got[1],
            "- [x] a 📅 2024-03-15 🔁 every day 🆔 abc ⛔ z ✅ 2024-03-15 ^blk"
        );
    }

    #[test]
    fn completing_goes_to_done_whatever_the_cycle() {
        let s = TaskSettings::default();
        let got = complete_line("- [/] a 📅 2024-03-15 🔁 every day", 1, &s, today()).unwrap();
        assert_eq!(got[1], "- [x] a 📅 2024-03-15 🔁 every day ✅ 2024-03-15");
        assert_eq!(
            complete_line("- [x] a", 1, &s, today()).unwrap(),
            ["- [x] a"]
        );
        assert_eq!(
            complete_line("- [-] a", 1, &s, today()).unwrap(),
            ["- [x] a ✅ 2024-03-15"]
        );
    }

    #[test]
    fn on_completion_delete_removes_the_done_task() {
        assert!(toggled("- [ ] a 🏁 delete").is_empty());
        assert_eq!(
            toggled("- [ ] a 📅 2024-03-15 🔁 every day 🏁 delete"),
            ["- [ ] a 📅 2024-03-16 🔁 every day 🏁 delete"]
        );
        // keep is just visible
        assert_eq!(toggled("- [ ] a 🏁 keep").len(), 1);
    }

    #[test]
    fn file_level_toggle_changes_only_the_task_lines() {
        let text = "# T\r\n- [ ] a 📅 2024-03-15 🔁 every day\r\nafter\r\n";
        let e = toggle(text, 2, Some("a"), &TaskSettings::default(), today()).unwrap();
        assert_eq!(
            e.text,
            "# T\r\n- [ ] a 📅 2024-03-16 🔁 every day\r\n- [x] a 📅 2024-03-15 🔁 every day ✅ 2024-03-15\r\nafter\r\n"
        );
        assert_eq!(e.lines, [2, 3]);
        // the last line without a terminator stays without one
        let e = toggle("- [ ] a", 1, None, &TaskSettings::default(), today()).unwrap();
        assert_eq!(e.text, "- [x] a ✅ 2024-03-15");
        // deleting removes the line and its terminator
        let e = toggle(
            "x\n- [ ] a 🏁 delete\ny\n",
            2,
            None,
            &TaskSettings::default(),
            today(),
        )
        .unwrap();
        assert_eq!(e.text, "x\ny\n");
    }

    #[test]
    fn stale_or_wrong_targets_are_refused() {
        let s = TaskSettings::default();
        let text = "a\n- [ ] one\n";
        assert_eq!(
            toggle(text, 1, None, &s, today()),
            Err(EditError::NotATask(1))
        );
        assert_eq!(
            toggle(text, 9, None, &s, today()),
            Err(EditError::NoLine(9))
        );
        assert_eq!(
            toggle(text, 2, Some("two"), &s, today()),
            Err(EditError::Moved)
        );
    }

    #[test]
    fn custom_status_cycles() {
        use crate::tasks::status::{Status, StatusTable};
        let s = TaskSettings {
            statuses: StatusTable::default().with_first(vec![
                Status::new(' ', "Todo", '!', StatusType::Todo),
                Status::new('!', "Important", 'x', StatusType::Todo),
            ]),
            ..Default::default()
        };
        assert_eq!(toggle_line("- [ ] a", 1, &s, today()).unwrap(), ["- [!] a"]);
        assert_eq!(
            toggle_line("- [!] a", 1, &s, today()).unwrap(),
            ["- [x] a ✅ 2024-03-15"]
        );
    }

    #[test]
    fn set_and_clear_fields() {
        let s = TaskSettings::default();
        let set =
            |line: &str, f, v: &str| set_field_line(line, 1, f, &FieldValue::Set(v.into()), &s);
        assert_eq!(
            set("- [ ] a", Field::Due, "2024-04-01").unwrap(),
            "- [ ] a 📅 2024-04-01"
        );
        assert_eq!(
            set("- [ ] a 📅 2024-01-01 ^x", Field::Due, "2024-04-01").unwrap(),
            "- [ ] a 📅 2024-04-01 ^x"
        );
        assert_eq!(
            set("- [ ] a", Field::Priority, "High").unwrap(),
            "- [ ] a ⏫"
        );
        assert_eq!(
            set("- [ ] a", Field::Recurrence, "every month").unwrap(),
            "- [ ] a 🔁 every month"
        );
        assert!(set("- [ ] a", Field::Due, "tomorrow").is_err());
        assert!(set("- [ ] a", Field::Recurrence, "someday").is_err());
        assert!(set("- [ ] a", Field::Priority, "urgent").is_err());
        assert_eq!(
            set_field_line(
                "- [ ] a ⏫ 📅 2024-01-01",
                1,
                Field::Priority,
                &FieldValue::Clear,
                &s
            )
            .unwrap(),
            "- [ ] a 📅 2024-01-01"
        );
        assert!(set_field_line("not a task", 1, Field::Due, &FieldValue::Clear, &s).is_err());
    }

    #[test]
    fn appending_and_new_tasks() {
        let e = append_task("# Inbox\n", "- [ ] new");
        assert_eq!(e.text, "# Inbox\n- [ ] new\n");
        assert_eq!(e.lines, [2]);
        assert_eq!(append_task("a", "- [ ] n").text, "a\n- [ ] n\n");
        assert_eq!(append_task("", "- [ ] n").lines, [1]);
        assert_eq!(append_task("a\r\n", "- [ ] n").text, "a\r\n- [ ] n\r\n");
        let s = TaskSettings::default();
        let line = new_task(
            "call Ann",
            &[
                (Field::Due, "2024-03-20".into()),
                (Field::Priority, "high".into()),
            ],
            &s,
        )
        .unwrap();
        assert_eq!(line, "- [ ] call Ann 📅 2024-03-20 ⏫");
        assert!(new_task("  ", &[], &s).is_err());
    }
}
