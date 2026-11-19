//! The typed event contract of the agent pane, Rust side. The TypeScript types are
//! generated from it (`features/agent/web/bindings.ts`, re-exported by `features/agent/web/lib/events.ts`); spec: `SPECs/native-agent-spec.md`.
//!
//! JSON shape rules (pinned by the tests below and the golden files in
//! `shared/agent-golden/`): a kebab-case `type` discriminant, camelCase field names, enums as
//! kebab-case strings. Nothing here is claude-specific; `claude_stream.rs` maps the claude CLI
//! to these types.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

pub type ChatId = String;
pub type MessageId = String;
pub type ToolCallId = String;
pub type PermissionRequestId = String;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum TurnFinishReason {
    Completed,
    Interrupted,
    Error,
    MaxTurns,
    Budget,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum ToolOutcome {
    Ok,
    Error,
    Rejected,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum PermissionResolution {
    Allowed,
    Denied,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum UsageScope {
    Message,
    Turn,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum ThinkingPhase {
    Start,
    Delta,
    End,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum SessionEndReason {
    Exit,
    Killed,
    Closed,
    VaultSwitched,
}

/// The CLI's `--permission-mode` choices minus `bypassPermissions`, which Writer never offers.
/// (Wire names are the CLI's own camelCase, not kebab-case.)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
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

/// `agent.memory`: where the CLI keeps what it remembers across chats (ADR "Keep agent memory in
/// the vault ..."). `Vault` redirects it into the vault (`memory.rs`), `Default` leaves the CLI's
/// own home location (argv and env untouched), `Off` turns it off.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum AgentMemory {
    Vault,
    Default,
    Off,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum PermissionPersist {
    Session,
    Project,
    AcceptEdits,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum PermissionDecision {
    Allow,
    Deny,
}

/// Backend -> UI. One JSON object per event, `type` is the discriminant.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
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
        /// Skills the CLI loaded (project, user and plugin), by name.
        skills: Vec<String>,
        /// The MCP servers the CLI reports with their connection state (`init.mcp_servers`).
        mcp_servers: Vec<McpServerStatus>,
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
        #[specta(type = specta_typescript::Unknown)]
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
        #[specta(type = specta_typescript::Unknown)]
        input: Value,
        description: Option<String>,
        decision_reason: Option<String>,
        #[specta(type = Vec<specta_typescript::Unknown>)]
        suggestions: Vec<Value>,
        /// The sub-agent role asking (`worker`), set by the runner from the call's parent; absent:
        /// the main agent. The card says who asks.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        by: Option<String>,
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
        /// Turn scope: the model that did the work, the `modelUsage` key with the most output.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        model: Option<String>,
    },
    /// The CLI refused a model switch (`restricted_by_org`) and kept `using`. Writer drops the
    /// refused model for the chat instead of passing it again.
    ModelRefused {
        requested: Option<String>,
        using: Option<String>,
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
    /// Runner-originated, right after `turn-finished`: the vault files the agent changed during
    /// the turn (compact, no contents). Only sent when something changed. See `changes.rs`.
    TurnChanges(TurnChangesSummary),
    /// Runner-originated: every note this chat has changed so far (the row above the composer),
    /// sent when an edit's tool call ends and at the end of a turn (only when the list changed). Never
    /// stored in the transcript; the chat note keeps the list (paths and counts). See `changes.rs`.
    SessionChanges(SessionChangesSummary),
    SessionEnded {
        reason: SessionEndReason,
        exit_code: Option<i32>,
        signal: Option<String>,
    },
    /// Runner-originated: the process was replaced (the user's `agent_reload`, or Writer after a
    /// config change, `config_sync.rs`) so it re-reads skills, MCP servers, settings and
    /// instruction files. Never stored in the chat
    /// note; the UI shows a transient notice and forgets the old session lists.
    SessionReloaded {
        /// What made Writer restart the process ("skill writer-graph changed", "MCP server
        /// github connected"); `None` for the user's own "Reload session".
        reason: Option<String>,
    },
    /// Runner-originated: the CLI never acknowledged a steer within `Timing::steer_ack` (its
    /// `message_id` is the one `agent_steer` was given). The message was not delivered.
    SteerUndelivered { message_id: String },
    /// An API message made by a sub-agent, not by the main agent: its `text`, `thinking` and tool
    /// events (the message ids it names) belong to the sub-agent run started by the `Agent`/`Task`
    /// call `parent_tool_call_id`. Sent once, before the message's first block; never for the main
    /// agent's own messages. Tool calls carry their own `parent_tool_call_id`.
    SubagentMessage {
        message_id: MessageId,
        parent_tool_call_id: ToolCallId,
    },
    /// Runner-originated, when the `Agent`/`Task` call's input is complete: who the sub-agent is
    /// and the model it runs, resolved from the role's tier through the backend adapter's tier
    /// setting as it was when the process started (`subagents::resolve_launch`). The UI never
    /// recomputes either.
    SubagentStarted {
        tool_call_id: ToolCallId,
        /// The registry role id (`explorer`, `worker`); `None` for a sub-agent type Writer does
        /// not define (a user's own agent).
        role: Option<String>,
        /// The sub-agent type as the call named it (`writer-worker`).
        name: String,
        /// The model the sub-agent runs; a tier that inherits shows the chat's model.
        model: Option<String>,
    },
    /// A sub-agent run changed state. Decided in one place, `sub_tracker.rs`: `running` from the
    /// launch; a foreground run ends with its launch call's result; a background run (its launch
    /// result comes back at once and says nothing about the outcome) ends only with the CLI's
    /// `task_notification`. `report` is the sub-agent's own final report, when there is one (a
    /// final status can be repeated once to add it); the launch boilerplate is never a report.
    SubagentStatus {
        tool_call_id: ToolCallId,
        status: SubagentRunStatus,
        report: Option<String>,
    },
}

/// The state of a sub-agent run as the CLI reports it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum SubagentRunStatus {
    Running,
    Completed,
    Failed,
    /// Killed, cancelled or stopped.
    Stopped,
    /// Never reported its end and cannot any more (its process went away, or the chat was
    /// restored from its note): neither done nor failed.
    Interrupted,
}

impl SubagentRunStatus {
    /// A CLI status word (`completed`, `failed`, `killed`, ...) to a state; anything not final is
    /// `Running`.
    pub fn from_cli(word: &str) -> Self {
        match word {
            "completed" => Self::Completed,
            "failed" => Self::Failed,
            "killed" | "cancelled" | "stopped" => Self::Stopped,
            _ => Self::Running,
        }
    }

    pub fn is_final(self) -> bool {
        self != Self::Running
    }
}

/// One entry of `init.mcp_servers`: the server name and the CLI's own status word (`connected`,
/// `failed`, `pending`, `needs-auth`, ... passed through, never interpreted here).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct McpServerStatus {
    pub name: String,
    pub status: String,
}

/// What `agent_reload` did: `Started` (the process is being replaced, or there was none to
/// replace) or `Busy` (a turn or a permission card is open: nothing was touched).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum ReloadOutcome {
    Started,
    Busy,
}

// -------------------------------------------------------------------------------------------
// Turn changes (the "Changes" card; Tauri-free logic in `changes.rs`)

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum ChangeStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
}

/// How a changed file got on the card, i.e. how far its "before" can be trusted.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum ChangeOrigin {
    /// An `Edit`/`MultiEdit`/`Write`/`NotebookEdit` call: a trusted pre-image, a diff, Undo.
    #[default]
    Edit,
    /// Changed while a `Bash` call of the chat was running (seen by the file watcher): listed
    /// only, no diff, no Undo.
    Command,
    /// An edit call wrote the file, but the "before" could not be established (the tool ran
    /// before its pre-image was read and the edit cannot be undone exactly): no diff, no Undo.
    BeforeUnknown,
}

