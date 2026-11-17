/**
 * The transcript model the agent pane renders (spec section 3.3). Plain data only: the reducer
 * (`reduce.ts`) folds `AgentEvent`s into it, components read it, nothing here has behaviour.
 */
import type {
  AgentErrorKind,
  AgentSessionState,
  ChatId,
  ContextRef,
  MessageId,
  PermissionRequestId,
  PermissionSuggestion,
  ToolCallId,
  TurnFinishReason,
} from "./events";

/** `waiting`: the CLI asked for permission and the card is pending. `interrupted`: the turn
 *  was stopped (or the connection lost) before the tool finished. */
export type ToolStatus = "running" | "waiting" | "ok" | "error" | "rejected" | "interrupted";

/** What happened to the tool's permission request, if it had one. */
export type ToolPermission = "pending" | "allowed" | "denied" | "cancelled";

export type TextBlock = {
  kind: "text";
  /** `text:<messageId>:<blockIndex>` */
  id: string;
  messageId: MessageId;
  blockIndex: number;
  text: string;
  /** True once the final `text` event arrived (or the turn ended); the block stops streaming. */
  final: boolean;
};

export type ThinkingBlock = {
  kind: "thinking";
  /** `thinking:<messageId>:<blockIndex>` */
  id: string;
  messageId: MessageId;
  blockIndex: number;
  /** UI clock (ms): "Thought for Ns" is `endedAt - startedAt`, the CLI sends no duration. */
  startedAt: number;
  endedAt: number | null;
  text: string;
  estimatedTokens: number | null;
};

export type ToolBlock = {
  kind: "tool";
  /** The tool call id. */
  id: ToolCallId;
  messageId: MessageId;
  tool: string;
  parentToolCallId: ToolCallId | null;
  /** Streaming input JSON text (display only); empty once `input` is known. */
  inputText: string;
  /** The parsed input, once `tool-call-input` arrived. */
  input: unknown;
  hasInput: boolean;
  status: ToolStatus;
  output: string | null;
  truncated: boolean;
  permission: ToolPermission | null;
};

export type Block = TextBlock | ThinkingBlock | ToolBlock;

export type TurnStatus = "running" | TurnFinishReason;

export type UserMessage = {
  messageId: MessageId;
  text: string;
  context: ContextRef[];
  /** The `> context:` line of a reopened chat (the note keeps paths, not refs). */
  contextLabel?: string;
  /** Unix milliseconds. */
  ts: number;
};

export type TurnUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number | null;
};

export type Turn = {
  id: string;
  /** Null for work the agent started on its own (replayed or resumed sessions). */
  user: UserMessage | null;
  blocks: Block[];
  status: TurnStatus;
  startedAt: number;
  finishedAt: number | null;
  /** From `turn-finished`; null while running. */
  durationMs: number | null;
  /** Authoritative `usage{scope:"turn"}`. */
  usage: TurnUsage | null;
  /** Output tokens summed from `usage{scope:"message"}` while the turn runs. */
  liveOutputTokens: number;
  errors: string[];
};

export type PermissionView = {
  requestId: PermissionRequestId;
  toolCallId: ToolCallId | null;
  tool: string;
  displayName: string | null;
  input: unknown;
  description: string | null;
  decisionReason: string | null;
  suggestions: PermissionSuggestion[];
};

export type ChatError = {
  kind: AgentErrorKind;
  message: string;
  retryable: boolean;
  /** Unix milliseconds. */
  at: number;
};

export type SessionInfo = {
  sessionId: string;
  model: string | null;
  cwd: string;
  permissionMode: string | null;
  tools: string[];
  slashCommands: string[];
  cliVersion: string | null;
};

export type Chat = {
  chatId: ChatId;
  /** Tab title; set from the first user message unless renamed. */
  title: string;
  projectPath: string | null;
  state: AgentSessionState;
  turns: Turn[];
  session: SessionInfo | null;
  /** Permission requests waiting for an answer, oldest first. */
  pendingPermissions: PermissionView[];
  error: ChatError | null;
  /** Shown as a banner row ("Connection lost, resuming"). */
  banner: string | null;
  rateLimit: { status: string; resetsAt: number | null } | null;
  /** Context window of the model from the last `usage{scope:"turn"}`. */
  contextWindow: number | null;
  /** Tokens in the context after the last turn (input + cache read + cache creation). */
  contextTokens: number | null;
  /** Sum of the `costUsd` of every finished turn of this chat (a lower bound: null costs add 0). */
  totalCostUsd: number;
  /** Last `seq` applied from the backend; 0 before the first event. */
  lastSeq: number;
  /** The CLI session to `--resume` on the next start (a reopened chat); null for a new one. */
  resumeSessionId: string | null;
  /** The last save failed: the message, shown under the composer. */
  saveError: string | null;
};
