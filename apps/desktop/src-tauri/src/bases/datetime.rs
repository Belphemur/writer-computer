//! Calendar and duration arithmetic on top of `std` only.
//!
//! Obsidian dates in frontmatter and in expressions are time-zone-less, so a
//! date is stored as "local-naive" milliseconds since 1970-01-01T00:00:00
//! (i.e. the wall-clock fields interpreted as if they were UTC). The only place
//! a UTC offset matters is parsing a string that carries an explicit offset
//! (`Z`, `+02:00`) and `number(date)`; both take the injected clock's offset.

use std::cmp::Ordering;

pub const MS_PER_SECOND: i64 = 1_000;
pub const MS_PER_MINUTE: i64 = 60_000;
pub const MS_PER_HOUR: i64 = 3_600_000;
pub const MS_PER_DAY: i64 = 86_400_000;
pub const MS_PER_WEEK: i64 = 7 * MS_PER_DAY;
/// Average Gregorian month, used only to compare/convert durations that carry
/// calendar months (never to add them to a date).
pub const MS_PER_MONTH_AVG: i64 = 2_629_800_000;

/// Days since 1970-01-01 for a proleptic Gregorian civil date.
pub fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m as i64 + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Inverse of [`days_from_civil`].
pub fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

pub fn is_leap(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

pub fn days_in_month(y: i64, m: u32) -> u32 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ => {
            if is_leap(y) {
                29
            } else {
                28
            }
        }
    }
}

/// Broken-down wall-clock fields.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Civil {
    pub year: i64,
    pub month: u32,
    pub day: u32,
    pub hour: u32,
    pub minute: u32,
    pub second: u32,
    pub milli: u32,
}

/// Dates beyond about +-250,000 years are rejected by arithmetic and clamped
/// by the calendar functions, so no intermediate value can overflow `i64`.
pub const MAX_ABS_MS: i64 = 8_000_000_000_000_000;

pub fn civil_from_ms(ms: i64) -> Civil {
    let ms = ms.clamp(-MAX_ABS_MS, MAX_ABS_MS);
    let days = ms.div_euclid(MS_PER_DAY);
    let rem = ms.rem_euclid(MS_PER_DAY);
    let (year, month, day) = civil_from_days(days);
    Civil {
        year,
        month,
        day,
        hour: (rem / MS_PER_HOUR) as u32,
        minute: ((rem % MS_PER_HOUR) / MS_PER_MINUTE) as u32,
        second: ((rem % MS_PER_MINUTE) / MS_PER_SECOND) as u32,
        milli: (rem % MS_PER_SECOND) as u32,
    }
}

pub fn ms_from_civil(c: &Civil) -> i64 {
    days_from_civil(c.year, c.month, c.day) * MS_PER_DAY
        + c.hour as i64 * MS_PER_HOUR
        + c.minute as i64 * MS_PER_MINUTE
        + c.second as i64 * MS_PER_SECOND
        + c.milli as i64
}

/// 0 = Sunday .. 6 = Saturday.
pub fn weekday(ms: i64) -> u32 {
    // 1970-01-01 was a Thursday (4).
    (ms.div_euclid(MS_PER_DAY) + 4).rem_euclid(7) as u32
}

pub fn day_of_year(c: &Civil) -> u32 {
    (days_from_civil(c.year, c.month, c.day) - days_from_civil(c.year, 1, 1)) as u32 + 1
}

/// ISO-8601 week number and week-year.
pub fn iso_week(ms: i64) -> (i64, u32) {
    let c = civil_from_ms(ms);
    let wd = (weekday(ms) + 6) % 7; // Monday = 0
    let doy = day_of_year(&c) as i64;
    let mut week = (doy - 1 - wd as i64 + 10) / 7;
    let mut year = c.year;
    if week < 1 {
        year -= 1;
        let dec31 = days_from_civil(year, 12, 31) * MS_PER_DAY;
        return (year, iso_week(dec31).1);
    }
    if week == 53 {
        // A year has 53 ISO weeks only if Jan 1 is a Thursday, or a leap year
        // starting on Wednesday.
        let jan1_wd = (weekday(days_from_civil(c.year, 1, 1) * MS_PER_DAY) + 6) % 7;
        let has53 = jan1_wd == 3 || (is_leap(c.year) && jan1_wd == 2);
        if !has53 {
            week = 1;
            year += 1;
        }
    }
    (year, week as u32)
}

