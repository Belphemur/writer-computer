//! Recurrence rules: the Tasks plugin's natural-language phrases (`every 2 weeks`, `every weekday`,
//! `every month on the 15th`, `every week on Monday, Wednesday when done`) as our own rule type
//! and the next date after a reference day. No calendar crate: the arithmetic is `tasks::date`'s.
//!
//! Semantics follow the plugin (`src/Task/Recurrence.ts`, MIT, see `THIRD_PARTY_NOTICES.md`):
//! the next date is strictly after the reference date (the due date, else scheduled, else start;
//! today when the task has none), `when done` counts from today instead, a plain month or year
//! rule clamps the day (Jan 31 + 1 month = Feb 28/29) and a rule that fixes the day
//! (`on the 31st`) skips the months that lack it. Other dates of the task keep their distance to
//! the reference date (`Occurrence.next`, `shift`).

use super::date::Day;
use crate::bases::datetime::days_in_month;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Freq {
    Day,
    Week,
    Month,
    Year,
}

/// Where in the month a monthly rule lands when it fixes the day.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MonthPos {
    /// Same day number as the reference date (clamped to the month's end).
    Same,
    /// `on the 15th` (1..=31) or `on the last day` (-1).
    Day(i8),
    /// `on the 2nd Tuesday` / `on the last Friday`: the n-th (1..=4, -1 = last) weekday, 0 = Sunday.
    Nth(i8, u8),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Rule {
    pub interval: u32,
    pub freq: Freq,
    /// Weekly rules: the allowed weekdays (0 = Sunday); empty = the reference date's weekday.
    pub weekdays: Vec<u8>,
    pub month: MonthPos,
    pub when_done: bool,
}

const WEEKDAYS: [&str; 7] = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
];

fn weekday_word(w: &str) -> Option<u8> {
    let w = w.strip_suffix('s').unwrap_or(w);
    WEEKDAYS.iter().position(|d| *d == w).map(|i| i as u8)
}

fn ordinal(w: &str) -> Option<i8> {
    match w {
        "first" => return Some(1),
        "second" => return Some(2),
        "third" => return Some(3),
        "fourth" => return Some(4),
        "last" => return Some(-1),
        _ => {}
    }
    let digits: String = w.chars().take_while(char::is_ascii_digit).collect();
    let suffix = &w[digits.len()..];
    if !matches!(suffix, "st" | "nd" | "rd" | "th") {
        return None;
    }
    let n: i8 = digits.parse().ok()?;
    (1..=31).contains(&n).then_some(n)
}

/// Parse a rule phrase; `None` when it is not one (a task keeps a phrase it cannot read as text).
pub fn parse(text: &str) -> Option<Rule> {
    let lower = text.trim().to_lowercase();
    let (body, when_done) = match lower.strip_suffix("when done") {
        Some(b) if b.ends_with(char::is_whitespace) => (b.trim(), true),
        _ => (lower.as_str(), false),
    };
    let spaced = body.replace(',', " , ");
    let words: Vec<&str> = spaced.split_whitespace().collect();
    let mut it = words.iter().copied().peekable();
    if it.next()? != "every" {
        return None;
    }
    let mut rule = Rule {
        interval: 1,
        freq: Freq::Day,
        weekdays: Vec::new(),
        month: MonthPos::Same,
        when_done,
    };
    let first = *it.peek()?;
    if first == "weekday" {
        it.next();
        rule.freq = Freq::Week;
        rule.weekdays = vec![1, 2, 3, 4, 5];
        return it.next().is_none().then_some(rule);
    }
    if weekday_word(first).is_some() {
        rule.freq = Freq::Week;
        rule.weekdays = weekday_list(&mut it)?;
        return it.next().is_none().then_some(rule);
    }
    if first == "other" {
        it.next();
        rule.interval = 2;
    } else if let Ok(n) = first.parse::<u32>() {
        if n == 0 || n > 1000 {
            return None;
        }
        it.next();
        rule.interval = n;
    }
    rule.freq = match it.next()? {
        "day" | "days" => Freq::Day,
        "week" | "weeks" => Freq::Week,
        "month" | "months" => Freq::Month,
        "year" | "years" => Freq::Year,
        _ => return None,
    };
    if it.peek().is_none() {
        return Some(rule);
    }
    if it.next()? != "on" {
        return None;
    }
    match rule.freq {
        Freq::Week => rule.weekdays = weekday_list(&mut it)?,
        Freq::Month => {
            if *it.peek()? == "the" {
                it.next();
            }
            let nth = ordinal(it.next()?)?;
            rule.month = match it.next() {
                Some("day") | None if nth == -1 || (1..=31).contains(&nth) => MonthPos::Day(nth),
                Some(w) => {
                    let wd = weekday_word(w)?;
                    if nth > 4 {
                        return None;
                    }
                    MonthPos::Nth(nth, wd)
                }
                None => return None,
            };
        }
        _ => return None,
    }
    it.next().is_none().then_some(rule)
}

fn weekday_list<'a>(
    it: &mut std::iter::Peekable<impl Iterator<Item = &'a str>>,
) -> Option<Vec<u8>> {
    let mut out: Vec<u8> = Vec::new();
    loop {
        let w = it.next()?;
        let d = weekday_word(w)?;
        if !out.contains(&d) {
            out.push(d);
        }
        match it.peek() {
            Some(&",") | Some(&"and") => {
                it.next();
                if it.peek() == Some(&"and") {
                    it.next();
                }
            }
            _ => break,
        }
    }
    Some(out)
}

