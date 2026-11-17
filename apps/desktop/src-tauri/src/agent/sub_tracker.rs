//! Which sub-agents are working in a chat's turn, and who made a tool call. Tauri-free, pure.
//!
//! Two jobs for the runner (`SPECs/agent-roles-spec.md` section 2, ADR item 5):
//!
//! - Attribution: a tool call carries `parentToolCallId`, the id of the `Agent`/`Task` call that
//!   launched the sub-agent making it; that call's `subagent_type` gives the role label of the
//!   Changes card ([`SubTracker::author_of`]).
//! - Keeping the turn open: the card of a turn is finished at its `turn-finished`, but a sub-agent
//!   can outlive the first `result` (a background task, woken later by `task_notification`). The
//!   turn counts as busy while any launch call has no result yet or any task is listed
//!   ([`SubTracker::busy`]).

use super::claude_stream::TaskSignal;
use super::subagents::{is_launch_tool, launch_label};
use serde_json::Value;
use std::collections::{HashMap, HashSet};

/// Who made a call: the role label and the launch call of the sub-agent run it belongs to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Author {
    pub label: String,
    /// The `Agent`/`Task` call id: what the UI keys the sub-agent card by.
    pub call_id: String,
}

#[derive(Default)]
struct Launch {
    /// The role label, known once the call's input is complete.
    label: Option<String>,
    finished: bool,
}

#[derive(Default)]
pub struct SubTracker {
    /// Parent call id by call id, for the calls a sub-agent made.
    parents: HashMap<String, String>,
    launches: HashMap<String, Launch>,
    tasks: HashSet<String>,
}

impl SubTracker {
    pub fn on_started(&mut self, call_id: &str, tool: &str, parent: Option<&str>) {
        if let Some(p) = parent {
            self.parents.insert(call_id.to_string(), p.to_string());
        }
        if is_launch_tool(tool) {
            self.launches.entry(call_id.to_string()).or_default();
        }
    }

    pub fn on_input(&mut self, call_id: &str, input: &Value) {
        if let Some(launch) = self.launches.get_mut(call_id) {
            launch.label = launch_label(input);
        }
    }

    /// The call got its `tool_result`.
    pub fn on_finished(&mut self, call_id: &str) {
        if let Some(launch) = self.launches.get_mut(call_id) {
            launch.finished = true;
        }
    }

    pub fn on_task(&mut self, signal: &TaskSignal) {
        match signal {
            TaskSignal::Started(id) => {
                self.tasks.insert(id.clone());
            }
            TaskSignal::Ended(id) => {
                self.tasks.remove(id);
            }
        }
    }

    /// The sub-agent that made `call_id`; `None` for the main agent's own calls.
    pub fn author_of(&self, call_id: Option<&str>) -> Option<Author> {
        let parent = self.parents.get(call_id?)?;
        Some(Author {
            label: self.launches.get(parent)?.label.clone()?,
            call_id: parent.clone(),
        })
    }

    /// A launch call has no result yet, or a task is running.
    pub fn busy(&self) -> bool {
        !self.tasks.is_empty() || self.launches.values().any(|l| !l.finished)
    }

    pub fn clear(&mut self) {
        *self = Self::default();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_sub_agent_call_is_attributed_to_its_launch_calls_role() {
        let mut t = SubTracker::default();
        t.on_started("a1", "Agent", None);
        t.on_input("a1", &json!({"subagent_type": "writer-worker"}));
        t.on_started("w1", "Write", Some("a1"));
        t.on_started("m1", "Write", None);
        assert_eq!(
            t.author_of(Some("w1")),
            Some(Author {
                label: "worker".into(),
                call_id: "a1".into()
            })
        );
        assert_eq!(t.author_of(Some("m1")), None, "the main agent's own call");
        assert_eq!(t.author_of(None), None);
        assert_eq!(t.author_of(Some("unknown")), None);
    }

    #[test]
    fn busy_while_a_launch_has_no_result_or_a_task_runs() {
        let mut t = SubTracker::default();
        assert!(!t.busy());
        t.on_started("a1", "Task", None);
        assert!(t.busy());
        t.on_finished("a1");
        assert!(!t.busy());
        t.on_task(&TaskSignal::Started("k".into()));
        assert!(t.busy());
        t.on_task(&TaskSignal::Ended("k".into()));
        assert!(!t.busy());
        t.on_started("r1", "Read", None);
        assert!(!t.busy(), "only launch calls count");
        t.on_started("a2", "Agent", None);
        t.clear();
        assert!(!t.busy());
    }
}