/// Add calendar months, clamping the day to the end of the target month
/// (Moment semantics: Jan 31 + 1 month = Feb 28/29).
pub fn add_months(ms: i64, months: i64) -> Option<i64> {
    if months == 0 {
        return Some(ms);
    }
    let c = civil_from_ms(ms);
    let idx = (c.year * 12 + (c.month as i64 - 1)).checked_add(months)?;
    let year = idx.div_euclid(12);
    if year.abs() > 250_000 {
        return None;
    }
    let month = idx.rem_euclid(12) as u32 + 1;
    let day = c.day.min(days_in_month(year, month));
    Some(ms_from_civil(&Civil {
        year,
        month,
        day,
        ..c
    }))
}

pub fn start_of_day(ms: i64) -> i64 {
    ms.div_euclid(MS_PER_DAY) * MS_PER_DAY
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/// Parse `YYYY-MM-DD`, optionally followed by `T` or a space and
/// `HH:mm[:ss[.SSS]]`, optionally followed by `Z` or `±HH[:mm]`.
/// Returns local-naive milliseconds and whether a time part was present.
/// An explicit offset is converted to the local time at `local_offset_min`.
pub fn parse_date(s: &str, local_offset_min: i32) -> Option<(i64, bool)> {
    let b = s.trim().as_bytes();
    let mut i = 0;
    let year = num(b, &mut i, 4, 4)? as i64;
    expect(b, &mut i, b'-')?;
    let month = num(b, &mut i, 2, 2)?;
    expect(b, &mut i, b'-')?;
    let day = num(b, &mut i, 2, 2)?;
    if !(1..=12).contains(&month) || day < 1 || day > days_in_month(year, month) {
        return None;
    }
    let mut ms = days_from_civil(year, month, day) * MS_PER_DAY;
    if i == b.len() {
        return Some((ms, false));
    }
    if b[i] != b'T' && b[i] != b' ' && b[i] != b't' {
        return None;
    }
    i += 1;
    let hour = num(b, &mut i, 2, 2)?;
    expect(b, &mut i, b':')?;
    let minute = num(b, &mut i, 2, 2)?;
    let mut second = 0;
    let mut milli = 0;
    if i < b.len() && b[i] == b':' {
        i += 1;
        second = num(b, &mut i, 2, 2)?;
        if i < b.len() && (b[i] == b'.' || b[i] == b',') {
            i += 1;
            let start = i;
            while i < b.len() && b[i].is_ascii_digit() {
                i += 1;
            }
            if i == start {
                return None;
            }
            let frac = &b[start..i.min(start + 3)];
            let mut v = 0u32;
            for d in frac {
                v = v * 10 + (d - b'0') as u32;
            }
            for _ in frac.len()..3 {
                v *= 10;
            }
            milli = v;
        }
    }
    if hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    ms += hour as i64 * MS_PER_HOUR
        + minute as i64 * MS_PER_MINUTE
        + second as i64 * MS_PER_SECOND
        + milli as i64;
    if i < b.len() {
        let src_offset = match b[i] {
            b'Z' | b'z' => {
                i += 1;
                0
            }
            sign @ (b'+' | b'-') => {
                i += 1;
                let h = num(b, &mut i, 2, 2)? as i32;
                if i < b.len() && b[i] == b':' {
                    i += 1;
                }
                let m = if i < b.len() {
                    num(b, &mut i, 2, 2)? as i32
                } else {
                    0
                };
                let total = h * 60 + m;
                if sign == b'-' {
                    -total
                } else {
                    total
                }
            }
            _ => return None,
        };
        if i != b.len() {
            return None;
        }
        // wall-clock at the source offset -> UTC -> wall-clock at local offset
        ms += (local_offset_min - src_offset) as i64 * MS_PER_MINUTE;
    }
    Some((ms, true))
}

fn num(b: &[u8], i: &mut usize, min: usize, max: usize) -> Option<u32> {
    let start = *i;
    let mut v: u32 = 0;
    while *i < b.len() && *i - start < max && b[*i].is_ascii_digit() {
        v = v * 10 + (b[*i] - b'0') as u32;
        *i += 1;
    }
    if *i - start < min {
        None
    } else {
        Some(v)
    }
}

fn expect(b: &[u8], i: &mut usize, c: u8) -> Option<()> {
    if *i < b.len() && b[*i] == c {
        *i += 1;
        Some(())
    } else {
        None
    }
}

// ---------------------------------------------------------------------------
// Durations
// ---------------------------------------------------------------------------

/// A duration. Calendar units (years, months) are kept apart from the fixed
/// part so that `date + "1M"` adds a calendar month.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DurationValue {
    pub months: i64,
    pub millis: i64,
}