fn nth_weekday(year: i64, month: u32, nth: i8, weekday: u8) -> Option<Day> {
    if nth > 0 {
        let first = Day::ymd(year, month, 1)?;
        let shift = (weekday as i64 - first.weekday() as i64).rem_euclid(7);
        let d = first.add_days(shift + 7 * (nth as i64 - 1));
        (d.civil().1 == month).then_some(d)
    } else {
        let last = Day::ymd(year, month, days_in_month(year, month))?;
        let back = (last.weekday() as i64 - weekday as i64).rem_euclid(7);
        Some(last.add_days(-back))
    }
}

impl Rule {
    /// The day the rule's next occurrence lands on, strictly after `reference` (`today` for a
    /// `when done` rule). `None` only for a rule that never lands (a bounded search gives up).
    pub fn next(&self, reference: Day, today: Day) -> Option<Day> {
        let base = if self.when_done { today } else { reference };
        let n = self.interval as i64;
        match self.freq {
            Freq::Day => Some(base.add_days(n)),
            Freq::Week if self.weekdays.is_empty() => Some(base.add_days(7 * n)),
            Freq::Week => {
                let anchor = base.monday();
                (1..=7 * n + 7).map(|d| base.add_days(d)).find(|c| {
                    ((c.monday().0 - anchor.0) / 7) % n == 0 && self.weekdays.contains(&c.weekday())
                })
            }
            Freq::Month => match self.month {
                MonthPos::Same => Some(base.add_months(n)),
                pos => {
                    let (y, m, _) = base.civil();
                    let start = y * 12 + (m as i64 - 1);
                    (0..=240).find_map(|k| {
                        let idx = start + k * n;
                        let (year, month) = (idx.div_euclid(12), idx.rem_euclid(12) as u32 + 1);
                        let day = match pos {
                            MonthPos::Day(-1) => Day::ymd(year, month, days_in_month(year, month)),
                            MonthPos::Day(d) => Day::ymd(year, month, d as u32),
                            MonthPos::Nth(nth, wd) => nth_weekday(year, month, nth, wd),
                            MonthPos::Same => None,
                        }?;
                        (day > base).then_some(day)
                    })
                }
            },
            Freq::Year => Some(base.add_months(12 * n)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(s: &str) -> Day {
        Day::parse(s).unwrap()
    }

    /// `(rule, reference, today, next)`.
    const CASES: &[(&str, &str, &str, &str)] = &[
        ("every day", "2024-03-15", "2024-03-20", "2024-03-16"),
        ("every 3 days", "2024-03-15", "2024-03-15", "2024-03-18"),
        ("every other day", "2024-03-15", "2024-03-15", "2024-03-17"),
        ("every week", "2024-03-15", "2024-03-15", "2024-03-22"),
        ("every 2 weeks", "2024-03-15", "2024-03-15", "2024-03-29"),
        // weekday rules: Friday 2024-03-15 -> Monday
        ("every weekday", "2024-03-15", "2024-03-15", "2024-03-18"),
        ("every weekday", "2024-03-13", "2024-03-15", "2024-03-14"),
        ("every monday", "2024-03-15", "2024-03-15", "2024-03-18"),
        (
            "every week on Monday, Wednesday",
            "2024-03-18",
            "2024-03-18",
            "2024-03-20",
        ),
        (
            "every week on Monday and Wednesday",
            "2024-03-20",
            "2024-03-20",
            "2024-03-25",
        ),
        (
            "every 2 weeks on Friday",
            "2024-03-15",
            "2024-03-15",
            "2024-03-29",
        ),
        ("every month", "2024-03-15", "2024-03-15", "2024-04-15"),
        // month ends: clamped, then it keeps going from the clamped day
        ("every month", "2022-01-31", "2022-01-31", "2022-02-28"),
        ("every month", "2024-01-31", "2024-01-31", "2024-02-29"),
        ("every 2 months", "2024-03-15", "2024-03-15", "2024-05-15"),
        ("every year", "2024-02-29", "2024-02-29", "2025-02-28"),
        // fixed day
        (
            "every month on the 31st",
            "2022-01-31",
            "2022-01-31",
            "2022-03-31",
        ),
        (
            "every month on the 15th",
            "2024-03-20",
            "2024-03-20",
            "2024-04-15",
        ),
        (
            "every month on the 15th",
            "2024-03-10",
            "2024-03-10",
            "2024-03-15",
        ),
        (
            "every month on the last day",
            "2024-02-29",
            "2024-02-29",
            "2024-03-31",
        ),
        (
            "every month on the last Friday",
            "2024-03-29",
            "2024-03-29",
            "2024-04-26",
        ),
        (
            "every month on the 2nd Tuesday",
            "2024-03-12",
            "2024-03-12",
            "2024-04-09",
        ),
        // when done counts from today, not the reference
        (
            "every week when done",
            "2024-03-01",
            "2024-03-15",
            "2024-03-22",
        ),
        (
            "every month when done",
            "2024-01-31",
            "2024-03-15",
            "2024-04-15",
        ),
        // DST has no effect on whole days
        ("every day", "2024-03-09", "2024-03-09", "2024-03-10"),
        ("every day", "2024-11-02", "2024-11-02", "2024-11-03"),
    ];

    #[test]
    fn next_dates() {
        for (text, reference, today, want) in CASES {
            let rule = parse(text).unwrap_or_else(|| panic!("{text} parses"));
            assert_eq!(
                rule.next(d(reference), d(today)),
                Some(d(want)),
                "{text} from {reference} (today {today})"
            );
        }
    }

    #[test]
    fn what_is_not_a_rule() {
        for bad in [
            "",
            "daily",
            "every",
            "every fortnight",
            "every 0 days",
            "every day on monday",
            "every month on the",
            "every week on someday",
            "sometimes",
        ] {
            assert_eq!(parse(bad), None, "{bad}");
        }
        assert!(parse("Every Day WHEN DONE").unwrap().when_done);
    }
}
