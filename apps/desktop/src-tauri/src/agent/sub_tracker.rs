//! Which sub-agents are working in a chat's turn, who made a tool call, and how each run is going.
//! Tauri-free, pure. The one place that decides a sub-agent's life (ADR "Track sub-agent
//! lifecycle from the CLI's completion signal ...").
//!
//! Three jobs for the runner (`SPECs/agent-roles-spec.md` section 2, ADR item 5):
//!
//! - Attribution: a tool call carries `parentToolCallId`, the id of the `Agent`/`Task` call that
//!   launched the sub-agent making it; that call's `subagent_type` gives the role label of the
//!   Changes card ([`SubTracker::author_of`]).
//! - Keeping the turn open: the card of a turn is finished at its `turn-finished`, but a sub-agent
//!   can outlive the first `result` (a background task, woken later by `task_notification`). The
//!   turn counts as busy while any launch call has no result yet or any task is listed
//!   ([`SubTracker::busy`]).
//! - Lifecycle (`subagent-status`): `running` from the launch; a launch result that says the run
//!   went to the background ([`TaskSignal::AsyncLaunched`], `run_in_background`, or the task's
//!   `is_backgrounded`) is "running in background", never the outcome; a background run ends only
//!   with the CLI's `task_notification`, whose own report is its result; a foreground run ends
//!   with its launch result, which is its report. A final state is never overwritten; a
//!   notification can still add the report to a state `task_updated` already settled.

use super::claude_stream::TaskSignal;
use super::events::{AgentEvent, SubagentRunStatus, ToolOutcome};
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
    /// The launch call has its `tool_result`.
    finished: bool,
    /// Runs on after its launch result.
    background: bool,
    /// The state last told to the UI.
    status: Option<SubagentRunStatus>,
    /// The final state carried the report already.
    reported: bool,
}

#[derive(Default)]
pub struct SubTracker {
    /// Parent call id by call id, for the calls a sub-agent made.
    parents: HashMap<String, String>,
    launches: HashMap<String, Launch>,
    tasks: HashSet<String>,
}

impl SubTracker {
    /// Feeds one mapped event; returns the `subagent-status` events it decides.
    pub fn observe(&mut self, ev: &AgentEvent) -> Vec<AgentEvent> {
        match ev {
            AgentEvent::ToolCallStarted {
                tool_call_id,
                tool,
                parent_tool_call_id,
                ..
            } => {
                if let Some(p) = parent_tool_call_id {
                    self.parents.insert(tool_call_id.clone(), p.clone());
                }
                if is_launch_tool(tool) {
                    self.launches.entry(tool_call_id.clone()).or_default();
                }
                Vec::new()
            }
            AgentEvent::ToolCallInput {
                tool_call_id,
                input,
            } => {
                if let Some(launch) = self.launches.get_mut(tool_call_id) {
                    launch.label = launch_label(input);
                    launch.background |= input.get("run_in_background") == Some(&Value::Bool(true));
                }
                Vec::new()
            }
            AgentEvent::ToolCallFinished {
                tool_call_id,
                output,
                outcome,
                ..
            } => self.on_launch_result(tool_call_id, output, *outcome),
            _ => Vec::new(),
        }
    }

    /// The launch call got its `tool_result`.
    fn on_launch_result(
        &mut self,
        call: &str,
        output: &str,
        outcome: ToolOutcome,
    ) -> Vec<AgentEvent> {
        let Some(launch) = self.launches.get_mut(call) else {
            return Vec::new();
        };
        launch.finished = true;
        match outcome {
            // the run never started
            ToolOutcome::Error => self.settle(call, SubagentRunStatus::Failed, None),
            ToolOutcome::Rejected => self.settle(call, SubagentRunStatus::Stopped, None),
            ToolOutcome::Ok if launch.background => self.running(call),
            ToolOutcome::Ok => {
                let report = (!output.trim().is_empty()).then(|| output.to_string());
                self.settle(call, SubagentRunStatus::Completed, report)
            }
        }
    }

    /// Feeds one task line; returns the `subagent-status` events it decides. Ids that are not a
    /// launch call (a sub-agent's own `Bash` task) only keep the turn busy.
    pub fn on_task(&mut self, signal: &TaskSignal) -> Vec<AgentEvent> {
        match signal {
            TaskSignal::Started {
                task,
                call,
                background,
            } => {
                self.tasks.insert(task.clone());
                let Some(call) = call.as_deref().filter(|c| self.launches.contains_key(*c)) else {
                    return Vec::new();
                };
                if let Some(l) = self.launches.get_mut(call) {
                    l.background |= *background;
                }
                self.running(call)
            }
            TaskSignal::Updated { task, call, status } => {
                self.tasks.remove(task);
                self.settle_task(call.as_deref(), *status, None)
            }
            TaskSignal::Notified {
                task,
                call,
                status,
                report,
            } => {
                self.tasks.remove(task);
                self.settle_task(call.as_deref(), *status, report.clone())
            }
            TaskSignal::AsyncLaunched { call } => {
                let Some(l) = self.launches.get_mut(call) else {
                    return Vec::new();
                };
                l.background = true;
                self.running(call)
            }
        }
    }