impl DurationValue {
    pub const ZERO: DurationValue = DurationValue {
        months: 0,
        millis: 0,
    };

    pub fn from_millis(millis: i64) -> Self {
        DurationValue { months: 0, millis }
    }

    /// Approximate total length in milliseconds (months at their average).
    pub fn total_millis(&self) -> f64 {
        self.months as f64 * MS_PER_MONTH_AVG as f64 + self.millis as f64
    }

    pub fn neg(&self) -> Self {
        DurationValue {
            months: self.months.saturating_neg(),
            millis: self.millis.saturating_neg(),
        }
    }

    pub fn add(&self, o: &Self) -> Self {
        DurationValue {
            months: self.months.saturating_add(o.months),
            millis: self.millis.saturating_add(o.millis),
        }
    }

    pub fn scale(&self, k: f64) -> Self {
        DurationValue {
            months: (self.months as f64 * k).round() as i64,
            millis: (self.millis as f64 * k).round() as i64,
        }
    }

    pub fn cmp_total(&self, o: &Self) -> Ordering {
        self.total_millis()
            .partial_cmp(&o.total_millis())
            .unwrap_or(Ordering::Equal)
    }

    /// Apply to a local-naive timestamp; `None` when the result is out of range.
    pub fn add_to(&self, ms: i64) -> Option<i64> {
        let r = add_months(ms, self.months)?.checked_add(self.millis)?;
        (r.abs() <= MAX_ABS_MS).then_some(r)
    }
}

