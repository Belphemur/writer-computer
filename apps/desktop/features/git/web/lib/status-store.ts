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

export const useGitStatus = create<StatusState>((set) => ({
  status: null,
  unavailable: false,
  apply: (status) => set({ status, unavailable: false }),
  refresh: (identity = false) => {
    // one read at a time: a burst of events is one read
    inflight ??= (async () => {
      try {
        set({ status: (await fetchStatus(identity)) ?? null, unavailable: false });
      } catch {
        set({ status: null, unavailable: true });
        logger.warn("git", "status unavailable");
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  },
  reset: () => set({ status: null, unavailable: false }),
}));

/** Starts reading: now, on a poll, and on `listen`'s event. Returns the stop function. */
export function startStatusSync(listen: (onChange: () => void) => () => void): () => void {
  const refresh = () => void useGitStatus.getState().refresh();
  refresh();
  const timer = setInterval(refresh, POLL_MS);
  const stopListening = listen(refresh);
  return () => {
    clearInterval(timer);
    stopListening();
    useGitStatus.getState().reset();
  };
}
