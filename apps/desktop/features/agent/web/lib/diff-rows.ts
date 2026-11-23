/**
 * Pure presentation helpers of the "Changes" card (spec "Turn changes"): which unchanged lines to
 * fold behind "Show N lines", the totals of the header and the labels. The diff itself is
 * computed in Rust (`changes.rs`, the shared `text_diff`); this only decides what to show. The
 * folding and the diff view are core's (`@/lib/text-diff`, `@/components/diff`).
 */
import type { ChangeOrigin, ChangeStatus, FileChangeSummary } from "./events";

export { CONTEXT_LINES, PAGE_ROWS, collapseContext } from "@/lib/text-diff";
export type { Segment as DiffSegment } from "@/lib/text-diff";

export function totals(files: readonly FileChangeSummary[]): { added: number; removed: number } {
  return files.reduce((t, f) => ({ added: t.added + f.added, removed: t.removed + f.removed }), {
    added: 0,
    removed: 0,
  });
}

/** "3 files changed" / "1 file changed". */
export function filesChangedLabel(count: number): string {
  return `${count} ${count === 1 ? "file" : "files"} changed`;
}

export const STATUS_LABEL: Record<ChangeStatus, string> = {
  added: "Added",
  modified: "Modified",
  deleted: "Deleted",
  renamed: "Renamed",
};

/** The files that are not an ordinary edit: a small marker, a tooltip and, when there is no diff
 *  (no trusted "before"), the line shown where it would be. A command-changed file whose "before"
 *  is vouched for (the Git history, spec "Turn changes") keeps the marker and has a diff and Undo. */
export const ORIGIN_NOTE: Record<
  Exclude<ChangeOrigin, "edit"> | "command-compared",
  { marker: string; title: string; body?: string }
> = {
  command: {
    marker: "by command",
    title: "Changed while a command of this chat was running, not necessarily by it",
    body: "Changed while a shell command was running: listed without a diff",
  },
  "command-compared": {
    marker: "by command",
    title:
      "Changed while a shell command was running; compared with the version from before the turn",
  },
  "before-unknown": {
    marker: "before unknown",
    title: "The text from before the edit could not be captured",
    body: "Edited, but the text from before is not known: listed without a diff",
  },
};

/** The note of a file that is not an ordinary edit; `undefined` for one. */
export function originNote(f: Pick<FileChangeSummary, "origin" | "beforeKnown">) {
  if (!f.origin || f.origin === "edit") return undefined;
  return ORIGIN_NOTE[f.origin === "command" && f.beforeKnown ? "command-compared" : f.origin];
}

/** A command-changed file with no "before": only known to differ, not whether it was created. */
export function commandWithoutBefore(
  f: Pick<FileChangeSummary, "origin" | "beforeKnown">,
): boolean {
  return f.origin === "command" && !f.beforeKnown;
}

/** Status word of a file row: a command-changed file with no "before" is only known to differ
 *  ("Changed"), as whether it was created or modified is not known. */
export function statusLabel(
  f: Pick<FileChangeSummary, "origin" | "beforeKnown" | "status">,
): string {
  return commandWithoutBefore(f) && f.status !== "deleted" ? "Changed" : STATUS_LABEL[f.status];
}

/** Shortens the middle of a long path, keeping the folder start and the file name; the full path
 *  goes in a tooltip. */
export function middleTruncate(path: string, max = 48): string {
  if (path.length <= max) return path;
  const keepEnd = Math.min(path.length - 1, Math.max(12, Math.floor(max * 0.6)));
  const keepStart = Math.max(1, max - keepEnd - 1);
  return `${path.slice(0, keepStart)}…${path.slice(path.length - keepEnd)}`;
}

/** A single-file turn opens its diff at once; many files start folded (spec). */
export function defaultExpanded(fileCount: number): { card: boolean; firstFile: boolean } {
  return { card: fileCount <= 5, firstFile: fileCount === 1 };
}