/// Parse `"1d"`, `"2 weeks"`, `"1h 30m"`, `"-3 days"`, `"1.5h"`.
///
/// Units: `y`/`year(s)`, `M`/`month(s)`, `w`/`week(s)`, `d`/`day(s)`,
/// `h`/`hr(s)`/`hour(s)`, `m`/`min(s)`/`minute(s)`, `s`/`sec(s)`/`second(s)`.
/// The one-letter forms are case-sensitive (`M` months, `m` minutes); long
/// names are not.
pub fn parse_duration(s: &str) -> Option<DurationValue> {
    let b: Vec<char> = s.trim().chars().collect();
    if b.is_empty() {
        return None;
    }
    let mut i = 0;
    let mut total = DurationValue::ZERO;
    let mut any = false;
    while i < b.len() {
        while i < b.len() && (b[i].is_whitespace() || b[i] == ',') {
            i += 1;
        }
        if i >= b.len() {
            break;
        }
        let mut sign = 1.0;
        if b[i] == '-' || b[i] == '+' {
            if b[i] == '-' {
                sign = -1.0;
            }
            i += 1;
        }
        let start = i;
        while i < b.len() && (b[i].is_ascii_digit() || b[i] == '.') {
            i += 1;
        }
        if start == i {
            return None;
        }
        let n: f64 = b[start..i].iter().collect::<String>().parse().ok()?;
        while i < b.len() && b[i].is_whitespace() {
            i += 1;
        }
        let ustart = i;
        while i < b.len() && b[i].is_alphabetic() {
            i += 1;
        }
        let unit: String = b[ustart..i].iter().collect();
        let n = n * sign;
        let d = match unit.as_str() {
            "y" => DurationValue {
                months: (n * 12.0).round() as i64,
                millis: 0,
            },
            "M" => DurationValue {
                months: n.round() as i64,
                millis: 0,
            },
            "m" => DurationValue::from_millis((n * MS_PER_MINUTE as f64).round() as i64),
            _ => {
                let u = unit.to_ascii_lowercase();
                match u.as_str() {
                    "year" | "years" => DurationValue {
                        months: (n * 12.0).round() as i64,
                        millis: 0,
                    },
                    "month" | "months" => DurationValue {
                        months: n.round() as i64,
                        millis: 0,
                    },
                    "w" | "week" | "weeks" => {
                        DurationValue::from_millis((n * MS_PER_WEEK as f64).round() as i64)
                    }
                    "d" | "day" | "days" => {
                        DurationValue::from_millis((n * MS_PER_DAY as f64).round() as i64)
                    }
                    "h" | "hr" | "hrs" | "hour" | "hours" => {
                        DurationValue::from_millis((n * MS_PER_HOUR as f64).round() as i64)
                    }
                    "min" | "mins" | "minute" | "minutes" => {
                        DurationValue::from_millis((n * MS_PER_MINUTE as f64).round() as i64)
                    }
                    "s" | "sec" | "secs" | "second" | "seconds" => {
                        DurationValue::from_millis((n * MS_PER_SECOND as f64).round() as i64)
                    }
                    _ => return None,
                }
            }
        };
        total = total.add(&d);
        any = true;
    }
    any.then_some(total)
}

/// Compact display such as `1d 2h`, `3M`, `0s`.
pub fn format_duration(d: &DurationValue) -> String {
    let mut parts: Vec<String> = Vec::new();
    let sign = if d.months < 0 || (d.months == 0 && d.millis < 0) {
        "-"
    } else {
        ""
    };
    let months = d.months.unsigned_abs();
    let mut ms = d.millis.unsigned_abs();
    if months >= 12 {
        parts.push(format!("{}y", months / 12));
    }
    if !months.is_multiple_of(12) {
        parts.push(format!("{}M", months % 12));
    }
    for (unit, size) in [
        ("d", MS_PER_DAY as u64),
        ("h", MS_PER_HOUR as u64),
        ("m", MS_PER_MINUTE as u64),
        ("s", MS_PER_SECOND as u64),
    ] {
        if ms >= size {
            parts.push(format!("{}{}", ms / size, unit));
            ms %= size;
        }
    }
    if ms > 0 {
        parts.push(format!("{ms}ms"));
    }
    if parts.is_empty() {
        return "0s".to_string();
    }
    format!("{sign}{}", parts.join(" "))
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const MONTHS: [&str; 12] = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
];
const WEEKDAYS: [&str; 7] = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
];

fn ordinal(n: u32) -> String {
    let suffix = match (n % 100, n % 10) {
        (11..=13, _) => "th",
        (_, 1) => "st",
        (_, 2) => "nd",
        (_, 3) => "rd",
        _ => "th",
    };
    format!("{n}{suffix}")
}

/// Tokens in match-priority order (longest first within a family).
const TOKENS: &[&str] = &[
    "YYYY", "YY", "MMMM", "MMM", "MM", "Mo", "M", "DDDD", "DDD", "Do", "DD", "D", "dddd", "ddd",
    "dd", "d", "E", "Qo", "Q", "WW", "Wo", "W", "GGGG", "HH", "H", "hh", "h", "kk", "k", "mm", "m",
    "ss", "s", "SSS", "SS", "S", "A", "a", "ZZ", "Z", "X", "x",
];

