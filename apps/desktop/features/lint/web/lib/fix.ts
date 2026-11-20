// Fixing the note shown in an editor: "fix on idle" (scope safe, the `idleFix` editor
// extension, switched by the `lint.fix-on-save` setting), "Fix all" (scope all, the palette command) and one warning's "Fix".
// One apply path: the edits go in as one CodeMirror transaction, only when the document is still
// the one that was sent to Rust. The edits keep the caret and the selection (they map through
// changes), and the transaction is its own undo step (`isolateHistory`), so one undo restores the
// note exactly.
import { isolateHistory } from "@codemirror/commands";
import type { EditorState } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { editorNotePath } from "@/lib/editor-views";
import { logger } from "@/lib/logger";
import { check, fix, type Edit, type FixScope, type KeepRange } from "../ipc";
import { anySafeRuleEnabled, fixOnSaveEnabled } from "./settings";

/** Notes longer than this are not linted (a transfer of megabytes per save is not worth it). */
export const MAX_LINT_CHARS = 1_000_000;

/** The user event of the fix transaction: tests and other extensions can tell it apart. */
export const FIX_EVENT = "lint.fix";

/** The pause after the last keystroke before the editor's warnings are checked. */
export const LINT_DEBOUNCE_MS = 1000;
/** The pause after the last keystroke before the safe fixes run. */
export const FIX_IDLE_MS = 5000;

export const isMarkdownPath = (path: string) => /\.(md|markdown)$/i.test(path);

function applyEdits(view: EditorView, edits: readonly Edit[]): void {
  view.dispatch({
    changes: edits.map((e) => ({ from: e.from, to: e.to, insert: e.insert })),
    userEvent: FIX_EVENT,
    annotations: isolateHistory.of("full"),
  });
}

/** The lines holding a caret or a selection, whole: what an autosave must not rewrite under the
 *  user's hands (`# ` would lose its space, a trailing space its place). */
export function editedLines(state: EditorState): KeepRange[] {
  return state.selection.ranges.map((r) => ({
    from: state.doc.lineAt(r.from).from,
    to: state.doc.lineAt(r.to).to,
  }));
}

/** Fixes the note in `view`; returns whether the editor changed. With `keepEditedLines` a fix
 *  never touches a line with a caret or selection (an autosave while typing); without it
 *  everything is fixed (the user asked). A document, or a selection when lines are kept, changed
 *  while Rust worked leaves the editor alone (the next save tries again). */
export async function fixView(
  view: EditorView,
  scope: FixScope,
  { keepEditedLines = false } = {},
): Promise<boolean> {
  const { doc, selection } = view.state;
  if (doc.length > MAX_LINT_CHARS) return false;
  const keep = keepEditedLines ? editedLines(view.state) : [];
  const fixed = await fix(doc.toString(), scope, keep);
  if (fixed.edits.length === 0 || view.state.doc !== doc) return false;
  if (keepEditedLines && !view.state.selection.eq(selection)) return false;
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

/** Fix on idle: once the note has had no edit for `FIX_IDLE_MS`, the safe fixes run, never on a
 *  line with a caret or selection and never mid-composition (an IME). The fix is an edit like
 *  any other, so the normal autosave writes it; closing the tab first leaves the note unfixed.
 *  The timer restarts on every edit by the user (the fix's own transaction does not) and dies
 *  with the view. */
export const idleFix = ViewPlugin.fromClass(
  class {
    timer: ReturnType<typeof setTimeout> | undefined;
    constructor(readonly view: EditorView) {}
    update(u: ViewUpdate) {
      if (!u.docChanged || u.transactions.every((t) => t.isUserEvent(FIX_EVENT))) return;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.run(), FIX_IDLE_MS);
    }
    async run() {
      const { view } = this;
      const path = view.state.facet(editorNotePath)();
      if (!path || !isMarkdownPath(path) || !fixOnSaveEnabled() || !anySafeRuleEnabled()) return;
      if (view.composing || view.compositionStarted) return;
      try {
        await fixView(view, "safe", { keepEditedLines: true });
      } catch (e) {
        logger.warn("lint", `the fix failed: ${String(e)}`);
      }
    }
    destroy() {
      clearTimeout(this.timer);
    }
  },
);