impl ChangeOrigin {
    pub fn is_edit(&self) -> bool {
        matches!(self, ChangeOrigin::Edit)
    }
}

/// One changed file, as sent in `turn-changes` and stored in the chat note (paths and counts only).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FileChangeSummary {
    /// Vault-relative, forward slashes. For a rename, the new path.
    pub path: String,
    pub status: ChangeStatus,
    pub added: u32,
    pub removed: u32,
    /// Renames only: where the file came from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    /// Not shown as a diff: binary, too large, or not safely readable. Counts are 0.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub no_diff: bool,
    /// Absent: a normal edit. `command` / `before-unknown` files have no diff and no Undo
    /// (`no_diff` is set with them).
    #[serde(default, skip_serializing_if = "ChangeOrigin::is_edit")]
    pub origin: ChangeOrigin,
    /// The sub-agent role that made the edit (`worker`; another sub-agent type as it is named),
    /// shown as a small label on the card. Absent: the main agent. The first edit of the file in
    /// the turn decides (the card's first-snapshot-wins rule).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub by: Option<String>,
    /// The `Agent`/`Task` call of that sub-agent run (the id of its card in the transcript), so the
    /// card can link to it. Absent with `by`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub by_call: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TurnChangesSummary {
    /// Opaque; unique per app run, so a stored summary never matches a later snapshot by accident.
    pub turn_id: String,
    pub files: Vec<FileChangeSummary>,
    /// A shell command ran in the turn: its side effects are not tracked.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub bash: bool,
}

