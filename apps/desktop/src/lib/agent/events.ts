/**
 * The typed event contract shared by the agent backend (Rust, `src-tauri/src/agent/events.rs`)
 * and the agent pane (React). Spec: `SPECs/native-agent-spec.md`.
 *
 * Rules that keep the two sides equal (a Rust test pins the JSON, `tests/agent-events.test.ts`
 * reads the same golden files):
 *
 *   - every event/command is an object with a kebab-case `type` discriminant;
 *   - field names are camelCase on the wire (Rust: `rename_all_fields = "camelCase"`);
 *   - nothing here is claude-specific: `claude_stream.rs` maps the claude CLI's stream-json to
 *     these events, so another backend (Codex or OpenCode over ACP) is a second mapper, not a
 *     UI change;
 *   - an event never carries note contents the user did not send (tool output is capped).
 *
 * Tauri transport: the backend emits `agent://event` with an {@link AgentEventEnvelope}; the UI
 * calls the commands listed in {@link AGENT_COMMANDS}.
 */

// ---------------------------------------------------------------------------------------------
// Identifiers and enums

/** A Writer chat. A uuid v4; for the claude backend it is also the CLI session id (the CLI
 *  honours `--session-id`), kept as a separate frontmatter field anyway. */
export type ChatId = string;
export type MessageId = string;
export type ToolCallId = string;
export type PermissionRequestId = string;

export type AgentBackendId = "claude";

/** Mirrors the claude CLI's `--permission-mode` choices minus `bypassPermissions`, which Writer
 *  never offers. `manual` is the CLI's "default": ask for everything not already allowed. */
export type AgentPermissionMode = "manual" | "acceptEdits" | "plan" | "auto" | "dontAsk";

/** `completed`: the model ended its turn. `interrupted`: the user cancelled (control request
 *  `interrupt`). `error`: API or process error (an `error` event precedes or follows).
 *  `max-turns` / `budget`: a limit passed to the CLI was reached. */
export type TurnFinishReason = "completed" | "interrupted" | "error" | "max-turns" | "budget";

export type ToolOutcome = "ok" | "error" | "rejected";

export type PermissionResolution = "allowed" | "denied" | "cancelled";

export type UsageScope = "message" | "turn";

export type ThinkingPhase = "start" | "delta" | "end";

export type AgentErrorKind =
  | "binary-not-found"
  | "spawn-denied"
  | "spawn-failed"
  | "auth"
  | "rate-limit"
  | "api"
  | "protocol"
  | "process-exited"
  | "timeout"
  | "unknown";

export type SessionEndReason = "exit" | "killed" | "closed" | "vault-switched";

/** What "Always allow" persists. `session`: this chat's CLI process only. `project`: the CLI
 *  writes the rule to `<cwd>/.claude/settings.local.json`. `accept-edits`: switch the session to
 *  acceptEdits (the CLI's own `setMode` suggestion). */
export type PermissionPersist = "session" | "project" | "accept-edits";

// ---------------------------------------------------------------------------------------------
// Events (backend -> UI)

/** An opaque permission suggestion exactly as the CLI sent it (`addRules`, `setMode`, ...).
 *  The UI only inspects it to label the "Always allow" choice; the backend rebuilds the
 *  response from its own copy, so the UI never echoes it. */
export type PermissionSuggestion = {
  type: string;
  rules?: { toolName: string; ruleContent?: string }[];
  behavior?: "allow" | "deny" | "ask";
  mode?: string;
  destination?: string;
  [key: string]: unknown;
};

