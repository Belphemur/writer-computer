import { Decoration, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { type EditorState, RangeSetBuilder } from "@codemirror/state";
import type { DecorationSet } from "@codemirror/view";
import { WidgetType } from "@codemirror/view";
import { type Extension } from "@codemirror/state";
import { createCodeCopyButton } from "@/lib/code-copy-button";
import { isFrontmatterNode } from "./markdown/frontmatter";
import { codeBlockText } from "./codeBlockText";
import {
  CODE_LINE_CLASS,
  CODE_LINE_FIRST_CLASS,
  CODE_LINE_LAST_CLASS,
  codeBlockScrollExtension,
  codeBlockAt,
  codeBlockScrollField,
  isCodeBlockNode,
} from "./codeFenceScroll";
import { renderedRanges, renderedRangesChanged, treeChanged } from "./utils";

const fallbackMonospaceCodeFont =
  "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace";
const codeFontFamily = `var(--pm-code-font, ${fallbackMonospaceCodeFont})`;
const editorFontSize = "var(--writer-editor-font-size, 16px)";

type Range = { from: number; to: number };

export const CODE_COPY_SLOT_CLASS = "cm-code-copy-slot";
const CODE_COPY_VISIBLE_CLASS = "is-visible";

/** Start of the code block holding the caret (-1 when it is in none): its copy button shows. */
const activeBlockFrom = (state: EditorState): number =>
  codeBlockAt(state, state.selection.main.head)?.from ?? -1;

/** Line decorations for every fenced code / frontmatter block touching
 *  `ranges`, with each block's horizontal scroll `offsets` (by block start)
 *  rendered as a negative `text-indent` on all of its lines, and a copy button
 *  on the first line of each fenced or indented block (not frontmatter), shown
 *  while the caret is in the block (`activeFrom`) or the block is hovered. */
const buildCodeBlockDecorations = (
  state: EditorState,
  ranges: readonly Range[],
  offsets: ReadonlyMap<number, number>,
  activeFrom = -1,
): DecorationSet => {
  const builder = new RangeSetBuilder<Decoration>();

  // If there are multiple visible ranges, it's possible to see
  // the same code block multiple times
  const visited = new Set<string>();

  for (const { from, to } of ranges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        if (isCodeBlockNode(node)) {
          const isFrontmatter = isFrontmatterNode(node);
          const key = JSON.stringify([node.from, node.to]);
          if (visited.has(key)) return;
          visited.add(key);

          const offset = offsets.get(node.from) ?? 0;
          const attributes = offset > 0 ? { style: `text-indent:-${offset}px` } : undefined;

          for (let pos = node.from; pos <= node.to;) {
            const line = state.doc.lineAt(pos);
            const isFirstLine = pos === node.from;
            const isLastLine = line.to >= node.to;

            builder.add(
              line.from,
              line.from,
              Decoration.line({
                class: `${CODE_LINE_CLASS} ${isFirstLine ? CODE_LINE_FIRST_CLASS : ""} ${
                  isLastLine ? CODE_LINE_LAST_CLASS : ""
                }`,
                ...(attributes ? { attributes } : {}),
              }),
            );

            if (isFirstLine && !isFrontmatter) {
              builder.add(
                line.from,
                line.from,
                Decoration.widget({
                  widget: new CodeCopyWidget(node.from === activeFrom),
                }),
              );
            }

            pos = line.to + 1;
          }
        }
      },
    });
  }

  return builder.finish();
};

const codeBlockDecorations = (view: EditorView) =>
  buildCodeBlockDecorations(
    view.state,
    renderedRanges(view),
    view.state.field(codeBlockScrollField),
    activeBlockFrom(view.state),
  );

/** The copy button of a code block, at the top right of its first line. It copies the block's
 *  code from the document as it is when clicked: the block is found again from the widget's
 *  place, so an edited block, or one that moved, copies what it holds now. The button is part of
 *  no selection or copied text (it holds none, and a press never takes focus from the editor). */
class CodeCopyWidget extends WidgetType {
  constructor(readonly active: boolean) {
    super();
  }

  eq(other: CodeCopyWidget) {
    return other.active === this.active;
  }

