import {
  Decoration,
  type DecorationSet,
  EditorView,
  tooltips,
  type ViewUpdate,
  ViewPlugin,
  WidgetType,
} from "@codemirror/view";
import { type EditorState, type Extension, Prec, RangeSetBuilder } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { convertFileSrc } from "@tauri-apps/api/core";
import * as tauri from "@/lib/tauri";
import { getWorkspaceRoot } from "@/hooks/workspace-api";
import { linkActivationExtension, wikiLinkTarget } from "@/lib/link-activation";
import { LINK_ICON_CLASS, WIKI_LINK_CLASS } from "@/lib/link-dom";
import { contributedCompletions } from "@/lib/editor-completion-sources";
import { watchLinkIcon } from "@/lib/file-icons";
import { fillIconElement } from "@/lib/icon-picker/icon-dom";
import {
  wikiSuggestions,
  parseWikiLink,
  parseWikiImageEmbedTarget,
  resolveWikiImage,
  WIKI_SUGGEST_TRIGGER,
  wikiLinkScanner,
} from "@/lib/wiki-links";
import { attachStableImageHeight } from "@/lib/prosemark-core/fold/image";
import { getEffectiveSelectionRanges } from "./drag-selection-gate";
import { renderedRanges, renderedRangesChanged } from "@/lib/prosemark-core/utils";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// `wikiLinkScanner()` captures the optional `!` embed prefix (Obsidian image embeds) apart from
// the inner target: treating `![[img.png]]` as a plain wiki link used to render a link widget
// with a stray literal `!`.

const CODE_NODE_NAMES = new Set(["FencedCode", "InlineCode", "CodeBlock", "CodeText", "CodeInfo"]);

export function isInsideCode(state: EditorState, pos: number): boolean {
  let inside = false;
  syntaxTree(state).iterate({
    from: pos,
    to: pos,
    enter(node) {
      if (CODE_NODE_NAMES.has(node.name)) {
        inside = true;
        return false;
      }
    },
  });
  return inside;
}

/**
 * Extract the wiki-link target text from the line containing `pos`.
 * Searches the whole line for a `[[...]]` token whose range covers `pos`,
 * so it works both when clicking raw text and replace-widget positions.
 */