export type AgentEvent =
  | {
      type: "session-started";
      sessionId: string;
      model: string | null;
      cwd: string;
      permissionMode: string | null;
      tools: string[];
      slashCommands: string[];
      cliVersion: string | null;
    }
  /** A streamed chunk of assistant text. Append to the block `(messageId, blockIndex)`. */
  | { type: "text-delta"; messageId: MessageId; blockIndex: number; text: string }
  /** The final text of a block; REPLACES whatever deltas accumulated. */
  | { type: "text"; messageId: MessageId; blockIndex: number; text: string }
  /** Thinking. `start` has empty text, `delta` the new chunk (current CLIs send none: the
   *  thinking text is not exposed, only a token estimate), `end` the full text (may be empty).
   *  The UI times "Thought for Ns" from start to end. */
  | {
      type: "thinking";
      messageId: MessageId;
      blockIndex: number;
      phase: ThinkingPhase;
      text: string;
      estimatedTokens: number | null;
    }
  | {
      type: "tool-call-started";
      toolCallId: ToolCallId;
      messageId: MessageId;
      tool: string;
      /** The tool call of the subagent that issued this one, if any. */
      parentToolCallId: ToolCallId | null;
    }
  /** A fragment of the tool input JSON text; concatenate per toolCallId. Display only. */
  | { type: "tool-call-input-delta"; toolCallId: ToolCallId; partialJson: string }
  /** The complete, parsed input (authoritative; replaces the deltas). */
  | { type: "tool-call-input"; toolCallId: ToolCallId; input: unknown }
  | {
      type: "tool-call-finished";
      toolCallId: ToolCallId;
      /** Flattened text of the result; capped, see `truncated`. */
      output: string;
      isError: boolean;
      outcome: ToolOutcome;
      truncated: boolean;
    }
  | {
      type: "permission-request";
      requestId: PermissionRequestId;
      toolCallId: ToolCallId | null;
      tool: string;
      displayName: string | null;
      input: unknown;
      description: string | null;
      decisionReason: string | null;
      suggestions: PermissionSuggestion[];
    }
  /** Resolved by the user (`allowed`/`denied`, emitted by the runner when it writes the
   *  response) or by the CLI (`cancelled`: control_cancel_request, e.g. after an interrupt). */
  | {
      type: "permission-resolved";
      requestId: PermissionRequestId;
      resolution: PermissionResolution;
    }
  | {
      type: "usage";
      scope: UsageScope;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
      costUsd: number | null;
      contextWindow: number | null;
    }
  | { type: "rate-limit"; status: string; resetsAt: number | null }
  | {
      type: "turn-finished";
      reason: TurnFinishReason;
      durationMs: number;
      apiDurationMs: number | null;
      numTurns: number | null;
      isError: boolean;
      /** The CLI's final result text (equals the last assistant text on success). */
      result: string | null;
      sessionId: string | null;
      errors: string[];
    }
  | { type: "error"; kind: AgentErrorKind; message: string; retryable: boolean }
  | {
      type: "session-ended";
      reason: SessionEndReason;
      exitCode: number | null;
      signal: string | null;
    };

export type AgentEventType = AgentEvent["type"];

export const AGENT_EVENT_TYPES = [
  "session-started",
  "text-delta",
  "text",
  "thinking",
  "tool-call-started",
  "tool-call-input-delta",
  "tool-call-input",
  "tool-call-finished",
  "permission-request",
  "permission-resolved",
  "usage",
  "rate-limit",
  "turn-finished",
  "error",
  "session-ended",
] as const satisfies readonly AgentEventType[];

// `satisfies` only checks one direction; this makes the list exhaustive.
type _MissingEventTypes = Exclude<AgentEventType, (typeof AGENT_EVENT_TYPES)[number]>;
const _exhaustive: [_MissingEventTypes] extends [never] ? true : never = true;
void _exhaustive;

export function isAgentEvent(value: unknown): value is AgentEvent {
  if (typeof value !== "object" || value === null) return false;
  const t = (value as { type?: unknown }).type;
  return typeof t === "string" && (AGENT_EVENT_TYPES as readonly string[]).includes(t);
}

/** Payload of the Tauri event `agent://event`. `seq` is per chat, starts at 1 and increases by
 *  1; a gap means the UI missed events and must call `agent_snapshot` to resynchronise. */
export type AgentEventEnvelope = { chatId: ChatId; seq: number; event: AgentEvent };

