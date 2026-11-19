// Custom statuses in the editor: core draws a checkbox for `[ ]` and `[x]` only, so a task such
// as `- [/] doing` is a bullet with `[/]` in its text. This marks that `[c]` as the status symbol
// (drawn as a small box with the character; the text stays, so the caret and selection behave) and
// a click on it cycles the status through Rust like a checkbox does (`editor.ts`).
import { RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { isInsideCode } from "@/components/editor-area/wiki-link-extension";
import { renderedRanges, renderedRangesChanged } from "@/lib/prosemark-core/utils";

export const STATUS_CLASS = "cm-task-status";

/** A list item whose box holds a character core does not draw (not space, `x` or `X`). */
const CUSTOM_STATUS = /^([ \t]*(?:[-+*]|\d+[.)])[ \t]+\[)([^ xX\]])(\][ \t])/;

/** The `[c]` range of the custom status on `text` (a line starting at `lineFrom`), or null. */
export function customStatusRange(
  text: string,
  lineFrom: number,
): { from: number; to: number; symbol: string } | null {
  const m = CUSTOM_STATUS.exec(text);
  if (!m) return null;
  const from = lineFrom + m[1]!.length - 1;
  return { from, to: from + 3, symbol: m[2]! };
}

function build(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  let lastLine = -1;
  for (const { from, to } of renderedRanges(view)) {
    for (let pos = from; pos <= to;) {
      const line = view.state.doc.lineAt(pos);
      pos = line.to + 1;
      if (line.number <= lastLine) continue;
      lastLine = line.number;
      const hit = customStatusRange(line.text, line.from);
      if (!hit || isInsideCode(view.state, hit.from)) continue;
      builder.add(
        hit.from,
        hit.to,
        Decoration.mark({
          class: STATUS_CLASS,
          attributes: { "data-status": hit.symbol, title: "Task status" },
        }),
      );
    }
  }
  return builder.finish();
}

const plugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || renderedRangesChanged(update)) {
        this.decorations = build(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

const theme = EditorView.baseTheme({
  [`.${STATUS_CLASS}`]: {
    cursor: "pointer",
    borderRadius: "3px",
    border: "1px solid var(--line-subtle, currentColor)",
    padding: "0 2px",
    fontSize: "0.85em",
    color: "var(--text-muted, inherit)",
  },
});

export const statusMarks = [plugin, theme];