/// Moment-style `format()`. Text inside `[...]` is literal; characters that
/// are not tokens pass through. `offset_min` feeds `Z`, `ZZ`, `X`, `x`.
pub fn format_date(ms: i64, fmt: &str, offset_min: i32) -> String {
    let ms = ms.clamp(-MAX_ABS_MS, MAX_ABS_MS);
    let c = civil_from_ms(ms);
    let chars: Vec<char> = fmt.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '[' {
            if let Some(end) = chars[i + 1..].iter().position(|&ch| ch == ']') {
                out.extend(&chars[i + 1..i + 1 + end]);
                i += end + 2;
                continue;
            }
        }
        if chars[i] == '\\' && i + 1 < chars.len() {
            out.push(chars[i + 1]);
            i += 2;
            continue;
        }
        let rest: String = chars[i..chars.len().min(i + 4)].iter().collect();
        let tok = TOKENS.iter().find(|t| rest.starts_with(**t));
        match tok {
            Some(t) => {
                out.push_str(&render_token(t, &c, ms, offset_min));
                i += t.chars().count();
            }
            None => {
                out.push(chars[i]);
                i += 1;
            }
        }
    }
    out
}

fn render_token(t: &str, c: &Civil, ms: i64, offset_min: i32) -> String {
    let wd = weekday(ms) as usize;
    let h12 = if c.hour.is_multiple_of(12) {
        12
    } else {
        c.hour % 12
    };
    match t {
        "YYYY" => format!("{:04}", c.year),
        "YY" => format!("{:02}", c.year.rem_euclid(100)),
        "MMMM" => MONTHS[c.month as usize - 1].to_string(),
        "MMM" => MONTHS[c.month as usize - 1][..3].to_string(),
        "MM" => format!("{:02}", c.month),
        "Mo" => ordinal(c.month),
        "M" => c.month.to_string(),
        "DDDD" => format!("{:03}", day_of_year(c)),
        "DDD" => day_of_year(c).to_string(),
        "Do" => ordinal(c.day),
        "DD" => format!("{:02}", c.day),
        "D" => c.day.to_string(),
        "dddd" => WEEKDAYS[wd].to_string(),
        "ddd" => WEEKDAYS[wd][..3].to_string(),
        "dd" => WEEKDAYS[wd][..2].to_string(),
        "d" => wd.to_string(),
        "E" => (if wd == 0 { 7 } else { wd }).to_string(),
        "Qo" => ordinal((c.month - 1) / 3 + 1),
        "Q" => ((c.month - 1) / 3 + 1).to_string(),
        "WW" => format!("{:02}", iso_week(ms).1),
        "Wo" => ordinal(iso_week(ms).1),
        "W" => iso_week(ms).1.to_string(),
        "GGGG" => format!("{:04}", iso_week(ms).0),
        "HH" => format!("{:02}", c.hour),
        "H" => c.hour.to_string(),
        "hh" => format!("{:02}", h12),
        "h" => h12.to_string(),
        "kk" => format!("{:02}", if c.hour == 0 { 24 } else { c.hour }),
        "k" => (if c.hour == 0 { 24 } else { c.hour }).to_string(),
        "mm" => format!("{:02}", c.minute),
        "m" => c.minute.to_string(),
        "ss" => format!("{:02}", c.second),
        "s" => c.second.to_string(),
        "SSS" => format!("{:03}", c.milli),
        "SS" => format!("{:02}", c.milli / 10),
        "S" => (c.milli / 100).to_string(),
        "A" => (if c.hour < 12 { "AM" } else { "PM" }).to_string(),
        "a" => (if c.hour < 12 { "am" } else { "pm" }).to_string(),
        "Z" | "ZZ" => {
            let sign = if offset_min < 0 { '-' } else { '+' };
            let a = offset_min.abs();
            if t == "Z" {
                format!("{sign}{:02}:{:02}", a / 60, a % 60)
            } else {
                format!("{sign}{:02}{:02}", a / 60, a % 60)
            }
        }
        "X" => (ms.div_euclid(1000) - offset_min as i64 * 60).to_string(),
        "x" => (ms - offset_min as i64 * MS_PER_MINUTE).to_string(),
        _ => t.to_string(),
    }
}