// ---------------------------------------------------------------------------------------------
// Context references (what the user attaches; resolved by the backend, never trusted as paths
// outside the vault)

export type ContextRef =
  /** The note open in the editor (sent as a path, not a body, unless `inline`). */
  | { kind: "active-note"; path: string; inline: boolean }
  | { kind: "selection"; path: string; text: string; fromLine: number; toLine: number }
  | { kind: "note"; path: string }
  | { kind: "folder"; path: string }
  | { kind: "tag"; tag: string }
  | { kind: "property"; name: string; value: string | null }
  /** Instructions and sources of the chat's project, attached by the system, shown in the
   *  ledger but not removable per message. */
  | { kind: "project-instructions"; path: string }
  | { kind: "project-source"; source: ProjectSource };

/** One row of the context ledger. `tokens` is an estimate (chars / 4), never exact. */
export type LedgerItem = {
  id: string;
  ref: ContextRef;
  label: string;
  origin: "active-note" | "mention" | "selection" | "project" | "vault-instructions";
  mode: "path" | "inline" | "manifest";
  estimatedTokens: number;
  lifetime: "message" | "chat" | "project";
  enabled: boolean;
};

// ---------------------------------------------------------------------------------------------
// Commands (UI -> backend). Each maps to one Tauri command, see `AGENT_COMMANDS`.

export type AgentCommand =
  | {
      type: "send-message";
      messageId: MessageId;
      text: string;
      context: ContextRef[];
    }
  | { type: "cancel" }
  | {
      type: "permission-decision";
      requestId: PermissionRequestId;
      decision: "allow" | "deny";
      persist?: PermissionPersist;
      /** Shown to the model on deny. */
      message?: string;
    }
  | { type: "resume"; sessionId: string }
  | { type: "set-permission-mode"; mode: AgentPermissionMode }
  | { type: "close" };

export type AgentCommandType = AgentCommand["type"];

// ---------------------------------------------------------------------------------------------
// Sessions, chats, projects

export type AgentSessionState =
  | "idle"
  | "starting"
  | "running"
  | "awaiting-permission"
  | "cancelling"
  | "reconnecting"
  | "error"
  | "ended";

export type AgentSettings = {
  binaryPath: string | null;
  model: string | null;
  effort: "low" | "medium" | "high" | "xhigh" | "max" | null;
  permissionMode: AgentPermissionMode;
  /** Extra `--allowedTools` entries (Claude permission rule syntax). */
  allowedTools: string[];
  disallowedTools: string[];
};

export type StartSessionRequest = {
  chatId: ChatId;
  /** Vault-relative project folder, or null for the vault root. */
  projectPath: string | null;
  resumeSessionId: string | null;
  settings: AgentSettings;
  /** The project's `AGENTS.md` text is injected through this; see the spec ("Instruction layers"). */
  appendSystemPrompt: string | null;
};

export type ChatSummary = {
  chatId: ChatId;
  /** Vault-relative path of the chat note. */
  path: string;
  title: string;
  projectPath: string | null;
  sessionId: string | null;
  createdAt: number;
  updatedAt: number;
  turnCount: number;
  archived: boolean;
  pinned: boolean;
  /** First user message, one line (history list and search). */
  preview?: string;
};

/** A context source declared in `project.md`. `raw` is the original text of the entry. */
export type ProjectSource =
  | { kind: "folder"; path: string; raw: string }
  | { kind: "note"; path: string; raw: string }
  | { kind: "tag"; tag: string; raw: string }
  | { kind: "property"; name: string; value: string | null; raw: string }
  | { kind: "url"; url: string; raw: string };

export type ProjectInfo = {
  /** Vault-relative folder path. */
  path: string;
  /** `copilot-project-id`, or generated on first write. */
  id: string;
  name: string;
  description: string;
  createdAt: number | null;
  lastUsedAt: number | null;
  archivedAt: number | null;
  inclusions: ProjectSource[];
  exclusions: ProjectSource[];
  hasAgentsMd: boolean;
  hasClaudeMd: boolean;
};