    fn settle_task(
        &mut self,
        call: Option<&str>,
        status: SubagentRunStatus,
        report: Option<String>,
    ) -> Vec<AgentEvent> {
        match call.filter(|c| self.launches.contains_key(*c)) {
            Some(call) => self.settle(call, status, report),
            None => Vec::new(),
        }
    }

    /// `running`, once, unless the run already has a state.
    fn running(&mut self, call: &str) -> Vec<AgentEvent> {
        match self.launches.get_mut(call) {
            Some(l) if l.status.is_none() => {
                l.status = Some(SubagentRunStatus::Running);
                vec![status_event(call, SubagentRunStatus::Running, None)]
            }
            _ => Vec::new(),
        }
    }

    /// A final state; never overwritten, but the report may follow it once.
    fn settle(
        &mut self,
        call: &str,
        status: SubagentRunStatus,
        report: Option<String>,
    ) -> Vec<AgentEvent> {
        let Some(l) = self.launches.get_mut(call) else {
            return Vec::new();
        };
        match l.status {
            Some(s) if s.is_final() => {
                if report.is_none() || l.reported {
                    return Vec::new();
                }
                l.reported = true;
                vec![status_event(call, s, report)]
            }
            _ => {
                l.status = Some(status);
                l.reported = report.is_some();
                vec![status_event(call, status, report)]
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

fn status_event(call: &str, status: SubagentRunStatus, report: Option<String>) -> AgentEvent {
    AgentEvent::SubagentStatus {
        tool_call_id: call.to_string(),
        status,
        report,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use SubagentRunStatus::{Completed, Failed, Interrupted, Running, Stopped};

    fn started(t: &mut SubTracker, call: &str, tool: &str, parent: Option<&str>) {
        t.observe(&AgentEvent::ToolCallStarted {
            tool_call_id: call.into(),
            tool: tool.into(),
            parent_tool_call_id: parent.map(String::from),
            message_id: "m".into(),
        });
    }

    fn input(t: &mut SubTracker, call: &str, input: Value) {
        t.observe(&AgentEvent::ToolCallInput {
            tool_call_id: call.into(),
            input,
        });
    }

    fn result(
        t: &mut SubTracker,
        call: &str,
        output: &str,
        outcome: ToolOutcome,
    ) -> Vec<AgentEvent> {
        t.observe(&AgentEvent::ToolCallFinished {
            tool_call_id: call.into(),
            output: output.into(),
            is_error: outcome == ToolOutcome::Error,
            outcome,
            truncated: false,
        })
    }

    fn st(call: &str, status: SubagentRunStatus, report: Option<&str>) -> AgentEvent {
        status_event(call, status, report.map(String::from))
    }

    fn started_task(call: &str, background: bool) -> TaskSignal {
        TaskSignal::Started {
            task: "t1".into(),
            call: Some(call.into()),
            background,
        }
    }

    fn notified(call: &str, status: SubagentRunStatus, report: Option<&str>) -> TaskSignal {
        TaskSignal::Notified {
            task: "t1".into(),
            call: Some(call.into()),
            status,
            report: report.map(String::from),
        }
    }

    #[test]
    fn a_sub_agent_call_is_attributed_to_its_launch_calls_role() {
        let mut t = SubTracker::default();
        started(&mut t, "a1", "Agent", None);
        input(&mut t, "a1", json!({"subagent_type": "writer-worker"}));
        started(&mut t, "w1", "Write", Some("a1"));
        started(&mut t, "m1", "Write", None);
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
        started(&mut t, "a1", "Task", None);
        assert!(t.busy());
        result(&mut t, "a1", "", ToolOutcome::Ok);
        assert!(!t.busy());
        t.on_task(&started_task("zz", false));
        assert!(t.busy());
        t.on_task(&notified("zz", Completed, None));
        assert!(!t.busy());
        started(&mut t, "r1", "Read", None);
        assert!(!t.busy(), "only launch calls count");
        started(&mut t, "a2", "Agent", None);
        t.clear();
        assert!(!t.busy());
    }

    #[test]
    fn a_foreground_run_is_done_with_its_result_as_the_report() {
        let mut t = SubTracker::default();
        started(&mut t, "a1", "Agent", None);
        assert_eq!(
            t.on_task(&started_task("a1", false)),
            [st("a1", Running, None)]
        );
        assert_eq!(
            result(&mut t, "a1", "the answer", ToolOutcome::Ok),
            [st("a1", Completed, Some("the answer"))]
        );
        assert!(
            t.on_task(&notified("a1", Completed, None)).is_empty(),
            "an end is final"
        );
    }

    #[test]
    fn a_failed_or_rejected_launch_result_ends_the_run() {
        let mut t = SubTracker::default();
        started(&mut t, "a1", "Agent", None);
        input(&mut t, "a1", json!({"run_in_background": true}));
        assert_eq!(
            result(&mut t, "a1", "boom", ToolOutcome::Error),
            [st("a1", Failed, None)]
        );
        started(&mut t, "a2", "Agent", None);
        assert_eq!(
            result(&mut t, "a2", "", ToolOutcome::Rejected),
            [st("a2", Stopped, None)]
        );
    }

    /// Every way a run is known to be in the background keeps its launch result from ending it.
    #[test]
    fn a_background_launch_result_is_running_never_done() {
        for how in ["input flag", "task is_backgrounded", "async launch result"] {
            let mut t = SubTracker::default();
            started(&mut t, "a1", "Agent", None);
            match how {
                "input flag" => input(&mut t, "a1", json!({"run_in_background": true})),
                "task is_backgrounded" => {
                    t.on_task(&started_task("a1", true));
                }
                _ => {
                    t.on_task(&TaskSignal::AsyncLaunched { call: "a1".into() });
                }
            }
            let after = result(&mut t, "a1", "", ToolOutcome::Ok);
            assert!(
                after.iter().all(
                    |e| !matches!(e, AgentEvent::SubagentStatus { status, .. } if status.is_final())
                ),
                "{how}: the launch result is not the end"
            );
            // the CLI's notification is the end, and carries the report
            assert_eq!(
                t.on_task(&notified("a1", Completed, Some("real report"))),
                [st("a1", Completed, Some("real report"))],
                "{how}"
            );
        }
    }

    #[test]
    fn a_notification_maps_failed_and_killed_and_never_overwrites_an_end() {
        for (status, want) in [(Failed, Failed), (Stopped, Stopped)] {
            let mut t = SubTracker::default();
            started(&mut t, "a1", "Agent", None);
            t.on_task(&TaskSignal::AsyncLaunched { call: "a1".into() });
            result(&mut t, "a1", "", ToolOutcome::Ok);
            assert_eq!(
                t.on_task(&notified("a1", status, None)),
                [st("a1", want, None)]
            );
            assert!(t.on_task(&notified("a1", Completed, None)).is_empty());
        }
    }

    #[test]
    fn the_report_may_follow_a_final_task_update_once() {
        let mut t = SubTracker::default();
        started(&mut t, "a1", "Agent", None);
        t.on_task(&started_task("a1", true));
        let updated = TaskSignal::Updated {
            task: "t1".into(),
            call: Some("a1".into()),
            status: Completed,
        };
        assert_eq!(t.on_task(&updated), [st("a1", Completed, None)]);
        assert_eq!(
            t.on_task(&notified("a1", Completed, Some("r"))),
            [st("a1", Completed, Some("r"))]
        );
        assert!(t
            .on_task(&notified("a1", Completed, Some("again")))
            .is_empty());
    }

    #[test]
    fn a_task_that_is_not_a_launch_call_decides_nothing() {
        let mut t = SubTracker::default();
        started(&mut t, "a1", "Agent", None);
        started(&mut t, "b1", "Bash", Some("a1"));
        assert!(t.on_task(&started_task("b1", false)).is_empty());
        assert!(t.busy());
        assert!(t.on_task(&notified("b1", Completed, None)).is_empty());
    }

    #[test]
    fn a_turn_end_with_a_background_run_going_stays_busy_until_its_notification() {
        let mut t = SubTracker::default();
        started(&mut t, "a1", "Agent", None);
        t.on_task(&started_task("a1", true));
        t.on_task(&TaskSignal::AsyncLaunched { call: "a1".into() });
        result(&mut t, "a1", "", ToolOutcome::Ok);
        assert!(t.busy(), "the main turn may end; the run has not");
        t.on_task(&notified("a1", Completed, None));
        assert!(!t.busy());
    }

    #[test]
    fn interrupted_is_final_and_never_a_cli_word() {
        assert!(Interrupted.is_final());
        assert_eq!(SubagentRunStatus::from_cli("interrupted"), Running);
    }
}