/// ISO form without zone: `YYYY-MM-DD` or `YYYY-MM-DDTHH:mm:ss[.SSS]`.
pub fn iso_string(ms: i64, has_time: bool) -> String {
    let c = civil_from_ms(ms);
    if !has_time {
        return format!("{:04}-{:02}-{:02}", c.year, c.month, c.day);
    }
    let mut s = format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}",
        c.year, c.month, c.day, c.hour, c.minute, c.second
    );
    if c.milli != 0 {
        s.push_str(&format!(".{:03}", c.milli));
    }
    s
}

/// Moment's `fromNow()` wording with its rounding thresholds.
pub fn relative(date_ms: i64, now_ms: i64) -> String {
    let diff = date_ms.saturating_sub(now_ms);
    let future = diff > 0;
    let secs = diff.unsigned_abs() as f64 / 1000.0;
    let mins = secs / 60.0;
    let hours = mins / 60.0;
    let days = hours / 24.0;
    let phrase = if secs < 45.0 {
        "a few seconds".to_string()
    } else if secs < 90.0 {
        "a minute".to_string()
    } else if mins < 45.0 {
        format!("{} minutes", mins.round() as i64)
    } else if mins < 90.0 {
        "an hour".to_string()
    } else if hours < 22.0 {
        format!("{} hours", hours.round() as i64)
    } else if hours < 36.0 {
        "a day".to_string()
    } else if days < 26.0 {
        format!("{} days", days.round() as i64)
    } else if days < 45.0 {
        "a month".to_string()
    } else if days < 320.0 {
        format!("{} months", (days / 30.4375).round() as i64)
    } else if days < 548.0 {
        "a year".to_string()
    } else {
        format!("{} years", (days / 365.25).round() as i64)
    };
    if future {
        format!("in {phrase}")
    } else {
        format!("{phrase} ago")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_round_trip() {
        for days in (-800_000..800_000).step_by(997) {
            let (y, m, d) = civil_from_days(days);
            assert_eq!(days_from_civil(y, m, d), days);
        }
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(civil_from_days(19_723), (2024, 1, 1));
    }

    #[test]
    fn weekday_known() {
        let ms = days_from_civil(2024, 1, 5) * MS_PER_DAY; // a Friday
        assert_eq!(weekday(ms), 5);
        assert_eq!(weekday(0), 4);
    }

    #[test]
    fn parse_forms() {
        let (ms, t) = parse_date("2024-01-05", 0).unwrap();
        assert!(!t);
        assert_eq!(iso_string(ms, false), "2024-01-05");
        let (ms, t) = parse_date("2024-01-05T14:30:15.250", 0).unwrap();
        assert!(t);
        assert_eq!(iso_string(ms, true), "2024-01-05T14:30:15.250");
        let (ms, _) = parse_date("2024-01-05 09:00", 0).unwrap();
        assert_eq!(format_date(ms, "HH:mm", 0), "09:00");
        // explicit offset converted to the local offset (+60)
        let (ms, _) = parse_date("2024-01-05T12:00:00Z", 60).unwrap();
        assert_eq!(format_date(ms, "HH:mm", 60), "13:00");
        let (ms, _) = parse_date("2024-01-05T12:00:00+02:00", 0).unwrap();
        assert_eq!(format_date(ms, "HH:mm", 0), "10:00");
        assert!(parse_date("2024-02-30", 0).is_none());
        assert!(parse_date("2024-13-01", 0).is_none());
        assert!(parse_date("hello", 0).is_none());
        assert!(parse_date("2024-01-05T25:00", 0).is_none());
        assert!(parse_date("2024-01-05x", 0).is_none());
    }

    #[test]
    fn months_clamp() {
        let (jan31, _) = parse_date("2024-01-31", 0).unwrap();
        assert_eq!(
            iso_string(add_months(jan31, 1).unwrap(), false),
            "2024-02-29"
        );
        assert_eq!(
            iso_string(add_months(jan31, -2).unwrap(), false),
            "2023-11-30"
        );
        assert_eq!(
            iso_string(add_months(jan31, 12).unwrap(), false),
            "2025-01-31"
        );
        assert_eq!(add_months(jan31, i64::MAX), None);
        assert_eq!(add_months(jan31, 12 * 300_000), None);
    }

    #[test]
    fn durations() {
        assert_eq!(parse_duration("1d").unwrap().millis, MS_PER_DAY);
        assert_eq!(parse_duration("2 weeks").unwrap().millis, 2 * MS_PER_WEEK);
        assert_eq!(parse_duration("1M").unwrap().months, 1);
        assert_eq!(parse_duration("1m").unwrap().millis, MS_PER_MINUTE);
        assert_eq!(parse_duration("1y").unwrap().months, 12);
        assert_eq!(
            parse_duration("1h 30m").unwrap().millis,
            MS_PER_HOUR + 30 * MS_PER_MINUTE
        );
        assert_eq!(parse_duration("-3 days").unwrap().millis, -3 * MS_PER_DAY);
        assert_eq!(parse_duration("1.5h").unwrap().millis, 90 * MS_PER_MINUTE);
        assert!(parse_duration("").is_none());
        assert!(parse_duration("soon").is_none());
        assert!(parse_duration("3 parsecs").is_none());
        assert_eq!(format_duration(&parse_duration("1d 2h").unwrap()), "1d 2h");
        assert_eq!(format_duration(&DurationValue::ZERO), "0s");
    }

    #[test]
    fn format_tokens() {
        let (ms, _) = parse_date("2024-01-05T14:07:09.042", 0).unwrap();
        assert_eq!(format_date(ms, "YYYY-MM-DD", 0), "2024-01-05");
        assert_eq!(format_date(ms, "ddd, MMM D", 0), "Fri, Jan 5");
        assert_eq!(
            format_date(ms, "dddd Do MMMM YY", 0),
            "Friday 5th January 24"
        );
        assert_eq!(format_date(ms, "h:mm A", 0), "2:07 PM");
        assert_eq!(format_date(ms, "HH:mm:ss.SSS", 0), "14:07:09.042");
        assert_eq!(format_date(ms, "[Week] W, Q", 0), "Week 1, 1");
        assert_eq!(format_date(ms, "DDDD", 0), "005");
        assert_eq!(format_date(ms, "Z ZZ", 120), "+02:00 +0200");
        assert_eq!(format_date(ms, "YYYY年", 0), "2024年");
    }

    #[test]
    fn iso_weeks() {
        let w = |s: &str| iso_week(parse_date(s, 0).unwrap().0);
        assert_eq!(w("2024-01-01"), (2024, 1));
        assert_eq!(w("2021-01-03"), (2020, 53));
        assert_eq!(w("2020-12-31"), (2020, 53));
        assert_eq!(w("2019-12-30"), (2020, 1));
        assert_eq!(w("2024-12-30"), (2025, 1));
    }

    #[test]
    fn relative_phrases() {
        let now = 1_000_000_000_000;
        assert_eq!(relative(now - 10_000, now), "a few seconds ago");
        assert_eq!(relative(now + 2 * MS_PER_DAY, now), "in 2 days");
        assert_eq!(relative(now - 3 * MS_PER_HOUR, now), "3 hours ago");
        assert_eq!(relative(now - 400 * MS_PER_DAY, now), "a year ago");
        assert_eq!(relative(now - 1000 * MS_PER_DAY, now), "3 years ago");
    }
}