export type NewProjectRequest = {
  /** Folder name; created under `parent` (default: `Projects`). */
  name: string;
  parent: string | null;
  description: string;
  inclusions: string[];
  /** Seeds `AGENTS.md`. Empty means the short template. */
  instructions: string;
};

// ---------------------------------------------------------------------------------------------
// Tauri surface (documented here, implemented by the backend lanes)

export const AGENT_EVENT_CHANNEL = "agent://event";

/** command name -> [args, result]. All commands are `async` and run IO through
 *  `commands::blocking`. Errors are `AppError` (see `error.rs`). */
export type AgentCommandMap = {
  agent_detect_binary: [{ override?: string | null }, AgentBinaryInfo];
  agent_start: [StartSessionRequest, { chatId: ChatId; sessionId: string }];
  agent_send: [{ chatId: ChatId; messageId: MessageId; text: string; context: ContextRef[] }, void];
  agent_cancel: [{ chatId: ChatId }, void];
  agent_permission: [
    {
      chatId: ChatId;
      requestId: PermissionRequestId;
      decision: "allow" | "deny";
      persist?: PermissionPersist;
      message?: string;
    },
    void,
  ];
  agent_set_permission_mode: [{ chatId: ChatId; mode: AgentPermissionMode }, void];
  agent_close: [{ chatId: ChatId }, void];
  /** Events with seq > afterSeq still buffered (bounded ring), plus the current state. */
  agent_snapshot: [
    { chatId: ChatId; afterSeq: number },
    { state: AgentSessionState; events: AgentEventEnvelope[] },
  ];
  /** `all: true` lists every project's chats (the history view groups them); `query` filters by
   *  title and first user message. */
  agent_list_chats: [
    { projectPath: string | null; includeArchived?: boolean; all?: boolean; query?: string },
    ChatSummary[],
  ];
  agent_load_chat: [{ chatId: ChatId }, { summary: ChatSummary; markdown: string }];
  agent_save_chat: [{ chatId: ChatId; markdown: string; titleHint?: string }, ChatSummary];
  agent_chat_action: [
    {
      chatId: ChatId;
      action: "rename" | "pin" | "unpin" | "archive" | "unarchive" | "delete";
      title?: string;
    },
    ChatSummary | null,
  ];
  agent_list_projects: [{ includeArchived?: boolean }, ProjectInfo[]];
  agent_read_project: [{ path: string }, ProjectInfo];
  agent_create_project: [NewProjectRequest, ProjectInfo];
  agent_make_project: [{ path: string; createAgentsMd: boolean }, ProjectInfo];
  agent_context_preview: [
    { projectPath: string | null; context: ContextRef[]; text: string },
    { items: LedgerItem[]; totalEstimatedTokens: number; manifest: string },
  ];
  agent_permission_rules: [{ projectPath: string | null }, { allow: string[]; deny: string[] }];
  agent_remove_permission_rule: [{ projectPath: string | null; rule: string }, void];
};

export type AgentBinaryInfo = {
  found: boolean;
  path: string | null;
  version: string | null;
  /** Where it was found: `override`, `path`, `login-path`, `known-dir`. */
  source: "override" | "path" | "login-path" | "known-dir" | null;
};

export const AGENT_COMMANDS = [
  "agent_detect_binary",
  "agent_start",
  "agent_send",
  "agent_cancel",
  "agent_permission",
  "agent_set_permission_mode",
  "agent_close",
  "agent_snapshot",
  "agent_list_chats",
  "agent_load_chat",
  "agent_save_chat",
  "agent_chat_action",
  "agent_list_projects",
  "agent_read_project",
  "agent_create_project",
  "agent_make_project",
  "agent_context_preview",
  "agent_permission_rules",
  "agent_remove_permission_rule",
] as const satisfies readonly (keyof AgentCommandMap)[];
