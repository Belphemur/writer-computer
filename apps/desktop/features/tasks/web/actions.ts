// What the feature's commands, menu item and editor click do. Loaded on first use (the entry
// stays light). Every task write goes through Rust (`ipc.ts`): the grammar, the done date and the
// next occurrence of a recurring task are not re-implemented here.
import type { EditorView } from "@codemirror/view";
import { getActiveFilePath } from "@/hooks/editor-api";
import { getWorkspaceRoot } from "@/hooks/workspace-api";
import { showEditorNotice } from "@/components/editor-area/editor-notice-store";
import { findEditorView } from "@/lib/editor-views";
import { logger } from "@/lib/logger";
import { getRelativePath } from "@/lib/paths";
import { tasksBlockAt } from "./lib/blocks";
import { replaceLineSpec } from "./lib/editor-lines";
import { localToday } from "./lib/today";
import { taskLineInfo, taskLineToggle, tasksConvertBlock } from "./ipc";
import { offerTasksTakeover } from "./takeover";
import { useTasksUi } from "./store";

function activeEditor(): EditorView | null {
  return findEditorView(getActiveFilePath());
}

/** Toggle the task whose line starts at `from`: the next status of its cycle, the done date, the
 *  next occurrence of a recurring task. Answers `false` when nothing was done. */
export async function toggleTaskLine(view: EditorView, from: number): Promise<boolean> {
  const text = view.state.doc.lineAt(from).text;
  try {
    const lines = await taskLineToggle(text, localToday());
    const spec = replaceLineSpec(view.state, from, text, lines);
    if (!spec) {
      showEditorNotice("The task changed meanwhile; try again.");
      return false;
    }
    view.dispatch(spec);
    void offerTasksTakeover();
    return true;
  } catch (e) {
    logger.warn("app", `could not toggle a task: ${e instanceof Error ? e.message : String(e)}`);
    showEditorNotice("Could not change this task.");
    return false;
  }
}

/** "Toggle task": the task line under the caret. */
export async function toggleTaskAtCaret(): Promise<void> {
  const view = activeEditor();
  if (!view) return;
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  if (!(await taskLineInfo(line.text))) {
    showEditorNotice("The caret is not on a task.");
    return;
  }
  await toggleTaskLine(view, line.from);
}

/** "Edit task": the dialog for the task line under the caret. */
export async function editTaskAtCaret(): Promise<void> {
  const view = activeEditor();
  if (!view) return;
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  if (!(await taskLineInfo(line.text))) {
    showEditorNotice("The caret is not on a task.");
    return;
  }
  useTasksUi.getState().openEdit({ view, from: line.from, text: line.text });
}

export function openQuickAdd(): void {
  useTasksUi.getState().openQuickAdd();
}

/** Is the document position inside a ```tasks block? */
export function hasTasksBlockAt(view: EditorView, pos: number): boolean {
  return tasksBlockAt(view.state.doc.toString(), pos) !== null;
}

/**
 * "Convert tasks block to base" for the ```tasks block at `pos` (the caret when absent): a dry run
 * first, so a block with an instruction no base can express is left as it is and the first such
 * instruction is named; otherwise the base is written next to the note and the block becomes its
 * embed.
 */
export async function convertTasksBlock(view: EditorView, pos?: number): Promise<boolean> {
  const root = getWorkspaceRoot();
  const abs = getActiveFilePath();
  if (!root || !abs) return false;
  const at = pos ?? view.state.selection.main.head;
  const block = tasksBlockAt(view.state.doc.toString(), at);
  if (!block) {
    showEditorNotice("The caret is not in a tasks block.");
    return false;
  }
  try {
    const note = getRelativePath(abs, root);
    const result = await tasksConvertBlock(note, block.source, true);
    if (!result.embed) {
      const first = result.unmapped[0];
      showEditorNotice(
        first
          ? `Line ${first.line} has no base equivalent: ${first.reason}`
          : "This block has no base equivalent.",
      );
      return false;
    }
    // the block may have moved while Rust wrote the base: find it again before replacing
    const now = tasksBlockAt(view.state.doc.toString(), at);
    if (!now || now.source !== block.source) {
      showEditorNotice("The block changed meanwhile; the base was written, embed it by hand.");
      return false;
    }
    view.dispatch({ changes: { from: now.from, to: now.to, insert: result.embed } });
    return true;
  } catch (e) {
    logger.warn(
      "app",
      `could not convert a tasks block: ${e instanceof Error ? e.message : String(e)}`,
    );
    showEditorNotice("Could not convert this block.");
    return false;
  }
}
