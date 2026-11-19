/**
 * Pure reducer: `AgentEvent` -> `Chat` (spec section 3.3). No IO, no clock except the `now`
 * argument, so the golden files replay deterministically in tests.
 *
 * Rules: events are idempotent where the CLI repeats them (`session-started` every turn);
 * unknown event types are ignored (forward compatible); user actions that are not events
 * (send, stop) have their own helpers below so the state machine lives in one file.
 */
import type {
  AgentEvent,
  AgentSessionState,
  ChatId,
  ContextRef,
  MessageId,
  PermissionResolution,
  PermissionSuggestion,
  SubagentRunStatus,
} from "./events";
import { contextTokensOf } from "./context-usage";
import { foldSessionChanges } from "./session-changes";
import type {
  Block,
  Chat,
  ContextUsage,
  PermissionView,
  SubagentMeta,
  ThinkingBlock,
  ToolBlock,
  ToolPermission,
  Turn,
  TurnStatus,
} from "./transcript";

export function createChat(chatId: ChatId, opts: { projectPath?: string | null } = {}): Chat {
  return {
    chatId,
    title: "New chat",
    projectPath: opts.projectPath ?? null,
    state: "idle",
    turns: [],
    session: null,
    pendingPermissions: [],
    error: null,
    banner: null,
    localNotice: null,
    rateLimit: null,
    contextWindow: null,
    reportedModel: null,
    contextUsage: null,
    totalCostUsd: 0,
    lastSeq: 0,
    resumeSessionId: null,
    saveError: null,
  };
}

// ---------------------------------------------------------------------------------------------
// Helpers

const isRunning = (turn: Turn | undefined): turn is Turn => turn?.status === "running";

function newTurn(chat: Chat, now: number, user: Turn["user"]): Turn {
  return {
    id: `turn-${chat.turns.length}`,
    user,
    blocks: [],
    status: "running",
    startedAt: now,
    finishedAt: null,
    durationMs: null,
    usage: null,
    liveOutputTokens: 0,
    errors: [],
  };
}

/** Records the context size from a usage event. A call without input tokens (a stream that only
 *  reports output) never zeroes the ring; a turn-scope sum yields to the per-call numbers already
 *  recorded in the same turn. */
function withContextUsage(
  chat: Chat,
  event: Extract<AgentEvent, { type: "usage" }>,
  perCall: boolean,
): Chat {
  const usage: ContextUsage = {
    inputTokens: event.inputTokens,
    cacheReadTokens: event.cacheReadTokens,
    cacheCreationTokens: event.cacheCreationTokens,
    outputTokens: event.outputTokens,
    turnIndex: chat.turns.length,
  };
  if (contextTokensOf(usage) === 0) return chat;
  if (!perCall && chat.contextUsage?.turnIndex === usage.turnIndex) return chat;
  return { ...chat, contextUsage: usage };
}

/** Applies `fn` to the running turn, opening an agent-initiated one when none runs. */
function inTurn(chat: Chat, now: number, fn: (turn: Turn) => Turn): Chat {
  const last = chat.turns[chat.turns.length - 1];
  if (isRunning(last)) {
    const turns = chat.turns.slice();
    turns[turns.length - 1] = fn(last);
    return { ...chat, turns };
  }
  return { ...chat, turns: [...chat.turns, fn(newTurn(chat, now, null))] };
}

function mapBlock(blocks: Block[], id: string, fn: (b: Block) => Block): Block[] | null {
  const i = blocks.findIndex((b) => b.id === id);
  if (i < 0) return null;
  const next = blocks.slice();
  next[i] = fn(blocks[i]!);
  return next;
}

