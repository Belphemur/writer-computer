// The one store of the vault's version status, read by the status item, the panel and the
// settings page. Rust answers `git_status` (the single source); the store refreshes on the
// `git:changed` event, after every action and on a slow poll, so the pending count follows edits.
import { create } from "zustand";
import { logger } from "@/lib/logger";
import { status as fetchStatus, type GitStatus } from "../ipc";

interface StatusState {
  status: GitStatus | null;
  /** The status could not be read (no vault is open, or Rust refused). */
  unavailable: boolean;
  apply: (status: GitStatus) => void;
  /** `identity`: also ask git for the commit identity again (otherwise Rust remembers it). */
  refresh: (identity?: boolean) => Promise<void>;
  reset: () => void;
}

/** How often the pending count is read; commits and actions refresh at once through the event. */
export const POLL_MS = 10_000;

let inflight: Promise<void> | null = null;
/** An identity refresh asked for while a plain read was running: read once more afterwards. */
let again: Promise<void> | null = null;

export const useGitStatus = create<StatusState>((set) => {
  const read = async (identity: boolean) => {
    try {
      set({ status: (await fetchStatus(identity)) ?? null, unavailable: false });
    } catch {
      set({ status: null, unavailable: true });
      logger.warn("git", "status unavailable");
    }
  };
  return {
    status: null,
    unavailable: false,
    apply: (status) => set({ status, unavailable: false }),
    refresh: (identity = false) => {
      // one read at a time: a burst of events is one read; an identity refresh asked for during a
      // plain read is a second read after it (its answer must not be the remembered one)
      if (inflight) {
        if (!identity) return inflight;
        again ??= inflight.then(async () => {
          await read(true);
          again = null;
        });
        return again;
      }
      inflight = read(identity).finally(() => {
        inflight = null;
      });
      return inflight;
    },
    reset: () => set({ status: null, unavailable: false }),
  };
});

/** Starts reading: now, on a poll (`every` is `ctx.setInterval`) and on the event `onEvent` hooks
 *  (`ctx.listen`). Returns the stop function. */
export function startStatusSync(
  onEvent: (onChange: () => void) => () => void,
  every: (fn: () => void, ms: number) => () => void,
): () => void {
  const refresh = () => void useGitStatus.getState().refresh();
  refresh();
  const stopTimer = every(refresh, POLL_MS);
  const stopListening = onEvent(refresh);
  return () => {
    stopTimer();
    stopListening();
    useGitStatus.getState().reset();
  };
}
