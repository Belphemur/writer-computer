/**
 * A backend-free `AgentClient` that replays `shared/agent-golden/*.events.json` (real captures
 * of the claude CLI mapped to `AgentEvent`s). It is what the pane runs against until the Rust
 * runner (lane 1) lands, and what the store tests drive.
 *
 * Fidelity: the goldens are mapper output, so the events the runner would add are synthesised
 * here (`permission-resolved` after the user answers, `turn-finished{interrupted}` on cancel).
 * A scenario is chosen from the message text (see `pickScenario`); replies are canned, never AI.
 */
import type {
  AgentEvent,
  AgentEventEnvelope,
  AgentSessionState,
  ChatId,
  PermissionResolution,
} from "./events";
import type { AgentClient } from "./client";

export type ScenarioName =
  | "ok-turn"
  | "tool-auto-allowed"
  | "permission-allow"
  | "permission-deny"
  | "interrupt"
  | "multi-turn-rule";

export type Goldens = Record<ScenarioName, AgentEvent[]>;

export async function loadGoldens(): Promise<Goldens> {
  const load = async (m: Promise<{ default: unknown }>) => (await m).default as AgentEvent[];
  return {
    "ok-turn": await load(import("@shared/agent-golden/ok-turn.events.json")),
    "tool-auto-allowed": await load(import("@shared/agent-golden/tool-auto-allowed.events.json")),
    "permission-allow": await load(import("@shared/agent-golden/permission-allow.events.json")),
    "permission-deny": await load(import("@shared/agent-golden/permission-deny.events.json")),
    interrupt: await load(import("@shared/agent-golden/interrupt.events.json")),
    "multi-turn-rule": await load(import("@shared/agent-golden/multi-turn-rule.events.json")),
  };
}

/** Keyword routing, documented in the empty state's demo hint: deny, stop, again, tools. */
export function pickScenario(text: string): ScenarioName {
  const t = text.toLowerCase();
  if (/\bdeny|denied|refuse\b/.test(t)) return "permission-deny";
  if (/\bstop|interrupt|cancel\b/.test(t)) return "interrupt";
  if (/\bagain|twice|rule\b/.test(t)) return "multi-turn-rule";
  if (/\btool|read|list|search\b/.test(t)) return "tool-auto-allowed";
  if (/\bwrite|edit|run|permission|create\b/.test(t)) return "permission-allow";
  return "ok-turn";
}

/** Splits a capture at each `turn-finished` (the multi-turn golden holds two turns). */
export function splitTurns(events: readonly AgentEvent[]): AgentEvent[][] {
  const turns: AgentEvent[][] = [];
  let cur: AgentEvent[] = [];
  for (const e of events) {
    cur.push(e);
    if (e.type === "turn-finished") {
      turns.push(cur);
      cur = [];
    }
  }
  if (cur.length) turns.push(cur);
  return turns;
}

export type MockOptions = {
  goldens: Goldens;
  /** Pause between events; 0 in tests. */
  delayMs?: number;
  pickScenario?: (text: string) => ScenarioName;
};

type Waiter = (r: PermissionResolution) => void;