/** Any turn's tool block (a late result can arrive after the turn closed). */
function patchTool(chat: Chat, toolCallId: string, fn: (b: ToolBlock) => ToolBlock): Chat {
  for (let t = chat.turns.length - 1; t >= 0; t--) {
    const turn = chat.turns[t]!;
    const blocks = mapBlock(turn.blocks, toolCallId, (b) => (b.kind === "tool" ? fn(b) : b));
    if (blocks) {
      const turns = chat.turns.slice();
      turns[t] = { ...turn, blocks };
      return { ...chat, turns };
    }
  }
  return chat;
}

/** The sub-agent run of a launch call, in whichever turn holds the call (a background run's status
 *  can arrive after its turn closed); a run nothing launched is ignored. */
function patchSubagent(
  chat: Chat,
  toolCallId: string,
  fn: (meta: SubagentMeta | undefined, block: ToolBlock) => SubagentMeta | undefined,
): Chat {
  for (let t = chat.turns.length - 1; t >= 0; t--) {
    const turn = chat.turns[t]!;
    const block = turn.blocks.find((b) => b.id === toolCallId);
    if (block?.kind !== "tool") continue;
    const meta = fn(turn.subagents?.[toolCallId], block);
    if (!meta) return chat;
    const turns = chat.turns.slice();
    turns[t] = { ...turn, subagents: { ...turn.subagents, [toolCallId]: meta } };
    return { ...chat, turns };
  }
  return chat;
}

const blankSubagent = (): SubagentMeta => ({
  role: null,
  name: "",
  model: null,
  status: null,
  startedAt: null,
  endedAt: null,
});

/** A run that never reported its end: it ended as `status` (`stopped` when its turn was stopped,
 *  `interrupted` when the process went away). */
function endRunning(chat: Chat, now: number, status: "stopped" | "interrupted"): Chat {
  let changed = false;
  const turns = chat.turns.map((turn) => {
    const runs = Object.entries(turn.subagents ?? {}).filter(([, m]) => m.status === "running");
    if (runs.length === 0) return turn;
    changed = true;
    const subagents = { ...turn.subagents };
    for (const [id, m] of runs) subagents[id] = { ...m, status, endedAt: m.endedAt ?? now };
    return { ...turn, subagents };
  });
  return changed ? { ...chat, turns } : chat;
}

/** Activity moves an idle or starting chat to running; waiting/cancelling states are kept. */
function active(chat: Chat): Chat {
  return chat.state === "idle" || chat.state === "starting" || chat.state === "reconnecting"
    ? { ...chat, state: "running", banner: null }
    : chat;
}

function addBlock(turn: Turn, block: Block): Turn {
  return { ...turn, blocks: [...turn.blocks, block] };
}

function blockExists(chat: Chat, id: string, parent: string | null = null): boolean {
  const i = parent ? runTurnIndex(chat, parent) : -1;
  const turn = i >= 0 ? chat.turns[i] : chat.turns[chat.turns.length - 1];
  return (i >= 0 || isRunning(turn)) && !!turn?.blocks.some((b) => b.id === id);
}

/** The run (launch call) a sub-agent message belongs to, from `subagent-message`. */
function parentOfMessage(chat: Chat, messageId: string): string | null {
  for (let t = chat.turns.length - 1; t >= 0; t--) {
    const parent = chat.turns[t]!.messageParents?.[messageId];
    if (parent) return parent;
  }
  return null;
}

/** The turn holding a launch call: a background run keeps working after its turn closed, and its
 *  late rows belong in its card, not in a turn of their own. -1 when no turn holds it. */
function runTurnIndex(chat: Chat, launchId: string): number {
  for (let t = chat.turns.length - 1; t >= 0; t--)
    if (chat.turns[t]!.blocks.some((b) => b.id === launchId)) return t;
  return -1;
}

/** [`inTurn`] for something a sub-agent made: in the turn of its launch call when there is one. */
function inRunTurn(chat: Chat, now: number, parent: string | null, fn: (turn: Turn) => Turn): Chat {
  const i = parent ? runTurnIndex(chat, parent) : -1;
  if (i < 0) return inTurn(chat, now, fn);
  const turns = chat.turns.slice();
  turns[i] = fn(turns[i]!);
  return { ...chat, turns };
}

