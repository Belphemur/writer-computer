/**
 * The data of the one diff component (`components/diff`): the shapes Rust's shared text diff
 * (`src-tauri/src/text_diff`) sends, for the agent's Changes card and the Git history, and the
 * folding both views use. Structurally the generated `DiffRow`, `NoteDiff` ... of each feature's
 * bindings, so a feature passes its own wire value as is.
 */

export type DiffRow = {
  kind: "context" | "add" | "del";
  /** 1-based; null on an added row. */
  oldLine: number | null;
  /** 1-based; null on a removed row. */
  newLine: number | null;
  text: string;
};

export type DiffPart = { op: "eq" | "ins" | "del"; text: string };

export type DiffBlock = {
  style: "paragraph" | "heading" | "list-item" | "quote" | "code" | "rule";
  /** Heading level (1 to 6) or list depth. */
  level: number;
  change: "same" | "added" | "removed" | "changed";
  parts: DiffPart[];
};

/** A changed front matter property: `before` null when added, `after` null when removed. */
export type DiffProp = { name: string; before: string | null; after: string | null };

/** The rendered view of a note. */
export type NoteDiff = { front: DiffProp[]; blocks: DiffBlock[] };

/** One text diff as the component takes it. */
export interface TextDiffData {
  rows: readonly DiffRow[];
  truncated?: boolean;
  /** Present for a Markdown note: the rendered view and the Source toggle. */
  rendered?: NoteDiff | null;
  /** Only whitespace and line breaks changed. */
  formattingOnly?: boolean;
}

/** Unchanged items kept next to a change. */
export const CONTEXT_LINES = 3;
/** Rows rendered before "Show more". */
export const PAGE_ROWS = 400;

export type Segment<T> =
  | { kind: "rows"; rows: T[] }
  /** Unchanged items folded away; shown by a "Show N ..." button. */
  | { kind: "gap"; rows: T[] };

/** Folds runs of unchanged items, keeping `context` of them next to every change. A run that
 *  would hide fewer than 2 items stays visible (a "Show 1 line" button is worse than the line). */
export function foldRuns<T>(
  items: readonly T[],
  isQuiet: (item: T) => boolean,
  context = CONTEXT_LINES,
): Segment<T>[] {
  const segments: Segment<T>[] = [];
  const push = (kind: Segment<T>["kind"], part: T[]) => {
    if (part.length === 0) return;
    const last = segments[segments.length - 1];
    if (last && last.kind === kind) last.rows.push(...part);
    else segments.push({ kind, rows: part });
  };
  let i = 0;
  while (i < items.length) {
    if (!isQuiet(items[i]!)) {
      let j = i;
      while (j < items.length && !isQuiet(items[j]!)) j++;
      push("rows", items.slice(i, j) as T[]);
      i = j;
      continue;
    }
    let j = i;
    while (j < items.length && isQuiet(items[j]!)) j++;
    const run = items.slice(i, j) as T[];
    const head = i === 0 ? 0 : context; // after a change
    const tail = j === items.length ? 0 : context; // before a change
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

/** The line diff folded: unchanged lines far from a change are hidden. */
export const collapseContext = (rows: readonly DiffRow[], context = CONTEXT_LINES) =>
  foldRuns(rows, (r) => r.kind === "context", context);
