// ```tasks blocks in a note: a small card (`query-card-view.tsx`) in a CodeMirror block widget, the
// same decoration shape as the Bases and Dataview blocks (docs/editor.md): the source is replaced
// by the card while the selection is away and stays editable, with the card under it, while the
// selection touches it. Blocks are never run; the card converts them to a base.
import type { EditorState } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import type { SyntaxNodeRef } from "@lezer/common";
import { createElement, type ReactElement } from "react";
import { parseFencedCode } from "@/components/editor-area/fenced-code";
import { enterBlockEditMode, HeightMemory, ReactBlockWidget } from "@/lib/react-block-widget";
import { foldableSyntaxFacet } from "@/lib/prosemark-core/main";
import { convertTasksBlock } from "./actions";
import { tasksBlockAt } from "./lib/blocks";
import { TasksQueryCard } from "./query-card-view";

const heightCache = new HeightMemory(70, 100);

/** A closed fenced ```tasks block with a non-empty body. */
export function tasksQueryInFence(state: EditorState, node: SyntaxNodeRef) {
  if (node.name !== "FencedCode") return null;
  const parsed = parseFencedCode(state, node);
  if (!parsed || parsed.info.trim().toLowerCase() !== "tasks") return null;
  if (!parsed.closed || parsed.source.trim() === "") return null;
  return { from: node.from, to: node.to, source: parsed.source };
}

class TasksQueryWidget extends ReactBlockWidget {
  protected readonly className = "cm-tasks-query";
  protected readonly heights = heightCache;

  constructor(readonly source: string) {
    super();
  }

  eq(other: TasksQueryWidget): boolean {
    return this.source === other.source;
  }

  protected heightKey(): string {
    return this.source;
  }

  protected content(host: HTMLElement, view: EditorView): ReactElement {
    // looked up live: a widget keeps no position (docs/editor.md)
    const block = () => tasksBlockAt(view.state.doc.toString(), view.posAtDOM(host));
    return createElement(TasksQueryCard, {
      source: this.source,
      onConvert: async () => {
        const b = block();
        return b ? convertTasksBlock(view, b.from) : false;
      },
      onEdit: () => {
        const b = block();
        if (b) enterBlockEditMode(view, b);
      },
    });
  }
}

const theme = EditorView.baseTheme({ ".cm-tasks-query": { padding: "6px 0" } });

export function tasksQueryCards() {
  return [
    foldableSyntaxFacet.of({
      nodePath: "FencedCode",
      keepDecorationOnUnfold: true,
      buildDecorations: (state, node, touches) => {
        const found = tasksQueryInFence(state, node);
        if (!found) return undefined;
        const widget = new TasksQueryWidget(found.source);
        return touches
          ? Decoration.widget({ widget, block: true, side: 1 }).range(found.to, found.to)
          : Decoration.replace({ widget, block: true }).range(found.from, found.to);
      },
    }),
    theme,
  ];
}