function removePending(chat: Chat, requestId: string): PermissionView[] {
  return chat.pendingPermissions.filter((p) => p.requestId !== requestId);
}

function afterPermissionChange(chat: Chat, pending: PermissionView[]): Chat {
  let state: AgentSessionState = chat.state;
  if (state === "awaiting-permission" && pending.length === 0) state = "running";
  if (pending.length > 0 && state === "running") state = "awaiting-permission";
  return { ...chat, pendingPermissions: pending, state };
}

function closeBlocks(blocks: Block[], now: number, toolStatus: ToolBlock["status"]): Block[] {
  return blocks.map((b) => {
    if (b.kind === "text") return b.final ? b : { ...b, final: true };
    if (b.kind === "thinking") return b.endedAt === null ? { ...b, endedAt: now } : b;
    if (b.kind === "steer") return b;
    return b.status === "running" || b.status === "waiting"
      ? {
          ...b,
          status: toolStatus,
          permission: b.permission === "pending" ? "cancelled" : b.permission,
        }
      : b;
  });
}

function finishTurns(
  chat: Chat,
  now: number,
  status: Exclude<TurnStatus, "running">,
  extra: Partial<Turn> = {},
): Chat {
  const last = chat.turns[chat.turns.length - 1];
  if (!isRunning(last)) return chat;
  const turns = chat.turns.slice();
  turns[turns.length - 1] = {
    ...last,
    ...extra,
    status,
    finishedAt: now,
    blocks: closeBlocks(last.blocks, now, status === "completed" ? "error" : "interrupted"),
  };
  return { ...chat, turns };
}

const toolStatusOf = (outcome: "ok" | "error" | "rejected"): ToolBlock["status"] => outcome;

// ---------------------------------------------------------------------------------------------
// The reducer

/** The message a `message-received` receipt names (the store keeps the lines it wrote). */
export type SentLine = { text: string; context: ContextRef[] };
export type LineLookup = (messageId: string) => SentLine | undefined;

