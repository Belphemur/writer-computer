// The editor extension of the feature:
// - a click on a task's checkbox, or on the symbol of a custom status, goes through Rust, so the
//   done date, the next occurrence of a recurring task and the status cycle of the vault all apply
//   (core's checkbox only flips `[ ]` and `[x]`). It runs ahead of core's handler (`Prec.highest`),
//   takes the click, and applies the answer only when the line is still what it was;
// - custom statuses are drawn with their own symbol (`status-marks.ts`);
// - completions after a signifier or a Dataview key (`completions-source.ts`);
// - the card of a ```tasks block (`query-decorations.ts`).
import { Prec, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { completionSources } from "@/lib/editor-completion-sources";
import { toggleTaskLine } from "./actions";
import { taskCompletionSource } from "./completions-source";
import { tasksQueryCards } from "./query-decorations";
import { STATUS_CLASS, statusMarks } from "./status-marks";

const CLICKABLE = `.cm-list-prefix-task, .${STATUS_CLASS}`;

export function tasksEditor(): Extension {
  return [
    Prec.highest(
      EditorView.domEventHandlers({
        click(event, view) {
          const target = event.target;
          if (!(target instanceof Element) || !target.closest(CLICKABLE)) return false;
          const line = view.state.doc.lineAt(view.posAtDOM(target));
          void toggleTaskLine(view, line.from);
          return true;
        },
      }),
    ),
    statusMarks,
    completionSources.of(taskCompletionSource),
    tasksQueryCards(),
  ];
}