/// The whole chat's changed notes against their first-touch versions, in first-touch order.
/// Paths and counts only; the entries are [`FileChangeSummary`] (`by` is the first author).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SessionChangesSummary {
    pub files: Vec<FileChangeSummary>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum DiffRowKind {
    Context,
    Add,
    Del,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DiffRow {
    pub kind: DiffRowKind,
    /// 1-based; None on an added row.
    pub old_line: Option<u32>,
    /// 1-based; None on a removed row.
    pub new_line: Option<u32>,
    pub text: String,
}

/// Whether "Undo" can run now.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum UndoState {
    Available,
    /// The file differs from how the turn left it: Undo would clobber newer edits.
    ChangedSince,
    /// No pre-turn copy (too large, binary, outside the vault, a link).
    Unavailable,
    Reverted,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    #[serde(flatten)]
    pub summary: FileChangeSummary,
    pub rows: Vec<DiffRow>,
    /// `rows` stops early (very large diff).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub truncated: bool,
    pub undo: UndoState,
}

/// One note of the session diff: its summary and the diff against the first-touch version.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SessionFileChange {
    #[serde(flatten)]
    pub summary: FileChangeSummary,
    pub rows: Vec<DiffRow>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub truncated: bool,
}

/// Reply of `agent_session_changes`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SessionChanges {
    pub files: Vec<SessionFileChange>,
}

/// Reply of `agent_turn_changes`: the summary plus every diff.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TurnChanges {
    pub turn_id: String,
    pub files: Vec<FileChange>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub bash: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum RevertResult {
    Reverted,
    ChangedSince,
    Unavailable,
    Failed,
}

/// Reply item of `agent_revert_changes`, one per requested path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RevertOutcome {
    pub path: String,
    pub result: RevertResult,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// Payload of the Tauri event `agent:event`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentEventEnvelope {
    pub chat_id: ChatId,
    pub seq: u64,
    pub event: AgentEvent,
}

pub const AGENT_EVENT_CHANNEL: &str = "agent:event";

// -------------------------------------------------------------------------------------------
// Context references

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
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
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
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
    /// An image attached to the message (vault-relative path): sent to the model as a native
    /// image block and listed in the references footer. Pasted images live in the chat's hidden
    /// `assets/` folder (`files.rs`), an image from the sidebar is referenced where it is.
    Image {
        path: String,
    },
    /// A PDF attached to the message (vault-relative path): sent to the model as a native
    /// `document` block and listed in the references footer, stored like an image.
    Document {
        path: String,
    },
}

// -------------------------------------------------------------------------------------------
// Commands (UI -> backend)

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
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
    /// `model` None is the CLI default. `effort` is a spawn flag, so a change restarts.
    SetModel {
        #[serde(default)]
        model: Option<String>,
        #[serde(default)]
        effort: Option<Effort>,
    },
    Close,
}