export function reduceEvent(
  chat: Chat,
  event: AgentEvent,
  now: number = Date.now(),
  lines?: LineLookup,
): Chat {
  switch (event.type) {
    case "session-started": {
      const hasTurn = isRunning(chat.turns[chat.turns.length - 1]);
      const state: AgentSessionState =
        chat.state === "starting" || chat.state === "reconnecting" || chat.state === "idle"
          ? hasTurn
            ? "running"
            : "idle"
          : chat.state;
      return {
        ...chat,
        state,
        banner: null,
        session: {
          sessionId: event.sessionId,
          model: event.model,
          cwd: event.cwd,
          permissionMode: event.permissionMode,
          tools: event.tools,
          slashCommands: event.slashCommands,
          skills: event.skills ?? [],
          mcpServers: event.mcpServers ?? [],
          cliVersion: event.cliVersion,
        },
      };
    }

    case "text-delta": {
      const id = `text:${event.messageId}:${event.blockIndex}`;
      let next = active(chat);
      const parent = parentOfMessage(next, event.messageId);
      if (blockExists(next, id, parent)) {
        return inRunTurn(next, now, parent, (t) => ({
          ...t,
          blocks: mapBlock(t.blocks, id, (b) =>
            b.kind === "text" && !b.final ? { ...b, text: b.text + event.text } : b,
          )!,
        }));
      }
      next = inRunTurn(next, now, parent, (t) =>
        addBlock(t, {
          kind: "text",
          id,
          messageId: event.messageId,
          blockIndex: event.blockIndex,
          text: event.text,
          final: false,
          parentToolCallId: t.messageParents?.[event.messageId] ?? null,
        }),
      );
      return next;
    }

    case "text": {
      const id = `text:${event.messageId}:${event.blockIndex}`;
      const next = active(chat);
      return inRunTurn(next, now, parentOfMessage(next, event.messageId), (t) => {
        const replaced = mapBlock(t.blocks, id, (b) =>
          b.kind === "text" ? { ...b, text: event.text, final: true } : b,
        );
        return replaced
          ? { ...t, blocks: replaced }
          : addBlock(t, {
              kind: "text",
              id,
              messageId: event.messageId,
              blockIndex: event.blockIndex,
              text: event.text,
              final: true,
              parentToolCallId: t.messageParents?.[event.messageId] ?? null,
            });
      });
    }

    case "thinking": {
      const id = `thinking:${event.messageId}:${event.blockIndex}`;
      const next = active(chat);
      return inRunTurn(next, now, parentOfMessage(next, event.messageId), (t) => {
        const update = (b: ThinkingBlock): ThinkingBlock => {
          const estimatedTokens = event.estimatedTokens ?? b.estimatedTokens;
          if (event.phase === "delta") return { ...b, text: b.text + event.text, estimatedTokens };
          if (event.phase === "end")
            return {
              ...b,
              text: event.text || b.text,
              endedAt: b.endedAt ?? now,
              estimatedTokens,
            };
          return { ...b, estimatedTokens };
        };
        const patched = mapBlock(t.blocks, id, (b) => (b.kind === "thinking" ? update(b) : b));
        if (patched) return { ...t, blocks: patched };
        const fresh: ThinkingBlock = {
          kind: "thinking",
          id,
          messageId: event.messageId,
          blockIndex: event.blockIndex,
          startedAt: now,
          endedAt: null,
          text: "",
          estimatedTokens: null,
          parentToolCallId: t.messageParents?.[event.messageId] ?? null,
        };
        return addBlock(t, update(fresh));
      });
    }

    case "tool-call-started": {
      if (chat.turns.some((t) => t.blocks.some((b) => b.id === event.toolCallId))) return chat;
      const block: ToolBlock = {
        kind: "tool",
        id: event.toolCallId,
        messageId: event.messageId,
        tool: event.tool,
        parentToolCallId: event.parentToolCallId,
        inputText: "",
        input: undefined,
        hasInput: false,
        status: "running",
        output: null,
        truncated: false,
        permission: null,
      };
      return inRunTurn(active(chat), now, event.parentToolCallId, (t) => addBlock(t, block));
    }

    case "tool-call-input-delta":
      return patchTool(chat, event.toolCallId, (b) =>
        b.hasInput ? b : { ...b, inputText: b.inputText + event.partialJson },
      );

    case "tool-call-input":
      return patchTool(chat, event.toolCallId, (b) => ({
        ...b,
        input: event.input,
        hasInput: true,
        inputText: "",
      }));

    case "tool-call-finished": {
      const pending = chat.pendingPermissions.find((p) => p.toolCallId === event.toolCallId);
      let next = patchTool(chat, event.toolCallId, (b) => ({
        ...b,
        status:
          b.status === "interrupted" ||
          (event.outcome === "rejected" && b.permission === "cancelled")
            ? "interrupted"
            : toolStatusOf(event.outcome),
        output: event.output,
        truncated: event.truncated,
        permission:
          b.permission === "pending"
            ? event.outcome === "rejected"
              ? "denied"
              : "allowed"
            : b.permission,
      }));
      if (pending) next = afterPermissionChange(next, removePending(next, pending.requestId));
      // a sub-agent's end is Rust's word (`subagent-status`), never this result
      return next;
    }

    case "subagent-message":
      return inRunTurn(active(chat), now, event.parentToolCallId, (t) => ({
        ...t,
        messageParents: { ...t.messageParents, [event.messageId]: event.parentToolCallId },
      }));

    case "subagent-started":
      return patchSubagent(chat, event.toolCallId, (meta) => ({
        ...(meta ?? blankSubagent()),
        role: event.role,
        name: event.name,
        model: event.model,
        startedAt: meta?.startedAt ?? now,
      }));

    case "subagent-status":
      return patchSubagent(chat, event.toolCallId, (meta) => {
        const base = meta ?? blankSubagent();
        // a run that ended stays ended; its report may follow the end once
        if (base.status !== null && base.status !== "running")
          return event.report && !base.summary ? { ...base, summary: event.report } : base;
        const status: SubagentRunStatus = event.status;
        return {
          ...base,
          status,
          summary: event.report ?? base.summary,
          startedAt: base.startedAt ?? now,
          endedAt: status === "running" ? null : now,
        };
      });

    case "permission-request": {
      if (chat.pendingPermissions.some((p) => p.requestId === event.requestId)) return chat;
      const view: PermissionView = {
        requestId: event.requestId,
        toolCallId: event.toolCallId,
        tool: event.tool,
        displayName: event.displayName,
        input: event.input,
        description: event.description,
        decisionReason: event.decisionReason,
        // The wire type is `unknown[]` (opaque, as the CLI sent it); the view types what the label reads.
        suggestions: event.suggestions as PermissionSuggestion[],
        by: event.by,
      };
      let next = inTurn(active(chat), now, (t) => t);
      if (event.toolCallId)
        next = patchTool(next, event.toolCallId, (b) => ({
          ...b,
          status: "waiting",
          permission: "pending",
        }));
      return {
        ...next,
        pendingPermissions: [...next.pendingPermissions, view],
        state: next.state === "cancelling" ? "cancelling" : "awaiting-permission",
      };
    }

    case "permission-resolved": {
      const req = chat.pendingPermissions.find((p) => p.requestId === event.requestId);
      let next = chat;
      if (req?.toolCallId) {
        const resolution: PermissionResolution = event.resolution;
        const permission: ToolPermission = resolution === "allowed" ? "allowed" : resolution;
        next = patchTool(next, req.toolCallId, (b) => ({
          ...b,
          permission,
          status:
            b.status !== "waiting"
              ? b.status
              : resolution === "allowed"
                ? "running"
                : resolution === "denied"
                  ? "rejected"
                  : "interrupted",
        }));
      }
      return afterPermissionChange(next, removePending(next, event.requestId));
    }

    case "usage": {
      if (event.scope === "message") {
        const next = inTurn(chat, now, (t) => ({
          ...t,
          liveOutputTokens: t.liveOutputTokens + event.outputTokens,
        }));
        return withContextUsage(next, event, true);
      }
      const last = chat.turns[chat.turns.length - 1];
      const usage = {
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        cacheReadTokens: event.cacheReadTokens,
        cacheCreationTokens: event.cacheCreationTokens,
        costUsd: event.costUsd,
      };
      const base: Chat = {
        ...chat,
        contextWindow: event.contextWindow ?? chat.contextWindow,
        reportedModel: event.model ?? chat.reportedModel,
        totalCostUsd: chat.totalCostUsd + (event.costUsd ?? 0),
      };
      // The turn's usage is summed over its API calls: only a fallback for the context size.
      const withContext = withContextUsage(base, event, false);
      if (!last) return withContext;
      const turns = withContext.turns.slice();
      turns[turns.length - 1] = { ...last, usage };
      return { ...withContext, turns };
    }

    case "model-refused":
      return {
        ...chat,
        reportedModel: event.using ?? chat.reportedModel,
        banner: `Model ${event.requested ?? "default"} is not available in your organization; using ${event.using ?? "the default"}`,
      };

    case "rate-limit":
      return { ...chat, rateLimit: { status: event.status, resetsAt: event.resetsAt } };

    case "turn-finished": {
      const finished = finishTurns(chat, now, event.reason, {
        durationMs: event.durationMs,
        errors: event.errors,
      });
      // a normal end can leave a background run going; a stopped or failed turn ends its runs
      const closed = event.reason === "completed" ? finished : endRunning(finished, now, "stopped");
      return {
        ...closed,
        pendingPermissions: [],
        state: chat.state === "error" || chat.state === "ended" ? chat.state : "idle",
        banner: null,
      };
    }

    case "turn-changes": {
      // follows its `turn-finished`; a queued message may already have opened the next turn
      let i = chat.turns.length - 1;
      while (i >= 0 && isRunning(chat.turns[i])) i--;
      const turn = chat.turns[i];
      if (!turn || turn.changes) return chat;
      const { type: _type, ...summary } = event;
      const turns = chat.turns.slice();
      turns[i] = { ...turn, changes: summary };
      return { ...chat, turns };
    }

    case "session-changes":
      return { ...chat, sessionChanges: foldSessionChanges(chat.sessionChanges, event) };

    case "error": {
      const error = {
        kind: event.kind,
        message: event.message,
        retryable: event.retryable,
        at: now,
      };
      if (event.kind === "process-exited" && event.retryable)
        return { ...chat, error, state: "reconnecting", banner: "Connection lost, resuming" };
      if (!event.retryable) return { ...chat, error, state: "error" };
      return { ...chat, error, state: chat.state === "cancelling" ? "idle" : chat.state };
    }

    case "session-ended": {
      const midTurn = isRunning(chat.turns[chat.turns.length - 1]);
      const lost = midTurn && event.reason === "exit";
      const closed = endRunning(
        midTurn ? finishTurns(chat, now, lost ? "error" : "interrupted") : chat,
        now,
        "interrupted",
      );
      return {
        ...closed,
        pendingPermissions: [],
        state: lost ? "reconnecting" : "ended",
        banner: lost ? "Connection lost, resuming" : null,
      };
    }

    // The process was replaced (the user's reload, or Writer after a config change): a transient
    // notice, never stored in the chat note, and the lists of the old process are no longer
    // current until the next message's `init`.
    case "steer-undelivered": {
      const id = `steer:${event.messageId}`;
      let found = false;
      const turns = chat.turns.map((t) => {
        const blocks = mapBlock(t.blocks, id, (b) => {
          found = true;
          return b.kind === "steer" ? { ...b, undelivered: true } : b;
        });
        return blocks ? { ...t, blocks } : t;
      });
      return found ? { ...chat, turns, localNotice: STEER_UNDELIVERED_TEXT } : chat;
    }

    case "message-received": {
      const line = lines?.(event.messageId);
      return line ? placeReceived(chat, { messageId: event.messageId, ...line }, now) : chat;
    }

    case "session-reloaded":
      return {
        ...chat,
        localNotice: reloadedNotice(event.reason),
        session: chat.session && { ...chat.session, mcpServers: null },
      };

    default:
      return chat;
  }
}

