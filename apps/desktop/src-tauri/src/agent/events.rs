//! The typed event contract of the agent pane, Rust side. The TypeScript mirror is
//! `src/lib/agent/events.ts`; spec: `SPECs/native-agent-spec.md`.
//!
//! JSON shape rules (pinned by the tests below and the golden files in
//! `shared/agent-golden/`): a kebab-case `type` discriminant, camelCase field names, enums as
//! kebab-case strings. Nothing here is claude-specific; `claude_stream.rs` maps the claude CLI
//! to these types.

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub type ChatId = String;
pub type MessageId = String;
pub type ToolCallId = String;
pub type PermissionRequestId = String;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TurnFinishReason {
    Completed,
    Interrupted,
    Error,
    MaxTurns,
    Budget,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ToolOutcome {
    Ok,
    Error,
    Rejected,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PermissionResolution {
    Allowed,
    Denied,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum UsageScope {
    Message,
    Turn,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ThinkingPhase {
    Start,
    Delta,
    End,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentErrorKind {
    BinaryNotFound,
    SpawnDenied,
    SpawnFailed,
    Auth,
    RateLimit,
    Api,
    Protocol,
    ProcessExited,
    Timeout,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SessionEndReason {
    Exit,
    Killed,
    Closed,
    VaultSwitched,
}

/// The CLI's `--permission-mode` choices minus `bypassPermissions`, which Writer never offers.
/// (Wire names are the CLI's own camelCase, not kebab-case.)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AgentPermissionMode {
    #[serde(rename = "manual")]
    Manual,
    #[serde(rename = "acceptEdits")]
    AcceptEdits,
    #[serde(rename = "plan")]
    Plan,
    #[serde(rename = "auto")]
    Auto,
    #[serde(rename = "dontAsk")]
    DontAsk,
}

impl AgentPermissionMode {
    pub fn as_cli_arg(self) -> &'static str {
        match self {
            Self::Manual => "manual",
            Self::AcceptEdits => "acceptEdits",
            Self::Plan => "plan",
            Self::Auto => "auto",
            Self::DontAsk => "dontAsk",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PermissionPersist {
    Session,
    Project,
    AcceptEdits,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PermissionDecision {
    Allow,
    Deny,
}

/// Backend -> UI. One JSON object per event, `type` is the discriminant.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum AgentEvent {
    SessionStarted {
        session_id: String,
        model: Option<String>,
        cwd: String,
        permission_mode: Option<String>,
        tools: Vec<String>,
        slash_commands: Vec<String>,
        cli_version: Option<String>,
    },
    TextDelta {
        message_id: MessageId,
        block_index: u32,
        text: String,
    },
    Text {
        message_id: MessageId,
        block_index: u32,
        text: String,
    },
    Thinking {
        message_id: MessageId,
        block_index: u32,
        phase: ThinkingPhase,
        text: String,
        estimated_tokens: Option<u64>,
    },
    ToolCallStarted {
        tool_call_id: ToolCallId,
        message_id: MessageId,
        tool: String,
        parent_tool_call_id: Option<ToolCallId>,
    },
    ToolCallInputDelta {
        tool_call_id: ToolCallId,
        partial_json: String,
    },
    ToolCallInput {
        tool_call_id: ToolCallId,
        input: Value,
    },
    ToolCallFinished {
        tool_call_id: ToolCallId,
        output: String,
        is_error: bool,
        outcome: ToolOutcome,
        truncated: bool,
    },
    PermissionRequest {
        request_id: PermissionRequestId,
        tool_call_id: Option<ToolCallId>,
        tool: String,
        display_name: Option<String>,
        input: Value,
        description: Option<String>,
        decision_reason: Option<String>,
        suggestions: Vec<Value>,
    },
    PermissionResolved {
        request_id: PermissionRequestId,
        resolution: PermissionResolution,
    },
    Usage {
        scope: UsageScope,
        input_tokens: u64,
        output_tokens: u64,
        cache_read_tokens: u64,
        cache_creation_tokens: u64,
        cost_usd: Option<f64>,
        context_window: Option<u64>,
    },
    RateLimit {
        status: String,
        resets_at: Option<i64>,
    },
    TurnFinished {
        reason: TurnFinishReason,
        duration_ms: u64,
        api_duration_ms: Option<u64>,
        num_turns: Option<u32>,
        is_error: bool,
        result: Option<String>,
        session_id: Option<String>,
        errors: Vec<String>,
    },
    Error {
        kind: AgentErrorKind,
        message: String,
        retryable: bool,
    },
    SessionEnded {
        reason: SessionEndReason,
        exit_code: Option<i32>,
        signal: Option<String>,
    },
}

/// Payload of the Tauri event `agent://event`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEventEnvelope {
    pub chat_id: ChatId,
    pub seq: u64,
    pub event: AgentEvent,
}

pub const AGENT_EVENT_CHANNEL: &str = "agent://event";

// -------------------------------------------------------------------------------------------
// Context references

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum ProjectSource {
    Folder {
        path: String,
        raw: String,
    },
    Note {
        path: String,
        raw: String,
    },
    Tag {
        tag: String,
        raw: String,
    },
    Property {
        name: String,
        value: Option<String>,
        raw: String,
    },
    Url {
        url: String,
        raw: String,
    },
}

/// Data types (`ContextRef`, `ProjectSource`) use `kind` as their discriminant; events and
/// commands use `type`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum ContextRef {
    ActiveNote {
        path: String,
        inline: bool,
    },
    Selection {
        path: String,
        text: String,
        from_line: u32,
        to_line: u32,
    },
    Note {
        path: String,
    },
    Folder {
        path: String,
    },
    Tag {
        tag: String,
    },
    Property {
        name: String,
        value: Option<String>,
    },
    ProjectInstructions {
        path: String,
    },
    ProjectSource {
        source: ProjectSource,
    },
}

// -------------------------------------------------------------------------------------------
// Commands (UI -> backend)

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum AgentCommand {
    SendMessage {
        message_id: MessageId,
        text: String,
        context: Vec<ContextRef>,
    },
    Cancel,
    PermissionDecision {
        request_id: PermissionRequestId,
        decision: PermissionDecision,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        persist: Option<PermissionPersist>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    Resume {
        session_id: String,
    },
    SetPermissionMode {
        mode: AgentPermissionMode,
    },
    Close,
}

// -------------------------------------------------------------------------------------------
// Sessions, chats, projects

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentSessionState {
    Idle,
    Starting,
    Running,
    AwaitingPermission,
    Cancelling,
    Reconnecting,
    Error,
    Ended,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Effort {
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

impl Effort {
    pub fn as_cli_arg(self) -> &'static str {
        match self {
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::Xhigh => "xhigh",
            Self::Max => "max",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSettings {
    pub binary_path: Option<String>,
    pub model: Option<String>,
    pub effort: Option<Effort>,
    pub permission_mode: AgentPermissionMode,
    pub allowed_tools: Vec<String>,
    pub disallowed_tools: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartSessionRequest {
    pub chat_id: ChatId,
    pub project_path: Option<String>,
    pub resume_session_id: Option<String>,
    pub settings: AgentSettings,
    pub append_system_prompt: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSummary {
    pub chat_id: ChatId,
    pub path: String,
    pub title: String,
    pub project_path: Option<String>,
    pub session_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub turn_count: u32,
    pub archived: bool,
    pub pinned: bool,
    /// First user message, one line, for the history list and its search.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    pub path: String,
    pub id: String,
    pub name: String,
    pub description: String,
    pub created_at: Option<i64>,
    pub last_used_at: Option<i64>,
    pub archived_at: Option<i64>,
    pub inclusions: Vec<ProjectSource>,
    pub exclusions: Vec<ProjectSource>,
    pub has_agents_md: bool,
    pub has_claude_md: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewProjectRequest {
    pub name: String,
    pub parent: Option<String>,
    pub description: String,
    pub inclusions: Vec<String>,
    pub instructions: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn round_trip<T>(value: &T) -> Value
    where
        T: Serialize + for<'de> Deserialize<'de> + PartialEq + std::fmt::Debug,
    {
        let json = serde_json::to_value(value).unwrap();
        let back: T = serde_json::from_value(json.clone()).unwrap();
        assert_eq!(&back, value);
        json
    }

    #[test]
    fn events_use_kebab_type_and_camel_fields() {
        let ev = AgentEvent::ToolCallStarted {
            tool_call_id: "t1".into(),
            message_id: "m1".into(),
            tool: "Bash".into(),
            parent_tool_call_id: None,
        };
        assert_eq!(
            round_trip(&ev),
            json!({"type":"tool-call-started","toolCallId":"t1","messageId":"m1","tool":"Bash","parentToolCallId":null})
        );
        let ev = AgentEvent::PermissionResolved {
            request_id: "r".into(),
            resolution: PermissionResolution::Cancelled,
        };
        assert_eq!(
            round_trip(&ev),
            json!({"type":"permission-resolved","requestId":"r","resolution":"cancelled"})
        );
    }

    #[test]
    fn every_event_variant_round_trips() {
        let events = vec![
            AgentEvent::SessionStarted {
                session_id: "s".into(),
                model: Some("m".into()),
                cwd: "/v".into(),
                permission_mode: Some("default".into()),
                tools: vec!["Bash".into()],
                slash_commands: vec![],
                cli_version: Some("2.1.325".into()),
            },
            AgentEvent::TextDelta {
                message_id: "m".into(),
                block_index: 0,
                text: "a".into(),
            },
            AgentEvent::Text {
                message_id: "m".into(),
                block_index: 0,
                text: "ab".into(),
            },
            AgentEvent::Thinking {
                message_id: "m".into(),
                block_index: 0,
                phase: ThinkingPhase::Start,
                text: String::new(),
                estimated_tokens: Some(50),
            },
            AgentEvent::ToolCallInputDelta {
                tool_call_id: "t".into(),
                partial_json: "{\"c".into(),
            },
            AgentEvent::ToolCallInput {
                tool_call_id: "t".into(),
                input: json!({"command":"ls"}),
            },
            AgentEvent::ToolCallFinished {
                tool_call_id: "t".into(),
                output: "x".into(),
                is_error: false,
                outcome: ToolOutcome::Ok,
                truncated: false,
            },
            AgentEvent::PermissionRequest {
                request_id: "r".into(),
                tool_call_id: Some("t".into()),
                tool: "Bash".into(),
                display_name: None,
                input: json!({"command":"ls"}),
                description: None,
                decision_reason: Some("This command requires approval".into()),
                suggestions: vec![
                    json!({"type":"setMode","mode":"acceptEdits","destination":"session"}),
                ],
            },
            AgentEvent::Usage {
                scope: UsageScope::Turn,
                input_tokens: 1,
                output_tokens: 2,
                cache_read_tokens: 3,
                cache_creation_tokens: 4,
                cost_usd: Some(0.01),
                context_window: Some(1_000_000),
            },
            AgentEvent::RateLimit {
                status: "allowed".into(),
                resets_at: Some(1),
            },
            AgentEvent::TurnFinished {
                reason: TurnFinishReason::MaxTurns,
                duration_ms: 5,
                api_duration_ms: None,
                num_turns: Some(1),
                is_error: true,
                result: None,
                session_id: None,
                errors: vec!["e".into()],
            },
            AgentEvent::Error {
                kind: AgentErrorKind::BinaryNotFound,
                message: "no claude".into(),
                retryable: false,
            },
            AgentEvent::SessionEnded {
                reason: SessionEndReason::VaultSwitched,
                exit_code: None,
                signal: Some("SIGTERM".into()),
            },
        ];
        for ev in &events {
            let json = round_trip(ev);
            let t = json["type"].as_str().unwrap();
            assert_eq!(t, t.to_lowercase());
            let obj = json.as_object().unwrap();
            assert!(
                obj.keys().all(|k| !k.contains('_')),
                "snake_case key in {json}"
            );
        }
    }

    #[test]
    fn commands_round_trip_and_skip_absent_options() {
        let c = AgentCommand::PermissionDecision {
            request_id: "r".into(),
            decision: PermissionDecision::Allow,
            persist: Some(PermissionPersist::AcceptEdits),
            message: None,
        };
        assert_eq!(
            round_trip(&c),
            json!({"type":"permission-decision","requestId":"r","decision":"allow","persist":"accept-edits"})
        );
        let from_ui: AgentCommand = serde_json::from_value(
            json!({"type":"permission-decision","requestId":"r","decision":"deny"}),
        )
        .unwrap();
        assert_eq!(
            from_ui,
            AgentCommand::PermissionDecision {
                request_id: "r".into(),
                decision: PermissionDecision::Deny,
                persist: None,
                message: None
            }
        );
        let send = AgentCommand::SendMessage {
            message_id: "m".into(),
            text: "hi".into(),
            context: vec![
                ContextRef::ActiveNote {
                    path: "a.md".into(),
                    inline: false,
                },
                ContextRef::Selection {
                    path: "a.md".into(),
                    text: "t".into(),
                    from_line: 1,
                    to_line: 2,
                },
                ContextRef::Tag {
                    tag: "client".into(),
                },
                ContextRef::Property {
                    name: "status".into(),
                    value: None,
                },
                ContextRef::ProjectSource {
                    source: ProjectSource::Folder {
                        path: "Notes".into(),
                        raw: "Notes".into(),
                    },
                },
            ],
        };
        let v = round_trip(&send);
        assert_eq!(
            v["context"][0],
            json!({"kind":"active-note","path":"a.md","inline":false})
        );
        assert_eq!(v["context"][4]["source"]["kind"], "folder");
        round_trip(&AgentCommand::Cancel);
        round_trip(&AgentCommand::Close);
        round_trip(&AgentCommand::Resume {
            session_id: "s".into(),
        });
        let m = round_trip(&AgentCommand::SetPermissionMode {
            mode: AgentPermissionMode::AcceptEdits,
        });
        assert_eq!(m["mode"], "acceptEdits");
    }

    #[test]
    fn envelope_session_and_project_types_round_trip() {
        let env = AgentEventEnvelope {
            chat_id: "c".into(),
            seq: 3,
            event: AgentEvent::Text {
                message_id: "m".into(),
                block_index: 1,
                text: "x".into(),
            },
        };
        assert_eq!(
            round_trip(&env),
            json!({"chatId":"c","seq":3,"event":{"type":"text","messageId":"m","blockIndex":1,"text":"x"}})
        );
        round_trip(&StartSessionRequest {
            chat_id: "c".into(),
            project_path: Some("Projects/Demo".into()),
            resume_session_id: None,
            settings: AgentSettings {
                binary_path: None,
                model: None,
                effort: Some(Effort::High),
                permission_mode: AgentPermissionMode::Manual,
                allowed_tools: vec!["Read".into()],
                disallowed_tools: vec![],
            },
            append_system_prompt: None,
        });
        round_trip(&ChatSummary {
            chat_id: "c".into(),
            path: "Projects/Demo/.chats/x.md".into(),
            title: "t".into(),
            project_path: Some("Projects/Demo".into()),
            session_id: Some("s".into()),
            created_at: 1,
            updated_at: 2,
            turn_count: 3,
            archived: false,
            pinned: true,
            preview: Some("hi".into()),
        });
        round_trip(&ProjectInfo {
            path: "Projects/Demo".into(),
            id: "p".into(),
            name: "Demo".into(),
            description: String::new(),
            created_at: Some(1),
            last_used_at: None,
            archived_at: None,
            inclusions: vec![ProjectSource::Tag {
                tag: "x".into(),
                raw: "#x".into(),
            }],
            exclusions: vec![],
            has_agents_md: true,
            has_claude_md: false,
        });
        round_trip(&NewProjectRequest {
            name: "Demo".into(),
            parent: None,
            description: String::new(),
            inclusions: vec!["Notes".into()],
            instructions: String::new(),
        });
        round_trip(&AgentSessionState::AwaitingPermission);
    }
}
