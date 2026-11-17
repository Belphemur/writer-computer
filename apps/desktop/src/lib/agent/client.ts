/**
 * Transport for the agent pane: the ONLY module that calls `invoke`/`listen` for agent
 * commands (spec 3.2). Everything above it talks to the `AgentClient` interface, so the pane runs
 * unchanged against the Tauri backend or the golden-replaying `mock-client.ts`.
 *
 * `createEventPump` is the receiving half: it orders the per-chat `seq` numbers (drops
 * duplicates, resynchronises through `agent_snapshot` on a gap) and batches events per animation
 * frame so a delta storm costs at most one store update per frame (spec 3.5).
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  AGENT_EVENT_CHANNEL,
  type AgentBinaryInfo,
  type AgentCommandMap,
  type AgentEvent,
  type AgentEventEnvelope,
  type AgentSessionState,
  type ChatId,
} from "./events";

type Args<K extends keyof AgentCommandMap> = AgentCommandMap[K][0];
type Result<K extends keyof AgentCommandMap> = AgentCommandMap[K][1];

export type Unsubscribe = () => void;

export interface AgentClient {
  detectBinary(args: Args<"agent_detect_binary">): Promise<AgentBinaryInfo>;
  start(args: Args<"agent_start">): Promise<Result<"agent_start">>;
  send(args: Args<"agent_send">): Promise<void>;
  cancel(args: Args<"agent_cancel">): Promise<void>;
  permission(args: Args<"agent_permission">): Promise<void>;
  setPermissionMode(args: Args<"agent_set_permission_mode">): Promise<void>;
  close(args: Args<"agent_close">): Promise<void>;
  snapshot(args: Args<"agent_snapshot">): Promise<Result<"agent_snapshot">>;
  /** Registers the one envelope listener; resolves once the subscription is live. */
  subscribe(handler: (envelope: AgentEventEnvelope) => void): Promise<Unsubscribe>;
}

export function createTauriAgentClient(): AgentClient {
  const call = <K extends keyof AgentCommandMap>(cmd: K, args: Args<K>) =>
    invoke<Result<K>>(cmd, args as Record<string, unknown>);
  return {
    detectBinary: (a) => call("agent_detect_binary", a),
    start: (a) => call("agent_start", a),
    send: (a) => call("agent_send", a),
    cancel: (a) => call("agent_cancel", a),
    permission: (a) => call("agent_permission", a),
    setPermissionMode: (a) => call("agent_set_permission_mode", a),
    close: (a) => call("agent_close", a),
    snapshot: (a) => call("agent_snapshot", a),
    subscribe: (handler) =>
      listen<AgentEventEnvelope>(AGENT_EVENT_CHANNEL, (e) => handler(e.payload)),
  };
}

// ---------------------------------------------------------------------------------------------
// Event pump: seq ordering plus per-frame batching

export type PumpOptions = {
  snapshot: AgentClient["snapshot"];
  /** One call per chat per frame with the new events in order and the last applied `seq`. */
  onBatch: (chatId: ChatId, events: AgentEvent[], lastSeq: number) => void;
  /** The backend's view of the session state after a resync (the events alone can miss it). */
  onResync?: (chatId: ChatId, state: AgentSessionState) => void;
  onResyncError?: (chatId: ChatId, error: unknown) => void;
  /** Defaults to `requestAnimationFrame`, falling back to a 16 ms timeout. */
  schedule?: (flush: () => void) => void;
};

type ChatPump = {
  last: number;
  resyncing: boolean;
  buffer: AgentEventEnvelope[];
  queue: AgentEvent[];
  scheduled: boolean;
};

export type EventPump = {
  push(envelope: AgentEventEnvelope): void;
  /** Declares that events up to `seq` are already applied (after loading a snapshot). */
  setLastSeq(chatId: ChatId, seq: number): void;
  forget(chatId: ChatId): void;
  /** Delivers queued events now (tests, unmount). */
  flush(): void;
};

const defaultSchedule = (flush: () => void) => {
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => flush());
  else setTimeout(flush, 16);
};

export function createEventPump(opts: PumpOptions): EventPump {
  const schedule = opts.schedule ?? defaultSchedule;
  const chats = new Map<ChatId, ChatPump>();
  const get = (id: ChatId): ChatPump => {
    let c = chats.get(id);
    if (!c) {
      c = { last: 0, resyncing: false, buffer: [], queue: [], scheduled: false };
      chats.set(id, c);
    }
    return c;
  };

  function flushChat(id: ChatId, c: ChatPump) {
    c.scheduled = false;
    if (c.queue.length === 0) return;
    const events = c.queue;
    c.queue = [];
    opts.onBatch(id, events, c.last);
  }

  function accept(id: ChatId, c: ChatPump, env: AgentEventEnvelope) {
    c.last = env.seq;
    c.queue.push(env.event);
    if (!c.scheduled) {
      c.scheduled = true;
      schedule(() => flushChat(id, c));
    }
  }

  function drain(id: ChatId, c: ChatPump) {
    const pending = c.buffer.sort((a, b) => a.seq - b.seq);
    c.buffer = [];
    for (const env of pending) handle(id, c, env);
  }

  function resync(id: ChatId, c: ChatPump) {
    c.resyncing = true;
    opts
      .snapshot({ chatId: id, afterSeq: c.last })
      .then((snap) => {
        for (const env of [...snap.events].sort((a, b) => a.seq - b.seq))
          if (env.seq > c.last) accept(id, c, env);
        opts.onResync?.(id, snap.state);
      })
      .catch((error: unknown) => opts.onResyncError?.(id, error))
      .finally(() => {
        // The snapshot is the most the backend still has. A hole it could not fill (a ring that
        // already dropped those events, or a failed call) is accepted: resyncing again would loop.
        const first = c.buffer.reduce((m, e) => Math.min(m, e.seq), Infinity);
        if (Number.isFinite(first) && first > c.last + 1) c.last = first - 1;
        c.resyncing = false;
        drain(id, c);
      });
  }

  function handle(id: ChatId, c: ChatPump, env: AgentEventEnvelope) {
    if (c.resyncing) {
      c.buffer.push(env);
      return;
    }
    if (env.seq <= c.last) return; // duplicate
    if (env.seq === c.last + 1) {
      accept(id, c, env);
      return;
    }
    c.buffer.push(env); // gap
    resync(id, c);
  }

  return {
    push: (env) => handle(env.chatId, get(env.chatId), env),
    setLastSeq: (id, seq) => {
      get(id).last = seq;
    },
    forget: (id) => void chats.delete(id),
    flush: () => {
      for (const [id, c] of chats) flushChat(id, c);
    },
  };
}