/** "Session reloaded", with the cause when Writer restarted the chat by itself. */
export const reloadedNotice = (reason: string | null | undefined): string =>
  reason ? `Session reloaded: ${reason}` : "Session reloaded";

/** Folds a batch (one animation frame) into the chat. */
export function reduceEvents(
  chat: Chat,
  events: readonly AgentEvent[],
  now?: number,
  lines?: LineLookup,
): Chat {
  let next = chat;
  for (const event of events) next = reduceEvent(next, event, now, lines);
  return next;
}

// ---------------------------------------------------------------------------------------------
// User actions (not events)

export function titleFromText(text: string): string {
  const line = text.trim().split("\n")[0] ?? "";
  const clean = line.replace(/\s+/g, " ");
  return clean.length > 40 ? `${clean.slice(0, 39)}…` : clean || "New chat";
}

/** Optimistic user card; `live` is whether a process already runs (else `starting`). */
export function appendUserTurn(
  chat: Chat,
  msg: { messageId: MessageId; text: string; context: ContextRef[] },
  now: number,
  live: boolean,
): Chat {
  const turn = newTurn(chat, now, { ...msg, ts: now });
  return {
    ...chat,
    turns: [...chat.turns, turn],
    title:
      chat.turns.length === 0 && chat.title === "New chat" ? titleFromText(msg.text) : chat.title,
    state: live ? "running" : "starting",
    error: null,
    banner: null,
    localNotice: null,
  };
}

