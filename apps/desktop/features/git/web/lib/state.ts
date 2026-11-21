// What the status item and the panel say about the vault: one pure reading of the status.
import type { GitStatus } from "../ipc";

export type Tone = "ok" | "pending" | "error" | "quiet";

export interface Summary {
  /** `Local`, `Pending n`, `Paused` or `Error`. */
  label: string;
  tone: Tone;
  /** One line for an error: what to do about it. */
  detail?: string;
}

export const IDENTITY_HINT = "Set your git name and email";

/** `null` while the vault has no history: the footer item is hidden. */
export function summarize(status: GitStatus | null): Summary | null {
  if (!status || !status.setUp) return null;
  if (status.identityError) {
    return { label: "Error", tone: "error", detail: IDENTITY_HINT };
  }
  if (status.error) return { label: "Error", tone: "error", detail: status.error };
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
