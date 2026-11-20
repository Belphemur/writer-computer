//! The claude CLI's `--output-format stream-json` / `--input-format stream-json` protocol as pure
//! functions: raw stdout lines in, [`AgentEvent`]s out; user intents in, stdin lines out; the
//! argument vector. No process, no IO, no Tauri. The runner (lane 1) wires these to a child
//! process. Verified against claude 2.1.325, see the spec's appendix and `fixtures/`.
//!
//! What the mapper relies on (all observed, see `fixtures/*.jsonl`):
//!
//! - with `--include-partial-messages` every API message is `stream_event` `message_start`,
//!   `content_block_start/delta/stop`, `message_delta` (usage), `message_stop`, and between a
//!   block's last delta and its stop one complete `assistant` message carrying THAT block (one
//!   block per `assistant` line). The mapper turns streamed deltas into `*-delta` events and the
//!   `assistant` block into the authoritative final event, which replaces the deltas;
//! - tool results arrive as `user` lines with `tool_result` blocks;
//! - a permission prompt is a `control_request` with `subtype: "can_use_tool"` on stdout, answered
//!   by a `control_response` on stdin; `control_cancel_request` withdraws it;
//! - `result` ends every turn (the process stays alive for the next user line).
//!
//! The mapper never keeps or logs content; it only keeps ids.

use super::events::*;
use super::files::{FileKind, FilePart};
use super::mcp_wiring::{Launch, McpWiring};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::path::Path;

/// Tool output carried by `tool-call-finished` is cut here (on a char boundary). The full output
/// stays in the CLI's own transcript.
pub const MAX_TOOL_OUTPUT_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone)]
enum BlockKind {
    Text,
    Thinking,
    Tool(String),
}

/// Result of mapping one stdout line.
#[derive(Debug, Default, PartialEq)]
pub struct MapOutput {
    pub events: Vec<AgentEvent>,
    /// A `control_request` of a subtype Writer does not implement (hooks, MCP, elicitation).
    /// The runner MUST answer it with [`encode_control_error`], or the CLI waits forever.
    pub unsupported_control_request: Option<String>,
    /// Sub-agent tasks that started or ended (`system` `task_*` lines). Not UI events: the runner
    /// keeps its turn open while a task runs (`SPECs/agent-roles-spec.md`, section 2).
    pub tasks: Vec<TaskSignal>,
    /// The `uuid` of a user message the CLI echoed back (`--replay-user-messages`, `isReplay`):
    /// the receipt that it took a message Writer wrote mid-turn (a steer). Not a UI event.
    pub user_echo: Option<String>,
    /// The `command_uuid` of a `command_lifecycle` line in state `queued`: the CLI accepted the
    /// message and will run it, which can be long before the echo (a steer waits for the running
    /// sub-agents' tool calls to end, `steer-now-subagents`). Not a UI event.
    pub command_queued: Option<String>,
}

/// A task line of the stream, by the CLI's task id. Facts only: what they mean for a sub-agent's
/// life is decided in one place, `sub_tracker.rs`. `call` is the launch call the task belongs to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TaskSignal {
    /// `task_started`; `background` is the CLI's `is_backgrounded`.
    Started {
        task: String,
        call: Option<String>,
        background: bool,
    },
    /// `task_updated` with a final `patch.status`.
    Updated {
        task: String,
        call: Option<String>,
        status: SubagentRunStatus,
    },
    /// `task_notification`: the completion signal. `report` is the sub-agent's own final report
    /// when the CLI carries it (`handback_report.text`); its `summary` sentence is CLI text and
    /// never a report.
    Notified {
        task: String,
        call: Option<String>,
        status: SubagentRunStatus,
        report: Option<String>,
    },
    /// The launch call's result says the run went to the background (`tool_use_result.status`
    /// `async_launched`, which the CLI also answers for a run it moved to the background by
    /// itself). The result's text is CLI-internal and is not emitted.
    AsyncLaunched { call: String },
}

impl TaskSignal {
    /// The task id, for the signals that are about a task (not a launch result).
    pub fn task(&self) -> Option<&str> {
        match self {
            Self::Started { task, .. }
            | Self::Updated { task, .. }
            | Self::Notified { task, .. } => Some(task),
            Self::AsyncLaunched { .. } => None,
        }
    }
}

#[derive(Default)]
pub struct ClaudeStreamMapper {
    message_id: Option<String>,
    streamed: bool,
    blocks: HashMap<u32, BlockKind>,
    finalized: u32,
    thinking_block: Option<(String, u32)>,
    started_tools: HashSet<String>,
    finished_tools: HashSet<String>,
    pending_permissions: HashSet<String>,
    /// Open question cards by request id (their tool call id): a withdrawal resolves them as
    /// `cancelled` question events, not permission ones.
    pending_questions: HashMap<String, (Option<String>, Value)>,
    /// The launch call (`tool_use_id`) of each sub-agent task id: `task_updated` carries only
    /// the task id.
    task_calls: HashMap<String, String>,
    /// Each model's cumulative `outputTokens` at the last `result`: `modelUsage` sums the whole
    /// session, so the model of a turn is the one whose total grew.
    model_output: HashMap<String, u64>,
    /// The model of the last message the MAIN agent made this turn (`message.model` of a message
    /// with no `parent_tool_use_id`): the chat's own model. `modelUsage` also counts every
    /// sub-agent, which often runs on another model, so it only decides when this is unknown.
    main_model: Option<String>,
}

fn str_of<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

fn u64_of(v: &Value, key: &str) -> u64 {
    v.get(key).and_then(Value::as_u64).unwrap_or(0)
}

/// The report a `task_notification` carries from the sub-agent itself, bounded.
fn handback_report(v: &Value) -> Option<String> {
    let text = v.get("handback_report")?.get("text")?.as_str()?.trim();
    (!text.is_empty()).then(|| truncate_to_boundary(text.to_string(), MAX_TOOL_OUTPUT_BYTES).0)
}

fn truncate_to_boundary(mut s: String, max: usize) -> (String, bool) {
    if s.len() <= max {
        return (s, false);
    }
    let mut cut = max;
    while !s.is_char_boundary(cut) {
        cut -= 1;
    }
    s.truncate(cut);
    (s, true)
}

