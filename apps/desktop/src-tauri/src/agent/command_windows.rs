//! When a chat's shell commands are running: the windows in which a vault change seen by the file
//! watcher is blamed on a `Bash` call. Tauri-free and pure (times are passed in). Owned by
//! `changes.rs`, which turns an explained change into a "changed by a command" record.
//! Spec: `SPECs/native-agent-spec.md` "Turn changes" (shell commands).
//!
//! One window per `Bash` call, main agent or sub-agent, keyed by its tool call id: it opens at the
//! call's `tool-call-started` (the CLI runs an auto-allowed tool ~10 ms after its `tool_use`, so
//! this is never late) and closes at its `tool_result`, or when the chat's process or turn ends.
//!
//! The rule. A batch of watcher paths that reaches us at time `t` belongs to a window when
//! `start <= t` and, once the window is closed, `t <= end + COMMAND_TAIL`. The tail exists
//! because the watcher debounces: a file written just before the result is reported up to about
//! two debounce periods later. Trade-offs, stated so nobody mistakes this for proof: a change made
//! up to that lag BEFORE the call started can still be reported after it started, and a change
//! by anything else (another chat, a terminal, a sync tool) during the window is blamed on the
//! command. The editor's own saves never get here (the watcher knows them as self-writes).
//! Several chats with a running command each explain the same change (each lists it); several
//! windows of one chat: the one that started first names the author.

use super::sub_tracker::Author;
use std::time::{Duration, Instant};

/// How long after its `tool_result` a command still explains changes: twice the watcher's
/// debounce (300 ms, `watcher::DEBOUNCE_MS`, pinned by a test) plus the file system's own event
/// latency.
pub const COMMAND_TAIL: Duration = Duration::from_millis(1000);

#[derive(Debug, Clone)]
struct Window {
    chat_id: String,
    call_id: String,
    by: Option<Author>,
    start: Instant,
    /// `None`: still running.
    end: Option<Instant>,
}

impl Window {
    fn explains(&self, at: Instant) -> bool {
        self.start <= at && self.end.is_none_or(|e| at <= e + COMMAND_TAIL)
    }
}

#[derive(Default)]
pub struct CommandWindows {
    /// In start order.
    list: Vec<Window>,
}

impl CommandWindows {
    pub fn start(&mut self, chat_id: &str, call_id: &str, by: Option<Author>, at: Instant) {
        self.prune(at);
        // a call that is waiting for approval was shut and opens again when it is allowed
        if self
            .list
            .iter()
            .any(|w| w.chat_id == chat_id && w.call_id == call_id && w.end.is_none())
        {
            return;
        }
        self.list.push(Window {
            chat_id: chat_id.to_string(),
            call_id: call_id.to_string(),
            by,
            start: at,
            end: None,
        });
    }

    /// The call got its `tool_result`. An unknown id (not a `Bash` call) changes nothing.
    pub fn finish(&mut self, chat_id: &str, call_id: &str, at: Instant) {
        if let Some(w) = self
            .list
            .iter_mut()
            .find(|w| w.chat_id == chat_id && w.call_id == call_id && w.end.is_none())
        {
            w.end = Some(at);
        }
    }

    /// Nothing of this chat can still be running (its turn or process ended).
    pub fn end_chat(&mut self, chat_id: &str, at: Instant) {
        for w in self
            .list
            .iter_mut()
            .filter(|w| w.chat_id == chat_id && w.end.is_none())
        {
            w.end = Some(at);
        }
    }

    /// The author a change reported at `at` is blamed on: `None` when no window of the chat
    /// explains it, `Some(None)` when the main agent's command does.
    pub fn explaining(&mut self, chat_id: &str, at: Instant) -> Option<Option<Author>> {
        self.prune(at);
        self.list
            .iter()
            .find(|w| w.chat_id == chat_id && w.explains(at))
            .map(|w| w.by.clone())
    }

    /// Windows whose tail is over can never explain anything again (`at` only moves forward).
    fn prune(&mut self, at: Instant) {
        self.list
            .retain(|w| w.end.is_none_or(|e| at <= e + COMMAND_TAIL));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const C: &str = "chat";

    fn ms(base: Instant, n: u64) -> Instant {
        base + Duration::from_millis(n)
    }

    fn author(label: &str) -> Author {
        Author {
            label: label.into(),
            call_id: format!("agent-{label}"),
        }
    }

    #[test]
    fn a_window_explains_from_its_start_until_its_end_plus_the_tail() {
        let t = Instant::now();
        let mut w = CommandWindows::default();
        w.start(C, "b1", None, ms(t, 100));
        assert_eq!(w.explaining(C, ms(t, 50)), None, "before the call started");
        assert_eq!(w.explaining(C, ms(t, 100)), Some(None));
        assert_eq!(w.explaining(C, ms(t, 60_000)), Some(None), "still running");
        w.finish(C, "b1", ms(t, 500));
        assert_eq!(w.explaining(C, ms(t, 500) + COMMAND_TAIL), Some(None));
        assert_eq!(
            w.explaining(C, ms(t, 501) + COMMAND_TAIL),
            None,
            "the tail is over"
        );
    }

    #[test]
    fn windows_are_per_chat_and_per_call() {
        let t = Instant::now();
        let mut w = CommandWindows::default();
        w.start(C, "b1", None, t);
        assert_eq!(w.explaining("other", ms(t, 1)), None);
        w.finish(C, "unknown", ms(t, 5));
        assert_eq!(
            w.explaining(C, ms(t, 5_000)),
            Some(None),
            "unknown id ignored"
        );
    }

    #[test]
    fn the_earliest_running_window_names_the_author() {
        let t = Instant::now();
        let mut w = CommandWindows::default();
        w.start(C, "sub", Some(author("worker")), ms(t, 10));
        w.start(C, "main", None, ms(t, 20));
        assert_eq!(w.explaining(C, ms(t, 30)), Some(Some(author("worker"))));
        w.finish(C, "sub", ms(t, 40));
        // the sub-agent's tail is over, the main command still runs
        assert_eq!(w.explaining(C, ms(t, 40) + COMMAND_TAIL * 2), Some(None));
    }

    #[test]
    fn ending_a_chat_closes_its_windows_but_keeps_their_tail() {
        let t = Instant::now();
        let mut w = CommandWindows::default();
        w.start(C, "b1", None, t);
        w.start("other", "b2", None, t);
        w.end_chat(C, ms(t, 100));
        assert_eq!(w.explaining(C, ms(t, 200)), Some(None), "inside the tail");
        assert_eq!(w.explaining(C, ms(t, 101) + COMMAND_TAIL), None);
        assert_eq!(w.explaining("other", ms(t, 101) + COMMAND_TAIL), Some(None));
    }

    #[test]
    fn the_tail_covers_two_debounce_periods() {
        // changes.rs's window must outlast the watcher's batching delay
        assert!(COMMAND_TAIL >= Duration::from_millis(2 * crate::watcher::DEBOUNCE_MS));
    }
}