  toDOM(view: EditorView) {
    const slot = document.createElement("span");
    slot.className = CODE_COPY_SLOT_CLASS;
    slot.setAttribute("contenteditable", "false");
    if (this.active) slot.classList.add(CODE_COPY_VISIBLE_CLASS);
    slot.append(
      createCodeCopyButton(() => {
        const line = view.state.doc.lineAt(view.posAtDOM(slot));
        const block = codeBlockAt(view.state, line.to);
        return block && block.from <= line.to ? codeBlockText(view.state, block) : "";
      }),
    );
    return slot;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

/** The first line of the code block a hovered element belongs to. */
const blockFirstLine = (target: EventTarget | null): Element | null => {
  let line = target instanceof Element ? target.closest(`.${CODE_LINE_CLASS}`) : null;
  while (line && !line.classList.contains(CODE_LINE_FIRST_CLASS)) {
    const previous: Element | null = line.previousElementSibling;
    line = previous?.classList.contains(CODE_LINE_CLASS) ? previous : null;
  }
  return line;
};

const codeBlockDecorationsPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    activeFrom: number;
    hovered: Element | null = null;

    constructor(view: EditorView) {
      this.decorations = codeBlockDecorations(view);
      this.activeFrom = activeBlockFrom(view.state);
    }

    /** Show the copy button of the hovered block (every line of it counts, not only the first). */
    hover(target: EventTarget | null) {
      const slot = blockFirstLine(target)?.querySelector(`.${CODE_COPY_SLOT_CLASS}`) ?? null;
      if (slot === this.hovered) return;
      this.hovered?.classList.remove(CODE_COPY_VISIBLE_CLASS);
      slot?.classList.add(CODE_COPY_VISIBLE_CLASS);
      this.hovered = slot;
    }

    update(update: ViewUpdate) {
      const activeFrom =
        update.selectionSet || update.docChanged ? activeBlockFrom(update.state) : this.activeFrom;
      const activeChanged = activeFrom !== this.activeFrom;
      this.activeFrom = activeFrom;
      if (
        activeChanged ||
        update.docChanged ||
        renderedRangesChanged(update) ||
        treeChanged(update) ||
        update.state.field(codeBlockScrollField) !== update.startState.field(codeBlockScrollField)
      ) {
        this.decorations = codeBlockDecorations(update.view);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
    eventHandlers: {
      mouseover(event) {
        this.hover(event.target);
      },
      mouseleave() {
        this.hover(null);
      },
    },
  },
);

export const codeBlockDecorationsExtension: Extension = [
  codeBlockScrollExtension,
  codeBlockDecorationsPlugin,
];

const codeFenceThemeSpec = {
  ".cm-fenced-code-line": {
    display: "block",
    marginLeft: "6px",
    backgroundColor: "var(--pm-code-background-color)",
    fontFamily: codeFontFamily,
    fontSize: editorFontSize,
    fontVariantLigatures: "none",
    fontFeatureSettings: '"calt" 0',
    fontKerning: "none",
    // Code never wraps. Overflow is clipped (not scrolled: a line must not
    // become a scroll container, see codeFenceScroll.ts) and the block scrolls
    // as one through the `text-indent` decoration on each of its lines.
    whiteSpace: "pre",
    overflowX: "clip",
  },
  // In case the active line color changes
  ".cm-activeLine.cm-fenced-code-line": {
    backgroundColor: "var(--pm-code-background-color)",
  },
  ".cm-fenced-code-line-first": {
    // Anchors the copy button (`CodeCopyWidget`), laid over the line out of the text flow.
    position: "relative",
    borderTopLeftRadius: "0.4rem",
    borderTopRightRadius: "0.4rem",
  },
  ".cm-fenced-code-line-last": {
    borderBottomLeftRadius: "0.4rem",
    borderBottomRightRadius: "0.4rem",
  },
  // Drawn by `codeBlockScrollbarLayer` along the bottom of a block whose
  // lines overflow; styled like the app's overlay scrollbars.
  ".cm-code-scrollbar-thumb": {
    borderRadius: "3px",
    backgroundColor: "var(--scrollbar-thumb, rgba(128, 128, 128, 0.5))",
    opacity: "0.6",
    transition: "opacity 120ms",
  },
  ".cm-code-scrollbar-thumb:hover, .cm-code-scrollbar-thumb.cm-code-scrollbar-dragging": {
    opacity: "1",
  },
  // No layout shift, and un-indented by the block's horizontal scroll (`text-indent` inherits).
  [`.${CODE_COPY_SLOT_CLASS}`]: {
    position: "absolute",
    top: "0.3em",
    right: "0.3em",
    textIndent: "0",
    whiteSpace: "normal",
    lineHeight: "0",
    opacity: "0",
    transition: "opacity 120ms",
  },
  [`.${CODE_COPY_SLOT_CLASS}.${CODE_COPY_VISIBLE_CLASS}, .${CODE_COPY_SLOT_CLASS}:focus-within`]: {
    opacity: "1",
  },
};

export const codeFenceTheme = EditorView.theme(codeFenceThemeSpec);

export const __testCodeFenceExtension = {
  codeFenceThemeSpec,
  buildCodeBlockDecorations,
};
