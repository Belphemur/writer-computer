/**
 * The agent pane's view of the backend's wire types. The wire shapes (events, commands' results,
 * chats, projects, changes) are generated from the Rust side by tauri-specta
 * (`features/agent/web/bindings.ts`, `WRITER_UPDATE_BINDINGS=1 cargo test bindings`) and reach the
 * UI through the one wrapper module `features/agent/web/ipc.ts`; this file re-exports them under the
 * names the pane uses and adds what is UI-only. Nothing here is hand-copied from Rust, so a wire
 * change is a compile error here instead of a silent drift. Spec: `SPECs/native-agent-spec.md`.
 *
 * Rules that keep the two sides equal (a Rust test pins the JSON, `features/agent/tests/agent-events.test.ts`
 * reads the same golden files):
 *
 *   - every event is an object with a kebab-case `type` discriminant;
 *   - field names are camelCase on the wire (Rust: `rename_all_fields = "camelCase"`);
 *   - nothing here is claude-specific: `claude_stream.rs` maps the claude CLI's stream-json to
 *     these events, so another backend (Codex or OpenCode over ACP) is a second mapper, not a
 *     UI change;
 *   - an event never carries note contents the user did not send (tool output is capped).
 *
 * Tauri transport: the backend emits `agent:event` with an {@link AgentEventEnvelope}; the UI
 * calls the commands of `features/agent/web/ipc.ts`.
 */
import type { AgentEvent, ContextRef as WireContextRef } from "@features/agent/web/ipc";

export type {
  AgentBinaryInfo,
  AgentErrorKind,
  AgentEvent,
  AgentEventEnvelope,
  AgentMemory,
  AgentPermissionMode,
  AgentSessionState,
  AgentSettings,
  ChangeOrigin,
  ChangeStatus,
  ChatSummary,
  DiffRow,
  DiskSkill,
  FileChange,
  FileChangeSummary,
  McpServerStatus,
  PermissionPersist,
  PermissionResolution,
  ProjectInfo,
  ProjectSource,
  Question,
  QuestionAnswer,
  QuestionOption,
  QuestionResolution,
  RegenerateOutcome,
  RegenerateRefusal,
  ReloadOutcome,
  ReplaySeed,
  RevertOutcome,
  SessionChanges,
  SessionChangesSummary,
  SessionEndReason,
  SessionFileChange,
  SubagentRunStatus,
  ThinkingPhase,
  TitleSource,
  ToolOutcome,
  TurnChanges,
  TurnChangesSummary,
  TurnFinishReason,
  UndoState,
  UsageScope,
} from "@features/agent/web/ipc";

// ---------------------------------------------------------------------------------------------
// Identifiers (all plain strings on the wire; the names say which one)

/** A Writer chat. A uuid v4; for the claude backend it is also the CLI session id (the CLI
 *  honours `--session-id`), kept as a separate frontmatter field anyway. */
export type ChatId = string;
export type MessageId = string;
export type ToolCallId = string;
export type PermissionRequestId = string;

export type AgentBackendId = "claude";

// ---------------------------------------------------------------------------------------------
// Events

/** An opaque permission suggestion exactly as the CLI sent it (`addRules`, `setMode`, ...); the
 *  wire carries `unknown[]`. The UI only inspects it to label the "Always allow" choice; the
 *  backend rebuilds the response from its own copy, so the UI never echoes it. */
export type PermissionSuggestion = {
  type: string;
  rules?: { toolName: string; ruleContent?: string }[];
  behavior?: "allow" | "deny" | "ask";
  mode?: string;
  destination?: string;
  /** Set on Writer's own Bash proposal (the CLI sent no rule): the prefix rules, or the whole
   *  command. Absent on the CLI's suggestions. */
  proposal?: "prefix" | "exact";
  [key: string]: unknown;
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
  "question-request",
  "question-resolved",
  "usage",
  "model-refused",
  "rate-limit",
  "turn-finished",
  "turn-changes",
  "session-changes",
  "error",
  "session-ended",
  "session-reloaded",
  "steer-undelivered",
  "message-received",
  "subagent-message",
  "subagent-started",
  "subagent-model",
  "subagent-status",
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

// ---------------------------------------------------------------------------------------------
// Context references (what the user attaches; resolved by the backend, never trusted as paths
// outside the vault)

/** The wire `ContextRef` plus `label` on the two path kinds: the readable name the composer put
 *  in the text (`@"Plan"`), UI side only (the prompt builder maps that token to `path`; Rust
 *  ignores the field). Assignable to the wire type, so it goes straight into `agent_send`. */
export type ContextRef =
  | Exclude<WireContextRef, { kind: "note" | "folder" }>
  | (Extract<WireContextRef, { kind: "note" }> & { label?: string })
  | (Extract<WireContextRef, { kind: "folder" }> & { label?: string });

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
