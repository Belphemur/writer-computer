// Obsidian Bases embedded in a note: `![[x.base]]`, `![[x.base#View]]` (an alias after `|` is
// ignored) and fenced ```base blocks render as a read-only `EmbeddedBase` (a React root hosted
// in a CodeMirror block widget).
//
// Decoration shape (docs/editor.md): conditional replace <-> widget, as in `fold/image.ts`.
// The source is replaced by the widget while the selection is away and stays visible, editable
// in the main editor, with the widget below it while the selection touches it. Why not
// replace-only like Mermaid: a Mermaid fence has a nested editor in its canvas; a base embed has
// none, and the point of the source is a single line (or a short YAML block) the writer edits
// with the keyboard, with the rendered base updating live underneath. Both shapes ride on
// `foldableSyntaxFacet`, so drag-freeze, parse-commit rebuilds and the arrow-key reveal
// (`revealBlockOnArrow`) come for free.
import { EditorSelection, type EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { Decoration, EditorView } from "@codemirror/view";
import type { SyntaxNode, SyntaxNodeRef } from "@lezer/common";
import { createElement, type ReactElement } from "react";
import { EmbeddedBase } from "./view/embedded";
import { embedKey, isBaseFenceInfo, parseBaseEmbedLine, type BaseEmbed } from "./lib/embeds";
import { editorNotePath } from "@/lib/editor-views";
import { foldableSyntaxFacet } from "@/lib/prosemark-core/main";
import { HeightMemory, ReactBlockWidget } from "@/lib/react-block-widget";
import { parseFencedCode } from "@/components/editor-area/fenced-code";

// Last measured height per embed (title bar plus a few rows until measured). The data loads after
// the widget is inserted, so without a remembered height every scroll past an embed shifts the
// heightmap under the viewport (same story as images in `fold/image.ts`).
const heightCache = new HeightMemory(160, 200);

// ---------------------------------------------------------------------------
// Finding embeds in the syntax tree
// ---------------------------------------------------------------------------

export interface FoundEmbed {
  /** The whole block: the embed line, or the whole fence including its markers. */
  from: number;
  to: number;
  embed: BaseEmbed;
}

/**
 * `![[x.base]]` alone on a top-level line. Only a `Paragraph` that is a direct child of the
 * document counts, so frontmatter, code (fenced, indented, inline), HTML comments, list items and
 * block quotes never render one; a paragraph that continues onto the next line is not an embed.
 */
export function baseEmbedInParagraph(state: EditorState, node: SyntaxNodeRef): FoundEmbed | null {
  if (node.name !== "Paragraph" || node.node.parent?.name !== "Document") return null;
  const line = state.doc.lineAt(node.from);
  if (node.to > line.to) return null;
  const embed = parseBaseEmbedLine(line.text);
  return embed ? { from: line.from, to: line.to, embed } : null;
}

/** A closed fenced ```base block with a non-empty body. */
export function baseEmbedInFence(state: EditorState, node: SyntaxNodeRef): FoundEmbed | null {
  if (node.name !== "FencedCode") return null;
  const parsed = parseFencedCode(state, node);
  if (!parsed || !isBaseFenceInfo(parsed.info)) return null;
  // An unclosed fence is still being typed; replacing it would swallow the line under the caret.
  if (!parsed.closed || parsed.source.trim() === "") return null;
  return { from: node.from, to: node.to, embed: { kind: "block", text: parsed.source } };
}

/** Every embed in the document, in order (used by tests and the live lookup). */
export function findBaseEmbeds(state: EditorState): FoundEmbed[] {
  const found: FoundEmbed[] = [];
  syntaxTree(state).iterate({
    enter(node) {
      const hit = baseEmbedInParagraph(state, node) ?? baseEmbedInFence(state, node);
      if (hit) found.push(hit);
    },
  });
  return found;
}

/**
 * The embed whose widget is `host`, looked up live (docs/editor.md: no positions on widgets).
 * A widget anchored at a block boundary reports `posAtDOM === node.to` or `node.from`, so both
 * resolve sides are tried.
 */
export function findEmbedAtHost(view: EditorView, host: HTMLElement): FoundEmbed | null {
  const pos = view.posAtDOM(host);
  const tree = syntaxTree(view.state);
  for (const side of [-1, 1] as const) {
    let node: SyntaxNode | null = tree.resolveInner(pos, side);
    while (node) {
      const hit = baseEmbedInParagraph(view.state, node) ?? baseEmbedInFence(view.state, node);
      if (hit) return hit;
      node = node.parent;
    }
  }
  return null;
}

/**
 * Enter source-edit mode: range-select the whole block (reverse anchor), which flips
 * `selectionTouchesRange` and unfolds the source (docs/editor.md; a caret at a point is fragile).
 * `scrollSnapshot` for the replace -> widget height shift.
 */
export function enterEmbedEditMode(view: EditorView, host: HTMLElement): boolean {
  const found = findEmbedAtHost(view, host);
  if (!found) return false;
  view.dispatch({
    selection: EditorSelection.single(found.to, found.from),
    effects: view.scrollSnapshot(),
    scrollIntoView: true,
  });
  view.contentDOM.focus({ preventScroll: true });
  return true;
}

// ---------------------------------------------------------------------------
// The widget
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The widget
// ---------------------------------------------------------------------------

export class BaseEmbedWidget extends ReactBlockWidget {
  protected readonly className = "cm-base-embed";
  protected readonly heights = heightCache;

  constructor(
    readonly embed: BaseEmbed,
    /** Absolute path of the embedding note (`this`). */
    readonly notePath: string,
  ) {
    super();
  }

  // Visual identity only: what is embedded and for which note. Positions never enter it, so
  // typing above the embed keeps this widget (and its React root, view choice and data).
  eq(other: BaseEmbedWidget): boolean {
    return this.notePath === other.notePath && embedKey(this.embed) === embedKey(other.embed);
  }

  protected heightKey(): string {
    return embedKey(this.embed);
  }

  protected content(host: HTMLElement, view: EditorView): ReactElement {
    return createElement(EmbeddedBase, {
      embed: this.embed,
      notePath: this.notePath,
      onEdit: () => {
        if (!enterEmbedEditMode(view, host)) {
          console.error("[editor] base embed: could not find its source to edit");
        }
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Decorations
// ---------------------------------------------------------------------------

function decorate(found: FoundEmbed, notePath: string, touches: boolean) {
  const widget = new BaseEmbedWidget(found.embed, notePath);
  // `side: 1` puts a block widget after the line it is anchored on (the default is above it).
  return touches
    ? Decoration.widget({ widget, block: true, side: 1 }).range(found.to, found.to)
    : Decoration.replace({ widget, block: true }).range(found.from, found.to);
}

const embedTheme = EditorView.baseTheme({
  // Padding, not margin: CodeMirror measures a block widget's own box, not its margins.
  ".cm-base-embed": { padding: "6px 0" },
});

/** The feature's one editor extension (`index.ts`); `this` is the embedding note, which the
 *  `editorNotePath` facet of `createEditorExtensions` gives each editor. */
export function baseEmbedDecorations() {
  const notePath = (state: EditorState) => state.facet(editorNotePath)();
  return [
    foldableSyntaxFacet.of({
      nodePath: "Paragraph",
      keepDecorationOnUnfold: true,
      buildDecorations: (state, node, touches) => {
        const found = baseEmbedInParagraph(state, node);
        return found ? decorate(found, notePath(state), touches) : undefined;
      },
    }),
    foldableSyntaxFacet.of({
      nodePath: "FencedCode",
      keepDecorationOnUnfold: true,
      buildDecorations: (state, node, touches) => {
        const found = baseEmbedInFence(state, node);
        return found ? decorate(found, notePath(state), touches) : undefined;
      },
    }),
    embedTheme,
  ];
}

export const __testBaseEmbed = { heightCache };
