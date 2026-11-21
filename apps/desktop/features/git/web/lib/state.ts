// What the status item and the panel say about the vault: one pure reading of the status.
import type { GitStatus } from "../ipc";

export type Tone = "ok" | "pending" | "error" | "quiet";

export interface Summary {
  /** `Local`, `Pending n`, `Paused` or `Error`. */
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
  if (status.paused) return { label: "Paused", tone: "quiet" };
  if (status.changes.length > 0) {
    return { label: `Pending ${status.changes.length}`, tone: "pending" };
  }
  return { label: "Local", tone: "ok" };
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
