//! The mapper against every fixture (real captures of opencode 2.4.0, `fixtures/`): goldens of the
//! neutral stream the pane would get (the mapper's events and the tracker's sub-agent states, in
//! the order `Session` applies them), and the rows of the spec's section 6 one by one.
//! Regenerate the goldens deliberately with `WRITER_UPDATE_GOLDEN=1 cargo test golden`.

use super::opencode_api::{SseParser, WireEvent};
use super::opencode_events::MapState;
use crate::agent::events::*;
use crate::agent::sub_tracker::SubTracker;
use crate::agent::tool_table::{Role, ToolTable};
use crate::agent::transport::Mapped;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

pub(super) fn feature_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../features/opencode")
}

pub(super) fn fixtures_dir() -> PathBuf {
    feature_dir().join("fixtures")
}

/// OpenCode's tool table, as phase 3 hands it to the tracker.
pub(super) fn table() -> &'static ToolTable {
    static T: std::sync::OnceLock<ToolTable> = std::sync::OnceLock::new();
    T.get_or_init(|| {
        ToolTable::parse(include_str!("../tools.json")).expect("tools.json is a valid table")
    })
}

/// The frames of `<name>.sse` and the REST side `<name>.json` of a fixture.
pub(super) fn fixture(name: &str) -> (Vec<WireEvent>, Value) {
    let sse = std::fs::read_to_string(fixtures_dir().join(format!("{name}.sse"))).unwrap();
    let events = SseParser::default()
        .push(sse.as_bytes())
        .iter()
        .map(|p| WireEvent::parse(p).unwrap())
        .collect();
    let rest = std::fs::read_to_string(fixtures_dir().join(format!("{name}.json")))
        .map(|t| serde_json::from_str(&t).unwrap())
        .unwrap_or(Value::Null);
    (events, rest)
}

/// Every scenario fixture (the ones with a `.sse`).
pub(super) fn fixture_names() -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(fixtures_dir())
        .unwrap()
        .flatten()
        .filter_map(|e| {
            let n = e.file_name().to_string_lossy().into_owned();
            n.strip_suffix(".sse").map(String::from)
        })
        .collect();
    names.sort();
    names
}

/// The chat's own session: the first one created without a parent, else (a capture that began
/// after the session existed) the first session any event names.
pub(super) fn main_session(events: &[WireEvent]) -> String {
    events
        .iter()
        .find(|e| e.kind == "session.created" && e.data.get("parentID").is_none())
        .or_else(|| events.iter().find(|e| e.session_id().is_some()))
        .and_then(|e| e.session_id())
        .map(String::from)
        .unwrap_or_default()
}

/// What the pane gets for `events`, and everything the mapper said besides.
pub(super) struct Run {
    pub events: Vec<AgentEvent>,
    pub mapped: Vec<Mapped>,
    pub state: MapState,
}

pub(super) fn run_events(events: &[WireEvent], main: &str) -> Run {
    let mut state = MapState::new(main).with_codemode(table().name_of(Role::Codemode));
    let mut subs = SubTracker::new(table());
    let mut out = Vec::new();
    let mut all = Vec::new();
    for ev in events {
        let m = state.map(ev);
        // `Session::on_mapped`: tasks first, then each event with the states the tracker decides
        out.extend(m.tasks.iter().flat_map(|s| subs.on_task(s)));
        for e in &m.events {
            let d = subs.observe(e);
            out.extend(d.before);
            out.push(e.clone());
            out.extend(d.after);
        }
        all.push(m);
    }
    Run {
        events: out,
        mapped: all,
        state,
    }
}

pub(super) fn run(name: &str) -> Run {
    let (events, _) = fixture(name);
    let main = main_session(&events);
    run_events(&events, &main)
}

use crate::agent::golden_tests::kinds;

fn count(events: &[AgentEvent], kind: &str) -> usize {
    kinds(events).iter().filter(|k| *k == kind).count()
}

// ---------------------------------------------------------------------------------------------
// Goldens

/// The golden of a run: the pane's events in order, and the `taken` / `accepted` receipts and the
/// tracker signals where they occurred (so a change to either shows in review).
fn golden_of(run: &Run) -> Value {
    let mut steps = Vec::new();
    for m in &run.mapped {
        for t in &m.tasks {
            steps.push(json!({"task": format!("{t:?}")}));
        }
        if let Some(t) = &m.taken {
            steps.push(json!({"taken": t}));
        }
        if let Some(a) = &m.accepted {
            steps.push(json!({"accepted": a}));
        }
    }
    json!({"events": run.events, "signals": steps})
}

#[test]
fn golden_event_streams_match_the_files() {
    let dir = feature_dir().join("goldens");
    let names = fixture_names();
    assert!(names.len() >= 20, "fixtures went missing: {names:?}");
    for name in names {
        let actual = serde_json::to_string_pretty(&golden_of(&run(&name))).unwrap() + "\n";
        crate::agent::golden_tests::check(&dir, &name, &actual);
    }
}

#[test]
fn every_golden_has_its_fixture() {
    let names = fixture_names();
    for e in std::fs::read_dir(feature_dir().join("goldens"))
        .unwrap()
        .flatten()
    {
        let n = e.file_name().to_string_lossy().into_owned();
        let stem = n.strip_suffix(".events.json").unwrap_or(&n);
        assert!(names.iter().any(|f| f == stem), "golden {n} has no fixture");
    }
}

#[test]
fn no_fixture_makes_the_mapper_report_a_protocol_error() {
    for name in fixture_names() {
        let r = run(&name);
        let bad: Vec<_> = r
            .events
            .iter()
            .filter(|e| {
                matches!(
                    e,
                    AgentEvent::Error {
                        kind: AgentErrorKind::Protocol,
                        ..
                    }
                )
            })
            .collect();
        assert!(bad.is_empty(), "{name}: {bad:?}");
    }
}

// ---------------------------------------------------------------------------------------------
// The rows of section 6

