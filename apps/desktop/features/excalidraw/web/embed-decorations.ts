// A drawing embedded in a note: `![[Arch.excalidraw.md]]` alone on a line renders the drawing as
// a picture (`components/drawing-embed.tsx`, a React root hosted in a CodeMirror block widget).
//
// The decoration shape is the Bases embed's (docs/editor.md; the React host is the shared `lib/react-block-widget.ts`): the source line is replaced by the
// widget while the selection is away, and stays visible and editable, with the widget below it,
// while the selection touches it; both ride on `foldableSyntaxFacet`, so the arrow-key reveal
// comes for free. Only a `Paragraph` that is a direct child of the document counts (never code,
// a list item or a quote), and a paragraph that continues onto another line is not an embed.
import { type EditorState } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import type { SyntaxNodeRef } from "@lezer/common";
import { createElement, type ReactElement } from "react";
import { editorNotePath } from "@/lib/editor-views";
import { closeFullscreenWithEditor } from "@/lib/fullscreen-overlay";
import { foldableSyntaxFacet } from "@/lib/prosemark-core/main";
import { HeightMemory, ReactBlockWidget } from "@/lib/react-block-widget";
import { DrawingEmbed } from "./components/drawing-embed";
import { parseDrawingEmbedLine, type DrawingEmbed as Embed } from "./lib/embeds";

const heightCache = new HeightMemory(240, 100);

export interface FoundEmbed {
  from: number;
  to: number;
  embed: Embed;
}

export function drawingEmbedInParagraph(
  state: EditorState,
  node: SyntaxNodeRef,
): FoundEmbed | null {
  if (node.name !== "Paragraph" || node.node.parent?.name !== "Document") return null;
  const line = state.doc.lineAt(node.from);
  if (node.to > line.to) return null;
  const embed = parseDrawingEmbedLine(line.text);
  return embed ? { from: line.from, to: line.to, embed } : null;
}

class DrawingEmbedWidget extends ReactBlockWidget {
  protected readonly className = "cm-drawing-embed";
  protected readonly heights = heightCache;

  constructor(
    readonly embed: Embed,
    readonly notePath: string,
  ) {
    super();
  }

  eq(other: DrawingEmbedWidget): boolean {
    return this.notePath === other.notePath && this.embed.target === other.embed.target;
  }

  protected heightKey(): string {
    return this.embed.target;
  }

  protected content(host: HTMLElement): ReactElement {
    return createElement(DrawingEmbed, {
      target: this.embed.target,
      notePath: this.notePath,
      host,
    });
  }
}

function decorate(found: FoundEmbed, notePath: string, touches: boolean) {
  const widget = new DrawingEmbedWidget(found.embed, notePath);
  return touches
    ? Decoration.widget({ widget, block: true, side: 1 }).range(found.to, found.to)
    : Decoration.replace({ widget, block: true }).range(found.from, found.to);
}

const embedTheme = EditorView.baseTheme({
  ".cm-drawing-embed": { padding: "6px 0" },
});

/** The feature's one editor extension (`index.ts`); `this` note comes from `editorNotePath`. */
export function drawingEmbedDecorations() {
  const notePath = (state: EditorState) => state.facet(editorNotePath)();
  return [
    foldableSyntaxFacet.of({
      nodePath: "Paragraph",
      keepDecorationOnUnfold: true,
      buildDecorations: (state, node, touches) => {
        const found = drawingEmbedInParagraph(state, node);
        return found ? decorate(found, notePath(state), touches) : undefined;
      },
    }),
    embedTheme,
    // the full screen of an embed closes with the note
    closeFullscreenWithEditor(),
  ];
}