fn flatten_tool_result(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| match item.get("type").and_then(Value::as_str) {
                Some("text") => str_of(item, "text").unwrap_or("").to_string(),
                Some(other) => format!("[{other}]"),
                None => String::new(),
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// A signed-out CLI ends the turn with `is_error`, `terminal_reason:"api_error"`, no
/// `api_error_status` and the text `Not logged in · Please run /login` (captured, claude
/// 2.1.325). Matched loosely and only on that text; an expired key reports 401 and is
/// classified by status above.
fn looks_like_auth_failure(text: &str) -> bool {
    let t = text.to_ascii_lowercase();
    t.contains("not logged in") || t.contains("please run /login") || t.contains("invalid api key")
}

fn usage_event(
    scope: UsageScope,
    usage: &Value,
    cost: Option<f64>,
    window: Option<u64>,
    model: Option<String>,
) -> AgentEvent {
    AgentEvent::Usage {
        scope,
        input_tokens: u64_of(usage, "input_tokens"),
        output_tokens: u64_of(usage, "output_tokens"),
        cache_read_tokens: u64_of(usage, "cache_read_input_tokens"),
        cache_creation_tokens: u64_of(usage, "cache_creation_input_tokens"),
        cost_usd: cost,
        context_window: window,
        model,
    }
}

impl ClaudeStreamMapper {
    pub fn new() -> Self {
        Self::default()
    }

    /// Map one stdout line. A line that is not JSON yields an `error` event of kind `protocol`
    /// (without the line's content).
    pub fn map_line(&mut self, line: &str) -> MapOutput {
        let line = line.trim();
        if line.is_empty() {
            return MapOutput::default();
        }
        match serde_json::from_str::<Value>(line) {
            Ok(v) => self.map_value(&v),
            Err(_) => MapOutput {
                events: vec![AgentEvent::Error {
                    kind: AgentErrorKind::Protocol,
                    message: format!("claude sent a line that is not JSON ({} bytes)", line.len()),
                    retryable: false,
                }],
                unsupported_control_request: None,
                tasks: Vec::new(),
                user_echo: None,
                command_queued: None,
            },
        }
    }

    pub fn map_value(&mut self, v: &Value) -> MapOutput {
        let mut out = MapOutput::default();
        match str_of(v, "type") {
            Some("system") => self.system(v, &mut out),
            Some("stream_event") => self.stream_event(v, &mut out),
            Some("assistant") => self.assistant(v, &mut out),
            Some("user") => {
                if v.get("isReplay").and_then(Value::as_bool) == Some(true) {
                    out.user_echo = str_of(v, "uuid").map(String::from);
                }
                self.user(v, &mut out)
            }
            Some("control_request") => self.control_request(v, &mut out),
            Some("control_cancel_request") => {
                if let Some(id) = str_of(v, "request_id") {
                    if let Some((tool_call_id, _)) = self.pending_questions.remove(id) {
                        out.events.push(AgentEvent::QuestionResolved {
                            request_id: id.to_string(),
                            tool_call_id,
                            resolution: QuestionResolution::Cancelled,
                            answers: vec![],
                        });
                    } else if self.pending_permissions.remove(id) {
                        out.events.push(AgentEvent::PermissionResolved {
                            request_id: id.to_string(),
                            resolution: PermissionResolution::Cancelled,
                        });
                    }
                }
            }
            Some("command_lifecycle") => {
                if str_of(v, "state") == Some("queued") {
                    out.command_queued = str_of(v, "command_uuid").map(String::from);
                }
            }
            Some("rate_limit_event") => {
                if let Some(info) = v.get("rate_limit_info") {
                    out.events.push(AgentEvent::RateLimit {
                        status: str_of(info, "status").unwrap_or("unknown").to_string(),
                        resets_at: info.get("resetsAt").and_then(Value::as_i64),
                    });
                }
            }
            Some("result") => self.result(v, &mut out),
            // control_response (answers to our interrupt / set_permission_mode), keep_alive,
            // streamlined_* and anything newer: not part of the contract.
            _ => {}
        }
        out
    }

    fn system(&mut self, v: &Value, out: &mut MapOutput) {
        /// `init.mcp_servers`: `[{name, status}]`; an entry without a name is dropped, a missing
        /// status is `unknown`.
        fn mcp_servers(v: &Value) -> Vec<McpServerStatus> {
            v.get("mcp_servers")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(|x| {
                            Some(McpServerStatus {
                                name: str_of(x, "name")?.to_string(),
                                status: str_of(x, "status").unwrap_or("unknown").to_string(),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default()
        }
        match str_of(v, "subtype") {
            Some("init") => {
                let names = |key: &str| -> Vec<String> {
                    v.get(key)
                        .and_then(Value::as_array)
                        .map(|a| {
                            a.iter()
                                .filter_map(|x| x.as_str().map(String::from))
                                .collect()
                        })
                        .unwrap_or_default()
                };
                out.events.push(AgentEvent::SessionStarted {
                    session_id: str_of(v, "session_id").unwrap_or_default().to_string(),
                    model: str_of(v, "model").map(String::from),
                    cwd: str_of(v, "cwd").unwrap_or_default().to_string(),
                    permission_mode: str_of(v, "permissionMode").map(String::from),
                    tools: names("tools"),
                    slash_commands: names("slash_commands"),
                    skills: names("skills"),
                    mcp_servers: mcp_servers(v),
                    cli_version: str_of(v, "claude_code_version").map(String::from),
                });
            }
            // `task_started` / `task_updated` (patch.status) / `task_notification`, verified with a
            // real claude 2.1.326: a background task outlives the first `result`. Nested tasks (a
            // sub-agent's own `Bash`, `task_type` `local_bash`) carry their tool call's id; the
            // tracker ignores ids that are not a launch call.
            Some("task_started") => {
                if let Some(id) = str_of(v, "task_id") {
                    let call = str_of(v, "tool_use_id").map(String::from);
                    if let Some(call) = &call {
                        self.task_calls.insert(id.to_string(), call.clone());
                    }
                    out.tasks.push(TaskSignal::Started {
                        task: id.to_string(),
                        call,
                        background: v
                            .get("is_backgrounded")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                    });
                }
            }
            Some("task_updated") => {
                let status = v
                    .get("patch")
                    .and_then(|p| str_of(p, "status"))
                    .unwrap_or_default();
                let status = SubagentRunStatus::from_cli(status);
                if let (Some(id), true) = (str_of(v, "task_id"), status.is_final()) {
                    out.tasks.push(TaskSignal::Updated {
                        task: id.to_string(),
                        call: self.task_calls.get(id).cloned(),
                        status,
                    });
                }
            }
            Some("task_notification") => {
                if let Some(id) = str_of(v, "task_id") {
                    let call = str_of(v, "tool_use_id")
                        .map(String::from)
                        .or_else(|| self.task_calls.get(id).cloned());
                    out.tasks.push(TaskSignal::Notified {
                        task: id.to_string(),
                        call,
                        status: SubagentRunStatus::from_cli(
                            str_of(v, "status").unwrap_or("completed"),
                        ),
                        report: handback_report(v),
                    });
                }
            }
            Some("thinking_tokens") => {
                if let (Some((mid, idx)), Some(n)) = (
                    self.thinking_block.clone(),
                    v.get("estimated_tokens").and_then(Value::as_u64),
                ) {
                    out.events.push(AgentEvent::Thinking {
                        message_id: mid,
                        block_index: idx,
                        phase: ThinkingPhase::Delta,
                        text: String::new(),
                        estimated_tokens: Some(n),
                    });
                }
            }
            _ => {}
        }
    }

    fn start_message(&mut self, id: &str, streamed: bool) {
        self.message_id = Some(id.to_string());
        self.streamed = streamed;
        self.blocks.clear();
        self.finalized = 0;
        self.thinking_block = None;
    }

    /// Remembers the model of a message of the main agent (never a sub-agent's, never the
    /// CLI's `<synthetic>` placeholder).
    fn note_main_model(&mut self, v: &Value, msg: Option<&Value>) {
        if Self::parent_tool(v).is_some() {
            return;
        }
        if let Some(m) = msg
            .and_then(|m| str_of(m, "model"))
            .filter(|m| !m.is_empty() && !m.starts_with('<'))
        {
            self.main_model = Some(m.to_string());
        }
    }

    fn parent_tool(v: &Value) -> Option<String> {
        str_of(v, "parent_tool_use_id").map(String::from)
    }

    /// A message made by a sub-agent says whose it is, once, before its first block.
    fn note_message_parent(v: &Value, message_id: &str, out: &mut MapOutput) {
        if let Some(parent) = Self::parent_tool(v) {
            out.events.push(AgentEvent::SubagentMessage {
                message_id: message_id.to_string(),
                parent_tool_call_id: parent,
            });
        }
    }

    fn stream_event(&mut self, v: &Value, out: &mut MapOutput) {
        let Some(ev) = v.get("event") else { return };
        match str_of(ev, "type") {
            Some("message_start") => {
                let id = ev
                    .get("message")
                    .and_then(|m| str_of(m, "id"))
                    .unwrap_or("")
                    .to_string();
                self.start_message(&id, true);
                self.note_main_model(v, ev.get("message"));
                Self::note_message_parent(v, &id, out);
            }
            Some("content_block_start") => {
                let idx = ev.get("index").and_then(Value::as_u64).unwrap_or(0) as u32;
                let mid = self.message_id.clone().unwrap_or_default();
                let block = ev.get("content_block").cloned().unwrap_or(Value::Null);
                match str_of(&block, "type") {
                    Some("text") => {
                        self.blocks.insert(idx, BlockKind::Text);
                    }
                    Some("thinking") | Some("redacted_thinking") => {
                        self.blocks.insert(idx, BlockKind::Thinking);
                        self.thinking_block = Some((mid.clone(), idx));
                        out.events.push(AgentEvent::Thinking {
                            message_id: mid,
                            block_index: idx,
                            phase: ThinkingPhase::Start,
                            text: String::new(),
                            estimated_tokens: None,
                        });
                    }
                    Some("tool_use") | Some("server_tool_use") | Some("mcp_tool_use") => {
                        let id = str_of(&block, "id").unwrap_or_default().to_string();
                        self.blocks.insert(idx, BlockKind::Tool(id.clone()));
                        if self.started_tools.insert(id.clone()) {
                            out.events.push(AgentEvent::ToolCallStarted {
                                tool_call_id: id,
                                message_id: mid,
                                tool: str_of(&block, "name").unwrap_or("unknown").to_string(),
                                parent_tool_call_id: Self::parent_tool(v),
                            });
                        }
                    }
                    _ => {}
                }
            }
            Some("content_block_delta") => {
                let idx = ev.get("index").and_then(Value::as_u64).unwrap_or(0) as u32;
                let mid = self.message_id.clone().unwrap_or_default();
                let delta = ev.get("delta").cloned().unwrap_or(Value::Null);
                match str_of(&delta, "type") {
                    Some("text_delta") => {
                        let text = str_of(&delta, "text").unwrap_or("");
                        if !text.is_empty() {
                            out.events.push(AgentEvent::TextDelta {
                                message_id: mid,
                                block_index: idx,
                                text: text.to_string(),
                            });
                        }
                    }
                    Some("thinking_delta") => {
                        let text = str_of(&delta, "thinking").unwrap_or("");
                        let est = delta.get("estimated_tokens").and_then(Value::as_u64);
                        // Current CLIs send empty thinking text and only token estimates; the
                        // `system/thinking_tokens` line carries the same number, so an empty
                        // delta adds nothing.
                        if !text.is_empty() {
                            out.events.push(AgentEvent::Thinking {
                                message_id: mid,
                                block_index: idx,
                                phase: ThinkingPhase::Delta,
                                text: text.to_string(),
                                estimated_tokens: est,
                            });
                        }
                    }
                    Some("input_json_delta") => {
                        if let Some(BlockKind::Tool(id)) = self.blocks.get(&idx) {
                            let partial = str_of(&delta, "partial_json").unwrap_or("");
                            if !partial.is_empty() {
                                out.events.push(AgentEvent::ToolCallInputDelta {
                                    tool_call_id: id.clone(),
                                    partial_json: partial.to_string(),
                                });
                            }
                        }
                    }
                    _ => {}
                }
            }
            Some("message_delta") => {
                if let Some(usage) = ev.get("usage") {
                    out.events
                        .push(usage_event(UsageScope::Message, usage, None, None, None));
                }
            }
            _ => {}
        }
    }

    fn assistant(&mut self, v: &Value, out: &mut MapOutput) {
        let Some(msg) = v.get("message") else { return };
        let id = str_of(msg, "id").unwrap_or("").to_string();
        let new_message = self.message_id.as_deref() != Some(id.as_str());
        self.note_main_model(v, Some(msg));
        if new_message {
            // No stream_event preceded it (partial messages off): a complete message.
            self.start_message(&id, false);
            Self::note_message_parent(v, &id, out);
            if let Some(usage) = msg.get("usage") {
                out.events
                    .push(usage_event(UsageScope::Message, usage, None, None, None));
            }
        }
        let Some(blocks) = msg.get("content").and_then(Value::as_array) else {
            return;
        };
        for block in blocks {
            let idx = self.finalized;
            self.finalized += 1;
            match str_of(block, "type") {
                Some("text") => out.events.push(AgentEvent::Text {
                    message_id: id.clone(),
                    block_index: idx,
                    text: str_of(block, "text").unwrap_or("").to_string(),
                }),
                Some("thinking") | Some("redacted_thinking") => {
                    if !self.streamed {
                        out.events.push(AgentEvent::Thinking {
                            message_id: id.clone(),
                            block_index: idx,
                            phase: ThinkingPhase::Start,
                            text: String::new(),
                            estimated_tokens: None,
                        });
                    }
                    out.events.push(AgentEvent::Thinking {
                        message_id: id.clone(),
                        block_index: idx,
                        phase: ThinkingPhase::End,
                        text: str_of(block, "thinking").unwrap_or("").to_string(),
                        estimated_tokens: None,
                    });
                    self.thinking_block = None;
                }
                Some("tool_use") | Some("server_tool_use") | Some("mcp_tool_use") => {
                    let tool_id = str_of(block, "id").unwrap_or_default().to_string();
                    if self.started_tools.insert(tool_id.clone()) {
                        out.events.push(AgentEvent::ToolCallStarted {
                            tool_call_id: tool_id.clone(),
                            message_id: id.clone(),
                            tool: str_of(block, "name").unwrap_or("unknown").to_string(),
                            parent_tool_call_id: Self::parent_tool(v),
                        });
                    }
                    out.events.push(AgentEvent::ToolCallInput {
                        tool_call_id: tool_id,
                        input: block.get("input").cloned().unwrap_or_else(|| json!({})),
                    });
                }
                _ => {}
            }
        }
    }

    fn user(&mut self, v: &Value, out: &mut MapOutput) {
        let Some(blocks) = v
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(Value::as_array)
        else {
            return;
        };
        let metas = v.get("tool_result_meta").and_then(Value::as_array);
        let async_launch = v
            .get("tool_use_result")
            .is_some_and(|r| str_of(r, "status") == Some("async_launched"));
        for block in blocks {
            if str_of(block, "type") != Some("tool_result") {
                continue;
            }
            let Some(id) = str_of(block, "tool_use_id") else {
                continue;
            };
            if !self.finished_tools.insert(id.to_string()) {
                continue;
            }
            let is_error = block
                .get("is_error")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let rejected = metas
                .map(|m| {
                    m.iter().any(|e| {
                        str_of(e, "id") == Some(id) && e.get("non_execution_kind").is_some()
                    })
                })
                .unwrap_or(false);
            let (output, truncated) = if async_launch {
                // launch boilerplate with the agent id and the output file: CLI-internal
                out.tasks.push(TaskSignal::AsyncLaunched {
                    call: id.to_string(),
                });
                (String::new(), false)
            } else {
                truncate_to_boundary(
                    flatten_tool_result(block.get("content")),
                    MAX_TOOL_OUTPUT_BYTES,
                )
            };
            out.events.push(AgentEvent::ToolCallFinished {
                tool_call_id: id.to_string(),
                output,
                is_error,
                outcome: if rejected {
                    ToolOutcome::Rejected
                } else if is_error {
                    ToolOutcome::Error
                } else {
                    ToolOutcome::Ok
                },
                truncated,
            });
        }
    }

    fn control_request(&mut self, v: &Value, out: &mut MapOutput) {
        let Some(request_id) = str_of(v, "request_id") else {
            return;
        };
        let Some(req) = v.get("request") else { return };
        if str_of(req, "subtype") != Some("can_use_tool") {
            out.unsupported_control_request = Some(request_id.to_string());
            return;
        }
        // The CLI asks the user through this tool whatever the permission mode (verified, appendix
        // A.9): it is a question card, never a permission card. A shape that does not parse
        // falls through to the generic card, so nothing hangs.
        // The card hangs on its tool call, so a request without `tool_use_id` is generic too.
        if str_of(req, "tool_name") == Some(ASK_USER_QUESTION_TOOL) {
            if let (Some(questions), Some(call)) = (
                req.get("input").and_then(parse_questions),
                str_of(req, "tool_use_id"),
            ) {
                let tool_call_id = Some(call.to_string());
                self.pending_questions.insert(
                    request_id.to_string(),
                    (
                        tool_call_id.clone(),
                        req.get("input").cloned().unwrap_or_default(),
                    ),
                );
                out.events.push(AgentEvent::QuestionRequest {
                    request_id: request_id.to_string(),
                    tool_call_id,
                    questions,
                    by: None,
                });
                return;
            }
        }
        self.pending_permissions.insert(request_id.to_string());
        out.events.push(AgentEvent::PermissionRequest {
            request_id: request_id.to_string(),
            tool_call_id: str_of(req, "tool_use_id").map(String::from),
            tool: str_of(req, "tool_name").unwrap_or("unknown").to_string(),
            display_name: str_of(req, "display_name").map(String::from),
            input: req.get("input").cloned().unwrap_or_else(|| json!({})),
            description: str_of(req, "description").map(String::from),
            decision_reason: str_of(req, "decision_reason").map(String::from),
            suggestions: req
                .get("permission_suggestions")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
            by: None,
        });
    }

    /// The control response for an open question (`answers` `None` declines), built from the
    /// CLI's own input; `None` when no such question is open. Forgets the question.
    pub fn encode_question_answer(
        &mut self,
        request_id: &str,
        answers: Option<&[QuestionAnswer]>,
    ) -> Option<String> {
        let (_, input) = self.pending_questions.remove(request_id)?;
        Some(encode_question_answer(request_id, &input, answers))
    }

    /// The runner calls this when it writes the user's answer, so a late
    /// `control_cancel_request` for the same id is not reported twice.
    pub fn permission_answered(&mut self, request_id: &str) -> bool {
        self.pending_questions.remove(request_id).is_some()
            | self.pending_permissions.remove(request_id)
    }

    fn result(&mut self, v: &Value, out: &mut MapOutput) {
        let usage = v.get("usage").cloned().unwrap_or(Value::Null);
        let window = v
            .get("modelUsage")
            .and_then(Value::as_object)
            .and_then(|m| {
                m.values()
                    .filter_map(|e| e.get("contextWindow").and_then(Value::as_u64))
                    .max()
            });
        // The model that did this turn's work: `modelUsage` is cumulative over the session (after
        // a switch it still lists the old model with the larger total), so the winner is the key
        // whose output grew since the last result; a total that went down (new process) counts
        // in full.
        let totals: Vec<(String, u64)> = v
            .get("modelUsage")
            .and_then(Value::as_object)
            .map(|m| {
                m.iter()
                    .map(|(k, e)| {
                        (
                            k.clone(),
                            e.get("outputTokens").and_then(Value::as_u64).unwrap_or(0),
                        )
                    })
                    .collect()
            })
            .unwrap_or_default();
        let by_usage = totals
            .iter()
            .max_by_key(|(k, total)| {
                let before = self.model_output.get(k).copied().unwrap_or(0);
                if *total >= before {
                    total - before
                } else {
                    *total
                }
            })
            .map(|(k, _)| k.clone());
        // the main agent's own message names the chat's model; a turn with none falls back to
        // the usage that grew (sub-agents' usage must not decide it)
        let model = self.main_model.take().or(by_usage);
        log::debug!(target: "agent", "agent: turn model {:?} from {} usage entries", model, totals.len());
        self.model_output = totals.into_iter().collect();
        out.events.push(usage_event(
            UsageScope::Turn,
            &usage,
            v.get("total_cost_usd").and_then(Value::as_f64),
            window,
            model,
        ));
        let subtype = str_of(v, "subtype").unwrap_or("");
        let is_error = v.get("is_error").and_then(Value::as_bool).unwrap_or(false);
        let terminal = str_of(v, "terminal_reason").unwrap_or("");
        let reason = match (subtype, terminal) {
            ("error_max_turns", _) => TurnFinishReason::MaxTurns,
            ("error_max_budget_usd", _) => TurnFinishReason::Budget,
            (_, t) if t.starts_with("aborted") => TurnFinishReason::Interrupted,
            ("success", _) if !is_error => TurnFinishReason::Completed,
            _ => TurnFinishReason::Error,
        };
        let status = v.get("api_error_status").and_then(Value::as_u64);
        let errors: Vec<String> = v
            .get("errors")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|e| e.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        out.events.push(AgentEvent::TurnFinished {
            reason,
            duration_ms: u64_of(v, "duration_ms"),
            api_duration_ms: v.get("duration_api_ms").and_then(Value::as_u64),
            num_turns: v.get("num_turns").and_then(Value::as_u64).map(|n| n as u32),
            is_error,
            result: str_of(v, "result").map(String::from),
            session_id: str_of(v, "session_id").map(String::from),
            errors,
        });
        if reason == TurnFinishReason::Error {
            let (kind, retryable) = match status {
                Some(401) | Some(403) => (AgentErrorKind::Auth, false),
                Some(429) => (AgentErrorKind::RateLimit, true),
                Some(s) if s >= 500 => (AgentErrorKind::Api, true),
                Some(_) => (AgentErrorKind::Api, false),
                None if looks_like_auth_failure(str_of(v, "result").unwrap_or("")) => {
                    (AgentErrorKind::Auth, false)
                }
                None => (AgentErrorKind::Unknown, false),
            };
            out.events.push(AgentEvent::Error {
                kind,
                message: str_of(v, "result")
                    .unwrap_or("The turn ended with an error")
                    .to_string(),
                retryable,
            });
        }
    }
}

// -------------------------------------------------------------------------------------------
// stdin encoders. Each returns one JSON line WITHOUT the trailing newline.

/// A user turn. Plain text goes as a string; with files the content is an array of native
/// `image` and `document` blocks (base64) followed by the text block (the image shape verified
/// against the real CLI; the document block is the API's own shape).
pub fn encode_user_message(text: &str, files: &[FilePart]) -> String {
    user_value(text, files).to_string()
}

/// A steer: a user message written while a turn runs, with `priority:"now"` so the CLI aborts the
/// running tool or text, ends that turn with a `result` and starts this message's turn at once
/// (verified, spec 3.13). The `uuid` comes back on stdout as the receipt
/// (`--replay-user-messages`, see [`MapOutput::user_echo`]).
pub fn encode_steer_message(text: &str, files: &[FilePart], uuid: &str) -> String {
    let mut line = user_value(text, files);
    line["uuid"] = json!(uuid);
    line["priority"] = json!("now");
    line.to_string()
}

/// A message written while a turn runs without `priority`: the CLI injects it after the next
/// tool result of the running turn, or runs it right after the turn when no tool boundary comes
/// (captured: `queued-two`, `steer-injected`, `steer-deferred`; spec 3.13). Its `uuid` is the
/// receipt (the echo) and the handle of [`encode_cancel_queued`].
pub fn encode_queued_message(text: &str, files: &[FilePart], uuid: &str) -> String {
    let mut line = user_value(text, files);
    line["uuid"] = json!(uuid);
    line.to_string()
}

/// Takes a waiting [`encode_queued_message`] line back out of the CLI's queue (the SDK's
/// `cancel_async_message` control request, captured against the real CLI: `queued-cancel`). The
/// answer is a `control_response` whose `response.cancelled` says whether it was still waiting;
/// a line the CLI already took is a no-op (`cancelled:false`).
pub fn encode_cancel_queued(request_id: &str, uuid: &str) -> String {
    json!({"type":"control_request","request_id":request_id,
           "request":{"subtype":"cancel_async_message","message_uuid":uuid}})
    .to_string()
}

/// The answer to [`encode_cancel_queued`]: `(request id, cancelled)`. `None` for any other line.
pub fn parse_cancel_queued_response(line: &str) -> Option<(String, bool)> {
    let v: Value = serde_json::from_str(line).ok()?;
    let resp = v.get("response")?;
    let id = resp.get("request_id")?.as_str()?.to_string();
    let cancelled = resp
        .get("response")
        .and_then(|r| r.get("cancelled"))
        .and_then(Value::as_bool)
        == Some(true);
    Some((id, cancelled))
}

fn user_value(text: &str, files: &[FilePart]) -> Value {
    if files.is_empty() {
        return json!({"type":"user","message":{"role":"user","content":text}});
    }
    let mut content: Vec<Value> = files
        .iter()
        .map(|f| {
            let block = match f.kind {
                FileKind::Image => "image",
                FileKind::Document => "document",
            };
            json!({"type":block,"source":{"type":"base64","media_type":f.media_type,"data":f.data}})
        })
        .collect();
    content.push(json!({"type":"text","text":text}));
    json!({"type":"user","message":{"role":"user","content":content}})
}

pub fn encode_interrupt(request_id: &str) -> String {
    json!({"type":"control_request","request_id":request_id,"request":{"subtype":"interrupt"}})
        .to_string()
}

pub fn encode_set_permission_mode(request_id: &str, mode: AgentPermissionMode) -> String {
    json!({"type":"control_request","request_id":request_id,
           "request":{"subtype":"set_permission_mode","mode":mode.as_cli_arg()}})
    .to_string()
}

/// `set_model` control request. `None` asks for the CLI's default (verified: the CLI answers
/// `success` with `response.model` set to the resolved id; a refused model is an `error` response
/// carrying `error_code` and the model it kept).
pub fn encode_set_model(request_id: &str, model: Option<&str>) -> String {
    let mut request = json!({"subtype":"set_model"});
    if let Some(m) = model.filter(|m| !m.is_empty()) {
        request["model"] = json!(m);
    }
    json!({"type":"control_request","request_id":request_id,"request":request}).to_string()
}

pub fn encode_permission_allow(
    request_id: &str,
    updated_input: &Value,
    updated_permissions: &[Value],
) -> String {
    let mut resp = Map::new();
    resp.insert("behavior".into(), json!("allow"));
    resp.insert("updatedInput".into(), updated_input.clone());
    if !updated_permissions.is_empty() {
        resp.insert(
            "updatedPermissions".into(),
            Value::Array(updated_permissions.to_vec()),
        );
    }
    json!({"type":"control_response","response":{"subtype":"success","request_id":request_id,
           "response":Value::Object(resp)}})
    .to_string()
}

/// The Claude tool that asks the user questions (`can_use_tool` with `requires_user_interaction`).
pub const ASK_USER_QUESTION_TOOL: &str = "AskUserQuestion";

/// The questions of an `AskUserQuestion` input, or `None` when it is not the verified shape (a
/// non-empty `questions` array, each with a `question` and at least one option with a `label`).
fn parse_questions(input: &Value) -> Option<Vec<Question>> {
    let list = input.get("questions")?.as_array()?;
    let questions: Vec<Question> = list
        .iter()
        .map(|q| {
            let options: Vec<QuestionOption> = q
                .get("options")?
                .as_array()?
                .iter()
                .map(|o| {
                    Some(QuestionOption {
                        label: str_of(o, "label")?.to_string(),
                        description: str_of(o, "description").unwrap_or_default().to_string(),
                        preview: str_of(o, "preview").map(String::from),
                    })
                })
                .collect::<Option<_>>()?;
            if options.is_empty() {
                return None;
            }
            let question = str_of(q, "question")?.to_string();
            Some(Question {
                header: str_of(q, "header").unwrap_or_default().to_string(),
                question,
                multi_select: q
                    .get("multiSelect")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                options,
            })
        })
        .collect::<Option<_>>()?;
    (!questions.is_empty()).then_some(questions)
}

/// The control response that answers an `AskUserQuestion`: allow with the original input plus
/// `answers`, an object from each question's text to the answer (verified, appendix A.9: one
/// label, several labels joined with ", ", or the typed text). A decline is a deny the model
/// reads as "The user skipped the questions." (the CLI marks that tool result an error).
pub fn encode_question_answer(
    request_id: &str,
    input: &Value,
    answers: Option<&[QuestionAnswer]>,
) -> String {
    let Some(answers) = answers else {
        return encode_permission_deny(request_id, "The user skipped the questions.");
    };
    let mut updated = input.clone();
    let map: Map<String, Value> = answers
        .iter()
        .map(|a| (a.question.clone(), json!(a.answers.join(", "))))
        .collect();
    updated["answers"] = Value::Object(map);
    encode_permission_allow(request_id, &updated, &[])
}

pub fn encode_permission_deny(request_id: &str, message: &str) -> String {
    json!({"type":"control_response","response":{"subtype":"success","request_id":request_id,
           "response":{"behavior":"deny","message":message}}})
    .to_string()
}

/// Answer to a `control_request` Writer does not implement.
pub fn encode_control_error(request_id: &str, error: &str) -> String {
    json!({"type":"control_response","response":{"subtype":"error","request_id":request_id,"error":error}})
        .to_string()
}

/// What the CLI is told to persist for an "Always allow" choice, rebuilt from the suggestions it
/// sent (never from UI input). `project` writes `<cwd>/.claude/settings.local.json` (verified).
pub fn updated_permissions(
    suggestions: &[Value],
    persist: Option<PermissionPersist>,
) -> Vec<Value> {
    let Some(persist) = persist else {
        return Vec::new();
    };
    suggestions
        .iter()
        .filter_map(|s| {
            let kind = s.get("type").and_then(Value::as_str)?;
            match (persist, kind) {
                (PermissionPersist::Project, "addRules") => with_destination(s, "localSettings"),
                (PermissionPersist::Session, "addRules") => with_destination(s, "session"),
                (PermissionPersist::AcceptEdits, "setMode")
                    if s.get("mode").and_then(Value::as_str) == Some("acceptEdits") =>
                {
                    with_destination(s, "session")
                }
                _ => None,
            }
        })
        .collect()
}

fn with_destination(s: &Value, dest: &str) -> Option<Value> {
    let mut v = s.clone();
    v.as_object_mut()?.insert("destination".into(), json!(dest));
    Some(v)
}

// -------------------------------------------------------------------------------------------
// Argument vector

#[derive(Debug, Clone, PartialEq)]
pub enum SessionRef {
    /// First spawn of a chat: `--session-id <uuid>` (the CLI honours it).
    New(String),
    /// Later spawns: `--resume <uuid>`.
    Resume(String),
}

#[derive(Debug, Clone)]
pub struct ClaudeSpawn<'a> {
    pub session: SessionRef,
    pub settings: &'a AgentSettings,
    pub append_system_prompt: Option<&'a str>,
    /// Extra directories the CLI may read (absolute, inside the vault).
    pub add_dirs: &'a [String],
    /// The `--agents` JSON, `None` when orchestration is off.
    pub agents: Option<&'a str>,
    /// The memory folder (`agent.memory` = `vault`, built by `memory::prepare_dir`), `None`
    /// otherwise: becomes `--settings {"autoMemoryDirectory": ...}`. Never from model input.
    pub memory_dir: Option<&'a Path>,
    /// Writer's own MCP server (`mcp_wiring`): `--mcp-config` plus the allow rules of its
    /// read-only tools, `None` when the chat has no `writer` launcher.
    pub mcp: Option<&'a McpWiring>,
}

/// The `--settings` JSON that points the CLI's auto memory at `dir` (the `memory_directory`
/// capability of the Claude adapter). Verified with claude 2.1.326: no settings file is written,
/// the CLI saves `MEMORY.md` plus one note per fact there and a new session recalls them
/// (`SPECs/agent-memory-spec.md` check 3). `dir` must be an absolute, plain UTF-8 path.
pub fn memory_settings_json(dir: &Path) -> Result<String, String> {
    let text = dir
        .to_str()
        .filter(|d| is_safe_value(d))
        .ok_or("invalid memory folder")?;
    if !dir.is_absolute()
        || dir
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err("the memory folder must be an absolute path".into());
    }
    Ok(serde_json::json!({ "autoMemoryDirectory": text }).to_string())
}

fn is_uuid(s: &str) -> bool {
    s.len() == 36
        && s.char_indices().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => c == '-',
            _ => c.is_ascii_hexdigit(),
        })
}

pub(super) fn is_safe_value(s: &str) -> bool {
    !s.is_empty() && !s.starts_with('-') && !s.contains('\0') && !s.contains('\n')
}

/// The argv of the one-shot chat-title call (`claude -p`, the prompt on stdin): a single turn
/// with no tools, no setting files, no skills, no MCP servers and nothing saved to the CLI's
/// session history, JSON output (`result`, `is_error`, `total_cost_usd`). `model` `None` keeps the
/// CLI's default. Verified against claude 2.1.325 (spec "Automatic chat titles").
pub fn build_title_args(model: Option<&str>, system_prompt: &str) -> Result<Vec<String>, String> {
    let mut a: Vec<String> = [
        "-p",
        "--output-format",
        "json",
        "--max-turns",
        "1",
        "--no-session-persistence",
        "--tools",
        "",
        "--setting-sources",
        "",
        "--disable-slash-commands",
        "--strict-mcp-config",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    if let Some(model) = model.filter(|m| !m.is_empty()) {
        if !is_safe_value(model) {
            return Err("invalid model name".into());
        }
        a.push("--model".into());
        a.push(model.into());
    }
    if system_prompt.contains('\0') {
        return Err("system prompt contains NUL".into());
    }
    a.push("--system-prompt".into());
    a.push(system_prompt.into());
    Ok(a)
}

/// The argv after the program name. Fixed flags first; everything user-supplied is validated so
/// it can never be read as another flag.
pub fn build_args(spawn: &ClaudeSpawn) -> Result<Vec<String>, String> {
    let mut a: Vec<String> = [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--include-partial-messages",
        // the receipt of a steer (`MapOutput::user_echo`)
        "--replay-user-messages",
        "--verbose",
        "--permission-prompt-tool",
        "stdio",
        "--setting-sources",
        "user,project,local",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    a.push("--permission-mode".into());
    a.push(spawn.settings.permission_mode.as_cli_arg().into());
    match &spawn.session {
        SessionRef::New(id) => {
            if !is_uuid(id) {
                return Err("session id must be a uuid".into());
            }
            a.push("--session-id".into());
            a.push(id.clone());
        }
        SessionRef::Resume(id) => {
            if !is_uuid(id) {
                return Err("session id must be a uuid".into());
            }
            a.push("--resume".into());
            a.push(id.clone());
        }
    }
    if let Some(model) = spawn.settings.model.as_deref().filter(|m| !m.is_empty()) {
        if !is_safe_value(model) {
            return Err("invalid model name".into());
        }
        a.push("--model".into());
        a.push(model.into());
    }
    if let Some(effort) = spawn.settings.effort {
        a.push("--effort".into());
        a.push(effort.as_cli_arg().into());
    }
    if spawn.settings.show_thinking {
        // Without it the CLI streams empty `thinking` text (only token estimates); verified
        // with 2.1.326, spec A.3. A fixed value, never user-supplied.
        a.push("--thinking-display".into());
        a.push("summarized".into());
    }
    if let Some(dir) = spawn.memory_dir {
        a.push("--settings".into());
        a.push(memory_settings_json(dir)?);
    }
    if let Some(prompt) = spawn.append_system_prompt.filter(|p| !p.is_empty()) {
        // A value after its flag is never parsed as a flag by the CLI, but keep NULs out.
        if prompt.contains('\0') {
            return Err("system prompt contains NUL".into());
        }
        a.push("--append-system-prompt".into());
        a.push(prompt.into());
    }
    if let Some(mcp) = spawn.mcp {
        // Added to the servers of the user's own settings, never `--strict-mcp-config`.
        match &mcp.launch {
            Launch::Argv(args) => {
                if args.iter().any(|v| v.is_empty() || v.contains('\0')) {
                    return Err("invalid MCP config".into());
                }
                a.extend(args.iter().cloned());
            }
            Launch::Env(_) | Launch::Config(_) => {
                return Err("this launch is not implemented for claude".into());
            }
        }
    }
    let allowed: Vec<String> = spawn
        .settings
        .allowed_tools
        .iter()
        .chain(spawn.mcp.map_or(&[][..], |m| m.allowed.as_slice()))
        .cloned()
        .collect();
    for (flag, rules) in [
        ("--allowedTools", &allowed),
        ("--disallowedTools", &spawn.settings.disallowed_tools),
    ] {
        if rules.is_empty() {
            continue;
        }
        if !rules.iter().all(|r| is_safe_value(r)) {
            return Err("invalid tool rule".into());
        }
        a.push(flag.into());
        a.extend(rules.iter().cloned());
    }
    if let Some(agents) = spawn.agents {
        // The sub-agent definitions (`subagents::agents_json`); never given to the title call.
        a.push("--agents".into());
        a.push(agents.into());
    }
    for dir in spawn.add_dirs {
        if !is_safe_value(dir) {
            return Err("invalid directory".into());
        }
        a.push("--add-dir".into());
        a.push(dir.clone());
    }
    Ok(a)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    #[test]
    fn turn_model_is_the_one_whose_usage_grew_not_the_cumulative_leader() {
        let result = |sonnet: u64, opus: u64| {
            json!({"type":"result","subtype":"success","is_error":false,"usage":{},
                "modelUsage":{"claude-sonnet-5-5":{"outputTokens":sonnet},
                              "claude-opus-5-5":{"outputTokens":opus}}})
            .to_string()
        };
        let model_of = |m: &mut ClaudeStreamMapper, line: String| {
            m.map_line(&line).events.into_iter().find_map(|e| match e {
                AgentEvent::Usage { model, .. } => model,
                _ => None,
            })
        };
        let mut m = ClaudeStreamMapper::default();
        assert_eq!(
            model_of(&mut m, result(500, 0)).as_deref(),
            Some("claude-sonnet-5-5")
        );
        // switched to Opus: Sonnet still leads the session total, Opus did this turn
        assert_eq!(
            model_of(&mut m, result(500, 40)).as_deref(),
            Some("claude-opus-5-5")
        );
        assert_eq!(
            model_of(&mut m, result(500, 90)).as_deref(),
            Some("claude-opus-5-5")
        );
        // a real fallback to Sonnet for this turn shows
        assert_eq!(
            model_of(&mut m, result(530, 90)).as_deref(),
            Some("claude-sonnet-5-5")
        );
    }

    /// Sub-agents on another model add to `modelUsage` (more than the main agent does): the turn's
    /// model is still the one the main agent's own messages name.
    #[test]
    fn a_sub_agents_model_never_becomes_the_turns_model() {
        let mut m = ClaudeStreamMapper::default();
        let lines = [
            json!({"type":"assistant","message":{"id":"m1","model":"claude-opus-5-5",
                "content":[{"type":"text","text":"on it"}]},"parent_tool_use_id":null}),
            json!({"type":"assistant","message":{"id":"s1","model":"claude-sonnet-5-5",
                "content":[{"type":"text","text":"worker"}]},"parent_tool_use_id":"toolu_a"}),
            json!({"type":"result","subtype":"success","is_error":false,"usage":{},
                "modelUsage":{"claude-opus-5-5":{"outputTokens":50},
                              "claude-sonnet-5-5":{"outputTokens":9000}}}),
        ];
        let mut model = None;
        for l in lines {
            for e in m.map_value(&l).events {
                if let AgentEvent::Usage {
                    scope: UsageScope::Turn,
                    model: mo,
                    ..
                } = e
                {
                    model = mo;
                }
            }
        }
        assert_eq!(model.as_deref(), Some("claude-opus-5-5"));
        // a turn where only sub-agents spoke falls back to the usage that grew
        let r = json!({"type":"result","subtype":"success","is_error":false,"usage":{},
            "modelUsage":{"claude-opus-5-5":{"outputTokens":80},
                          "claude-sonnet-5-5":{"outputTokens":9000}}});
        let again = m.map_value(&r).events.into_iter().find_map(|e| match e {
            AgentEvent::Usage { model, .. } => model,
            _ => None,
        });
        assert_eq!(again.as_deref(), Some("claude-opus-5-5"));
    }

    fn golden_dir() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../shared/agent-golden")
    }

    fn fixture(name: &str) -> &'static str {
        match name {
            "ok-turn" => include_str!("fixtures/ok-turn.jsonl"),
            "tool-auto-allowed" => include_str!("fixtures/tool-auto-allowed.jsonl"),
            "permission-allow" => include_str!("fixtures/permission-allow.jsonl"),
            "permission-deny" => include_str!("fixtures/permission-deny.jsonl"),
            "interrupt" => include_str!("fixtures/interrupt.jsonl"),
            "multi-turn-rule" => include_str!("fixtures/multi-turn-rule.jsonl"),
            "thinking-summary" => include_str!("fixtures/thinking-summary.jsonl"),
            "thinking-redacted" => include_str!("fixtures/thinking-redacted.jsonl"),
            "steer-injected" => include_str!("fixtures/steer-injected.jsonl"),
            "steer-deferred" => include_str!("fixtures/steer-deferred.jsonl"),
            "steer-now-text" => include_str!("fixtures/steer-now-text.jsonl"),
            "steer-now-permission" => include_str!("fixtures/steer-now-permission.jsonl"),
            "steer-now-subagents" => include_str!("fixtures/steer-now-subagents.jsonl"),
            "queued-two" => include_str!("fixtures/queued-two.jsonl"),
            "queued-cancel" => include_str!("fixtures/queued-cancel.jsonl"),
            "subagent-parallel" => include_str!("fixtures/subagent-parallel.jsonl"),
            "subagent-background" => include_str!("fixtures/subagent-background.jsonl"),
            "subagent-auto-background" => {
                include_str!("fixtures/subagent-auto-background.jsonl")
            }
            "question-answered" => include_str!("fixtures/question-answered.jsonl"),
            "question-skipped" => include_str!("fixtures/question-skipped.jsonl"),
            other => panic!("unknown fixture {other}"),
        }
    }

    /// The mapper's events with the tracker's `subagent-status` events in the order the runner
    /// applies them (a line's task signals first, then each event followed by what it decided).
    fn run(name: &str) -> (Vec<AgentEvent>, Vec<String>) {
        let mut m = ClaudeStreamMapper::new();
        let mut subs = crate::agent::sub_tracker::SubTracker::default();
        let mut events = Vec::new();
        let mut unsupported = Vec::new();
        for line in fixture(name).lines() {
            let out = m.map_line(line);
            events.extend(out.tasks.iter().flat_map(|t| subs.on_task(t)));
            for ev in out.events {
                let decided = subs.observe(&ev);
                events.push(ev);
                events.extend(decided);
            }
            unsupported.extend(out.unsupported_control_request);
        }
        (events, unsupported)
    }

    /// The `(launch call, state, report)` of every `subagent-status` event.
    fn statuses(events: &[AgentEvent]) -> Vec<(&str, SubagentRunStatus, Option<&str>)> {
        events
            .iter()
            .filter_map(|e| match e {
                AgentEvent::SubagentStatus {
                    tool_call_id,
                    status,
                    report,
                } => Some((tool_call_id.as_str(), *status, report.as_deref())),
                _ => None,
            })
            .collect()
    }

    fn types(events: &[AgentEvent]) -> Vec<String> {
        events
            .iter()
            .map(|e| {
                serde_json::to_value(e).unwrap()["type"]
                    .as_str()
                    .unwrap()
                    .to_string()
            })
            .collect()
    }

    /// The golden files are what the TypeScript side reads (`features/agent/tests/agent-events.test.ts`).
    /// Regenerate with `WRITER_UPDATE_GOLDEN=1 cargo test golden`.
    #[test]
    fn golden_event_streams_match_the_files_typescript_reads() {
        for name in [
            "ok-turn",
            "tool-auto-allowed",
            "permission-allow",
            "permission-deny",
            "interrupt",
            "multi-turn-rule",
            "thinking-summary",
            "thinking-redacted",
            "steer-injected",
            "steer-deferred",
            "steer-now-text",
            "steer-now-permission",
            "steer-now-subagents",
            "queued-two",
            "queued-cancel",
            "subagent-parallel",
            "subagent-background",
            "subagent-auto-background",
            "question-answered",
            "question-skipped",
        ] {
            let (events, _) = run(name);
            let actual = serde_json::to_string_pretty(&events).unwrap() + "\n";
            let path = golden_dir().join(format!("{name}.events.json"));
            if std::env::var_os("WRITER_UPDATE_GOLDEN").is_some() {
                std::fs::create_dir_all(golden_dir()).unwrap();
                std::fs::write(&path, &actual).unwrap();
            }
            let expected = std::fs::read_to_string(&path).unwrap_or_else(|e| {
                panic!("{}: {e} (run with WRITER_UPDATE_GOLDEN=1)", path.display())
            });
            assert_eq!(actual, expected, "golden drift in {name}");
        }
    }

    /// What the CLI does with a user message written mid-turn (real captures, 2.1.326, haiku, with
    /// `--replay-user-messages` and a `uuid` on the message): it echoes the message back
    /// (`isReplay`, same `uuid`) when it takes it. At a tool boundary that is inside the running
    /// turn (one `result`); with no boundary it is after the turn's `result`, as the start of a
    /// second turn with its own `result`.
    #[test]
    fn steer_receipt_comes_inside_the_turn_or_after_its_end() {
        const STEER: &str = "00000000-0000-4000-8000-0000000000a1";
        let positions = |name: &str| {
            let mut m = ClaudeStreamMapper::new();
            let (mut echo, mut finished) = (None, Vec::new());
            for (i, line) in fixture(name).lines().enumerate() {
                let out = m.map_line(line);
                if out.user_echo.as_deref() == Some(STEER) {
                    echo = Some(i);
                }
                if out
                    .events
                    .iter()
                    .any(|e| matches!(e, AgentEvent::TurnFinished { .. }))
                {
                    finished.push(i);
                }
            }
            (echo.expect("the steer is echoed"), finished)
        };
        let (echo, finished) = positions("steer-injected");
        assert_eq!(finished.len(), 1, "one turn");
        assert!(echo < finished[0], "received inside the turn");
        let (echo, finished) = positions("steer-deferred");
        assert_eq!(finished.len(), 2, "the steer ran as a second turn");
        assert!(finished[0] < echo && echo < finished[1]);
    }

    /// A steer written while sub-agents run tool calls (`steer-now-subagents`, real capture, 2.1.326:
    /// three foreground sub-agents each in a 40 s Bash call, `priority:"now"` 4 s in): the CLI
    /// accepts the line at once (`command_lifecycle` `queued`) but aborts and echoes it only when
    /// those calls end, ~37 s later, past `Timing::steer_ack`. The acceptance is what the runner
    /// must treat as the receipt of delivery.
    #[test]
    fn a_steer_among_running_sub_agents_is_accepted_long_before_it_is_echoed() {
        const STEER: &str = "00000000-0000-4000-8000-0000000000a1";
        let mut m = ClaudeStreamMapper::new();
        let (mut queued, mut echo, mut finished) = (None, None, None);
        for (i, line) in fixture("steer-now-subagents").lines().enumerate() {
            let out = m.map_line(line);
            if out.command_queued.as_deref() == Some(STEER) {
                queued = Some(i);
            }
            if out.user_echo.as_deref() == Some(STEER) {
                echo = Some(i);
            }
            if out
                .events
                .iter()
                .any(|e| matches!(e, AgentEvent::TurnFinished { .. }))
                && finished.is_none()
            {
                finished = Some(i);
            }
        }
        let (queued, echo, finished) = (queued.unwrap(), echo.unwrap(), finished.unwrap());
        assert!(
            queued < finished && finished < echo,
            "{queued} {finished} {echo}"
        );
        // the lines between are the sub-agents' calls running on: nothing else says "taken"
        assert!(echo - queued > 10);
    }

    /// Two plain lines written during one tool call (`queued-two`, real capture): the CLI does NOT
    /// merge them. Both are echoed, one after the other, right after the tool's result and inside
    /// the running turn (one `result`), each with its own `uuid`; the model answers both in one
    /// message. This is why Writer merges queued messages itself (spec 3.13).
    #[test]
    fn two_lines_queued_at_one_boundary_are_delivered_as_two_messages() {
        let mut m = ClaudeStreamMapper::new();
        let mut echoes = Vec::new();
        let (mut tool_result, mut finished) = (None, None);
        for (i, line) in fixture("queued-two").lines().enumerate() {
            let out = m.map_line(line);
            if let Some(u) = out.user_echo {
                echoes.push((i, u));
            }
            if out
                .events
                .iter()
                .any(|e| matches!(e, AgentEvent::ToolCallFinished { .. }))
            {
                tool_result = Some(i);
            }
            if out
                .events
                .iter()
                .any(|e| matches!(e, AgentEvent::TurnFinished { .. }))
            {
                finished = Some(i);
            }
        }
        let ids: Vec<&str> = echoes.iter().map(|(_, u)| u.as_str()).collect();
        assert_eq!(
            ids,
            [
                "00000000-0000-4000-8000-000000000010",
                "00000000-0000-4000-8000-000000000011",
                "00000000-0000-4000-8000-000000000012"
            ],
            "the first message, then each queued line as its own message"
        );
        assert_eq!(echoes[2].0, echoes[1].0 + 1, "back to back");
        assert!(tool_result.unwrap() < echoes[1].0 && echoes[2].0 < finished.unwrap());
        let (events, _) = run("queued-two");
        assert_eq!(
            events
                .iter()
                .filter(|e| matches!(e, AgentEvent::TurnFinished { .. }))
                .count(),
            1
        );
    }

    /// `cancel_async_message` (`queued-cancel`, real capture): the answer says `cancelled:true`
    /// for a waiting line, `false` for one the CLI no longer holds, and the cancelled line is
    /// never echoed.
    #[test]
    fn cancelling_a_waiting_line_is_answered_and_the_line_is_never_echoed() {
        let answers: Vec<(String, bool)> = fixture("queued-cancel")
            .lines()
            .filter_map(parse_cancel_queued_response)
            .collect();
        assert_eq!(
            answers,
            [
                ("req_cancel_1".to_string(), true),
                ("req_cancel_2".to_string(), false)
            ]
        );
        let mut m = ClaudeStreamMapper::new();
        let echoed: Vec<String> = fixture("queued-cancel")
            .lines()
            .filter_map(|l| m.map_line(l).user_echo)
            .collect();
        assert_eq!(echoed, ["00000000-0000-4000-8000-000000000010"]);
        let v: Value = serde_json::from_str(&encode_cancel_queued("r1", "u-1")).unwrap();
        assert_eq!(v["request"]["subtype"], "cancel_async_message");
        assert_eq!(v["request"]["message_uuid"], "u-1");
        assert_eq!(v["request_id"], "r1");
        assert_eq!(parse_cancel_queued_response("not json"), None);
    }

    #[test]
    fn a_queued_line_carries_a_uuid_and_no_priority() {
        let v: Value = serde_json::from_str(&encode_queued_message("go left", &[], "u-1")).unwrap();
        assert_eq!(v["uuid"], "u-1");
        assert!(v.get("priority").is_none());
        assert_eq!(v["message"]["content"], "go left");
    }

    #[test]
    fn a_steer_carries_its_uuid_and_a_plain_message_does_not() {
        let v: Value = serde_json::from_str(&encode_steer_message("go left", &[], "u-1")).unwrap();
        assert_eq!(v["uuid"], "u-1");
        assert_eq!(v["priority"], "now");
        assert_eq!(v["message"]["content"], "go left");
        let v: Value = serde_json::from_str(&encode_user_message("go left", &[])).unwrap();
        assert!(v.get("uuid").is_none());
    }

    /// Two sub-agents at once (`subagent-parallel`, built from the observed line shapes): every
    /// message a sub-agent made says whose it is, once, the main agent's say nothing, and the
    /// `task_*` lines become one status per run keyed by the launch call.
    #[test]
    fn parallel_sub_agents_are_told_apart_by_message_and_by_run() {
        use SubagentRunStatus::{Completed, Running};
        let (events, _) = run("subagent-parallel");
        let parents: Vec<(&str, &str)> = events
            .iter()
            .filter_map(|e| match e {
                AgentEvent::SubagentMessage {
                    message_id,
                    parent_tool_call_id,
                } => Some((message_id.as_str(), parent_tool_call_id.as_str())),
                _ => None,
            })
            .collect();
        assert_eq!(
            parents,
            [
                ("msg_e1", "toolu_ex"),
                ("msg_w1", "toolu_wk"),
                ("msg_e2", "toolu_ex"),
                ("msg_w2", "toolu_wk"),
                ("msg_e3", "toolu_ex"),
                ("msg_w3", "toolu_wk"),
            ],
            "a streamed message is told once (message_start), not again by its assistant line"
        );
        let got = statuses(&events);
        assert_eq!(
            got.iter().map(|(c, s, _)| (*c, *s)).collect::<Vec<_>>(),
            [
                ("toolu_ex", Running),
                ("toolu_wk", Running),
                ("toolu_ex", Completed),
                ("toolu_wk", Completed),
                ("toolu_ex", Completed),
                ("toolu_wk", Completed),
            ],
            "task_updated is mapped through the task id; the foreground launch result adds the \
             report to the end once"
        );
        assert!(got[..4].iter().all(|(_, _, r)| r.is_none()));
        assert!(got[4..].iter().all(|(_, _, r)| r.is_some()), "{got:?}");
        let nested: Vec<(&str, Option<&str>)> = events
            .iter()
            .filter_map(|e| match e {
                AgentEvent::ToolCallStarted {
                    tool_call_id,
                    parent_tool_call_id,
                    ..
                } => Some((tool_call_id.as_str(), parent_tool_call_id.as_deref())),
                _ => None,
            })
            .collect();
        assert!(nested.contains(&("toolu_ex", None)) && nested.contains(&("toolu_wk", None)));
        assert!(nested.contains(&("toolu_e_grep", Some("toolu_ex"))));
        assert!(nested.contains(&("toolu_w_edit", Some("toolu_wk"))));
    }

    /// A background run's launch call returns at once and is not its end: the run is `running`
    /// after it, its calls go on, and only the completion notification ends it, with the run's own
    /// report. The launch boilerplate (agent id, output file) is never emitted.
    #[test]
    fn a_background_run_ends_by_its_notification_with_its_report_not_its_launch_result() {
        let (events, _) = run("subagent-background");
        let launch_result = events
            .iter()
            .position(|e| matches!(e, AgentEvent::ToolCallFinished { tool_call_id, .. } if tool_call_id == "toolu_agent1"))
            .unwrap();
        let AgentEvent::ToolCallFinished { output, .. } = &events[launch_result] else {
            unreachable!()
        };
        assert_eq!(output, "", "the launch text is CLI-internal");
        let after: Vec<_> = statuses(&events[launch_result..]);
        assert_eq!(
            after,
            [
                ("toolu_agent1", SubagentRunStatus::Completed, None),
                (
                    "toolu_agent1",
                    SubagentRunStatus::Completed,
                    Some("The note now says new line added.")
                ),
            ],
            "running from task_started, not ended by the launch result, done by the task's end \
             lines, the notification adding the report"
        );
        assert!(statuses(&events[..launch_result])
            .iter()
            .all(|(_, s, _)| *s == SubagentRunStatus::Running));
        let json = serde_json::to_string(&events).unwrap();
        for leak in ["Async agent", "agentId", "a1b2c3", "output_file", "/tmp/x"] {
            assert!(!json.contains(leak), "{leak} reached the UI");
        }
        assert!(
            events
                .iter()
                .any(|e| matches!(e, AgentEvent::ToolCallStarted { tool, .. } if tool == "Write")),
            "the sub-agent's calls after the launch result are mapped"
        );
    }

    /// The CLI can move a run to the background by itself (no `run_in_background` in the call):
    /// its launch result then says `async_launched`. That is not the end either, and a sub-agent's
    /// own `Bash` task (`task_type` `local_bash`) never becomes a sub-agent status.
    #[test]
    fn a_run_the_cli_moved_to_the_background_stays_running() {
        let (events, _) = run("subagent-auto-background");
        assert_eq!(
            statuses(&events),
            [
                ("toolu_agent1", SubagentRunStatus::Running, None),
                (
                    "toolu_agent1",
                    SubagentRunStatus::Completed,
                    None
                ),
                (
                    "toolu_agent1",
                    SubagentRunStatus::Completed,
                    Some("Both notes read: one, two.")
                ),
            ],
            "running through the launch result and the nested Bash task; the report follows the final update"
        );
        let launch_result = events
            .iter()
            .position(|e| matches!(e, AgentEvent::ToolCallFinished { tool_call_id, .. } if tool_call_id == "toolu_agent1"))
            .unwrap();
        let first_done = events
            .iter()
            .position(|e| matches!(e, AgentEvent::SubagentStatus { status, .. } if *status == SubagentRunStatus::Completed))
            .unwrap();
        let calls_after_launch = events[launch_result..first_done]
            .iter()
            .filter(|e| matches!(e, AgentEvent::ToolCallStarted { parent_tool_call_id: Some(p), .. } if p == "toolu_agent1"))
            .count();
        assert_eq!(
            calls_after_launch, 2,
            "the run's calls after the launch result are mapped"
        );
        assert!(!serde_json::to_string(&events).unwrap().contains("agentId"));
    }

    /// `--thinking-display summarized` (real capture, 2.1.326): the deltas carry the summary text
    /// in pieces that can end mid-word, and the final block repeats the whole text.
    #[test]
    fn thinking_summary_streams_text_and_ends_with_the_full_text() {
        let (events, _) = run("thinking-summary");
        let thinking: Vec<_> = events
            .iter()
            .filter_map(|e| match e {
                AgentEvent::Thinking {
                    phase,
                    text,
                    block_index,
                    ..
                } => Some((*phase, text.clone(), *block_index)),
                _ => None,
            })
            .collect();
        assert_eq!(thinking.first().unwrap().0, ThinkingPhase::Start);
        let streamed: String = thinking
            .iter()
            .filter(|(p, ..)| *p == ThinkingPhase::Delta)
            .map(|(_, t, _)| t.as_str())
            .collect();
        let (last_phase, final_text, _) = thinking.last().unwrap();
        assert_eq!(*last_phase, ThinkingPhase::End);
        assert!(streamed.starts_with("Checking the arithmetic: 17 times 23 breaks into"));
        assert!(!streamed.is_empty() && final_text.starts_with(&streamed[..20]));
        assert!(thinking.iter().all(|(_, _, i)| *i == 0));
    }

    /// Without `--thinking-display` (or for redacted content) every delta and the final block have
    /// empty text: only token estimates arrive, and no text event is invented.
    #[test]
    fn redacted_thinking_carries_no_text_only_token_estimates() {
        let (events, _) = run("thinking-redacted");
        let mut estimates = 0;
        for e in &events {
            if let AgentEvent::Thinking {
                phase,
                text,
                estimated_tokens,
                ..
            } = e
            {
                assert!(text.is_empty(), "{phase:?}");
                estimates += usize::from(estimated_tokens.is_some());
            }
        }
        assert!(estimates > 0);
        assert!(types(&events).contains(&"text".to_string()));
    }

    #[test]
    fn plain_text_turn() {
        let (events, unsupported) = run("ok-turn");
        assert!(unsupported.is_empty());
        let t = types(&events);
        assert_eq!(t.first().unwrap(), "session-started");
        assert!(t.contains(&"text-delta".to_string()));
        let text_pos = t.iter().position(|x| x == "text").unwrap();
        assert!(t.iter().position(|x| x == "text-delta").unwrap() < text_pos);
        match &events[0] {
            AgentEvent::SessionStarted {
                cli_version,
                tools,
                permission_mode,
                cwd,
                ..
            } => {
                assert_eq!(cli_version.as_deref(), Some("2.1.325"));
                assert_eq!(tools, &vec!["Bash", "Edit", "Read", "Write"]);
                assert_eq!(permission_mode.as_deref(), Some("default"));
                assert_eq!(cwd, "/vault/Projects/Demo");
            }
            other => panic!("{other:?}"),
        }
        let final_text = events
            .iter()
            .find_map(|e| match e {
                AgentEvent::Text {
                    text, block_index, ..
                } => Some((text.clone(), *block_index)),
                _ => None,
            })
            .unwrap();
        assert_eq!(final_text, ("ok".to_string(), 0));
        // message usage from message_delta, turn usage and finish from result
        let tf = events.iter().find_map(|e| match e {
            AgentEvent::TurnFinished {
                reason,
                is_error,
                result,
                num_turns,
                ..
            } => Some((*reason, *is_error, result.clone(), *num_turns)),
            _ => None,
        });
        assert_eq!(
            tf,
            Some((
                TurnFinishReason::Completed,
                false,
                Some("ok".into()),
                Some(1)
            ))
        );
        let turn_usage = events.iter().find_map(|e| match e {
            AgentEvent::Usage {
                scope: UsageScope::Turn,
                context_window,
                cost_usd,
                output_tokens,
                ..
            } => Some((*context_window, *cost_usd, *output_tokens)),
            _ => None,
        });
        let (window, cost, out_tokens) = turn_usage.unwrap();
        assert_eq!(window, Some(1_000_000));
        assert!(cost.unwrap() > 0.0);
        assert_eq!(out_tokens, 4);
        assert!(types(&events).contains(&"rate-limit".to_string()));
    }

    #[test]
    fn tool_call_lifecycle_and_thinking() {
        let (events, _) = run("tool-auto-allowed");
        let start = events
            .iter()
            .position(|e| matches!(e, AgentEvent::ToolCallStarted { tool, .. } if tool == "Bash"))
            .unwrap();
        let input = events
            .iter()
            .position(|e| matches!(e, AgentEvent::ToolCallInput { input, .. } if input["command"] == "echo hi"))
            .unwrap();
        let fin = events
            .iter()
            .position(|e| matches!(e, AgentEvent::ToolCallFinished { output, outcome: ToolOutcome::Ok, .. } if output == "hi"))
            .unwrap();
        assert!(start < input && input < fin);
        // streamed input fragments rebuild the same JSON
        let fragments: String = events
            .iter()
            .filter_map(|e| match e {
                AgentEvent::ToolCallInputDelta { partial_json, .. } => Some(partial_json.as_str()),
                _ => None,
            })
            .collect();
        let parsed: Value = serde_json::from_str(&fragments).unwrap();
        assert_eq!(parsed["command"], "echo hi");
        // started exactly once even though both the stream and the assistant line carry it
        assert_eq!(
            events
                .iter()
                .filter(|e| matches!(e, AgentEvent::ToolCallStarted { .. }))
                .count(),
            1
        );
        // thinking: start, token estimates, end (text empty in this CLI)
        let phases: Vec<_> = events
            .iter()
            .filter_map(|e| match e {
                AgentEvent::Thinking {
                    phase,
                    estimated_tokens,
                    ..
                } => Some((*phase, *estimated_tokens)),
                _ => None,
            })
            .collect();
        assert_eq!(phases.first().unwrap().0, ThinkingPhase::Start);
        assert_eq!(phases.last().unwrap().0, ThinkingPhase::End);
        assert!(phases
            .iter()
            .any(|(p, n)| *p == ThinkingPhase::Delta && n.is_some()));
        // the thinking block is block 0 and the text block 1 of the second message
        let text_idx = events.iter().find_map(|e| match e {
            AgentEvent::Text { block_index, .. } => Some(*block_index),
            _ => None,
        });
        assert_eq!(text_idx, Some(1));
    }

    #[test]
    fn permission_request_carries_suggestions_and_both_tools() {
        let (events, unsupported) = run("permission-allow");
        assert!(unsupported.is_empty());
        let reqs: Vec<_> = events
            .iter()
            .filter_map(|e| match e {
                AgentEvent::PermissionRequest {
                    tool,
                    tool_call_id,
                    suggestions,
                    decision_reason,
                    input,
                    ..
                } => Some((
                    tool.clone(),
                    tool_call_id.clone(),
                    suggestions.clone(),
                    decision_reason.clone(),
                    input.clone(),
                )),
                _ => None,
            })
            .collect();
        assert_eq!(reqs.len(), 2);
        assert_eq!(reqs[0].0, "Write");
        assert_eq!(reqs[0].2[0]["type"], "setMode");
        assert_eq!(reqs[1].0, "Bash");
        assert_eq!(reqs[1].2[0]["type"], "addRules");
        assert_eq!(reqs[1].3.as_deref(), Some("This command requires approval"));
        assert_eq!(reqs[1].4["command"], "python3 -c 'print(1)'");
        // each request points at a started tool call
        for (_, id, ..) in &reqs {
            let id = id.clone().unwrap();
            assert!(events.iter().any(|e| matches!(e, AgentEvent::ToolCallStarted { tool_call_id, .. } if *tool_call_id == id)));
        }
        // two parallel tool calls, both finished ok
        let finished = events
            .iter()
            .filter(|e| {
                matches!(
                    e,
                    AgentEvent::ToolCallFinished {
                        outcome: ToolOutcome::Ok,
                        ..
                    }
                )
            })
            .count();
        assert_eq!(finished, 2);
    }

    #[test]
    fn denied_tool_is_rejected_not_error() {
        let (events, _) = run("permission-deny");
        let outcome = events.iter().find_map(|e| match e {
            AgentEvent::ToolCallFinished {
                outcome, is_error, ..
            } => Some((*outcome, *is_error)),
            _ => None,
        });
        let (outcome, is_error) = outcome.unwrap();
        assert!(is_error);
        assert_eq!(outcome, ToolOutcome::Rejected);
    }

    #[test]
    fn interrupt_cancels_the_pending_permission_and_finishes_interrupted() {
        let (events, _) = run("interrupt");
        let t = types(&events);
        let cancelled = events
            .iter()
            .position(|e| {
                matches!(
                    e,
                    AgentEvent::PermissionResolved {
                        resolution: PermissionResolution::Cancelled,
                        ..
                    }
                )
            })
            .unwrap();
        let req = t.iter().position(|x| x == "permission-request").unwrap();
        assert!(req < cancelled);
        let fin = events.iter().find_map(|e| match e {
            AgentEvent::TurnFinished {
                reason, is_error, ..
            } => Some((*reason, *is_error)),
            _ => None,
        });
        assert_eq!(fin, Some((TurnFinishReason::Interrupted, true)));
        // an interrupt is not an error event
        assert!(!t.contains(&"error".to_string()));
    }

    #[test]
    fn two_turns_in_one_process_and_a_persisted_rule_skips_the_second_prompt() {
        let (events, _) = run("multi-turn-rule");
        let finished = events
            .iter()
            .filter(|e| matches!(e, AgentEvent::TurnFinished { .. }))
            .count();
        assert_eq!(finished, 2);
        let prompts = events
            .iter()
            .filter(|e| matches!(e, AgentEvent::PermissionRequest { .. }))
            .count();
        assert_eq!(prompts, 1);
        // the CLI repeats `system/init` at the start of EVERY turn of a long-lived process, so
        // `session-started` is idempotent: same session id each time
        let ids: Vec<_> = events
            .iter()
            .filter_map(|e| match e {
                AgentEvent::SessionStarted { session_id, .. } => Some(session_id.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(ids.len(), 2);
        assert_eq!(ids[0], ids[1]);
    }

    #[test]
    fn init_carries_the_slash_commands_and_skills_the_cli_reports() {
        let mut m = ClaudeStreamMapper::new();
        let out = m.map_line(
            r#"{"type":"system","subtype":"init","session_id":"s","cwd":"/v","tools":[],"slash_commands":["compact","context","my-skill"],"skills":["my-skill","user-skill"]}"#,
        );
        match &out.events[..] {
            [AgentEvent::SessionStarted {
                slash_commands,
                skills,
                ..
            }] => {
                assert_eq!(slash_commands, &["compact", "context", "my-skill"]);
                assert_eq!(skills, &["my-skill", "user-skill"]);
            }
            other => panic!("unexpected {other:?}"),
        }
        // An older CLI without the key gives an empty list, not an error.
        let out = m.map_line(r#"{"type":"system","subtype":"init","session_id":"s","cwd":"/v"}"#);
        assert!(matches!(
            &out.events[..],
            [AgentEvent::SessionStarted { skills, .. }] if skills.is_empty()
        ));
    }

    #[test]
    fn init_carries_the_mcp_servers_with_their_status() {
        let mut m = ClaudeStreamMapper::new();
        let out = m.map_line(
            r#"{"type":"system","subtype":"init","session_id":"s","cwd":"/v","mcp_servers":[{"name":"notes","status":"connected"},{"name":"web","status":"failed"},{"name":"bare"},{"status":"x"}]}"#,
        );
        match &out.events[..] {
            [AgentEvent::SessionStarted { mcp_servers, .. }] => {
                let got: Vec<_> = mcp_servers
                    .iter()
                    .map(|s| (s.name.as_str(), s.status.as_str()))
                    .collect();
                assert_eq!(
                    got,
                    [
                        ("notes", "connected"),
                        ("web", "failed"),
                        ("bare", "unknown")
                    ]
                );
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn cancel_after_answer_is_not_reported_twice() {
        let mut m = ClaudeStreamMapper::new();
        let req = r#"{"type":"control_request","request_id":"r1","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"ls"},"tool_use_id":"t1"}}"#;
        assert_eq!(m.map_line(req).events.len(), 1);
        assert!(m.permission_answered("r1"));
        let out = m.map_line(r#"{"type":"control_cancel_request","request_id":"r1"}"#);
        assert!(out.events.is_empty());
    }

    fn ask_request(id: &str, input: &str) -> String {
        format!(
            r#"{{"type":"control_request","request_id":"{id}","request":{{"subtype":"can_use_tool","tool_name":"AskUserQuestion","display_name":"AskUserQuestion","input":{input},"tool_use_id":"t1","requires_user_interaction":true}}}}"#
        )
    }

    const TWO_QUESTIONS: &str = r##"{"questions":[{"question":"Color?","header":"Color","options":[{"label":"Red","description":"warm"},{"label":"Blue","description":"cool","preview":"#00f"}],"multiSelect":false},{"question":"Fruit?","header":"Fruit","options":[{"label":"Apple","description":"crisp"},{"label":"Fig","description":"soft"}],"multiSelect":true}]}"##;

    #[test]
    fn ask_user_question_is_a_question_request_never_a_permission_card() {
        let mut m = ClaudeStreamMapper::new();
        let out = m.map_line(&ask_request("r1", TWO_QUESTIONS));
        assert_eq!(out.events.len(), 1);
        let AgentEvent::QuestionRequest {
            request_id,
            tool_call_id,
            questions,
            ..
        } = &out.events[0]
        else {
            panic!("{:?}", out.events)
        };
        assert_eq!(
            (request_id.as_str(), tool_call_id.as_deref()),
            ("r1", Some("t1"))
        );
        assert_eq!(questions.len(), 2);
        assert!(!questions[0].multi_select && questions[1].multi_select);
        assert_eq!(questions[0].header, "Color");
        assert_eq!(questions[0].options[1].preview.as_deref(), Some("#00f"));
        assert_eq!(questions[0].options[0].preview, None);
    }

    #[test]
    fn a_question_answer_is_allow_with_the_input_and_answers_by_question_text() {
        let mut m = ClaudeStreamMapper::new();
        m.map_line(&ask_request("r1", TWO_QUESTIONS));
        let answers = [
            QuestionAnswer {
                question: "Color?".into(),
                answers: vec!["Blue".into()],
            },
            QuestionAnswer {
                question: "Fruit?".into(),
                answers: vec!["Apple".into(), "my own".into()],
            },
        ];
        let line = m.encode_question_answer("r1", Some(&answers)).unwrap();
        let v: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(v["response"]["request_id"], "r1");
        let r = &v["response"]["response"];
        assert_eq!(r["behavior"], "allow");
        assert_eq!(r["updatedInput"]["answers"]["Color?"], "Blue");
        assert_eq!(r["updatedInput"]["answers"]["Fruit?"], "Apple, my own");
        assert_eq!(r["updatedInput"]["questions"].as_array().unwrap().len(), 2);
        // answered once
        assert!(m.encode_question_answer("r1", None).is_none());
    }

    #[test]
    fn declining_a_question_is_a_deny_the_model_reads_as_skipped() {
        let mut m = ClaudeStreamMapper::new();
        m.map_line(&ask_request("r1", TWO_QUESTIONS));
        let v: Value =
            serde_json::from_str(&m.encode_question_answer("r1", None).unwrap()).unwrap();
        assert_eq!(v["response"]["response"]["behavior"], "deny");
        assert_eq!(
            v["response"]["response"]["message"],
            "The user skipped the questions."
        );
    }

    #[test]
    fn a_withdrawn_question_resolves_as_a_cancelled_question() {
        let mut m = ClaudeStreamMapper::new();
        m.map_line(&ask_request("r1", TWO_QUESTIONS));
        let out = m.map_line(r#"{"type":"control_cancel_request","request_id":"r1"}"#);
        assert_eq!(
            out.events,
            vec![AgentEvent::QuestionResolved {
                request_id: "r1".into(),
                tool_call_id: Some("t1".into()),
                resolution: QuestionResolution::Cancelled,
                answers: vec![],
            }]
        );
        assert!(m
            .map_line(r#"{"type":"control_cancel_request","request_id":"r1"}"#)
            .events
            .is_empty());
    }

    #[test]
    fn a_question_without_a_tool_call_id_is_the_generic_card_too() {
        let mut m = ClaudeStreamMapper::new();
        let line = ask_request("r1", TWO_QUESTIONS).replace(r#","tool_use_id":"t1""#, "");
        assert!(matches!(
            m.map_line(&line).events[0],
            AgentEvent::PermissionRequest { .. }
        ));
    }

    #[test]
    fn an_unparsable_question_falls_back_to_the_generic_permission_card() {
        for input in [
            r#"{}"#,
            r#"{"questions":[]}"#,
            r#"{"questions":[{"question":"Q?","options":[]}]}"#,
            r#"{"questions":[{"header":"h","options":[{"label":"a"}]}]}"#,
            r#"{"questions":"nope"}"#,
        ] {
            let mut m = ClaudeStreamMapper::new();
            let out = m.map_line(&ask_request("r1", input));
            assert!(
                matches!(out.events[0], AgentEvent::PermissionRequest { .. }),
                "{input}"
            );
        }
    }

    #[test]
    fn a_signed_out_cli_is_an_auth_error_that_is_not_retryable() {
        let mut m = ClaudeStreamMapper::new();
        let out = m.map_line(
            r#"{"type":"result","subtype":"success","is_error":true,"terminal_reason":"api_error","api_error_status":null,"duration_ms":10,"result":"Not logged in · Please run /login","usage":{}}"#,
        );
        match out.events.last() {
            Some(AgentEvent::Error {
                kind, retryable, ..
            }) => {
                assert_eq!(*kind, AgentErrorKind::Auth);
                assert!(!retryable);
            }
            other => panic!("{other:?}"),
        }
        // other failures without a status stay unknown
        let out = m.map_line(
            r#"{"type":"result","subtype":"success","is_error":true,"terminal_reason":"api_error","duration_ms":1,"result":"Overloaded","usage":{}}"#,
        );
        assert!(matches!(
            out.events.last(),
            Some(AgentEvent::Error {
                kind: AgentErrorKind::Unknown,
                ..
            })
        ));
    }

    #[test]
    fn unsupported_control_requests_are_reported_for_an_error_reply() {
        let mut m = ClaudeStreamMapper::new();
        let out = m.map_line(
            r#"{"type":"control_request","request_id":"h1","request":{"subtype":"hook_callback","callback_id":"x"}}"#,
        );
        assert!(out.events.is_empty());
        assert_eq!(out.unsupported_control_request.as_deref(), Some("h1"));
        let reply: Value =
            serde_json::from_str(&encode_control_error("h1", "unsupported")).unwrap();
        assert_eq!(reply["response"]["subtype"], "error");
        assert_eq!(reply["response"]["request_id"], "h1");
    }

    #[test]
    fn garbage_and_unknown_lines_are_safe() {
        let mut m = ClaudeStreamMapper::new();
        assert_eq!(m.map_line("").events.len(), 0);
        let out = m.map_line("not json with a secret in it");
        match &out.events[0] {
            AgentEvent::Error {
                kind,
                message,
                retryable,
            } => {
                assert_eq!(*kind, AgentErrorKind::Protocol);
                assert!(!message.contains("secret"));
                assert!(!retryable);
            }
            other => panic!("{other:?}"),
        }
        assert!(m
            .map_line(r#"{"type":"brand_new_thing","x":1}"#)
            .events
            .is_empty());
        assert!(m.map_line(r#"{"type":"stream_event"}"#).events.is_empty());
        assert!(m
            .map_line(r#"{"type":"user","message":{"content":"plain string"}}"#)
            .events
            .is_empty());
    }

    #[test]
    fn non_streamed_assistant_messages_work_without_partial_events() {
        let mut m = ClaudeStreamMapper::new();
        let a = r#"{"type":"assistant","message":{"id":"m9","content":[{"type":"text","text":"hi"},{"type":"tool_use","id":"t9","name":"Read","input":{"file_path":"a.md"}}],"usage":{"input_tokens":1,"output_tokens":2}}}"#;
        let ev = m.map_line(a).events;
        let t = types(&ev);
        assert_eq!(t, ["usage", "text", "tool-call-started", "tool-call-input"]);
        match &ev[1] {
            AgentEvent::Text { block_index, .. } => assert_eq!(*block_index, 0),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn tool_output_is_flattened_and_capped_on_a_char_boundary() {
        let mut m = ClaudeStreamMapper::new();
        let big = "é".repeat(MAX_TOOL_OUTPUT_BYTES); // 2 bytes each
        let line = json!({"type":"user","message":{"content":[
            {"type":"tool_result","tool_use_id":"a","content":[{"type":"text","text":"l1"},{"type":"image"},{"type":"text","text":"l2"}]},
            {"type":"tool_result","tool_use_id":"b","content":big,"is_error":true}
        ]}})
        .to_string();
        let ev = m.map_line(&line).events;
        match (&ev[0], &ev[1]) {
            (
                AgentEvent::ToolCallFinished {
                    output: o1,
                    truncated: t1,
                    ..
                },
                AgentEvent::ToolCallFinished {
                    output: o2,
                    truncated: t2,
                    outcome,
                    ..
                },
            ) => {
                assert_eq!(o1, "l1\n[image]\nl2");
                assert!(!t1);
                assert!(*t2);
                assert!(o2.len() <= MAX_TOOL_OUTPUT_BYTES);
                assert_eq!(*outcome, ToolOutcome::Error);
            }
            other => panic!("{other:?}"),
        }
        // a repeated result for the same id is ignored
        assert!(m.map_line(&line).events.is_empty());
    }

    #[test]
    fn api_errors_map_to_kinds() {
        let mk = |status: Option<u64>| {
            let mut m = ClaudeStreamMapper::new();
            let mut v = json!({"type":"result","subtype":"success","is_error":true,"duration_ms":1,
                "result":"API Error","session_id":"s","terminal_reason":"completed"});
            if let Some(s) = status {
                v["api_error_status"] = json!(s);
            }
            let ev = m.map_value(&v).events;
            ev.into_iter()
                .find_map(|e| match e {
                    AgentEvent::Error {
                        kind, retryable, ..
                    } => Some((kind, retryable)),
                    _ => None,
                })
                .unwrap()
        };
        assert_eq!(mk(Some(401)), (AgentErrorKind::Auth, false));
        assert_eq!(mk(Some(429)), (AgentErrorKind::RateLimit, true));
        assert_eq!(mk(Some(529)), (AgentErrorKind::Api, true));
        assert_eq!(mk(Some(400)), (AgentErrorKind::Api, false));
        assert_eq!(mk(None), (AgentErrorKind::Unknown, false));
        let mut m = ClaudeStreamMapper::new();
        let ev = m
            .map_value(&json!({"type":"result","subtype":"error_max_turns","is_error":true,"duration_ms":1}))
            .events;
        assert!(matches!(
            ev.last(),
            Some(AgentEvent::TurnFinished {
                reason: TurnFinishReason::MaxTurns,
                ..
            })
        ));
    }

    #[test]
    fn a_pdf_is_a_base64_document_block_in_attach_order_before_the_text() {
        let part = |kind, m, d: &str| FilePart {
            kind,
            media_type: m,
            data: d.into(),
        };
        let files = [
            part(FileKind::Document, "application/pdf", "JVBERg=="),
            part(FileKind::Image, "image/png", "AAAA"),
        ];
        // Golden: the API's document block (`source.type: base64`, `application/pdf`), the
        // stream-json stdin shape of an image block carrying a different `type`.
        let expected = json!({"type":"user","message":{"role":"user","content":[
            {"type":"document","source":{"type":"base64","media_type":"application/pdf","data":"JVBERg=="}},
            {"type":"image","source":{"type":"base64","media_type":"image/png","data":"AAAA"}},
            {"type":"text","text":"summarise"}
        ]}});
        let v: Value = serde_json::from_str(&encode_user_message("summarise", &files)).unwrap();
        assert_eq!(v, expected);
        // a steer carries the same blocks plus its receipt
        let s: Value =
            serde_json::from_str(&encode_steer_message("summarise", &files, "u-9")).unwrap();
        assert_eq!(s["message"], expected["message"]);
        assert_eq!(s["uuid"], "u-9");
    }

    #[test]
    fn a_message_with_images_is_a_content_array_of_image_blocks_then_the_text() {
        let part = |m, d: &str| FilePart {
            kind: FileKind::Image,
            media_type: m,
            data: d.into(),
        };
        let line = encode_user_message(
            "look",
            &[part("image/png", "AAAA"), part("image/webp", "BBBB")],
        );
        assert!(!line.contains('\n'));
        let v: Value = serde_json::from_str(&line).unwrap();
        // Golden: the exact shape the real CLI accepted (images first, then the text block).
        assert_eq!(
            v,
            json!({"type":"user","message":{"role":"user","content":[
                {"type":"image","source":{"type":"base64","media_type":"image/png","data":"AAAA"}},
                {"type":"image","source":{"type":"base64","media_type":"image/webp","data":"BBBB"}},
                {"type":"text","text":"look"}
            ]}})
        );
        let v: Value = serde_json::from_str(&encode_user_message("look", &[])).unwrap();
        assert_eq!(v["message"]["content"], "look");
    }

    #[test]
    fn encoders_produce_the_verified_shapes() {
        let v: Value = serde_json::from_str(&encode_user_message("hello", &[])).unwrap();
        assert_eq!(
            v,
            json!({"type":"user","message":{"role":"user","content":"hello"}})
        );
        let v: Value = serde_json::from_str(&encode_interrupt("i1")).unwrap();
        assert_eq!(
            v,
            json!({"type":"control_request","request_id":"i1","request":{"subtype":"interrupt"}})
        );
        let sug = vec![
            json!({"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"ls"}],"behavior":"allow","destination":"localSettings"}),
        ];
        let perms = updated_permissions(&sug, Some(PermissionPersist::Project));
        let v: Value = serde_json::from_str(&encode_permission_allow(
            "r",
            &json!({"command":"ls"}),
            &perms,
        ))
        .unwrap();
        assert_eq!(v["response"]["subtype"], "success");
        assert_eq!(v["response"]["request_id"], "r");
        assert_eq!(v["response"]["response"]["behavior"], "allow");
        assert_eq!(v["response"]["response"]["updatedInput"]["command"], "ls");
        assert_eq!(
            v["response"]["response"]["updatedPermissions"][0]["destination"],
            "localSettings"
        );
        let v: Value =
            serde_json::from_str(&encode_permission_allow("r", &json!({}), &[])).unwrap();
        assert!(v["response"]["response"]
            .get("updatedPermissions")
            .is_none());
        let v: Value = serde_json::from_str(&encode_permission_deny("r", "No")).unwrap();
        assert_eq!(
            v["response"]["response"],
            json!({"behavior":"deny","message":"No"})
        );
        let v: Value = serde_json::from_str(&encode_set_permission_mode(
            "m",
            AgentPermissionMode::AcceptEdits,
        ))
        .unwrap();
        assert_eq!(
            v["request"],
            json!({"subtype":"set_permission_mode","mode":"acceptEdits"})
        );
        let v: Value = serde_json::from_str(&encode_set_model("m", Some("opus"))).unwrap();
        assert_eq!(v["request"], json!({"subtype":"set_model","model":"opus"}));
        let v: Value = serde_json::from_str(&encode_set_model("m", None)).unwrap();
        assert_eq!(v["request"], json!({"subtype":"set_model"}));
        // none of the encoders emit a newline (one JSON object per line)
        assert!(!encode_user_message("a\nb", &[]).contains('\n'));
    }

    /// The prompt is built in TypeScript (`features/agent/web/lib/context-text.ts`, which asserts these same
    /// cases); this side proves the refs of the contract deserialize and that the encoder carries
    /// each prompt to the CLI's stdin byte for byte, as one line.
    #[test]
    fn prompt_golden_cases_reach_stdin_verbatim() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../shared/agent-prompt-golden.json");
        let cases: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(path).unwrap())
            .expect("agent-prompt-golden.json");
        assert!(cases.len() >= 6);
        for c in &cases {
            let refs: Vec<ContextRef> = serde_json::from_value(c["refs"].clone()).unwrap();
            let prompt = c["prompt"].as_str().unwrap();
            let name = c["name"].as_str().unwrap();
            let line = encode_user_message(prompt, &[]);
            assert!(!line.contains('\n'), "{name}: one line");
            let v: Value = serde_json::from_str(&line).unwrap();
            assert_eq!(v["message"]["content"], prompt, "{name}");
            // the footer exists exactly when something was attached and no `/command` leads
            let footer = prompt.contains("\n\n<references>\n");
            let leading = c["text"].as_str().unwrap().trim_start().starts_with('/');
            assert!(!(footer && leading), "{name}: no footer behind a command");
            assert!(
                !(leading && prompt.contains("<open-tabs>")),
                "{name}: no open-tabs behind a command"
            );
            if refs.is_empty() && c.get("skills").is_none() && c.get("openTabs").is_none() {
                assert_eq!(prompt, c["text"].as_str().unwrap(), "{name}: unchanged");
            }
        }
        // the reference example, exactly as written to stdin
        let first = encode_user_message(cases[0]["prompt"].as_str().unwrap(), &[]);
        assert_eq!(
            first,
            r#"{"type":"user","message":{"role":"user","content":"compare @Projects/Plan.md with @Notes/Today.md and /summarize\n\n<references>\nAttached by the user, paths relative to the working directory (read them with the Read tool when relevant):\n- @Notes/Today.md (active note: the note open in Writer)\n- @Projects/Plan.md (note)\n- /summarize (skill, not expanded mid-message: invoke it with the Skill tool)\n</references>"}}"#
        );
    }

    #[test]
    fn persist_choices_rebuild_updated_permissions_from_suggestions() {
        let sug = vec![
            json!({"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"ls"}],"behavior":"allow","destination":"userSettings"}),
            json!({"type":"setMode","mode":"acceptEdits","destination":"session"}),
            json!({"type":"setMode","mode":"bypassPermissions","destination":"session"}),
        ];
        assert!(updated_permissions(&sug, None).is_empty());
        let project = updated_permissions(&sug, Some(PermissionPersist::Project));
        assert_eq!(project.len(), 1);
        assert_eq!(project[0]["destination"], "localSettings"); // forced, never userSettings
        let session = updated_permissions(&sug, Some(PermissionPersist::Session));
        assert_eq!(session[0]["destination"], "session");
        let edits = updated_permissions(&sug, Some(PermissionPersist::AcceptEdits));
        assert_eq!(edits.len(), 1);
        assert_eq!(edits[0]["mode"], "acceptEdits"); // bypassPermissions is never forwarded
    }

    fn settings() -> AgentSettings {
        AgentSettings {
            binary_path: None,
            model: None,
            effort: None,
            permission_mode: AgentPermissionMode::Manual,
            allowed_tools: vec![],
            disallowed_tools: vec![],
            orchestrate: true,
            show_thinking: false,
            auto_reload: true,
            memory: AgentMemory::Default,
            tier_models: Default::default(),
        }
    }

    const UUID: &str = "5328964b-5fe4-4e06-8843-5cf92bdc9e7c";

    #[test]
    fn args_for_new_and_resumed_sessions() {
        let s = settings();
        let args = build_args(&ClaudeSpawn {
            session: SessionRef::New(UUID.into()),
            settings: &s,
            append_system_prompt: None,
            add_dirs: &[],
            agents: None,
            memory_dir: None,
            mcp: None,
        })
        .unwrap();
        assert_eq!(&args[..3], ["-p", "--input-format", "stream-json"]);
        for flag in [
            "--include-partial-messages",
            "--replay-user-messages",
            "--verbose",
            "--permission-prompt-tool",
        ] {
            assert!(args.contains(&flag.to_string()), "{flag}");
        }
        let at = |f: &str| {
            args.iter()
                .position(|a| a == f)
                .map(|i| args[i + 1].clone())
        };
        assert_eq!(at("--permission-prompt-tool").as_deref(), Some("stdio"));
        assert_eq!(at("--permission-mode").as_deref(), Some("manual"));
        assert_eq!(
            at("--setting-sources").as_deref(),
            Some("user,project,local")
        );
        assert_eq!(at("--session-id").as_deref(), Some(UUID));
        assert!(!args.contains(&"--resume".to_string()));
        let resumed = build_args(&ClaudeSpawn {
            session: SessionRef::Resume(UUID.into()),
            settings: &s,
            append_system_prompt: None,
            add_dirs: &[],
            agents: None,
            memory_dir: None,
            mcp: None,
        })
        .unwrap();
        assert!(resumed.contains(&"--resume".to_string()));
        assert!(!resumed.contains(&"--session-id".to_string()));
        // never the dangerous flags
        for forbidden in [
            "--dangerously-skip-permissions",
            "--bare",
            "--allow-dangerously-skip-permissions",
        ] {
            assert!(!args.contains(&forbidden.to_string()));
        }
    }

    #[test]
    fn thinking_display_is_a_spawn_flag_of_the_setting() {
        for on in [true, false] {
            let mut s = settings();
            s.show_thinking = on;
            let args = build_args(&ClaudeSpawn {
                session: SessionRef::New(UUID.into()),
                settings: &s,
                append_system_prompt: None,
                add_dirs: &[],
                agents: None,
                memory_dir: None,
                mcp: None,
            })
            .unwrap();
            let at = args.iter().position(|a| a == "--thinking-display");
            assert_eq!(at.map(|i| args[i + 1].as_str()), on.then_some("summarized"));
        }
    }

    #[test]
    fn args_include_options_and_reject_injection() {
        let mut s = settings();
        s.model = Some("sonnet".into());
        s.effort = Some(Effort::High);
        s.permission_mode = AgentPermissionMode::AcceptEdits;
        s.allowed_tools = vec!["Read".into(), "Bash(git status)".into()];
        s.disallowed_tools = vec!["WebFetch".into()];
        let dirs = vec!["/vault/Notes".to_string()];
        let args = build_args(&ClaudeSpawn {
            session: SessionRef::New(UUID.into()),
            settings: &s,
            append_system_prompt: Some("Project rules"),
            add_dirs: &dirs,
            agents: None,
            memory_dir: None,
            mcp: None,
        })
        .unwrap();
        let pos = |f: &str| args.iter().position(|a| a == f).unwrap();
        assert_eq!(args[pos("--model") + 1], "sonnet");
        assert_eq!(args[pos("--effort") + 1], "high");
        assert_eq!(args[pos("--permission-mode") + 1], "acceptEdits");
        assert_eq!(args[pos("--append-system-prompt") + 1], "Project rules");
        assert_eq!(
            &args[pos("--allowedTools") + 1..pos("--allowedTools") + 3],
            ["Read", "Bash(git status)"]
        );
        assert_eq!(args[pos("--disallowedTools") + 1], "WebFetch");
        assert_eq!(args[pos("--add-dir") + 1], "/vault/Notes");

        let bad = |f: &dyn Fn(&mut AgentSettings), session: SessionRef| {
            let mut s = settings();
            f(&mut s);
            build_args(&ClaudeSpawn {
                session,
                settings: &s,
                append_system_prompt: None,
                add_dirs: &[],
                agents: None,
                memory_dir: None,
                mcp: None,
            })
        };
        assert!(bad(&|_| {}, SessionRef::New("not-a-uuid".into())).is_err());
        assert!(bad(
            &|s| s.model = Some("--dangerously-skip-permissions".into()),
            SessionRef::New(UUID.into())
        )
        .is_err());
        assert!(bad(
            &|s| s.allowed_tools = vec!["--bare".into()],
            SessionRef::New(UUID.into())
        )
        .is_err());
        assert!(bad(
            &|s| s.disallowed_tools = vec!["a\nb".into()],
            SessionRef::New(UUID.into())
        )
        .is_err());
    }

    #[test]
    fn task_lines_map_to_signals_without_deciding_anything() {
        let mut m = ClaudeStreamMapper::new();
        let lines = [
            r#"{"type":"system","subtype":"task_started","task_id":"t1","tool_use_id":"toolu_1","subagent_type":"writer-worker","is_backgrounded":false}"#,
            r#"{"type":"system","subtype":"task_progress","task_id":"t1","tool_use_id":"toolu_1"}"#,
            r#"{"type":"system","subtype":"task_updated","task_id":"t1","patch":{"status":"running"}}"#,
            r#"{"type":"system","subtype":"task_updated","task_id":"t1","patch":{"status":"killed","end_time":1}}"#,
            r#"{"type":"system","subtype":"task_notification","task_id":"t1","tool_use_id":"toolu_1","status":"failed","summary":"CLI sentence","handback_report":{"text":" the report "}}"#,
            r#"{"type":"system","subtype":"task_notification","task_id":"t2","tool_use_id":"toolu_2","status":"completed","summary":"CLI sentence"}"#,
        ];
        let out: Vec<_> = lines.iter().map(|l| m.map_line(l)).collect();
        assert!(
            out.iter().all(|o| o.events.is_empty()),
            "no UI event from a task line"
        );
        assert_eq!(
            out[0].tasks,
            [TaskSignal::Started {
                task: "t1".into(),
                call: Some("toolu_1".into()),
                background: false
            }]
        );
        assert!(out[1].tasks.is_empty() && out[2].tasks.is_empty());
        assert_eq!(
            out[3].tasks,
            [TaskSignal::Updated {
                task: "t1".into(),
                call: Some("toolu_1".into()),
                status: SubagentRunStatus::Stopped
            }]
        );
        assert_eq!(
            out[4].tasks,
            [TaskSignal::Notified {
                task: "t1".into(),
                call: Some("toolu_1".into()),
                status: SubagentRunStatus::Failed,
                report: Some("the report".into())
            }]
        );
        assert!(
            matches!(
                &out[5].tasks[..],
                [TaskSignal::Notified { report: None, .. }]
            ),
            "the CLI's summary sentence is never a report"
        );
    }

    #[test]
    fn agents_flag_follows_the_given_json_and_the_title_call_has_none() {
        let s = settings();
        let json = r#"{"writer-explorer":{"description":"d","tools":["Read"]}}"#.to_string();
        let argv = |agents| {
            build_args(&ClaudeSpawn {
                session: SessionRef::New(UUID.into()),
                settings: &s,
                append_system_prompt: None,
                add_dirs: &[],
                agents,
                memory_dir: None,
                mcp: None,
            })
            .unwrap()
        };
        let on = argv(Some(&json));
        let pos = on.iter().position(|a| a == "--agents").unwrap();
        assert_eq!(on[pos + 1], json);
        assert!(!argv(None).contains(&"--agents".to_string()));
        assert!(!build_title_args(None, "t")
            .unwrap()
            .contains(&"--agents".to_string()));
    }

    /// Writer's MCP server: `--mcp-config` carries the server and `--allowedTools` the rules of
    /// the read-only tools next to the user's own; never `--strict-mcp-config` (the user's servers
    /// stay), and without a wiring the argv is exactly what it was.
    #[test]
    fn the_mcp_server_is_added_next_to_the_users_and_its_read_tools_are_allowed() {
        let mut s = settings();
        s.allowed_tools = vec!["Bash(git status)".into()];
        let wiring = crate::agent::mcp_wiring::wiring(
            &crate::agent::subagents::ClaudeAdapter,
            Path::new("/data/bin/writer"),
            Path::new("/Users/me/Notes"),
        )
        .unwrap();
        let Launch::Argv(launch) = &wiring.launch else {
            panic!("claude takes the server as argv")
        };
        assert_eq!(launch[0], "--mcp-config");
        let argv = |mcp: Option<&McpWiring>| {
            build_args(&ClaudeSpawn {
                session: SessionRef::New(UUID.into()),
                settings: &s,
                append_system_prompt: None,
                add_dirs: &[],
                agents: None,
                memory_dir: None,
                mcp,
            })
            .unwrap()
        };
        let off = argv(None);
        assert!(!off.contains(&"--mcp-config".to_string()));
        assert_eq!(
            off.iter()
                .filter(|a| a.starts_with("mcp__writer__"))
                .count(),
            0
        );
        let on = argv(Some(&wiring));
        let pos = |f: &str| on.iter().position(|a| a == f).unwrap();
        assert_eq!(on[pos("--mcp-config") + 1], launch[1]);
        assert!(on[pos("--mcp-config") + 1].starts_with('{'));
        assert!(!on.contains(&"--strict-mcp-config".to_string()));
        // the user's rule first, then every read tool, in one flag
        let allowed = &on[pos("--allowedTools") + 1..];
        assert_eq!(allowed[0], "Bash(git status)");
        assert!(allowed.contains(&"mcp__writer__search".to_string()));
        assert!(!allowed.contains(&"mcp__writer__create".to_string()));
        assert_eq!(on.iter().filter(|a| *a == "--allowedTools").count(), 1);
        // everything else is unchanged
        let strip = |v: &[String]| -> Vec<String> {
            let mut out = Vec::new();
            let mut skip_rules = false;
            let mut skip_one = false;
            for a in v {
                if skip_one {
                    skip_one = false;
                    continue;
                }
                if a == "--mcp-config" {
                    skip_one = true;
                } else if a == "--allowedTools" {
                    skip_rules = true;
                } else if skip_rules && !a.starts_with("--") {
                } else {
                    skip_rules = false;
                    out.push(a.clone());
                }
            }
            out
        };
        assert_eq!(strip(&on), strip(&off));
        // the title call never has it, and a bad config is refused
        assert!(!build_title_args(None, "t")
            .unwrap()
            .contains(&"--mcp-config".to_string()));
        let bad = McpWiring {
            launch: Launch::Argv(vec!["--mcp-config".into(), "{\0}".into()]),
            allowed: vec![],
        };
        assert!(build_args(&ClaudeSpawn {
            session: SessionRef::New(UUID.into()),
            settings: &s,
            append_system_prompt: None,
            add_dirs: &[],
            agents: None,
            memory_dir: None,
            mcp: Some(&bad),
        })
        .is_err());
    }

    /// The memory flag: `--settings` carries `autoMemoryDirectory` only when a memory folder is
    /// given (`agent.memory` = `vault`); without one the argv is exactly what it was before, and
    /// the title call never has it.
    #[test]
    fn memory_folder_is_the_settings_flag_and_nothing_else_changes() {
        let s = settings();
        let argv = |memory_dir: Option<&Path>| {
            build_args(&ClaudeSpawn {
                session: SessionRef::New(UUID.into()),
                settings: &s,
                append_system_prompt: Some("block"),
                add_dirs: &[],
                agents: None,
                memory_dir,
                mcp: None,
            })
            .unwrap()
        };
        let none = argv(None);
        assert!(!none.contains(&"--settings".to_string()));
        let dir = Path::new("/vault/.writer/memory");
        let on = argv(Some(dir));
        let pos = on.iter().position(|a| a == "--settings").unwrap();
        assert_eq!(
            on[pos + 1],
            r#"{"autoMemoryDirectory":"/vault/.writer/memory"}"#
        );
        // everything else is the same, in the same order
        let mut without = on.clone();
        without.drain(pos..pos + 2);
        assert_eq!(without, none);
        let project = argv(Some(Path::new("/vault/Projects/P/.memory")));
        assert!(project[pos + 1].contains("/vault/Projects/P/.memory"));
        assert!(!build_title_args(None, "t")
            .unwrap()
            .contains(&"--settings".to_string()));
    }

    #[test]
    fn memory_settings_json_refuses_unsafe_folders() {
        assert!(memory_settings_json(Path::new("/v/.writer/memory")).is_ok());
        for bad in ["", "relative/memory", "/v/../etc", "/v/a\nb", "/v/a\0b"] {
            assert!(memory_settings_json(Path::new(bad)).is_err(), "{bad:?}");
        }
        // quotes and backslashes are escaped by the JSON encoder, never concatenated
        let json = memory_settings_json(Path::new("/v/a\"b\\c")).unwrap();
        let back: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(back["autoMemoryDirectory"], "/v/a\"b\\c");
    }
}
