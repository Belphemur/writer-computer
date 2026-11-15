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
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import type { SyntaxNode, SyntaxNodeRef } from "@lezer/common";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EmbeddedBase } from "@/components/base-view/embedded";
import { embedKey, isBaseFenceInfo, parseBaseEmbedLine, type BaseEmbed } from "@/lib/bases/embeds";
import { foldableSyntaxFacet } from "@/lib/prosemark-core/main";
import { parseFencedCode } from "./fenced-code";

/** Used until a widget has been measured once (title bar plus a few rows). */
const DEFAULT_ESTIMATED_HEIGHT = 160;
const HEIGHT_CACHE_LIMIT = 200;

// Last measured height per embed. The data loads after the widget is inserted, so without a
// remembered height every scroll past an embed inserts a placeholder that later snaps to size
// and shifts the heightmap under the viewport (same story as images in `fold/image.ts`).
const heightCache = new Map<string, number>();

function rememberHeight(key: string, height: number): void {
  heightCache.delete(key);
  heightCache.set(key, height);
  if (heightCache.size > HEIGHT_CACHE_LIMIT) {
    const oldest = heightCache.keys().next().value;
    if (oldest !== undefined) heightCache.delete(oldest);
  }
}

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

interface Mounted {
  root: Root;
  observer: ResizeObserver | null;
  unmounted: boolean;
}

// Keyed by the widget's DOM so `updateDOM` and `destroy` find the live root without going
// through CodeMirror state. Weak, so a dropped wrapper cannot leak a handle.
const mounted = new WeakMap<HTMLElement, Mounted>();

export class BaseEmbedWidget extends WidgetType {
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

  get estimatedHeight(): number {
    return heightCache.get(embedKey(this.embed)) ?? DEFAULT_ESTIMATED_HEIGHT;
  }

  private render(host: HTMLElement, view: EditorView): void {
    const handle = mounted.get(host);
    if (!handle || handle.unmounted) return;
    handle.root.render(
      createElement(EmbeddedBase, {
        embed: this.embed,
        notePath: this.notePath,
        onEdit: () => {
          if (!enterEmbedEditMode(view, host)) {
            console.error("[editor] base embed: could not find its source to edit");
          }
        },
      }),
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const host = document.createElement("div");
    host.className = "cm-base-embed";
    host.contentEditable = "false";
    const handle: Mounted = { root: createRoot(host), observer: null, unmounted: false };
    mounted.set(host, handle);
    // Height settles after the data loads: remember it and let CodeMirror re-measure while the
    // user is still interacting (docs/editor.md, heightmap shifts).
    if (typeof ResizeObserver !== "undefined") {
      let last = -1;
      handle.observer = new ResizeObserver(() => {
        const height = host.getBoundingClientRect().height;
        if (height <= 0 || Math.abs(height - last) < 1) return;
        last = height;
        rememberHeight(embedKey(this.embed), height);
        view.requestMeasure();
      });
      handle.observer.observe(host);
    }
    this.render(host, view);
    return host;
  }

  // Not `eq` but the same kind of block: keep the DOM and the React root, hand it the new embed.
  // This is what makes a source edit update the rendered base in place.
  updateDOM(dom: HTMLElement, view: EditorView): boolean {
    if (!mounted.has(dom)) return false;
    this.render(dom, view);
    return true;
  }

  destroy(dom: HTMLElement): void {
    const handle = mounted.get(dom);
    if (!handle) return;
    mounted.delete(dom);
    handle.unmounted = true;
    handle.observer?.disconnect();
    // `destroy` can run inside a React commit (a view torn down by an effect cleanup), where a
    // synchronous `root.unmount()` is refused.
    queueMicrotask(() => handle.root.unmount());
  }

  // Scrolling, tabs, links and buttons inside belong to the React tree; the explicit Edit
  // button (and the arrow keys, through `revealBlockOnArrow`) enter the source.
  ignoreEvent(): boolean {
    return true;
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

/** Registered by `createEditorExtensions`; `getFilePath` gives `this` (the embedding note). */
export function baseEmbedDecorations(getFilePath: () => string) {
  return [
    foldableSyntaxFacet.of({
      nodePath: "Paragraph",
      keepDecorationOnUnfold: true,
      buildDecorations: (state, node, touches) => {
        const found = baseEmbedInParagraph(state, node);
        return found ? decorate(found, getFilePath(), touches) : undefined;
      },
    }),
    foldableSyntaxFacet.of({
      nodePath: "FencedCode",
      keepDecorationOnUnfold: true,
      buildDecorations: (state, node, touches) => {
        const found = baseEmbedInFence(state, node);
        return found ? decorate(found, getFilePath(), touches) : undefined;
      },
    }),
    embedTheme,
  ];
}

export const __testBaseEmbed = { heightCache, mounted };