function extractWikiTarget(
  doc: { lineAt(pos: number): { from: number; text: string } },
  pos: number,
): string | null {
  const line = doc.lineAt(pos);

  for (const match of line.text.matchAll(wikiLinkScanner())) {
    const matchStart = line.from + match.index;
    const matchEnd = matchStart + match[0].length;
    if (pos >= matchStart && pos <= matchEnd) {
      return match[2]!;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Decorations — fold [[...]] into a clean link widget, unfold when editing
// ---------------------------------------------------------------------------

/** Stops the icon watch of a link widget's element once CodeMirror drops it. */
const iconWatchers = new WeakMap<HTMLElement, () => void>();

class WikiLinkWidget extends WidgetType {
  constructor(
    readonly target: string,
    readonly sourcePath: string | null = null,
  ) {
    super();
  }

  eq(other: WikiLinkWidget): boolean {
    return this.target === other.target;
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = WIKI_LINK_CLASS;
    // The icon of the note the link points to (`lib/file-icons.ts`; hidden, and empty, while the
    // note has none), before the text.
    const icon = document.createElement("span");
    icon.className = LINK_ICON_CLASS;
    icon.setAttribute("aria-hidden", "true");
    icon.style.display = "none";
    span.append(icon, document.createTextNode(parseWikiLink(this.target).displayText));
    iconWatchers.set(
      span,
      watchLinkIcon(this.target, this.sourcePath, (entry) =>
        fillIconElement(icon, entry?.icon, { color: entry?.color }),
      ),
    );
    return span;
  }

  destroy(dom: HTMLElement): void {
    iconWatchers.get(dom)?.();
    iconWatchers.delete(dom);
  }

  ignoreEvent(): boolean {
    return false;
  }
}

const wikiLinkEditingMark = Decoration.mark({ class: "cm-wiki-link-editing" });

// Resolved embed targets, keyed by workspace root + note dir + target.
// Positive-only: a hit means the file existed at that absolute path when we
// looked; misses re-probe on the next widget build so newly added images
// appear without an invalidation channel. Bounded in practice by the number
// of distinct embeds the user views in a session.
const embedResolutionCache = new Map<string, string>();

async function resolveEmbed(
  target: string,
  workspaceRoot: string | null,
  currentFilePath: string | null,
): Promise<string | null> {
  const key = `${workspaceRoot ?? ""}\0${currentFilePath ?? ""}\0${target}`;
  const cached = embedResolutionCache.get(key);
  if (cached) return cached;
  const resolved = await resolveWikiImage(
    target,
    workspaceRoot,
    currentFilePath,
    tauri.fileExists,
    tauri.findFileByName,
  );
  if (resolved) embedResolutionCache.set(key, resolved);
  return resolved;
}

/** Obsidian-style image embed `![[image.png]]`. Renders the resolved image
 *  inline (reusing the `.cm-image` styling and the shared height-stability
 *  cache from `fold/image.ts`); unresolved targets render the raw source
 *  text as a muted placeholder. */
class ImageEmbedWidget extends WidgetType {
  constructor(
    readonly rawText: string,
    readonly target: string,
    readonly workspaceRoot: string | null,
    readonly currentFilePath: string | null,
  ) {
    super();
  }

  eq(other: ImageEmbedWidget): boolean {
    return (
      this.rawText === other.rawText &&
      this.target === other.target &&
      this.workspaceRoot === other.workspaceRoot &&
      this.currentFilePath === other.currentFilePath
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const elem = document.createElement("span");
    elem.className = "cm-image cm-image-embed";
    const image = document.createElement("img");
    attachStableImageHeight(image, elem, this.target, view);
    elem.appendChild(image);

    void resolveEmbed(this.target, this.workspaceRoot, this.currentFilePath)
      .then((absolutePath) => {
        if (absolutePath) {
          image.src = convertFileSrc(absolutePath);
        } else {
          this.renderPlaceholder(elem, image);
        }
      })
      .catch((error) => {
        console.error("[editor] Failed to resolve image embed:", error);
        this.renderPlaceholder(elem, image);
      });

    return elem;
  }

  private renderPlaceholder(elem: HTMLElement, image: HTMLImageElement) {
    image.remove();
    elem.classList.add("cm-image-embed-unresolved");
    elem.textContent = this.rawText;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

function buildDecorations(view: EditorView, getFilePath: () => string): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const { doc } = view.state;
  // Use the drag-frozen snapshot when a pointer drag is in progress, so the
  // link doesn't flip between rendered and raw mid-drag.
  const ranges = getEffectiveSelectionRanges(view.state);
  const workspaceRoot = getWorkspaceRoot();
  const currentFilePath = getFilePath() || null;

  for (const { from, to } of renderedRanges(view)) {
    const text = doc.sliceString(from, to);
    for (const match of text.matchAll(wikiLinkScanner())) {
      const inner = match[2]!;
      const embedTarget = match[1] ? parseWikiImageEmbedTarget(inner) : null;
      // Non-image embeds (note transclusions, PDFs) keep the plain link
      // rendering over the `[[...]]` part, leaving the `!` as source text.
      const start = from + match.index + (match[1] && !embedTarget ? 1 : 0);
      const end = from + match.index + match[0].length;
      if (isInsideCode(view.state, start)) continue;

      const cursorInside = ranges.some((r) => r.from >= start && r.to <= end);

      if (cursorInside) {
        // Editing: show raw source with subtle link color
        builder.add(start, end, wikiLinkEditingMark);
      } else if (embedTarget) {
        builder.add(
          start,
          end,
          Decoration.replace({
            widget: new ImageEmbedWidget(match[0], embedTarget, workspaceRoot, currentFilePath),
          }),
        );
      } else {
        // Folded: replace with clean link text
        builder.add(
          start,
          end,
          Decoration.replace({ widget: new WikiLinkWidget(inner, currentFilePath) }),
        );
      }
    }
  }

  return builder.finish();
}

function wikiLinkDecorations(getFilePath: () => string) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = buildDecorations(view, getFilePath);
      }

      update(update: ViewUpdate) {
        if (update.docChanged || renderedRangesChanged(update) || update.selectionSet) {
          this.decorations = buildDecorations(update.view, getFilePath);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
}

// ---------------------------------------------------------------------------
// Autocomplete
// ---------------------------------------------------------------------------

async function wikiLinkCompletions(context: CompletionContext): Promise<CompletionResult | null> {
  const match = context.matchBefore(WIKI_SUGGEST_TRIGGER);
  if (!match) return null;

  const queryStart = match.from + 2;
  const query = match.text.slice(2);

  // Stay hidden until the user types at least one non-whitespace character
  if (!query.trim()) return null;
  if (isInsideCode(context.state, match.from)) return null;
  if (!context.state.selection.main.empty) return null;

  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) return null;

  const suggestions = await wikiSuggestions(query, tauri.fuzzySearch);
  if (suggestions.length === 0) return null;

  const options: Completion[] = suggestions.map(({ label, detail, insertText }) => ({
    label,
    detail,
    apply(view: EditorView, _completion: Completion, from: number, to: number) {
      // Consume a trailing ]] if it immediately follows the cursor
      const afterCursor = view.state.doc.sliceString(to, to + 2);
      const endPos = afterCursor === "]]" ? to + 2 : to;
      // The inserted link target stays the file name (`insertText`): a title is never a target.
      const insert = `${insertText}]]`;
      view.dispatch({
        changes: { from, to: endPos, insert },
        selection: { anchor: from + insert.length },
      });
    },
  }));

  return {
    from: queryStart,
    options,
    // `fuzzy_search` already matched and ranked by file name and title override; CodeMirror's own
    // label filter would drop a title-only match, so it re-asks the source on every keystroke.
    filter: false,
  };
}

// ---------------------------------------------------------------------------
// Click handling
// ---------------------------------------------------------------------------

/** The raw target a rendered wiki link element carries (`data-wiki-target`, set by table cells),
 *  if the element is inside one. */
export function wikiTargetOf(el: Element): string | null {
  return el.closest<HTMLElement>(`.${WIKI_LINK_CLASS}`)?.dataset.wikiTarget ?? null;
}

/** Resolve the wiki-link target under a mouse event, or null if it isn't a
 *  wiki link. Shared by the mousedown (claim the press) and click (navigate)
 *  handlers. */
function wikiTargetAt(event: MouseEvent, view: EditorView): string | null {
  const target = event.target;
  if (!(target instanceof Element)) return null;
  const wikiLink = target.closest(`.${WIKI_LINK_CLASS}`);
  if (!wikiLink) return null;

  const carried = wikiTargetOf(target);
  if (carried) return carried;
  const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
  if (pos === null) return null;
  return extractWikiTarget(view.state.doc, pos);
}

/** Left, middle and Cmd/Ctrl clicks on a wiki link (`lib/link-activation.ts`): the press is
 *  claimed on mousedown so CodeMirror does not move the caret into the link (which would unfold
 *  the rendered widget), and the note opens on click. */
function wikiLinkClickHandler(getFilePath: () => string, isDisposed: () => boolean): Extension {
  return Prec.highest(
    linkActivationExtension((event, view) => {
      const rawTarget = wikiTargetAt(event, view);
      if (rawTarget === null) return null;
      return wikiLinkTarget(rawTarget, getFilePath, isDisposed, (_problem, _raw, error) => {
        if (error) console.error("[editor] Failed to follow wiki link:", error);
      });
    }),
  );
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

const wikiLinkTheme = EditorView.baseTheme({
  [`.${WIKI_LINK_CLASS}`]: {
    color: "var(--pm-link-color, #7cacf8)",
    cursor: "pointer",
    textDecoration: "none",
  },
  [`.${LINK_ICON_CLASS}`]: {
    marginRight: "0.3em",
    verticalAlign: "-0.1em",
    alignItems: "center",
    justifyContent: "center",
  },
  ".cm-wiki-link-editing": {
    color: "var(--pm-link-color, #7cacf8)",
  },
  ".cm-image-embed-unresolved": {
    color: "var(--text-muted, #888)",
  },
  // Inner-list styling for the autocomplete tooltip. The card chrome
  // (background, blur, border, radius) is inherited from `.surface-card,
  // [cmdk-dialog], .cm-tooltip.cm-tooltip-autocomplete` in App.css so the
  // wiki-link popover matches cmd+f, cmd+p, and the section-rail outline.
  ".cm-tooltip-autocomplete": {
    overflow: "hidden",
    padding: "4px",
  },
  ".cm-tooltip-autocomplete ul": {
    fontFamily: "var(--ui-font) !important",
    fontSize: "13px",
    maxHeight: "280px",
  },
  ".cm-tooltip-autocomplete ul li": {
    padding: "6px 10px !important",
    borderRadius: "8px",
  },
  ".cm-tooltip-autocomplete ul li[aria-selected]": {
    backgroundColor: "var(--surface-selected) !important",
    color: "var(--text-primary) !important",
  },
  ".cm-completionDetail": {
    color: "var(--text-muted, #888) !important",
    fontStyle: "normal !important",
    marginLeft: "8px",
  },
});

// ---------------------------------------------------------------------------
// Public extension
// ---------------------------------------------------------------------------

export function wikiLinkExtension(
  getFilePath: () => string,
  isDisposed: () => boolean,
): Extension[] {
  return [
    wikiLinkDecorations(getFilePath),
    wikiLinkClickHandler(getFilePath, isDisposed),
    wikiLinkTheme,
    // Append the autocomplete tooltip to `document.body` so it escapes
    // `EditorScrollContainer`'s `mask-image`, which establishes a
    // compositing context that neutralizes `backdrop-filter` on any
    // descendant. Without this, the popover's blur is a no-op and editor
    // text bleeds straight through the card in light mode. `position`
    // already defaults to `"fixed"` on non-iOS.
    tooltips({ parent: document.body }),
    autocompletion({
      override: [wikiLinkCompletions, contributedCompletions],
      icons: false,
    }),
  ];
}
