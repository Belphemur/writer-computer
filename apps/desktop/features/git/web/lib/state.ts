// What the status item and the panel say about the vault: one pure reading of the status.
import type { GitStatus } from "../ipc";

export type Tone = "ok" | "pending" | "error" | "quiet";

export interface Summary {
  /** `Synced`, `Pending n`, `Syncing`, `Conflict n`, `Offline`, `Error`, `Paused` or `Local`. */
  label: string;
  tone: Tone;
  /** One line for an error: what to do about it. */
  detail?: string;
  /** The vault is not set up and the choice is the user's: a click opens Settings > Git. */
  setup?: boolean;
}

export const IDENTITY_HINT = "Set your git name and email";

/** `null` while the vault has no history and Writer is about to set it up: the footer item is
 *  hidden. A vault inside another repository, or one the user stopped, asks for the user's choice. */
export function summarize(status: GitStatus | null): Summary | null {
  if (!status) return null;
  if (!status.setUp) {
    if (status.stopped) return { label: "History off", tone: "quiet", setup: true };
    if (status.parentRepo && !status.hasRepo) {
      return {
        label: "History off",
        tone: "quiet",
        setup: true,
        detail: "This vault is inside another repository",
      };
    }
    return null;
  }
  if (status.identityError) {
    return { label: "Error", tone: "error", detail: IDENTITY_HINT };
  }
  if (status.error) return { label: "Error", tone: "error", detail: status.error };
  // a merge, rebase or detached HEAD: Writer commits nothing and resumes by itself when it ends
  if (status.operation) {
    return { label: "Paused", tone: "quiet", detail: `Paused: ${status.operation}` };
  }
  const linked = status.remote !== null;
  if (linked) {
    if (status.syncing) return { label: "Syncing", tone: "pending" };
    if (status.conflicts.length > 0) {
      return {
        label: `Conflict ${status.conflicts.length}`,
        tone: "error",
        detail: "Some files could not be merged",
      };
    }
    const failure = status.syncError;
    if (failure) {
      return failure.offline
        ? { label: "Offline", tone: "quiet", detail: failure.line }
        : { label: "Error", tone: "error", detail: failure.line };
    }
  }
  if (status.paused) return { label: "Paused", tone: "quiet" };
  if (linked && status.syncPaused) return { label: "Paused", tone: "quiet", detail: "Sync paused" };
  const pending = status.changes.length + (linked ? status.ahead : 0);
  if (pending > 0) return { label: `Pending ${pending}`, tone: "pending" };
  return linked ? { label: "Synced", tone: "ok" } : { label: "Local", tone: "ok" };
}

export const IDENTITY_COMMANDS = [
  'git config --global user.name "Your Name"',
  "git config --global user.email you@example.com",
];

/** The name a changed file shows: the note's title, any other file with its extension. */
export function fileLabel(path: string): string {
  const name = path.split("/").pop() ?? path;
  return name.replace(/\.md$/i, "");
}

export const KIND_LABEL: Record<string, string> = {
  add: "Added",
  edit: "Edited",
  delete: "Deleted",
  move: "Moved",
};
