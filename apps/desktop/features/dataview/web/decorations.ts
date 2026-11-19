// ```dataview and ```dataviewjs blocks in a note: a read-only React widget in a CodeMirror block
// widget, the same decoration shape as the Bases embeds (docs/editor.md): the source is replaced
// by the widget while the selection is away and stays editable, with the widget under it, while
// the selection touches it. The widget (`dataview-block.tsx`) lowers the query in Rust and shows
// it through the Bases views; `dataviewjs` is a placeholder, nothing is ever evaluated here.
import { EditorSelection, type EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { Decoration, EditorView } from "@codemirror/view";
import type { SyntaxNode, SyntaxNodeRef } from "@lezer/common";
import { createElement, type ReactElement } from "react";
import { editorNotePath } from "@/lib/editor-views";
import { HeightMemory, ReactBlockWidget } from "@/lib/react-block-widget";
import { foldableSyntaxFacet } from "@/lib/prosemark-core/main";
import { parseFencedCode } from "@/components/editor-area/fenced-code";
import { blockKey, blockKindOfInfo, type DataviewBlock } from "./blocks";
import { DataviewBlockView } from "./dataview-block";

// Last measured height per block (the shared helper explains why).
const heightCache = new HeightMemory(160, 100);

export interface FoundBlock {
  from: number;
  to: number;
  block: DataviewBlock;
}

/** A closed fenced ```dataview or ```dataviewjs block with a non-empty body. */
export function dataviewBlockInFence(state: EditorState, node: SyntaxNodeRef): FoundBlock | null {
  if (node.name !== "FencedCode") return null;
  const parsed = parseFencedCode(state, node);
  if (!parsed) return null;
  const kind = blockKindOfInfo(parsed.info);
  // An unclosed fence is still being typed; replacing it would swallow the line under the caret.
  if (!kind || !parsed.closed || parsed.source.trim() === "") return null;
  return { from: node.from, to: node.to, block: { kind, source: parsed.source } };
}

/** Every block in the document, in order. */
export function findDataviewBlocks(state: EditorState): FoundBlock[] {
  const found: FoundBlock[] = [];
  syntaxTree(state).iterate({
    enter(node) {
      const hit = dataviewBlockInFence(state, node);
      if (hit) found.push(hit);
    },
  });
  return found;
}

/** The block whose widget is `host`, looked up live (docs/editor.md: no positions on widgets). */
function findBlockAtHost(view: EditorView, host: HTMLElement): FoundBlock | null {
  const pos = view.posAtDOM(host);
  const tree = syntaxTree(view.state);
  for (const side of [-1, 1] as const) {
    let node: SyntaxNode | null = tree.resolveInner(pos, side);
    while (node) {
      const hit = dataviewBlockInFence(view.state, node);
      if (hit) return hit;
      node = node.parent;
    }
  }
  return null;
}

/** Range-select the whole block (reverse anchor) so the source unfolds (docs/editor.md). */
function enterEditMode(view: EditorView, host: HTMLElement): boolean {
  const found = findBlockAtHost(view, host);
  if (!found) return false;
  view.dispatch({
    selection: EditorSelection.single(found.to, found.from),
    effects: view.scrollSnapshot(),
    scrollIntoView: true,
  });
  view.contentDOM.focus({ preventScroll: true });
  return true;
}

function replaceBlock(view: EditorView, host: HTMLElement, text: string): boolean {
  const found = findBlockAtHost(view, host);
  if (!found) return false;
  view.dispatch({ changes: { from: found.from, to: found.to, insert: text } });
  return true;
}

export class DataviewWidget extends ReactBlockWidget {
  protected readonly className = "cm-dataview-block";
  protected readonly heights = heightCache;

  constructor(
    readonly block: DataviewBlock,
    /** Absolute path of the note holding the block (`this`). */
    readonly notePath: string,
  ) {
    super();
  }

  eq(other: DataviewWidget): boolean {
    return this.notePath === other.notePath && blockKey(this.block) === blockKey(other.block);
  }

  protected heightKey(): string {
    return blockKey(this.block);
  }

  protected content(host: HTMLElement, view: EditorView): ReactElement {
    return createElement(DataviewBlockView, {
      block: this.block,
      notePath: this.notePath,
      onEdit: () => {
        if (!enterEditMode(view, host)) console.error("[editor] dataview: no source to edit");
      },
      onReplace: (text: string) => {
        if (!replaceBlock(view, host, text))
          console.error("[editor] dataview: no block to replace");
      },
    });
  }
}

function decorate(found: FoundBlock, notePath: string, touches: boolean) {
  const widget = new DataviewWidget(found.block, notePath);
  return touches
    ? Decoration.widget({ widget, block: true, side: 1 }).range(found.to, found.to)
    : Decoration.replace({ widget, block: true }).range(found.from, found.to);
}

const blockTheme = EditorView.baseTheme({
  ".cm-dataview-block": { padding: "6px 0" },
});

/** The feature's one editor extension (`index.ts`); `this` is the note the editor shows. */
export function dataviewDecorations() {
  const notePath = (state: EditorState) => state.facet(editorNotePath)();
  return [
    foldableSyntaxFacet.of({
      nodePath: "FencedCode",
      keepDecorationOnUnfold: true,
      buildDecorations: (state, node, touches) => {
        const found = dataviewBlockInFence(state, node);
        return found ? decorate(found, notePath(state), touches) : undefined;
      },
    }),
    blockTheme,
  ];
}

export const __testDataviewBlocks = { heightCache };
