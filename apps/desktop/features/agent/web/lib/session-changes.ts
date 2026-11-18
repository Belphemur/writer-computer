/**
 * The chat's changed notes: the one state behind the row above the composer and the "Session
 * changes" tab (ADR 2026-11-18). The backend (`changes.rs`) sends the whole live list in each
 * `session-changes` event; this module folds it into the chat, restores the list from the chat
 * note (paths and counts, never text) and answers the one question both views ask:
 * `selectSessionChanges(chat)`.
 */
import { totals } from "./diff-rows";
import type { ChangeStatus, FileChangeSummary, SessionChangesSummary } from "./events";

export type SessionChangesState = {
  /** What the backend reports now: counts against the first touch since Writer started. */
  live: FileChangeSummary[];
  /** The list a reopened chat's note held; an entry stays until the backend reports its path. */
  restored: FileChangeSummary[];
  /** The user closed the row; the next change to the list brings it back. */
  hidden: boolean;
};

export type SessionChangesView = {
  files: FileChangeSummary[];
  added: number;
  removed: number;
  /** Paths whose diff Writer no longer has (restored from the note, not touched since). */
  restored: ReadonlySet<string>;
  hidden: boolean;
};

/** A state from the list a chat note holds. */
export function restoreSessionChanges(files: FileChangeSummary[]): SessionChangesState {
  return { live: [], restored: files, hidden: false };
}

const signature = (files: readonly FileChangeSummary[]) => JSON.stringify(files);

/** Folds one `session-changes` event. The row comes back (`hidden` false) only when the list
 *  changed, so the repeat at the end of a turn does not reopen a closed row. */
export function foldSessionChanges(
  prev: SessionChangesState | undefined,
  event: SessionChangesSummary,
): SessionChangesState {
  const live = event.files;
  const same = prev !== undefined && signature(prev.live) === signature(live);
  return {
    live,
    restored: prev?.restored ?? [],
    hidden: same ? prev.hidden : false,
  };
}

export const hideSessionChanges = (s: SessionChangesState): SessionChangesState =>
  s.hidden ? s : { ...s, hidden: true };

/** The list as the note stores it: restored entries the backend has not superseded, then live. */
export function sessionChangesFiles(s: SessionChangesState): FileChangeSummary[] {
  const live = new Set(s.live.map((f) => f.path));
  return [...s.restored.filter((f) => !live.has(f.path)), ...s.live];
}

/** The chat's changed notes, or null when it has none. One selector for the row and the tab. */
export function selectSessionChanges(chat: {
  sessionChanges?: SessionChangesState;
}): SessionChangesView | null {
  const s = chat.sessionChanges;
  if (!s) return null;
  const files = sessionChangesFiles(s);
  if (files.length === 0) return null;
  const live = new Set(s.live.map((f) => f.path));
  return {
    files,
    ...totals(files),
    restored: new Set(s.restored.filter((f) => !live.has(f.path)).map((f) => f.path)),
    hidden: s.hidden,
  };
}

/** "Changed 3 notes". */
export const changedNotesLabel = (count: number): string =>
  `Changed ${count} ${count === 1 ? "note" : "notes"}`;

/** The marks of a row: a plain edit has none. */
export const STATUS_MARK: Record<ChangeStatus, string | null> = {
  added: "created",
  modified: null,
  deleted: "deleted",
  renamed: "renamed",
};

/** The mark of a row: a command-changed file is only known to differ, not whether it was created. */
export function statusMark(f: Pick<FileChangeSummary, "origin" | "status">): string | null {
  return f.origin === "command" && f.status !== "deleted" ? null : STATUS_MARK[f.status];
}

/** A path as the row shows it: the file name without `.md`, and its folder. */
export function noteParts(path: string): { name: string; folder: string } {
  const cut = path.lastIndexOf("/");
  const file = path.slice(cut + 1);
  return {
    name: file.replace(/\.md$/i, ""),
    folder: cut > 0 ? path.slice(0, cut) : "",
  };
}