export const STEER_UNDELIVERED_TEXT = "The steer was not acknowledged";

/** A message forced into the running turn (`priority:"now"`: the CLI aborts the running tool or
 *  text, ends the turn and starts the message's turn): a card at the tail of the timeline, where it
 *  was sent. What the abort will do is what an interrupt does, so it is done now by the same
 *  `closeBlocks` (running tools become "interrupted", their permission cards are cancelled);
 *  the CLI's own `turn-finished` and the aborted tool's result then change nothing.
 *  With no running turn it is a normal send. */
export function appendSteer(
  chat: Chat,
  msg: { messageId: MessageId; text: string; context: ContextRef[] },
  now: number,
): Chat {
  const last = chat.turns[chat.turns.length - 1];
  if (!isRunning(last)) return appendUserTurn(chat, msg, now, true);
  const block = {
    kind: "steer" as const,
    id: `steer:${msg.messageId}`,
    message: { ...msg, ts: now },
  };
  const turns = chat.turns.slice();
  turns[turns.length - 1] = addBlock(
    { ...last, blocks: closeBlocks(last.blocks, now, "interrupted") },
    block,
  );
  return { ...chat, turns, pendingPermissions: [], state: "running", localNotice: null };
}

/** The CLI took a message written while a turn ran (its echo): inside the running turn, as a card
 *  at the point the CLI injected it (after a tool result; nothing is interrupted), or, when the
 *  turn had ended, as the user card of the turn it starts. */
