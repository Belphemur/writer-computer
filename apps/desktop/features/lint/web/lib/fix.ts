// Fixing the note shown in an editor: "fix on save" (scope safe, the `lint.fix-on-save`
// before-save contribution), "Fix all" (scope all, the palette command) and one warning's "Fix".
// One apply path: the edits go in as one CodeMirror transaction, only when the document is still
// the one that was sent to Rust. The edits keep the caret and the selection (they map through
// changes), and the transaction is its own undo step (`isolateHistory`), so one undo restores the
// note exactly.
import { isolateHistory } from "@codemirror/commands";
import type { EditorView } from "@codemirror/view";
import { findEditorView } from "@/lib/editor-views";
import { check, fix, type Edit, type FixScope } from "../ipc";
import { anySafeRuleEnabled, fixOnSaveEnabled } from "./settings";

/** Notes longer than this are not linted (a transfer of megabytes per save is not worth it). */
export const MAX_LINT_CHARS = 1_000_000;

/** The user event of the fix transaction: tests and other extensions can tell it apart. */
export const FIX_EVENT = "lint.fix";

export const isMarkdownPath = (path: string) => /\.(md|markdown)$/i.test(path);

function applyEdits(view: EditorView, edits: readonly Edit[]): void {
  view.dispatch({
    changes: edits.map((e) => ({ from: e.from, to: e.to, insert: e.insert })),
    userEvent: FIX_EVENT,
    annotations: isolateHistory.of("full"),
  });
}

/** Fixes the note in `view`; returns whether the editor changed. A document edited while Rust
 *  worked is left alone (the next save tries again). */
export async function fixView(view: EditorView, scope: FixScope): Promise<boolean> {
  const doc = view.state.doc;
  if (doc.length > MAX_LINT_CHARS) return false;
  const fixed = await fix(doc.toString(), scope);
  if (fixed.edits.length === 0 || view.state.doc !== doc) return false;
  applyEdits(view, fixed.edits);
  return true;
}

/** One warning's "Fix": Rust lints the note again, so the edits are placed in the document as it
 *  is now, and the warning is found by its rule and start. Nothing happens when it is gone. */
export async function fixFinding(view: EditorView, rule: string, start: number): Promise<boolean> {
  const doc = view.state.doc;
  const finding = (await check(doc.toString())).find(
    (f) => f.rule === rule && f.start === start && f.fix.length > 0,
  );
  if (!finding || view.state.doc !== doc) return false;
  applyEdits(view, finding.fix);
  return true;
}

/** The `lint.fix-on-save` contribution: runs for a save the editor asked for, never for what an
 *  agent or the disk changed (those reload the note clean and do not save). */
export async function fixOnSave(path: string): Promise<void> {
  if (!isMarkdownPath(path) || !fixOnSaveEnabled() || !anySafeRuleEnabled()) return;
  const view = findEditorView(path);
  if (view) await fixView(view, "safe");
}
