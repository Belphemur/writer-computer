//! A task's urgency score, the Tasks plugin's weighting (`src/Task/Urgency.ts`, MIT, see
//! `THIRD_PARTY_NOTICES.md`): due date up to 12, scheduled-or-past +5, not yet started -3,
//! priority from -1.8 to +9.

use super::date::Day;
use super::grammar::{Priority, TaskFields};

const DUE: f64 = 12.0;
const SCHEDULED: f64 = 5.0;
const NOT_STARTED: f64 = -3.0;
const PRIORITY: f64 = 6.0;

pub fn urgency(task: &TaskFields, today: Day) -> f64 {
    let mut u = 0.0;
    if let Some(due) = task.due {
        let overdue = (today.0 - due.0) as f64;
        // 21 days map to 0.2..1.0: a week overdue or more is 1, more than two weeks ahead 0.2
        let multiplier = if overdue >= 7.0 {
            1.0
        } else if overdue >= -14.0 {
            (overdue + 14.0) * 0.8 / 21.0 + 0.2
        } else {
            0.2
        };
        u += multiplier * DUE;
    }
    if task.scheduled.is_some_and(|s| today >= s) {
        u += SCHEDULED;
    }
    if task.start.is_some_and(|s| today < s) {
        u += NOT_STARTED;
    }
    u += PRIORITY
        * match task.priority {
            Some(Priority::Highest) => 1.5,
            Some(Priority::High) => 1.0,
            Some(Priority::Medium) => 0.65,
            None => 0.325,
            Some(Priority::Low) => 0.0,
            Some(Priority::Lowest) => -0.3,
        };
    u
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tasks::grammar::parse_task;

    fn u(line: &str) -> f64 {
        urgency(
            &parse_task(line).unwrap().fields,
            Day::parse("2024-03-15").unwrap(),
        )
    }

    fn close(a: f64, b: f64) {
        assert!((a - b).abs() < 1e-9, "{a} != {b}");
    }

    #[test]
    fn plugin_vectors() {
        close(u("- [ ] a"), 1.95);
        close(u("- [ ] a ⏫"), 6.0);
        close(u("- [ ] a 🔺"), 9.0);
        close(u("- [ ] a 🔼"), 3.9);
        close(u("- [ ] a 🔽"), 0.0);
        close(u("- [ ] a ⏬"), -1.8);
        // due a week ago or earlier caps at 12; today is 14/21*.8+.2; in 3 weeks is 0.2
        close(u("- [ ] a 📅 2024-03-01 🔽"), 12.0);
        close(
            u("- [ ] a 📅 2024-03-15 🔽"),
            (14.0 * 0.8 / 21.0 + 0.2) * 12.0,
        );
        close(u("- [ ] a 📅 2024-04-30 🔽"), 0.2 * 12.0);
        // scheduled today or earlier +5, a start in the future -3
        close(u("- [ ] a ⏳ 2024-03-15 🔽"), 5.0);
        close(u("- [ ] a ⏳ 2024-03-16 🔽"), 0.0);
        close(u("- [ ] a 🛫 2024-03-16 🔽"), -3.0);
    }
}