export function placeReceived(
  chat: Chat,
  msg: { messageId: MessageId; text: string; context: ContextRef[] },
  now: number,
): Chat {
  const last = chat.turns[chat.turns.length - 1];
  if (!isRunning(last)) return appendUserTurn(chat, msg, now, true);
  const block = {
    kind: "steer" as const,
    id: `steer:${msg.messageId}`,
    message: { ...msg, ts: now },
    injected: true,
  };
  const turns = chat.turns.slice();
  turns[turns.length - 1] = addBlock(last, block);
  return { ...chat, turns };
}

/** The user pressed stop: wait for `turn-finished`. */
export function markCancelling(chat: Chat): Chat {
  return chat.state === "running" ||
    chat.state === "awaiting-permission" ||
    chat.state === "starting"
    ? { ...chat, state: "cancelling" }
    : chat;
}

/** A send failed before any event arrived (spawn denied, binary missing, IPC error). */
export function failSend(chat: Chat, message: string, kind: ChatErrorKind, now: number): Chat {
  const closed = finishTurns(chat, now, "error");
  return {
    ...closed,
    pendingPermissions: [],
    state: "error",
    error: { kind, message, retryable: kind !== "binary-not-found" && kind !== "auth", at: now },
  };
}
type ChatErrorKind = NonNullable<Chat["error"]>["kind"];

/** A turn is running and takes a message into it (a starting or cancelling one does not). */
export const canSteer = (chat: Chat): boolean =>
  chat.state === "running" || chat.state === "awaiting-permission";

export const isBusy = (chat: Chat): boolean =>
  chat.state === "running" ||
  chat.state === "awaiting-permission" ||
  chat.state === "cancelling" ||
  chat.state === "starting";

/** Error kinds for which sending again cannot work until the user fixes something. */
export const BLOCKING_ERROR_KINDS = ["binary-not-found", "spawn-denied", "auth"] as const;

export const isComposerDisabled = (chat: Chat): boolean =>
  chat.state === "cancelling" ||
  chat.state === "reconnecting" ||
  chat.state === "ended" ||
  (chat.state === "error" &&
    chat.error !== null &&
    (BLOCKING_ERROR_KINDS as readonly string[]).includes(chat.error.kind));