fn finished(events: &[AgentEvent]) -> Vec<(TurnFinishReason, bool)> {
    events
        .iter()
        .filter_map(|e| match e {
            AgentEvent::TurnFinished {
                reason, is_error, ..
            } => Some((*reason, *is_error)),
            _ => None,
        })
        .collect()
}

#[test]
fn a_plain_turn_streams_text_and_reasoning_and_ends_with_its_usage() {
    let r = run("text");
    assert!(count(&r.events, "thinking") >= 3);
    assert!(count(&r.events, "text-delta") >= 1);
    assert_eq!(count(&r.events, "text"), 1);
    // Message usage per step, then the turn's, then the end: in that order
    let k = kinds(&r.events);
    let n = k.len();
    assert_eq!(&k[n - 2..], ["usage", "turn-finished"]);
    assert_eq!(finished(&r.events), [(TurnFinishReason::Completed, false)]);
    let usages: Vec<_> = r
        .events
        .iter()
        .filter_map(|e| match e {
            AgentEvent::Usage {
                scope,
                input_tokens,
                output_tokens,
                cache_read_tokens,
                ..
            } => Some((*scope, *input_tokens, *output_tokens, *cache_read_tokens)),
            _ => None,
        })
        .collect();
    type Sums = Vec<(UsageScope, u64, u64, u64)>;
    let (msg, turn): (Sums, Sums) = usages.iter().partition(|u| u.0 == UsageScope::Message);
    assert_eq!(turn.len(), 1);
    // the turn is the sum of its steps, reasoning counted as output
    assert_eq!(turn[0].1, msg.iter().map(|u| u.1).sum::<u64>());
    assert_eq!(turn[0].2, msg.iter().map(|u| u.2).sum::<u64>());
    assert_eq!(turn[0].3, msg.iter().map(|u| u.3).sum::<u64>());
}

#[test]
fn the_turn_duration_is_the_difference_of_the_servers_own_timestamps() {
    let (events, _) = fixture("text");
    let start = events
        .iter()
        .find(|e| e.kind == "session.execution.started")
        .unwrap()
        .created;
    let end = events
        .iter()
        .find(|e| e.kind == "session.execution.succeeded")
        .unwrap()
        .created;
    let r = run("text");
    let AgentEvent::TurnFinished { duration_ms, .. } = r.events.last().unwrap() else {
        panic!("no turn end")
    };
    assert_eq!(*duration_ms, (end - start) as u64);
    assert!(*duration_ms > 0);
}

#[test]
fn context_window_comes_from_the_model_limits_when_known() {
    let (events, _) = fixture("text");
    let main = main_session(&events);
    let mut state = MapState::new(&main);
    state.set_limits(HashMap::from([("opencode/beam-free".to_string(), 128_000)]));
    let mut windows = Vec::new();
    for ev in &events {
        for e in state.map(ev).events {
            if let AgentEvent::Usage {
                context_window,
                scope,
                ..
            } = e
            {
                windows.push((scope, context_window));
            }
        }
    }
    assert!(windows.iter().all(|(_, w)| *w == Some(128_000)));
    assert!(windows.iter().any(|(s, _)| *s == UsageScope::Turn));
    // unknown models carry none
    let r = run("text");
    assert!(r.events.iter().all(|e| !matches!(
        e,
        AgentEvent::Usage {
            context_window: Some(_),
            ..
        }
    )));
}