export function createMockAgentClient(opts: MockOptions): AgentClient & {
  /** Resolves when no scenario is running (tests). */
  idle(chatId: ChatId): Promise<void>;
} {
  const handlers = new Set<(e: AgentEventEnvelope) => void>();
  const seqs = new Map<ChatId, number>();
  const log = new Map<ChatId, AgentEventEnvelope[]>();
  const waiters = new Map<ChatId, Map<string, Waiter>>();
  const cancelled = new Set<ChatId>();
  /** Queued lines the demo CLI has not taken yet, by message id (its chat). */
  const waiting = new Map<string, ChatId>();
  const running = new Map<ChatId, Promise<void>>();
  const multiCursor = new Map<ChatId, number>();
  const states = new Map<ChatId, AgentSessionState>();
  const delay = opts.delayMs ?? 0;
  const pick = opts.pickScenario ?? pickScenario;

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  function emit(chatId: ChatId, event: AgentEvent) {
    const seq = (seqs.get(chatId) ?? 0) + 1;
    seqs.set(chatId, seq);
    const env = { chatId, seq, event };
    const l = log.get(chatId) ?? [];
    l.push(env);
    log.set(chatId, l);
    for (const h of handlers) h(env);
  }

  function awaitDecision(chatId: ChatId, requestId: string): Promise<PermissionResolution> {
    return new Promise((resolve) => {
      const m = waiters.get(chatId) ?? new Map();
      m.set(requestId, resolve);
      waiters.set(chatId, m);
    });
  }

  async function play(chatId: ChatId, events: AgentEvent[]) {
    cancelled.delete(chatId);
    for (let i = 0; i < events.length; i++) {
      const event = events[i]!;
      if (cancelled.has(chatId)) {
        emit(chatId, {
          type: "turn-finished",
          reason: "interrupted",
          durationMs: 0,
          apiDurationMs: null,
          numTurns: null,
          isError: true,
          result: null,
          sessionId: null,
          errors: [],
        });
        states.set(chatId, "idle");
        return;
      }
      if (delay) await sleep(delay);
      if (event.type === "permission-resolved") continue; // synthesised below
      emit(chatId, event);
      if (event.type === "permission-request") {
        states.set(chatId, "awaiting-permission");
        const resolution = await awaitDecision(chatId, event.requestId);
        // A cancel that answered the card is part of the capture's own tail (its tool result and
        // `turn-finished{interrupted}` follow), so do not synthesise a second ending; other captures get a synthetic one.
        const hasOwnEnding = events.some(
          (e) => e.type === "turn-finished" && e.reason === "interrupted",
        );
        if (resolution === "cancelled" && hasOwnEnding) cancelled.delete(chatId);
        emit(chatId, { type: "permission-resolved", requestId: event.requestId, resolution });
        states.set(chatId, "running");
      }
    }
    states.set(chatId, "idle");
  }

  const send = async (
    { chatId, text }: { chatId: ChatId; text: string },
    receipt?: string,
  ): Promise<void> => {
    const scenario = pick(text);
    const turns = splitTurns(opts.goldens[scenario]);
    let events: AgentEvent[];
    if (scenario === "multi-turn-rule") {
      const idx = multiCursor.get(chatId) ?? 0;
      events = turns[idx % turns.length]!;
      multiCursor.set(chatId, idx + 1);
    } else events = turns.flat();
    states.set(chatId, "running");
    const prev = running.get(chatId) ?? Promise.resolve();
    const p = prev.then(() => {
      // the demo's "CLI" takes a queued line when the running turn ends: the next turn starts
      if (receipt) {
        if (!waiting.delete(receipt)) return; // taken back
        emit(chatId, { type: "message-received", messageId: receipt });
      }
      return play(chatId, events);
    });
    running.set(chatId, p);
    void p.finally(() => {
      if (running.get(chatId) === p) running.delete(chatId);
    });
  };

  return {
    detectBinary: async () => ({
      found: true,
      path: "/demo/claude",
      version: "demo",
      source: "override",
      searched: [],
      authenticated: null,
      account: null,
    }),
    start: async ({ chatId }) => ({ chatId, sessionId: "00000000-0000-4000-8000-000000000001" }),
    send: (a) => send(a),
    // The demo has no live turn to join: a steer plays as a message that follows the running one.
    steer: (a) => send(a),
    queue: (a) => {
      waiting.set(a.messageId, a.chatId);
      return send(a, a.messageId);
    },
    // true while the line still waits behind the running turn
    unqueue: async ({ messageId }) => waiting.delete(messageId),
    cancel: async ({ chatId }) => {
      cancelled.add(chatId);
      // a stop takes the waiting lines out of the CLI and tells their chips
      for (const [messageId, chat] of waiting) {
        if (chat !== chatId) continue;
        waiting.delete(messageId);
        emit(chatId, { type: "steer-undelivered", messageId });
      }
      const m = waiters.get(chatId);
      if (m) {
        for (const w of m.values()) w("cancelled");
        m.clear();
      }
    },
    permission: async ({ chatId, requestId, decision }) => {
      const w = waiters.get(chatId)?.get(requestId);
      if (!w) throw new Error("Unknown or already-resolved permission request");
      waiters.get(chatId)!.delete(requestId);
      w(decision === "allow" ? "allowed" : "denied");
    },
    setPermissionMode: async () => {},
    setModel: async () => {},
    reload: async () => "started",
    listSkills: async () => [
      {
        name: "summarize-note",
        description: "Summarize the open note in five bullets.",
        scope: "vault",
        path: ".claude/skills/summarize-note/SKILL.md",
      },
    ],
    close: async ({ chatId }) => {
      cancelled.add(chatId);
      emit(chatId, { type: "session-ended", reason: "closed", exitCode: null, signal: null });
    },
    // the demo backend keeps no snapshots: the card shows "no longer available"
    turnChanges: async () => null,
    sessionChanges: async () => null,
    revertChanges: async () => null,
    snapshot: async ({ chatId, afterSeq }) => ({
      state: states.get(chatId) ?? "idle",
      events: (log.get(chatId) ?? []).filter((e) => e.seq > afterSeq),
    }),
    subscribe: async (handler) => {
      handlers.add(handler);
      return () => void handlers.delete(handler);
    },
    idle: async (chatId) => {
      while (running.has(chatId)) await running.get(chatId);
    },
  };
}
