/**
 * The transcript model the agent pane renders (spec section 3.3). Plain data only: the reducer
 * (`reduce.ts`) folds `AgentEvent`s into it, components read it, nothing here has behaviour.
 */
import type { SessionChangesState } from "./session-changes";
import type {
  AgentErrorKind,
  AgentSessionState,
  ChatId,
  ContextRef,
  McpServerStatus,
  MessageId,
  PermissionRequestId,
  PermissionSuggestion,
  Question,
  QuestionAnswer,
  QuestionResolution,
  SubagentRunStatus,
  ToolCallId,
  TurnChangesSummary,
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
  /** The sub-agent run (its `Agent`/`Task` call) that wrote it; absent: the main agent. */
  parentToolCallId?: ToolCallId | null;
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
  /** The sub-agent run that thought it; absent: the main agent. */
  parentToolCallId?: ToolCallId | null;
};

/** The question card of a tool call (`question-request`): pending until the user answers or skips,
 *  then what happened. A restored chat keeps only the answers (`questions` empty). */
export type QuestionState = {
  /** The open request; null in a restored chat. */
  requestId: string | null;
  questions: Question[];
  status: "pending" | QuestionResolution;
  answers: QuestionAnswer[];
  /** The sub-agent role asking; absent: the main agent. */
  by?: string | null;
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
  /** Set when the call is a question to the user: it renders as a question card, not a tool row. */
  question?: QuestionState;
};

/** A message the user sent into the running turn, at the point of the timeline where it landed: a
 *  steer (Cmd+Enter, it cut the step, shown with the "Steer" mark), or a plain line the CLI injected
 *  after a tool result (`injected`, no mark, nothing interrupted). */
export type SteerBlock = {
  kind: "steer";
  /** `steer:<messageId>` */
  id: string;
  message: UserMessage;
  /** A queued line the CLI took at a tool boundary (`message-received`), not a steer. */
  injected?: boolean;
  /** The CLI never acknowledged it (`steer-undelivered`): shown with a Retry button. */
  undelivered?: boolean;
};

export type Block = TextBlock | ThinkingBlock | ToolBlock | SteerBlock;

/** What the backend said about one sub-agent run (keyed by its launch call id in
 *  `Turn.subagents`): who it is and the model it runs (`subagent-started`, resolved in Rust), how
 *  how it is going (`subagent-status`, decided in Rust: the only end of a background run), and the UI
 *  clock for its elapsed time. */
export type SubagentMeta = {
  /** The registry role id (`explorer`); null for a sub-agent type Writer does not define. */
  role: string | null;
  /** The sub-agent type as the call named it. */
  name: string;
  /** The tier's model as launched (`subagent-started`); null for a type Writer does not define. */
  model: string | null;
  /** The model the run really ran on (`subagent-model`, from its own messages), the latest one;
   *  shown in place of `model` when known. */
  ranOn?: string;
  status: SubagentRunStatus | null;
  startedAt: number | null;
  endedAt: number | null;
  /** The latest run's final report (`subagent-status`), kept in the chat note. */
  summary?: string;
  /** Each time the run was resumed (`SendMessage`), in order, with what the run before it left.
   *  `startedAt`, `endedAt` and `summary` above are always the latest run's. */
  resumes?: SubagentResume[];
};

/** One restart of a sub-agent run: where in its blocks it began again, and the run that ended
 *  there (its report stays readable at the divider, its time adds to the card's). */
export type SubagentResume = {
  /** Index in the run's own blocks (`splitRuns(...).children`) of the first block of the new run;
   *  a restored note counts only the tool calls it kept. */
  at: number;
  /** The earlier run's report; absent when it left none. */
  report?: string;
  /** The earlier run's time in milliseconds; null when it was never timed (a restored chat). */
  ms: number | null;
};

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
  /** API requests of the turn (`turn-finished.numTurns`); absent while running or unknown. */
  numTurns?: number | null;
  errors: string[];
  /** What the agent changed in the vault this turn (`turn-changes`, or the chat note). */
  changes?: TurnChangesSummary;
  /** The sub-agent runs of the turn by launch call id. */
  subagents?: Record<ToolCallId, SubagentMeta>;
  /** The sub-agent run that made each message (`subagent-message`); absent: the main agent's. */
  messageParents?: Record<MessageId, ToolCallId>;
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
  /** The sub-agent role asking (`worker`); absent: the main agent. */
  by?: string | null;
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
  skills: string[];
  /** The MCP servers of the latest `init`; `null` after a reload until the next message's init
   *  (the CLI reports them only then). */
  mcpServers: McpServerStatus[] | null;
  cliVersion: string | null;
};

/** What the model was given on the latest API call, plus what it answered. `turnIndex` is
 *  `turns.length` when it was recorded, so a turn's summed result cannot overwrite the more
 *  accurate per-call numbers already seen in that turn. */
export type ContextUsage = {
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  turnIndex: number;
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
  /** The result line of a Writer slash command (`writer-commands.ts`): local to this window, never
   *  saved to the chat note; the next user turn clears it. */
  localNotice: string | null;
  rateLimit: { status: string; resetsAt: number | null } | null;
  /** Context window of the model from the last `usage{scope:"turn"}`. */
  contextWindow: number | null;
  /** The model the CLI says did the last turn (`usage{scope:"turn"}.model`); null before one. */
  reportedModel: string | null;
  /** The latest API call's usage (the context as of now); null on a new chat. See `context-usage.ts`. */
  contextUsage: ContextUsage | null;
  /** Sum of the `costUsd` of every finished turn of this chat (a lower bound: null costs add 0). */
  totalCostUsd: number;
  /** Last `seq` applied from the backend; 0 before the first event. */
  lastSeq: number;
  /** The CLI session to `--resume` on the next start (a reopened chat); null for a new one. */
  resumeSessionId: string | null;
  /** The last save failed: the message, shown under the composer. */
  saveError: string | null;
  /** The notes this chat changed (the tray row and the Session changes tab). Read through
   *  `selectSessionChanges`. */
  sessionChanges?: SessionChangesState;
};