// -------------------------------------------------------------------------------------------
// Sessions, chats, projects

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentSettings {
    pub binary_path: Option<String>,
    pub model: Option<String>,
    pub effort: Option<Effort>,
    pub permission_mode: AgentPermissionMode,
    pub allowed_tools: Vec<String>,
    pub disallowed_tools: Vec<String>,
    /// `agent.orchestrate`: the Writer block's orchestration paragraph and `--agents`.
    pub orchestrate: bool,
    /// `agent.show-thinking`: spawn with `--thinking-display summarized` so the CLI sends the
    /// reasoning summary text (without it every thinking block is empty, spec A.3).
    pub show_thinking: bool,
    /// `agent.memory`.
    pub memory: AgentMemory,
    /// `agent.auto-reload`: restart the chat's process under the hood when a file it read at start
    /// changes (read live by the runner, applied even to a running chat).
    pub auto_reload: bool,
    /// The `agent.claude.model-<tier>` settings by tier id, as stored (the tiers are the ones of
    /// `shared/agent-roles.json`); Rust resolves them in `subagents::tier_model`.
    #[serde(default)]
    pub tier_models: BTreeMap<String, Option<String>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StartSessionRequest {
    pub chat_id: ChatId,
    pub project_path: Option<String>,
    pub resume_session_id: Option<String>,
    pub settings: AgentSettings,
    pub append_system_prompt: Option<String>,
}

/// Who chose a chat's title: nobody yet (the first message, cut), the automatic titler, or the
/// user (a rename always wins and is never overwritten).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum TitleSource {
    #[default]
    None,
    Auto,
    User,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
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
    #[serde(default)]
    pub title_source: TitleSource,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
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
                skills: vec!["s".into()],
                mcp_servers: vec![McpServerStatus {
                    name: "m".into(),
                    status: "connected".into(),
                }],
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
                by: None,
            },
            AgentEvent::Usage {
                scope: UsageScope::Turn,
                input_tokens: 1,
                output_tokens: 2,
                cache_read_tokens: 3,
                cache_creation_tokens: 4,
                cost_usd: Some(0.01),
                context_window: Some(1_000_000),
                model: Some("claude-sonnet-5-5".into()),
            },
            AgentEvent::ModelRefused {
                requested: Some("opus".into()),
                using: Some("claude-haiku-5-5".into()),
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
            AgentEvent::SubagentMessage {
                message_id: "m".into(),
                parent_tool_call_id: "a".into(),
            },
            AgentEvent::SubagentStarted {
                tool_call_id: "a".into(),
                role: Some("worker".into()),
                name: "writer-worker".into(),
                model: Some("sonnet".into()),
            },
            AgentEvent::SubagentStatus {
                tool_call_id: "a".into(),
                status: SubagentRunStatus::Stopped,
                report: None,
            },
            AgentEvent::SteerUndelivered {
                message_id: "m".into(),
            },
            AgentEvent::SessionReloaded { reason: None },
            AgentEvent::SessionReloaded {
                reason: Some("skill x changed".into()),
            },
            AgentEvent::SessionEnded {
                reason: SessionEndReason::VaultSwitched,
                exit_code: None,
                signal: Some("SIGTERM".into()),
            },
            AgentEvent::SessionChanges(SessionChangesSummary { files: vec![] }),
            AgentEvent::TurnChanges(TurnChangesSummary {
                turn_id: "t1".into(),
                files: vec![FileChangeSummary {
                    path: "a.md".into(),
                    status: ChangeStatus::Renamed,
                    added: 0,
                    removed: 0,
                    old_path: Some("b.md".into()),
                    no_diff: false,
                    origin: ChangeOrigin::Edit,
                    by: None,
                    by_call: None,
                }],
                bash: true,
            }),
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
    fn turn_changes_wire_shape() {
        let ev = AgentEvent::TurnChanges(TurnChangesSummary {
            turn_id: "t1".into(),
            files: vec![FileChangeSummary {
                path: "a.md".into(),
                status: ChangeStatus::Modified,
                added: 3,
                removed: 1,
                old_path: None,
                no_diff: false,
                origin: ChangeOrigin::Edit,
                by: Some("worker".into()),
                by_call: Some("toolu_1".into()),
            }],
            bash: false,
        });
        assert_eq!(
            round_trip(&ev),
            json!({"type":"turn-changes","turnId":"t1","files":[{"path":"a.md","status":"modified","added":3,"removed":1,"by":"worker","byCall":"toolu_1"}]})
        );
        // the sub-agent events' wire shape
        assert_eq!(
            round_trip(&AgentEvent::SubagentStarted {
                tool_call_id: "a".into(),
                role: Some("worker".into()),
                name: "writer-worker".into(),
                model: None,
            }),
            json!({"type":"subagent-started","toolCallId":"a","role":"worker","name":"writer-worker","model":null})
        );
        assert_eq!(
            round_trip(&AgentEvent::SubagentStatus {
                tool_call_id: "a".into(),
                status: SubagentRunStatus::Completed,
                report: Some("r".into()),
            }),
            json!({"type":"subagent-status","toolCallId":"a","status":"completed","report":"r"})
        );
        assert_eq!(
            round_trip(&AgentEvent::SubagentMessage {
                message_id: "m".into(),
                parent_tool_call_id: "a".into(),
            }),
            json!({"type":"subagent-message","messageId":"m","parentToolCallId":"a"})
        );
        let detail = TurnChanges {
            turn_id: "t1".into(),
            files: vec![FileChange {
                summary: FileChangeSummary {
                    path: "a.md".into(),
                    status: ChangeStatus::Added,
                    added: 1,
                    removed: 0,
                    old_path: None,
                    no_diff: false,
                    origin: ChangeOrigin::Edit,
                    by: None,
                    by_call: None,
                },
                rows: vec![DiffRow {
                    kind: DiffRowKind::Add,
                    old_line: None,
                    new_line: Some(1),
                    text: "x".into(),
                }],
                truncated: false,
                undo: UndoState::ChangedSince,
            }],
            bash: true,
        };
        let v = round_trip(&detail);
        assert_eq!(
            v["files"][0]["path"], "a.md",
            "summary fields are flattened"
        );
        assert_eq!(v["files"][0]["undo"], "changed-since");
        assert_eq!(v["files"][0]["rows"][0]["newLine"], 1);
        round_trip(&RevertOutcome {
            path: "a.md".into(),
            result: RevertResult::ChangedSince,
            message: Some("file changed since".into()),
        });
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
        let m = round_trip(&AgentCommand::SetModel {
            model: Some("opus".into()),
            effort: None,
        });
        assert_eq!(m["model"], "opus");
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
                orchestrate: true,
                show_thinking: true,
                auto_reload: true,
                memory: AgentMemory::Vault,
                tier_models: BTreeMap::from([("cheap".to_string(), Some("haiku".to_string()))]),
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
            title_source: TitleSource::Auto,
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
