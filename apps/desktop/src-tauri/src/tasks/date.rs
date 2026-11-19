//! Calendar days for tasks: a day count since 1970-01-01, local and time-zone-less like every
//! date in the engine (`YYYY-MM-DD` on disk). The civil arithmetic is `bases::datetime`'s.

use crate::bases::datetime::{civil_from_days, days_from_civil, days_in_month};
use std::fmt;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Day(pub i64);

impl Day {
    pub fn ymd(y: i64, m: u32, d: u32) -> Option<Day> {
        if !(1..=12).contains(&m) || d == 0 || d > days_in_month(y, m) || !(0..=9999).contains(&y) {
            return None;
        }
        Some(Day(days_from_civil(y, m, d)))
    }

    /// Exactly `YYYY-MM-DD` and a real date.
    pub fn parse(s: &str) -> Option<Day> {
        let b = s.as_bytes();
        if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
            return None;
        }
        let digits = |r: std::ops::Range<usize>| -> Option<i64> {
            let t = &s[r];
            t.bytes()
                .all(|c| c.is_ascii_digit())
                .then(|| t.parse().ok())?
        };
        Day::ymd(digits(0..4)?, digits(5..7)? as u32, digits(8..10)? as u32)
    }

    /// The day of a local-naive millisecond timestamp (`Clock::now_local_ms`).
    pub fn from_local_ms(ms: i64) -> Day {
        Day(ms.div_euclid(86_400_000))
    }

    pub fn civil(self) -> (i64, u32, u32) {
        civil_from_days(self.0)
    }

    /// 0 = Sunday .. 6 = Saturday.
    pub fn weekday(self) -> u8 {
        (self.0 + 4).rem_euclid(7) as u8
    }

    pub fn add_days(self, n: i64) -> Day {
        Day(self.0 + n)
    }

    /// Calendar months, the day clamped to the month's end (Jan 31 + 1 month = Feb 28/29).
    pub fn add_months(self, n: i64) -> Day {
        let (y, m, d) = self.civil();
        let idx = y * 12 + (m as i64 - 1) + n;
        let (ny, nm) = (idx.div_euclid(12), idx.rem_euclid(12) as u32 + 1);
        Day(days_from_civil(ny, nm, d.min(days_in_month(ny, nm))))
    }

    /// The Monday on or before this day (the week start of recurrences).
    pub fn monday(self) -> Day {
        Day(self.0 - (self.weekday() as i64 + 6) % 7)
    }
}

impl fmt::Display for Day {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let (y, m, d) = self.civil();
        write!(f, "{y:04}-{m:02}-{d:02}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_and_print() {
        let d = Day::parse("2024-02-29").unwrap();
        assert_eq!(d.to_string(), "2024-02-29");
        assert_eq!(d.weekday(), 4); // Thursday
        assert!(Day::parse("2023-02-29").is_none());
        assert!(Day::parse("2024-13-01").is_none());
        assert!(Day::parse("2024-1-01").is_none());
        assert!(Day::parse("2024-01-0x").is_none());
    }

    #[test]
    fn months_clamp_and_weeks_start_on_monday() {
        let d = Day::parse("2022-01-31").unwrap();
        assert_eq!(d.add_months(1).to_string(), "2022-02-28");
        assert_eq!(d.add_months(-2).to_string(), "2021-11-30");
        assert_eq!(d.add_months(13).to_string(), "2023-02-28");
        let sun = Day::parse("2024-03-17").unwrap();
        assert_eq!(sun.weekday(), 0);
        assert_eq!(sun.monday().to_string(), "2024-03-11");
        assert_eq!(
            Day::parse("2024-03-11").unwrap().monday().to_string(),
            "2024-03-11"
        );
    }
}
