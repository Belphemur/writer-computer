// A PDF embedded in a note: `![[paper.pdf#page=3&height=600]]` alone on a line renders the
// reader (`components/pdf-embed.tsx`, a React root hosted in a CodeMirror block widget).
//
// The decoration shape is the Bases and Excalidraw embeds' (docs/editor.md; the React host is the
// shared `lib/react-block-widget.ts`): the source line is replaced by the widget while the
// selection is away, and stays visible and editable, with the widget below it, while the selection
// touches it; both ride on `foldableSyntaxFacet`, so the arrow-key reveal comes for free. Only a
// `Paragraph` that is a direct child of the document counts (never code, a list item or a quote),
// and a paragraph that continues onto another line is not an embed.
import { type EditorState } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import type { SyntaxNodeRef } from "@lezer/common";
import { createElement, type ReactElement } from "react";
import { editorNotePath } from "@/lib/editor-views";
import { foldableSyntaxFacet } from "@/lib/prosemark-core/main";
import { HeightMemory, ReactBlockWidget } from "@/lib/react-block-widget";
import { PdfEmbed } from "./components/pdf-embed";
import { PDF_EMBED_DEFAULT_HEIGHT, parsePdfEmbedLine, type PdfEmbed as Embed } from "./lib/embeds";

/** The embed box plus its footer strip. */
const FOOTER_HEIGHT = 32;
const heightCache = new HeightMemory(PDF_EMBED_DEFAULT_HEIGHT + FOOTER_HEIGHT, 100);

export interface FoundEmbed {
  from: number;
  to: number;
  embed: Embed;
}

export function pdfEmbedInParagraph(state: EditorState, node: SyntaxNodeRef): FoundEmbed | null {
  if (node.name !== "Paragraph" || node.node.parent?.name !== "Document") return null;
  const line = state.doc.lineAt(node.from);
  if (node.to > line.to) return null;
  const embed = parsePdfEmbedLine(line.text);
  return embed ? { from: line.from, to: line.to, embed } : null;
}

class PdfEmbedWidget extends ReactBlockWidget {
  protected readonly className = "cm-pdf-embed";
  protected readonly heights = heightCache;

  constructor(
    readonly embed: Embed,
    readonly notePath: string,
  ) {
    super();
  }

  eq(other: PdfEmbedWidget): boolean {
    return (
      this.notePath === other.notePath &&
      this.embed.target === other.embed.target &&
      this.embed.page === other.embed.page &&
      this.embed.height === other.embed.height
    );
  }

  protected heightKey(): string {
    return `${this.embed.target}#${this.embed.height}`;
  }

  protected content(): ReactElement {
    return createElement(PdfEmbed, {
      target: this.embed.target,
      notePath: this.notePath,
      page: this.embed.page,
      height: this.embed.height,
    });
  }
}

function decorate(found: FoundEmbed, notePath: string, touches: boolean) {
  const widget = new PdfEmbedWidget(found.embed, notePath);
  return touches
    ? Decoration.widget({ widget, block: true, side: 1 }).range(found.to, found.to)
    : Decoration.replace({ widget, block: true }).range(found.from, found.to);
}

const embedTheme = EditorView.baseTheme({
  ".cm-pdf-embed": { padding: "6px 0" },
});

/** The feature's one editor extension (`index.ts`); `this` note comes from `editorNotePath`. */
export function pdfEmbedDecorations() {
  const notePath = (state: EditorState) => state.facet(editorNotePath)();
  return [
    foldableSyntaxFacet.of({
      nodePath: "Paragraph",
      keepDecorationOnUnfold: true,
      buildDecorations: (state, node, touches) => {
        const found = pdfEmbedInParagraph(state, node);
        return found ? decorate(found, notePath(state), touches) : undefined;
      },
    }),
    embedTheme,
  ];
}
