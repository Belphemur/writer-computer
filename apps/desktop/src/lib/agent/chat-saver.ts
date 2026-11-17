/**
 * Debounced, serialised autosave of chat notes (spec section 9): one write at a time per chat,
 * a change during a write schedules exactly one more, streaming deltas never reach it (the
 * store schedules only after a send and a `turn-finished`).
 */
import type { ChatId, ChatSummary } from "./events";

export type SaveRequest = { markdown: string; titleHint: string };

export type SaverOptions = {
  save: (chatId: ChatId, req: SaveRequest) => Promise<ChatSummary>;
  onSaved?: (chatId: ChatId, summary: ChatSummary) => void;
  onError?: (chatId: ChatId, error: unknown) => void;
  delayMs?: number;
};

type Slot = {
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: Promise<void> | null;
  dirty: boolean;
  build: () => SaveRequest | null;
};

export type ChatSaver = {
  /** Writes after the debounce with whatever `build` returns then (null skips). */
  schedule(chatId: ChatId, build: () => SaveRequest | null): void;
  /** Writes now (closing a tab, tests) and resolves when nothing is pending. */
  flush(chatId: ChatId): Promise<void>;
  cancel(chatId: ChatId): void;
};

export function createChatSaver(opts: SaverOptions): ChatSaver {
  const delay = opts.delayMs ?? 500;
  const slots = new Map<ChatId, Slot>();

  async function run(chatId: ChatId, slot: Slot): Promise<void> {
    slot.timer = null;
    if (slot.inFlight) {
      slot.dirty = true;
      return slot.inFlight;
    }
    const req = slot.build();
    if (!req) return;
    slot.inFlight = (async () => {
      try {
        const summary = await opts.save(chatId, req);
        opts.onSaved?.(chatId, summary);
      } catch (e) {
        opts.onError?.(chatId, e);
      } finally {
        slot.inFlight = null;
      }
      if (slot.dirty) {
        slot.dirty = false;
        await run(chatId, slot);
      }
    })();
    return slot.inFlight;
  }

  return {
    schedule(chatId, build) {
      const slot = slots.get(chatId) ?? { timer: null, inFlight: null, dirty: false, build };
      slots.set(chatId, slot);
      slot.build = build;
      if (slot.timer) clearTimeout(slot.timer);
      slot.timer = setTimeout(() => void run(chatId, slot), delay);
    },
    async flush(chatId) {
      const slot = slots.get(chatId);
      if (!slot) return;
      if (slot.timer) {
        clearTimeout(slot.timer);
        await run(chatId, slot);
      }
      await slot.inFlight;
    },
    cancel(chatId) {
      const slot = slots.get(chatId);
      if (slot?.timer) clearTimeout(slot.timer);
      slots.delete(chatId);
    },
  };
}
