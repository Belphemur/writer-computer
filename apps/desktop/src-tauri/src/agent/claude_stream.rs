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
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};

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
}

fn str_of<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

fn u64_of(v: &Value, key: &str) -> u64 {
    v.get(key).and_then(Value::as_u64).unwrap_or(0)
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

fn usage_event(
    scope: UsageScope,
    usage: &Value,
    cost: Option<f64>,
    window: Option<u64>,
) -> AgentEvent {
    AgentEvent::Usage {
        scope,
        input_tokens: u64_of(usage, "input_tokens"),
        output_tokens: u64_of(usage, "output_tokens"),
        cache_read_tokens: u64_of(usage, "cache_read_input_tokens"),
        cache_creation_tokens: u64_of(usage, "cache_creation_input_tokens"),
        cost_usd: cost,
        context_window: window,
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
            },
        }
    }

    pub fn map_value(&mut self, v: &Value) -> MapOutput {
        let mut out = MapOutput::default();
        match str_of(v, "type") {
            Some("system") => self.system(v, &mut out),
            Some("stream_event") => self.stream_event(v, &mut out),
            Some("assistant") => self.assistant(v, &mut out),
            Some("user") => self.user(v, &mut out),
            Some("control_request") => self.control_request(v, &mut out),
            Some("control_cancel_request") => {
                if let Some(id) = str_of(v, "request_id") {
                    if self.pending_permissions.remove(id) {
                        out.events.push(AgentEvent::PermissionResolved {
                            request_id: id.to_string(),
                            resolution: PermissionResolution::Cancelled,
                        });
                    }
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
                    cli_version: str_of(v, "claude_code_version").map(String::from),
                });
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

    fn parent_tool(v: &Value) -> Option<String> {
        str_of(v, "parent_tool_use_id").map(String::from)
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
                        .push(usage_event(UsageScope::Message, usage, None, None));
                }
            }
            _ => {}
        }
    }

    fn assistant(&mut self, v: &Value, out: &mut MapOutput) {
        let Some(msg) = v.get("message") else { return };
        let id = str_of(msg, "id").unwrap_or("").to_string();
        let new_message = self.message_id.as_deref() != Some(id.as_str());
        if new_message {
            // No stream_event preceded it (partial messages off): a complete message.
            self.start_message(&id, false);
            if let Some(usage) = msg.get("usage") {
                out.events
                    .push(usage_event(UsageScope::Message, usage, None, None));
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
            let (output, truncated) = truncate_to_boundary(
                flatten_tool_result(block.get("content")),
                MAX_TOOL_OUTPUT_BYTES,
            );
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
        });
    }

    /// The runner calls this when it writes the user's answer, so a late
    /// `control_cancel_request` for the same id is not reported twice.
    pub fn permission_answered(&mut self, request_id: &str) -> bool {
        self.pending_permissions.remove(request_id)
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
        out.events.push(usage_event(
            UsageScope::Turn,
            &usage,
            v.get("total_cost_usd").and_then(Value::as_f64),
            window,
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

pub fn encode_user_message(text: &str) -> String {
    json!({"type":"user","message":{"role":"user","content":text}}).to_string()
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
}

fn is_uuid(s: &str) -> bool {
    s.len() == 36
        && s.char_indices().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => c == '-',
            _ => c.is_ascii_hexdigit(),
        })
}

fn is_safe_value(s: &str) -> bool {
    !s.is_empty() && !s.starts_with('-') && !s.contains('\0') && !s.contains('\n')
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
    if let Some(prompt) = spawn.append_system_prompt.filter(|p| !p.is_empty()) {
        // A value after its flag is never parsed as a flag by the CLI, but keep NULs out.
        if prompt.contains('\0') {
            return Err("system prompt contains NUL".into());
        }
        a.push("--append-system-prompt".into());
        a.push(prompt.into());
    }
    for (flag, rules) in [
        ("--allowedTools", &spawn.settings.allowed_tools),
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
            other => panic!("unknown fixture {other}"),
        }
    }

    fn run(name: &str) -> (Vec<AgentEvent>, Vec<String>) {
        let mut m = ClaudeStreamMapper::new();
        let mut events = Vec::new();
        let mut unsupported = Vec::new();
        for line in fixture(name).lines() {
            let out = m.map_line(line);
            events.extend(out.events);
            unsupported.extend(out.unsupported_control_request);
        }
        (events, unsupported)
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

    /// The golden files are what the TypeScript side reads (`tests/agent-events.test.ts`).
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
    fn cancel_after_answer_is_not_reported_twice() {
        let mut m = ClaudeStreamMapper::new();
        let req = r#"{"type":"control_request","request_id":"r1","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"ls"},"tool_use_id":"t1"}}"#;
        assert_eq!(m.map_line(req).events.len(), 1);
        assert!(m.permission_answered("r1"));
        let out = m.map_line(r#"{"type":"control_cancel_request","request_id":"r1"}"#);
        assert!(out.events.is_empty());
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
    fn encoders_produce_the_verified_shapes() {
        let v: Value = serde_json::from_str(&encode_user_message("hello")).unwrap();
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
        // none of the encoders emit a newline (one JSON object per line)
        assert!(!encode_user_message("a\nb").contains('\n'));
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
        })
        .unwrap();
        assert_eq!(&args[..3], ["-p", "--input-format", "stream-json"]);
        for flag in [
            "--include-partial-messages",
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
}
