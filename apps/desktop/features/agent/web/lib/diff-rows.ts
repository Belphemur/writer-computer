/**
 * Pure presentation helpers of the "Changes" card (spec "Turn changes"): which unchanged lines to
 * fold behind "Show N lines", the totals of the header and the labels. The diff itself is
 * computed in Rust (`changes.rs`); this only decides what to show.
 */
import type { ChangeStatus, DiffRow, FileChangeSummary } from "./events";

/** Unchanged lines kept next to a change. */
export const CONTEXT_LINES = 3;
/** Rows rendered before "Show more". */
export const PAGE_ROWS = 400;

export type DiffSegment =
  | { kind: "rows"; rows: DiffRow[] }
  /** Unchanged lines folded away; shown by "Show N lines". */
  | { kind: "gap"; rows: DiffRow[] };

/** Folds runs of unchanged lines, keeping `context` of them next to every change. A run that
 *  would hide fewer than 2 lines stays visible (a "Show 1 line" button is worse than the line). */
export function collapseContext(rows: readonly DiffRow[], context = CONTEXT_LINES): DiffSegment[] {
  const segments: DiffSegment[] = [];
  const push = (kind: DiffSegment["kind"], part: DiffRow[]) => {
    if (part.length === 0) return;
    const last = segments[segments.length - 1];
    if (last && last.kind === kind) last.rows.push(...part);
    else segments.push({ kind, rows: part });
  };
  let i = 0;
  while (i < rows.length) {
    if (rows[i]!.kind !== "context") {
      let j = i;
      while (j < rows.length && rows[j]!.kind !== "context") j++;
      push("rows", rows.slice(i, j) as DiffRow[]);
      i = j;
      continue;
    }
    let j = i;
    while (j < rows.length && rows[j]!.kind === "context") j++;
    const run = rows.slice(i, j) as DiffRow[];
    const head = i === 0 ? 0 : context; // after a change
    const tail = j === rows.length ? 0 : context; // before a change
    const hidden = run.length - head - tail;
    if (hidden >= 2) {
      push("rows", run.slice(0, head));
      push("gap", run.slice(head, run.length - tail));
      push("rows", run.slice(run.length - tail));
    } else {
      push("rows", run);
    }
    i = j;
  }
  return segments;
}

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
