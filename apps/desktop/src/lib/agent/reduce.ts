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
} from "./events";
import type {
  Block,
  Chat,
  PermissionView,
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
    rateLimit: null,
    contextWindow: null,
    reportedModel: null,
    contextTokens: null,
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

/** Activity moves an idle or starting chat to running; waiting/cancelling states are kept. */
function active(chat: Chat): Chat {
  return chat.state === "idle" || chat.state === "starting" || chat.state === "reconnecting"
    ? { ...chat, state: "running", banner: null }
    : chat;
}

function addBlock(turn: Turn, block: Block): Turn {
  return { ...turn, blocks: [...turn.blocks, block] };
}

function blockExists(chat: Chat, id: string): boolean {
  const last = chat.turns[chat.turns.length - 1];
  return isRunning(last) && last.blocks.some((b) => b.id === id);
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

export function reduceEvent(chat: Chat, event: AgentEvent, now: number = Date.now()): Chat {
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
          cliVersion: event.cliVersion,
        },
      };
    }

    case "text-delta": {
      const id = `text:${event.messageId}:${event.blockIndex}`;
      let next = active(chat);
      if (blockExists(next, id)) {
        return inTurn(next, now, (t) => ({
          ...t,
          blocks: mapBlock(t.blocks, id, (b) =>
            b.kind === "text" && !b.final ? { ...b, text: b.text + event.text } : b,
          )!,
        }));
      }
      next = inTurn(next, now, (t) =>
        addBlock(t, {
          kind: "text",
          id,
          messageId: event.messageId,
          blockIndex: event.blockIndex,
          text: event.text,
          final: false,
        }),
      );
      return next;
    }

    case "text": {
      const id = `text:${event.messageId}:${event.blockIndex}`;
      const next = active(chat);
      return inTurn(next, now, (t) => {
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
            });
      });
    }

    case "thinking": {
      const id = `thinking:${event.messageId}:${event.blockIndex}`;
      const next = active(chat);
      return inTurn(next, now, (t) => {
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
      return inTurn(active(chat), now, (t) => addBlock(t, block));
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
          event.outcome === "rejected" && b.permission === "cancelled"
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
      return next;
    }

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
        suggestions: event.suggestions,
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
        return inTurn(chat, now, (t) => ({
          ...t,
          liveOutputTokens: t.liveOutputTokens + event.outputTokens,
        }));
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
        contextTokens: event.inputTokens + event.cacheReadTokens + event.cacheCreationTokens,
        totalCostUsd: chat.totalCostUsd + (event.costUsd ?? 0),
      };
      if (!last) return base;
      const turns = base.turns.slice();
      turns[turns.length - 1] = { ...last, usage };
      return { ...base, turns };
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
      const closed = finishTurns(chat, now, event.reason, {
        durationMs: event.durationMs,
        errors: event.errors,
      });
      return {
        ...closed,
        pendingPermissions: [],
        state: chat.state === "error" || chat.state === "ended" ? chat.state : "idle",
        banner: null,
      };
    }

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
      const closed = midTurn ? finishTurns(chat, now, lost ? "error" : "interrupted") : chat;
      return {
        ...closed,
        pendingPermissions: [],
        state: lost ? "reconnecting" : "ended",
        banner: lost ? "Connection lost, resuming" : null,
      };
    }

    default:
      return chat;
  }
}

/** Folds a batch (one animation frame) into the chat. */
export function reduceEvents(chat: Chat, events: readonly AgentEvent[], now?: number): Chat {
  let next = chat;
  for (const event of events) next = reduceEvent(next, event, now);
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
  };
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
