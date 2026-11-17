import { create } from "zustand";
import type { ChatId, RevertOutcome, TurnChanges } from "@features/agent/web/lib/events";
import { getAgentClient } from "@features/agent/web/stores/agent-store";
import { logger } from "@/lib/logger";

/** Diff details and Undo state of the "Changes" cards, keyed `<chatId>:<turnId>`. The summary
 *  lives in the transcript (and the chat note); this holds what only the backend can answer:
 *  the diffs while its in-memory snapshot exists, and what Undo did. */
export type TurnChangesEntry = {
  /** `unavailable`: the backend has no snapshot (the app restarted, or it was dropped). */
  status: "loading" | "ready" | "unavailable" | "error";
  data: TurnChanges | null;
  error: string | null;
  /** An Undo is running. */
  busy: boolean;
  /** Last outcome per path, shown inline ("file changed since"). */
  outcomes: Record<string, RevertOutcome>;
};

type State = {
  entries: Record<string, TurnChangesEntry>;
  load: (chatId: ChatId, turnId: string) => Promise<void>;
  revert: (chatId: ChatId, turnId: string, paths: string[]) => Promise<void>;
};

export const changesKey = (chatId: ChatId, turnId: string) => `${chatId}:${turnId}`;

const EMPTY: TurnChangesEntry = {
  status: "loading",
  data: null,
  error: null,
  busy: false,
  outcomes: {},
};

export const useTurnChangesStore = create<State>()((set, get) => {
  const patch = (key: string, p: Partial<TurnChangesEntry>) =>
    set((s) => ({ entries: { ...s.entries, [key]: { ...(s.entries[key] ?? EMPTY), ...p } } }));
  const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
  return {
    entries: {},

    load: async (chatId, turnId) => {
      const key = changesKey(chatId, turnId);
      const known = get().entries[key];
      if (known && known.status !== "error") return;
      patch(key, { status: "loading", error: null });
      try {
        const client = await getAgentClient();
        const data = await client.turnChanges({ chatId, turnId });
        patch(key, data ? { status: "ready", data } : { status: "unavailable", data: null });
      } catch (e) {
        logger.warn("agent", "could not load turn changes");
        patch(key, { status: "error", error: message(e) });
      }
    },

    revert: async (chatId, turnId, paths) => {
      const key = changesKey(chatId, turnId);
      if (get().entries[key]?.busy) return;
      patch(key, { busy: true });
      try {
        const client = await getAgentClient();
        const outcomes = await client.revertChanges({ chatId, turnId, paths });
        if (!outcomes) {
          patch(key, { busy: false, status: "unavailable", data: null });
          return;
        }
        const data = await client.turnChanges({ chatId, turnId });
        patch(key, {
          busy: false,
          outcomes: {
            ...get().entries[key]?.outcomes,
            ...Object.fromEntries(outcomes.map((o) => [o.path, o])),
          },
          ...(data ? { data } : {}),
        });
      } catch (e) {
        const failed = Object.fromEntries(
          paths.map((p): [string, RevertOutcome] => [
            p,
            { path: p, result: "failed", message: message(e) },
          ]),
        );
        patch(key, {
          busy: false,
          outcomes: { ...get().entries[key]?.outcomes, ...failed },
        });
      }
    },
  };
});