#[test]
fn an_edit_asks_with_the_tools_own_input_and_both_always_choices() {
    let r = run("edit");
    let ask = r
        .events
        .iter()
        .find_map(|e| match e {
            AgentEvent::PermissionRequest {
                tool,
                input,
                suggestions,
                tool_call_id,
                ..
            } => Some((
                tool.clone(),
                input.clone(),
                suggestions.clone(),
                tool_call_id.clone(),
            )),
            _ => None,
        })
        .expect("a permission request");
    assert_eq!(ask.0, "edit");
    assert!(
        ask.1.get("oldString").is_some() && ask.1.get("newString").is_some(),
        "{:?}",
        ask.1
    );
    assert!(ask.3.is_some());
    let types: Vec<_> = ask
        .2
        .iter()
        .map(|s| s["type"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(types, ["addRules", "setMode"]);
    assert_eq!(ask.2[0]["rules"][0]["toolName"], "edit");
    // the answer resolves it, then the tool finishes
    assert_eq!(count(&r.events, "permission-resolved"), 1);
}

#[test]
fn a_write_asks_as_the_write_tool_though_its_action_is_edit() {
    let r = run("tool-write");
    let tool = r
        .events
        .iter()
        .find_map(|e| match e {
            AgentEvent::PermissionRequest { tool, input, .. } => {
                Some((tool.clone(), input.clone()))
            }
            _ => None,
        })
        .unwrap();
    assert_eq!(tool.0, "write");
    assert!(tool.1.get("content").is_some() && tool.1.get("path").is_some());
    assert_eq!(table().kind("write"), crate::agent::tool_table::Kind::Edit);
}

#[test]
fn glob_and_grep_are_search_calls_with_their_own_permission() {
    let r = run("tool-search");
    let tools: Vec<_> = r
        .events
        .iter()
        .filter_map(|e| match e {
            AgentEvent::PermissionRequest { tool, .. } => Some(tool.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(tools, ["glob", "grep"]);
    for t in tools {
        assert_eq!(table().kind(&t), crate::agent::tool_table::Kind::Search);
    }
}

#[test]
fn a_rejected_shell_ends_the_turn_interrupted_with_the_failed_steps_usage() {
    let r = run("shell-reject");
    assert_eq!(
        finished(&r.events),
        [(TurnFinishReason::Interrupted, false)]
    );
    let failed = r.events.iter().find_map(|e| match e {
        AgentEvent::ToolCallFinished {
            outcome, is_error, ..
        } => Some((*outcome, *is_error)),
        _ => None,
    });
    assert_eq!(failed, Some((ToolOutcome::Rejected, true)));
    // the failed step's tokens still count: a message usage and a turn usage exist
    assert!(count(&r.events, "usage") >= 2);
    let turn_tokens = r.events.iter().find_map(|e| match e {
        AgentEvent::Usage {
            scope: UsageScope::Turn,
            input_tokens,
            ..
        } => Some(*input_tokens),
        _ => None,
    });
    assert!(
        turn_tokens.unwrap_or(0) > 0,
        "the failed step carried tokens"
    );
}

#[test]
fn a_reject_with_a_message_is_a_rejected_call_and_the_turn_goes_on() {
    let r = run("reject-message");
    let outcomes: Vec<_> = r
        .events
        .iter()
        .filter_map(|e| match e {
            AgentEvent::ToolCallFinished {
                outcome, output, ..
            } => Some((*outcome, output.clone())),
            _ => None,
        })
        .collect();
    assert_eq!(outcomes.len(), 2);
    assert!(outcomes
        .iter()
        .all(|(o, m)| *o == ToolOutcome::Rejected && m.starts_with("Writer says")));
    // one reject answered both pending requests: both cards resolve as denied
    let denied = r
        .events
        .iter()
        .filter(|e| {
            matches!(
                e,
                AgentEvent::PermissionResolved {
                    resolution: PermissionResolution::Denied,
                    ..
                }
            )
        })
        .count();
    assert_eq!(denied, 2);
    assert_eq!(finished(&r.events), [(TurnFinishReason::Completed, false)]);
}

#[test]
fn always_on_one_request_resolves_its_sibling_too() {
    let r = run("shell-always");
    assert_eq!(count(&r.events, "permission-request"), 2);
    assert_eq!(count(&r.events, "permission-resolved"), 2);
    // both asks are about the shell tool, with the `echo *` pattern to save
    for e in &r.events {
        if let AgentEvent::PermissionRequest {
            tool,
            suggestions,
            input,
            ..
        } = e
        {
            assert_eq!(tool, "shell");
            assert_eq!(suggestions[0]["rules"][0]["ruleContent"], "echo *");
            assert!(input.get("command").is_some());
        }
    }
}

#[test]
fn an_interrupt_ends_the_turn_interrupted_and_the_shell_row_is_an_error() {
    let r = run("interrupt");
    assert_eq!(
        finished(&r.events),
        [(TurnFinishReason::Interrupted, false)]
    );
    assert!(r.events.iter().any(|e| matches!(
        e,
        AgentEvent::ToolCallFinished {
            outcome: ToolOutcome::Error,
            is_error: true,
            ..
        }
    )));
    assert!(
        count(&r.events, "usage") >= 2,
        "the interrupted step's usage is kept"
    );
}

#[test]
fn steer_now_is_an_interrupted_turn_then_a_second_turn() {
    let r = run("steer-now");
    assert_eq!(
        finished(&r.events),
        [
            (TurnFinishReason::Interrupted, false),
            (TurnFinishReason::Completed, false)
        ]
    );
}

#[test]
fn a_question_card_carries_the_fields_and_resolves_with_the_answers() {
    let r = run("question");
    let q = r
        .events
        .iter()
        .find_map(|e| match e {
            AgentEvent::QuestionRequest {
                questions,
                tool_call_id,
                ..
            } => Some((questions.clone(), tool_call_id.clone())),
            _ => None,
        })
        .unwrap();
    assert_eq!(q.0.len(), 1);
    assert!(!q.0[0].multi_select);
    assert!(q.0[0].options.len() >= 2);
    assert!(q.1.is_some());
    let a = r.events.iter().find_map(|e| match e {
        AgentEvent::QuestionResolved {
            resolution,
            answers,
            ..
        } => Some((*resolution, answers.clone())),
        _ => None,
    });
    let (resolution, answers) = a.unwrap();
    assert_eq!(resolution, QuestionResolution::Answered);
    assert_eq!(answers[0].answers, ["pear"]);
    assert_eq!(answers[0].question, q.0[0].question);
}

#[test]
fn a_multi_select_question_answers_with_several_values() {
    let r = run("question-multi");
    let multi = r.events.iter().any(
        |e| matches!(e, AgentEvent::QuestionRequest { questions, .. } if questions[0].multi_select),
    );
    assert!(multi);
    let answers = r.events.iter().find_map(|e| match e {
        AgentEvent::QuestionResolved {
            answers,
            resolution: QuestionResolution::Answered,
            ..
        } => Some(answers.clone()),
        _ => None,
    });
    assert_eq!(answers.unwrap()[0].answers, ["apple", "plum"]);
}

#[test]
fn a_skipped_question_resolves_skipped_and_the_tool_reads_as_rejected_text() {
    let r = run("question-skip");
    assert!(r.events.iter().any(|e| matches!(
        e,
        AgentEvent::QuestionResolved { resolution: QuestionResolution::Skipped, answers, .. } if answers.is_empty()
    )));
    // the tool failed with the asker's message and the turn went on
    assert_eq!(finished(&r.events), [(TurnFinishReason::Completed, false)]);
}

#[test]
fn a_sub_agent_is_linked_by_its_launch_call_and_its_events_carry_that_parent() {
    let r = run("subagent");
    let launch = r
        .events
        .iter()
        .find_map(|e| match e {
            AgentEvent::ToolCallStarted {
                tool_call_id, tool, ..
            } if tool == "subagent" => Some(tool_call_id.clone()),
            _ => None,
        })
        .unwrap();
    // the child's own calls hang under the launch call
    let child_calls: Vec<_> = r
        .events
        .iter()
        .filter_map(|e| match e {
            AgentEvent::ToolCallStarted {
                parent_tool_call_id: Some(p),
                tool,
                ..
            } => Some((p.clone(), tool.clone())),
            _ => None,
        })
        .collect();
    assert!(!child_calls.is_empty());
    assert!(child_calls.iter().all(|(p, _)| *p == launch));
    // the mapper tells the tracker, never the pane: Started then Notified with the report
    let tasks: Vec<_> = r.mapped.iter().flat_map(|m| m.tasks.iter()).collect();
    assert!(
        matches!(tasks[0], TaskSignal::Started { background: true, call: Some(c), .. } if *c == launch)
    );
    let notified = tasks.iter().find_map(|t| match t {
        TaskSignal::Notified {
            status,
            report,
            call,
            ..
        } => Some((*status, report.clone(), call.clone())),
        _ => None,
    });
    let (status, report, call) = notified.unwrap();
    assert_eq!(status, SubagentRunStatus::Completed);
    assert_eq!(call.as_deref(), Some(launch.as_str()));
    assert!(report.is_some_and(|r| !r.is_empty()));
    // the tracker's states reach the pane: running, then completed with the report
    let states: Vec<_> = r
        .events
        .iter()
        .filter_map(|e| match e {
            AgentEvent::SubagentStatus { status, report, .. } => Some((*status, report.is_some())),
            _ => None,
        })
        .collect();
    assert_eq!(
        states,
        [
            (SubagentRunStatus::Running, false),
            (SubagentRunStatus::Completed, true)
        ]
    );
    // the child's messages and model are announced as the Claude mapper announces its own
    assert!(count(&r.events, "subagent-message") >= 1);
    assert!(count(&r.events, "subagent-model") == 1);
    // the parent's first turn stays open for the background run: two turn ends, no error
    assert_eq!(finished(&r.events).len(), 2);
}

#[test]
fn a_sub_agent_that_fails_ends_failed() {
    let r = run("subagent-failed");
    let states: Vec<_> = r
        .events
        .iter()
        .filter_map(|e| match e {
            AgentEvent::SubagentStatus { status, .. } => Some(*status),
            _ => None,
        })
        .collect();
    assert_eq!(
        states,
        [SubagentRunStatus::Running, SubagentRunStatus::Failed]
    );
}

#[test]
fn a_child_edit_asks_through_the_child_session_with_the_launch_as_parent() {
    let r = run("subagent-child-edit");
    // the child's edit ran with no card (the session allowed it): the call is under the launch
    assert_eq!(count(&r.events, "permission-request"), 0);
    let edit = r.events.iter().find(|e| {
        matches!(e, AgentEvent::ToolCallStarted { tool, parent_tool_call_id: Some(_), .. } if tool == "edit")
    });
    assert!(edit.is_some());
}

#[test]
fn codemode_shows_its_inner_calls_as_nested_rows_and_the_execute_result() {
    let r = run("mcp-codemode");
    let rows: Vec<_> = r
        .events
        .iter()
        .filter_map(|e| match e {
            AgentEvent::ToolCallStarted {
                tool_call_id,
                tool,
                parent_tool_call_id: Some(p),
                ..
            } => Some((tool_call_id.clone(), tool.clone(), p.clone())),
            _ => None,
        })
        .collect();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].1, "writer_note_count");
    assert_eq!(rows[0].0, format!("{}:0", rows[0].2));
    // the card is about the inner row, in the inner call's name
    let ask = r.events.iter().find_map(|e| match e {
        AgentEvent::PermissionRequest {
            tool, tool_call_id, ..
        } => Some((tool.clone(), tool_call_id.clone())),
        _ => None,
    });
    let (tool, call) = ask.unwrap();
    assert_eq!(tool, "writer_note_count");
    assert_eq!(call.as_deref(), Some(rows[0].0.as_str()));
    // the inner row finishes before the execute row does
    let order: Vec<_> = r
        .events
        .iter()
        .filter_map(|e| match e {
            AgentEvent::ToolCallFinished { tool_call_id, .. } => Some(tool_call_id.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(order, [rows[0].0.clone(), rows[0].2.clone()]);
}

#[test]
fn a_failed_inner_call_is_an_error_row_and_a_denied_tool_is_not_shown_at_all() {
    let r = run("codemode-failures");
    let inner: Vec<_> = r
        .events
        .iter()
        .filter_map(|e| match e {
            AgentEvent::ToolCallFinished {
                tool_call_id,
                is_error,
                ..
            } if tool_call_id.contains(':') => Some((tool_call_id.clone(), *is_error)),
            _ => None,
        })
        .collect();
    assert_eq!(inner.len(), 2, "{inner:?}");
    assert!(!inner[0].1 && inner[1].1, "ok then error: {inner:?}");
    let started: Vec<_> = r
        .events
        .iter()
        .filter_map(|e| match e {
            AgentEvent::ToolCallStarted {
                tool,
                parent_tool_call_id: Some(_),
                ..
            } => Some(tool.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(started, ["writer_note_count", "writer_note_fail"]);
}

#[test]
fn a_direct_mcp_call_is_one_plain_row() {
    let r = run("mcp-direct");
    assert!(r.events.iter().any(|e| {
        matches!(e, AgentEvent::ToolCallStarted { tool, parent_tool_call_id: None, .. } if tool == "writer_note_count")
    }));
    assert!(r.events.iter().all(|e| !matches!(
        e,
        AgentEvent::ToolCallStarted {
            parent_tool_call_id: Some(_),
            ..
        }
    )));
}

#[test]
fn a_failed_execution_is_an_error_card_and_an_error_turn() {
    for (name, kind) in [
        ("error-unknown-model", AgentErrorKind::Api),
        ("error-unknown-provider", AgentErrorKind::Api),
        ("error-provider-auth", AgentErrorKind::Auth),
    ] {
        let r = run(name);
        let err = r.events.iter().find_map(|e| match e {
            AgentEvent::Error {
                kind, retryable, ..
            } => Some((*kind, *retryable)),
            _ => None,
        });
        assert_eq!(err, Some((kind, false)), "{name}");
        assert_eq!(
            finished(&r.events),
            [(TurnFinishReason::Error, true)],
            "{name}"
        );
        let k = kinds(&r.events);
        let e = k.iter().position(|x| x == "error").unwrap();
        // error, usage, turn-finished
        assert_eq!(&k[e..e + 3], ["error", "usage", "turn-finished"], "{name}");
    }
}

#[test]
fn the_files_fixture_maps_like_a_plain_turn() {
    let r = run("files-mention");
    assert_eq!(finished(&r.events), [(TurnFinishReason::Completed, false)]);
    assert!(count(&r.events, "text") >= 1);
}

#[test]
fn steer_and_queue_receipts_decode_only_for_ids_writer_made() {
    // the recorded ids are OpenCode's own (faked): no receipt, so nothing is "taken"
    let r = run("steer-queue");
    assert!(r
        .mapped
        .iter()
        .all(|m| m.taken.is_none() && m.accepted.is_none()));
    // an id derived from a receipt is taken and accepted
    let receipt = "0b6f2c1e-8d3a-4f55-9a10-1c2d3e4f5a6b";
    let id = super::opencode_api::message_id_for(receipt);
    let mut state = MapState::new("ses_a");
    let enq = WireEvent::parse(
        &json!({"type": "session.inbox.enqueued", "data": {"sessionID": "ses_a", "inboxID": id,
            "item": {"type": "user", "payload": {"text": "x"}, "delivery": "queue"}}})
        .to_string(),
    )
    .unwrap();
    assert_eq!(state.map(&enq).accepted.as_deref(), Some(receipt));
    let del = WireEvent::parse(
        &json!({"type": "session.inbox.delivered", "data": {"sessionID": "ses_a", "inboxID": id}})
            .to_string(),
    )
    .unwrap();
    let m = state.map(&del);
    assert_eq!(m.taken.as_deref(), Some(receipt));
    // the mapper does not emit MessageReceived itself: `Session` does, from `taken`
    assert!(m.events.is_empty());
}

// ---------------------------------------------------------------------------------------------
// Sub-agent routing with hand-made events

fn ev(kind: &str, data: Value) -> WireEvent {
    WireEvent::parse(&json!({"id": "e", "created": 1000.0, "type": kind, "data": data}).to_string())
        .unwrap()
}

fn created(session: &str, parent: Option<&str>) -> WireEvent {
    let mut d = json!({"sessionID": session, "model": {"id": "m", "providerID": "p"}});
    if let Some(p) = parent {
        d["parentID"] = json!(p);
    }
    ev("session.created", d)
}

fn text_delta(session: &str, message: &str, delta: &str) -> WireEvent {
    ev(
        "session.text.delta",
        json!({"sessionID": session, "assistantMessageID": message, "ordinal": 0, "delta": delta}),
    )
}

fn launch_progress(parent: &str, call: &str, child: &str) -> WireEvent {
    ev(
        "session.tool.progress",
        json!({"sessionID": parent, "id": call, "metadata": {"sessionID": child, "status": "running"}}),
    )
}

fn started(session: &str, call: &str, name: &str) -> WireEvent {
    ev(
        "session.tool.input.started",
        json!({"sessionID": session, "assistantMessageID": "m1", "id": call, "name": name}),
    )
}

#[test]
fn a_childs_events_are_held_until_the_link_and_then_released_in_order() {
    let mut s = MapState::new("ses_p");
    assert!(s.map(&started("ses_p", "c1", "subagent")).events.len() == 1);
    assert!(s.map(&created("ses_c", Some("ses_p"))).events.is_empty());
    // before the link nothing of the child reaches the pane
    assert!(s.map(&text_delta("ses_c", "mc", "a")).events.is_empty());
    assert!(s.map(&text_delta("ses_c", "mc", "b")).events.is_empty());
    let linked = s.map(&launch_progress("ses_p", "c1", "ses_c"));
    assert_eq!(linked.events.len(), 2, "both held deltas, in order");
    assert!(matches!(&linked.events[0], AgentEvent::TextDelta { text, .. } if text == "a"));
    assert!(matches!(&linked.events[1], AgentEvent::TextDelta { text, .. } if text == "b"));
    assert!(matches!(
        &linked.tasks[0],
        TaskSignal::Started { task, call: Some(c), background: true } if task == "ses_c" && c == "c1"
    ));
    // after it, events flow at once
    assert_eq!(s.map(&text_delta("ses_c", "mc", "c")).events.len(), 1);
}

#[test]
fn a_grandchild_resolves_through_its_parent_to_the_same_chat() {
    let mut s = MapState::new("ses_p");
    s.map(&started("ses_p", "c1", "subagent"));
    s.map(&created("ses_c", Some("ses_p")));
    s.map(&launch_progress("ses_p", "c1", "ses_c"));
    // the child launches a grandchild with a call of its own
    s.map(&started("ses_c", "c2", "subagent"));
    assert!(s.map(&created("ses_g", Some("ses_c"))).events.is_empty());
    assert!(s.map(&text_delta("ses_g", "mg", "x")).events.is_empty());
    let linked = s.map(&launch_progress("ses_c", "c2", "ses_g"));
    assert_eq!(linked.events.len(), 1);
    assert!(matches!(
        &linked.tasks[0],
        TaskSignal::Started { task, call: Some(c), .. } if task == "ses_g" && c == "c2"
    ));
    let kids: std::collections::BTreeSet<_> = s.children().collect();
    assert_eq!(kids, ["ses_c", "ses_g"].into_iter().collect());
}

// A session with no known ancestor never reaches the mapper: the server's fan-out drops it
// (`server_tests::events_go_to_the_chat_that_owns_their_session...`).

#[test]
fn a_child_still_unlinked_when_the_parent_turn_ends_is_a_protocol_error() {
    let mut s = MapState::new("ses_p");
    s.map(&ev(
        "session.execution.started",
        json!({"sessionID": "ses_p"}),
    ));
    s.map(&created("ses_c", Some("ses_p")));
    s.map(&text_delta("ses_c", "mc", "held"));
    let end = s.map(&ev(
        "session.execution.succeeded",
        json!({"sessionID": "ses_p"}),
    ));
    let errors: Vec<_> = end
        .events
        .iter()
        .filter(|e| {
            matches!(
                e,
                AgentEvent::Error {
                    kind: AgentErrorKind::Protocol,
                    ..
                }
            )
        })
        .collect();
    assert_eq!(errors.len(), 1);
    // said once
    s.map(&ev(
        "session.execution.started",
        json!({"sessionID": "ses_p"}),
    ));
    let again = s.map(&ev(
        "session.execution.succeeded",
        json!({"sessionID": "ses_p"}),
    ));
    assert!(again
        .events
        .iter()
        .all(|e| !matches!(e, AgentEvent::Error { .. })));
}

#[test]
fn a_report_that_arrives_after_the_end_is_added_once() {
    let mut s = MapState::new("ses_p");
    s.map(&started("ses_p", "c1", "subagent"));
    s.map(&created("ses_c", Some("ses_p")));
    s.map(&launch_progress("ses_p", "c1", "ses_c"));
    let job = ev(
        "experimental.job.updated",
        json!({"info": {"kind": "subagent", "id": "ses_c", "sessionID": "ses_p", "childSessionID": "ses_c", "status": "completed"}}),
    );
    let first = s.map(&job);
    assert!(matches!(
        &first.tasks[0],
        TaskSignal::Notified {
            report: None,
            status: SubagentRunStatus::Completed,
            ..
        }
    ));
    let synthetic = ev(
        "session.inbox.enqueued",
        json!({"sessionID": "ses_p", "inboxID": "msg_s", "item": {"type": "synthetic", "delivery": "steer",
            "payload": {"text": "<background-result kind=\"subagent\" state=\"completed\">\nDone.\n</background-result>",
                        "metadata": {"source": "subagent", "childID": "ses_c", "state": "completed"}}}}),
    );
    let second = s.map(&synthetic);
    assert!(
        matches!(&second.tasks[0], TaskSignal::Notified { report: Some(r), .. } if r == "Done.")
    );
    // and not a third time
    assert!(s.map(&synthetic).tasks.is_empty());
}

#[test]
fn an_unreadable_event_is_a_content_free_protocol_error() {
    let mut s = MapState::new("ses_p");
    let bad = ev(
        "session.text.delta",
        json!({"sessionID": "ses_p", "ordinal": "two"}),
    );
    let out = s.map(&bad);
    match &out.events[..] {
        [AgentEvent::Error {
            kind: AgentErrorKind::Protocol,
            message,
            retryable: false,
        }] => {
            assert!(message.contains("session.text.delta"));
        }
        other => panic!("{other:?}"),
    }
}

// ---------------------------------------------------------------------------------------------
// Resync

fn shown(events: &[AgentEvent]) -> (Vec<(String, u32, String)>, Vec<String>) {
    let mut texts = Vec::new();
    let mut tools = Vec::new();
    for e in events {
        match e {
            AgentEvent::Text {
                message_id,
                block_index,
                text,
            } => texts.push((message_id.clone(), *block_index, text.clone())),
            AgentEvent::ToolCallStarted {
                tool_call_id,
                parent_tool_call_id: None,
                ..
            } => tools.push(tool_call_id.clone()),
            _ => {}
        }
    }
    texts.sort();
    tools.sort();
    (texts, tools)
}

/// After a stream drop, the message list brings back every final block and tool call of the
/// main session that the events showed (single-session fixtures).
#[test]
fn resync_from_the_message_list_restores_what_the_dropped_events_showed() {
    for name in [
        "text",
        "edit",
        "tool-search",
        "tool-write",
        "shell-always",
        "question",
        "reject-message",
    ] {
        let (events, rest) = fixture(name);
        let main = main_session(&events);
        let full = run_events(&events, &main);
        // the connection died right after the turn started: nothing of the turn was seen
        let cut = events
            .iter()
            .position(|e| e.kind == "session.execution.started")
            .unwrap();
        let partial = run_events(&events[..=cut], &main);
        let mut state = partial.state;
        let resynced = state.resync(&rest["messages"]);
        let (want_texts, want_tools) = shown(&full.events);
        let (got_texts, got_tools) = shown(&resynced.events);
        assert_eq!(got_texts, want_texts, "{name}: texts");
        assert_eq!(got_tools, want_tools, "{name}: tool calls");
        // every tool call the list shows ends, with its input
        let ends = resynced
            .events
            .iter()
            .filter(|e| matches!(e, AgentEvent::ToolCallFinished { .. }))
            .count();
        assert_eq!(ends, want_tools.len(), "{name}: finished");
    }
}

#[test]
fn resync_adds_only_what_is_missing_and_never_twice() {
    let (events, rest) = fixture("tool-search");
    let main = main_session(&events);
    // the whole turn was seen: the list adds nothing
    let full = run_events(&events, &main);
    let mut state = full.state;
    assert!(state.resync(&rest["messages"]).events.is_empty());
    // half of it was seen: the rest comes once, a second resync adds nothing
    let half = events
        .iter()
        .position(|e| e.kind == "session.tool.success")
        .unwrap();
    let mut state = run_events(&events[..=half], &main).state;
    let first = state.resync(&rest["messages"]);
    assert!(!first.events.is_empty());
    assert!(state.resync(&rest["messages"]).events.is_empty());
}

// ---------------------------------------------------------------------------------------------
// Resync and seed, at every cut

fn finished_count(events: &[AgentEvent]) -> usize {
    count(events, "turn-finished")
}

/// The fixtures that are one plain main-session turn whose list ends in an `idle` item.
fn one_turn_fixtures() -> Vec<String> {
    fixture_names()
        .into_iter()
        .filter(|n| {
            let (events, rest) = fixture(n);
            events
                .iter()
                .filter(|e| e.kind == "session.execution.started")
                .count()
                == 1
                && events.iter().all(|e| e.data.get("parentID").is_none())
                && rest["messages"]["data"][0]["type"] == "idle"
        })
        .collect()
}

#[test]
fn every_cut_of_a_turn_ends_with_exactly_one_turn_finished_after_a_resync() {
    let names = one_turn_fixtures();
    assert!(names.len() >= 8, "{names:?}");
    for name in names {
        let (events, rest) = fixture(&name);
        let main = main_session(&events);
        let started = events
            .iter()
            .position(|e| e.kind == "session.execution.started")
            .unwrap();
        for cut in started..events.len() {
            let seen = run_events(&events[..=cut], &main);
            let mut state = seen.state;
            let more = state.resync(&rest["messages"]);
            let total = finished_count(&seen.events) + finished_count(&more.events);
            assert_eq!(
                total, 1,
                "{name}, cut after event {cut} ({})",
                events[cut].kind
            );
            // a second resync adds nothing
            assert!(
                state.resync(&rest["messages"]).events.is_empty(),
                "{name} {cut}"
            );
        }
    }
}

#[test]
fn a_resync_finishes_a_turn_with_the_reason_of_the_list() {
    let (events, rest) = fixture("interrupt");
    let main = main_session(&events);
    let started = events
        .iter()
        .position(|e| e.kind == "session.execution.started")
        .unwrap();
    let mut state = run_events(&events[..=started], &main).state;
    let out = state.resync(&rest["messages"]);
    assert!(out.events.iter().any(|e| matches!(
        e,
        AgentEvent::TurnFinished {
            reason: TurnFinishReason::Interrupted,
            ..
        }
    )));
}

fn started_and_finished(events: &[AgentEvent]) -> (Vec<String>, Vec<String>) {
    let mut s = Vec::new();
    let mut f = Vec::new();
    for e in events {
        match e {
            AgentEvent::ToolCallStarted { tool_call_id, .. } => s.push(tool_call_id.clone()),
            AgentEvent::ToolCallFinished { tool_call_id, .. } => f.push(tool_call_id.clone()),
            _ => {}
        }
    }
    (s, f)
}

#[test]
fn a_resync_settles_every_codemode_row_at_every_cut() {
    for name in ["mcp-codemode", "codemode-failures"] {
        let (events, rest) = fixture(name);
        let main = main_session(&events);
        let started = events
            .iter()
            .position(|e| e.kind == "session.execution.started")
            .unwrap();
        for cut in started..events.len() {
            let seen = run_events(&events[..=cut], &main);
            let mut state = seen.state;
            let mut all = seen.events.clone();
            all.extend(state.resync(&rest["messages"]).events);
            let (mut s, mut f) = started_and_finished(&all);
            s.sort();
            f.sort();
            assert_eq!(
                s, f,
                "{name}, cut {cut} ({}): every row started is finished once",
                events[cut].kind
            );
            let mut dedup = s.clone();
            dedup.dedup();
            assert_eq!(dedup, s, "{name} {cut}: nothing is started twice");
        }
    }
}

#[test]
fn a_resync_links_a_child_from_its_launch_block_and_reads_its_list_too() {
    let (events, rest) = fixture("subagent");
    let main = main_session(&events);
    // the stream broke right after the child was created: no link yet, its events are held
    let created = events
        .iter()
        .position(|e| e.kind == "session.created" && e.data.get("parentID").is_some())
        .unwrap();
    let seen = run_events(&events[..=created], &main);
    let mut state = seen.state;
    let child = state.children().next().unwrap().to_string();
    let parent_out = state.resync(&rest["parent"]);
    assert!(
        parent_out
            .tasks
            .iter()
            .any(|t| matches!(t, TaskSignal::Started { task, .. } if *task == child)),
        "the launch block of the list links the child"
    );
    let child_out = state.resync_child(&child, &rest["child"]);
    assert!(
        child_out.events.iter().any(|e| matches!(
            e,
            AgentEvent::Text { .. }
                | AgentEvent::ToolCallStarted {
                    parent_tool_call_id: Some(_),
                    ..
                }
        )),
        "the child's own list is shown under its launch"
    );
    // nothing is shown twice
    assert!(state.resync_child(&child, &rest["child"]).events.is_empty());
}

#[test]
fn a_fresh_resume_marks_the_history_and_shows_only_a_running_turn() {
    // all history: nothing is emitted, and a later resync adds nothing either
    let (events, rest) = fixture("steer-now");
    let main = main_session(&events);
    let mut fresh = MapState::new(&main);
    assert!(fresh.seed(&rest["messages"]).events.is_empty());
    assert!(fresh.resync(&rest["messages"]).events.is_empty());
    // a turn still running (the newest item is not `idle`): its blocks are shown
    let (events, rest) = fixture("shell-reject");
    let main = main_session(&events);
    let mut fresh = MapState::new(&main);
    let out = fresh.seed(&rest["messages"]);
    assert!(
        out.events
            .iter()
            .any(|e| matches!(e, AgentEvent::ToolCallStarted { .. })),
        "{out:?}"
    );
    // a running turn after history: only the running one
    let history = json!({"data": [
        {"id": "msg_fake9", "type": "assistant", "content": [{"type": "text", "text": "now"}]},
        {"id": "msg_fake8", "type": "idle", "outcome": "succeeded", "time": {"created": 1}},
        {"id": "msg_fake7", "type": "assistant", "content": [{"type": "text", "text": "before"}]},
    ]});
    let mut fresh = MapState::new("ses_p");
    let out = fresh.seed(&history);
    let texts: Vec<_> = out
        .events
        .iter()
        .filter_map(|e| match e {
            AgentEvent::Text { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(texts, ["now"]);
}

// ---------------------------------------------------------------------------------------------
// The permission-model captures (spec 10.9): what each fixture proves, read from the raw events

/// `(session, tool, outcome)` of every tool call of a fixture, `outcome` being `ok` or the error
/// type, and the `(session, action)` of every request that asked.
type Outcomes = (Vec<(String, String, String)>, Vec<(String, String)>);

fn tool_outcomes(name: &str) -> Outcomes {
    let (events, _) = fixture(name);
    let mut names = HashMap::new();
    let (mut tools, mut asked) = (Vec::new(), Vec::new());
    for e in &events {
        let sid = e.session_id().unwrap_or("").to_string();
        match e.kind.as_str() {
            "session.tool.input.started" => {
                names.insert(
                    e.data["id"].as_str().unwrap_or("").to_string(),
                    e.data["name"].as_str().unwrap_or("").to_string(),
                );
            }
            "session.tool.success" | "session.tool.failed" => {
                let tool = names
                    .get(e.data["id"].as_str().unwrap_or(""))
                    .cloned()
                    .unwrap_or_default();
                let out = if e.kind.ends_with("success") {
                    "ok".to_string()
                } else {
                    e.data["error"]["type"].as_str().unwrap_or("").to_string()
                };
                tools.push((sid, tool, out));
            }
            "permission.asked" => {
                asked.push((sid, e.data["action"].as_str().unwrap_or("").to_string()))
            }
            _ => {}
        }
    }
    (tools, asked)
}

fn edits(name: &str) -> Vec<String> {
    tool_outcomes(name)
        .0
        .into_iter()
        .filter(|t| t.1 == "edit")
        .map(|t| t.2)
        .collect()
}

fn shell_text(name: &str) -> String {
    let (events, _) = fixture(name);
    events
        .iter()
        .filter(|e| e.kind == "session.tool.success")
        .map(|e| e.data["content"].to_string())
        .collect()
}

#[test]
fn the_permission_captures_say_who_decides() {
    // a session that denies edit holds for the child too (it inherits the session's rules)
    assert_eq!(edits("perm-parent-deny-child-edit"), ["tool.execution"]);
    // a session that allows edit overrides the child's own agent-level deny: THE finding
    assert_eq!(edits("perm-session-allow-agent-deny"), ["ok"]);
    assert!(
        tool_outcomes("perm-session-allow-agent-deny").1.is_empty(),
        "and nobody was asked"
    );
    // with an empty session ruleset the agent's own rules decide
    assert_eq!(edits("perm-agent-deny-empty-session"), ["tool.execution"]);
    let (tools, asked) = tool_outcomes("perm-agent-ask-empty-session");
    assert!(
        asked.iter().any(|a| a.1 == "edit"),
        "an agent-level ask asks"
    );
    assert!(tools.iter().any(|t| t.1 == "edit" && t.2 == "ok"));
    // a child under an empty parent ruleset: its own agent's rules, else the config's, never
    // the parent agent's (which denied edit in both runs)
    let (_, asked) = tool_outcomes("perm-child-own-rules");
    assert!(
        asked.iter().any(|a| a.1 == "edit"),
        "the child's own `ask` applied"
    );
    assert_eq!(edits("perm-child-own-rules"), ["ok"]);
    let (_, asked) = tool_outcomes("perm-child-config-rules");
    assert!(
        asked.is_empty() && edits("perm-child-config-rules") == ["ok"],
        "the config's `allow` applied"
    );
    // a saved `always` rule does not beat an agent-level deny
    let (tools, _) = tool_outcomes("perm-saved-vs-agent-deny");
    let results: Vec<_> = tools
        .iter()
        .filter(|t| t.1 == "edit")
        .map(|t| t.2.as_str())
        .collect();
    assert_eq!(
        results,
        ["ok", "tool.execution"],
        "saved by the first session, denied in the second"
    );
    // a session-level deny (plan mode) holds against a saved `always` rule (saved by the first
    // session of the fixture) and against a child whose own agent allows edit
    assert_eq!(edits("perm-plan-deny-vs-saved"), ["ok", "tool.execution"]);
    assert!(edits("perm-session-deny-vs-child-allow")
        .iter()
        .all(|o| o != "ok"));
    // POST .../agent switches enforcement on a live session, both ways
    assert_eq!(edits("perm-switch-deny-to-allow"), ["ok"]);
    assert!(
        edits("perm-switch-allow-to-deny").is_empty(),
        "after allow -> deny no edit tool call ran"
    );
}

#[test]
fn the_environment_captures_say_what_the_agents_shell_can_read() {
    // the password is in the environment of the commands the agent runs...
    assert!(shell_text("perm-env-shell-probe").contains("OPENCODE_SERVER_PASSWORD=<redacted>"));
    // ...a wrapper set as the shell's program hides it from `env`...
    let wrapped = shell_text("perm-env-shell-wrapper");
    assert!(
        wrapped.contains("\"text\":\"0\\n\"") || wrapped.contains("\"text\": \"0\\n\""),
        "{wrapped}"
    );
    // ...but not from the process table: a same-user command reads the server's environment
    assert!(shell_text("perm-env-ps-probe").contains("1\\n"));
}

#[test]
fn a_child_nobody_saw_created_is_registered_by_the_launch_block_of_the_list() {
    let (events, rest) = fixture("subagent");
    let main = main_session(&events);
    let child = events
        .iter()
        .find(|e| e.kind == "session.created" && e.data.get("parentID").is_some())
        .and_then(|e| e.data["sessionID"].as_str().map(String::from))
        .unwrap();
    // a state that never heard of the child (the stream was down when it was created)
    let mut state = MapState::new(&main);
    assert_eq!(state.children().count(), 0);
    let out = state.resync(&rest["parent"]);
    assert_eq!(state.children().collect::<Vec<_>>(), [child.as_str()]);
    assert!(out
        .tasks
        .iter()
        .any(|t| matches!(t, TaskSignal::Started { task, .. } if *task == child)));
    // and its own list is shown under the launch
    assert!(!state.resync_child(&child, &rest["child"]).events.is_empty());
}
