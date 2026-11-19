// Replacing one task line of an editor with what Rust answered. The answer is computed from the
// line's text at click time; when the line changed meanwhile (typing, another edit) the answer is
// dropped instead of applied over newer text.
import type { EditorState, TransactionSpec } from "@codemirror/state";

/** The change that replaces line `from..` (its text was `expected`) by `lines`, or `null` when
 *  the document no longer has `expected` there. No lines removes the line with its break. */
export function replaceLineSpec(
  state: EditorState,
  from: number,
  expected: string,
  lines: readonly string[],
): TransactionSpec | null {
  if (from < 0 || from > state.doc.length) return null;
  const line = state.doc.lineAt(from);
  if (line.from !== from || line.text !== expected) return null;
  if (lines.length > 0) {
    return {
      changes: { from: line.from, to: line.to, insert: lines.join("\n") },
      userEvent: "input.tasks",
    };
  }
  // the line goes with one line break: the one after it, or before it for the last line
  const [start, end] =
    line.to < state.doc.length ? [line.from, line.to + 1] : [Math.max(0, line.from - 1), line.to];
  return { changes: { from: start, to: end }, userEvent: "delete.tasks" };
}
