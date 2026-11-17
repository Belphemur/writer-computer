// Community plugin markdown processors in the live editor.
//
//  - Fenced blocks whose language a plugin registered with `registerMarkdownCodeBlockProcessor`
//    (Dataview's `dataview` / `dataviewjs`, Tasks' `tasks`, Charts' `chart`, ...) render as a
//    block widget the processor draws into.
//  - Inline code that a registered `registerMarkdownPostProcessor` turns into something else
//    (Dataview's `` `=this.file.name` `` and `` `$=...` ``) renders as an inline widget.
//
// Decoration shape (docs/editor.md; same as `base-embed-decorations.ts`): conditional
// replace <-> widget. The source is replaced by the widget while the selection is away and stays
// visible and editable, with the widget (live, debounced) below it, while the selection touches
// it. Inline widgets show the raw code while the caret is in or next to it.
//
// Cost model: CodeMirror only builds widget DOM for the viewport; a rendered block parks in a
// pool (lib/obsidian-host/markdown-processors.ts) after its widget is destroyed, so scrolling or
// toggling edit mode does not re-run a query; unrelated edits keep the widget (`eq` compares
// language, source, note and the processor, never positions).
import { EditorSelection, type EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { Decoration, EditorView, ViewPlugin, WidgetType, type ViewUpdate } from "@codemirror/view";
import type { SyntaxNode, SyntaxNodeRef } from "@lezer/common";
import { foldableSyntaxFacet } from "@/lib/prosemark-core/main";
import {
  fenceLanguage,
  findCodeBlockProcessor,
  getMarkdownProcessorHost,
  hasPostProcessors,
  inlineClaim,
  inlineKey,
  isRegistered,
  mountCodeBlock,
  mountInline,
  pool,
  probeInline,
  subscribeMarkdownProcessors,
  type CodeBlockProcessor,
  type Mount,
  type SectionInfo,
} from "@/lib/obsidian-host/markdown-processors";
import { parseFencedCode } from "./fenced-code";

const DEFAULT_ESTIMATED_HEIGHT = 80;
const HEIGHT_CACHE_LIMIT = 200;
/** Re-render delay while the writer types inside a block that is showing its widget. */
export const PLUGIN_BLOCK_DEBOUNCE_MS = 400;
const INLINE_MAX_CHARS = 500;

const heightCache = new Map<string, number>();
function rememberHeight(key: string, height: number): void {
  heightCache.delete(key);
  heightCache.set(key, height);
  if (heightCache.size > HEIGHT_CACHE_LIMIT) {
    const oldest = heightCache.keys().next().value;
    if (oldest !== undefined) heightCache.delete(oldest);
  }
}

// ---------------------------------------------------------------- finding blocks

export interface FoundBlock {
  from: number;
  to: number;
  language: string;
  source: string;
  processor: CodeBlockProcessor;
}

/** A closed fenced block with a non-empty body whose language has a registered processor. */
export function pluginBlockInFence(state: EditorState, node: SyntaxNodeRef): FoundBlock | null {
  if (node.name !== "FencedCode") return null;
  const parsed = parseFencedCode(state, node);
  // An unclosed fence is still being typed; replacing it would swallow the line under the caret.
  if (!parsed || !parsed.closed || parsed.source.trim() === "") return null;
  const language = fenceLanguage(parsed.info);
  const processor = findCodeBlockProcessor(language);
  return processor
    ? { from: node.from, to: node.to, language, source: parsed.source, processor }
    : null;
}

/** The block whose widget is `host`, looked up live (docs/editor.md: no positions on widgets). */
export function findPluginBlockAtHost(view: EditorView, host: HTMLElement): FoundBlock | null {
  const pos = view.posAtDOM(host);
  const tree = syntaxTree(view.state);
  for (const side of [-1, 1] as const) {
    let node: SyntaxNode | null = tree.resolveInner(pos, side);
    while (node) {
      const hit = pluginBlockInFence(view.state, node);
      if (hit) return hit;
      node = node.parent;
    }
  }
  return null;
}

/** Range-select the whole block (reverse anchor) so the source unfolds for editing. */
export function enterPluginBlockEditMode(view: EditorView, host: HTMLElement): boolean {
  const found = findPluginBlockAtHost(view, host);
  if (!found) return false;
  view.dispatch({
    selection: EditorSelection.single(found.to, found.from),
    effects: view.scrollSnapshot(),
    scrollIntoView: true,
  });
  view.contentDOM.focus({ preventScroll: true });
  return true;
}

function sectionInfoFor(view: EditorView, host: HTMLElement): SectionInfo | null {
  const found = findPluginBlockAtHost(view, host);
  if (!found) return null;
  const doc = view.state.doc;
  return {
    text: doc.toString(),
    lineStart: doc.lineAt(found.from).number - 1,
    lineEnd: doc.lineAt(found.to).number - 1,
  };
}

/** `notePath` as plugins see it (vault-relative), or null for a file outside the vault. */
function sourcePathOf(notePath: string): string | null {
  return getMarkdownProcessorHost()?.toVaultPath(notePath) ?? null;
}

// ---------------------------------------------------------------- block widget

interface BlockState {
  host: HTMLElement;
  view: EditorView;
  widget: PluginBlockWidget;
  mount: Mount | null;
  timer: ReturnType<typeof setTimeout> | null;
  observer: ResizeObserver | null;
}
const states = new WeakMap<HTMLElement, BlockState>();

const blockKey = (w: PluginBlockWidget): string =>
  `block\0${w.sourcePath}\0${w.language}\0${w.source}`;

export class PluginBlockWidget extends WidgetType {
  constructor(
    readonly language: string,
    readonly source: string,
    readonly processor: CodeBlockProcessor,
    /** Absolute path of the note (`getFilePath`). */
    readonly notePath: string,
    readonly sourcePath: string,
  ) {
    super();
  }

  eq(other: PluginBlockWidget): boolean {
    return (
      this.notePath === other.notePath &&
      this.language === other.language &&
      this.source === other.source &&
      this.processor.fn === other.processor.fn
    );
  }

  get estimatedHeight(): number {
    return heightCache.get(blockKey(this)) ?? DEFAULT_ESTIMATED_HEIGHT;
  }

  /** Puts a mount for this widget's source into `state.host`, reusing a parked one. */
  private show(state: BlockState): void {
    const { host, view } = state;
    const key = blockKey(this);
    const resolver = (el: HTMLElement) =>
      sectionInfoFor(view, el.closest(".cm-plugin-block") ?? host);
    let mount = pool.acquire(key);
    if (mount && mount.fn !== this.processor.fn) {
      mount.dispose();
      mount = null;
    }
    mount ??= mountCodeBlock(this.processor, this.source, this.sourcePath, resolver);
    mount.ctx.sectionResolver = (el) => sectionInfoFor(view, host) ?? resolver(el);
    state.mount = mount;
    const body = host.querySelector<HTMLElement>(".cm-plugin-block-body");
    body?.replaceChildren(mount.el);
  }

  private unshow(state: BlockState, park: boolean): void {
    const mount = state.mount;
    state.mount = null;
    if (!mount) return;
    mount.el.remove();
    if (park) pool.release(blockKey(state.widget), mount);
    else mount.dispose();
  }

  toDOM(view: EditorView): HTMLElement {
    const host = document.createElement("div");
    host.className = "cm-plugin-block";
    host.contentEditable = "false";
    host.dataset.language = this.language;
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "cm-plugin-block-edit";
    edit.textContent = "Edit";
    edit.title = "Edit the block source";
    // mousedown would move the caret before the click lands (docs/editor.md, button focus race).
    edit.addEventListener("mousedown", (e) => e.preventDefault());
    edit.addEventListener("click", (e) => {
      e.preventDefault();
      if (!enterPluginBlockEditMode(view, host))
        console.error("[editor] plugin block: could not find its source to edit");
    });
    const body = document.createElement("div");
    body.className = "cm-plugin-block-body";
    host.append(edit, body);
    const state: BlockState = {
      host,
      view,
      widget: this,
      mount: null,
      timer: null,
      observer: null,
    };
    states.set(host, state);
    if (typeof ResizeObserver !== "undefined") {
      let last = -1;
      state.observer = new ResizeObserver(() => {
        const height = host.getBoundingClientRect().height;
        if (height <= 0 || Math.abs(height - last) < 1) return;
        last = height;
        rememberHeight(blockKey(state.widget), height);
        view.requestMeasure();
      });
      state.observer.observe(host);
    }
    this.show(state);
    return host;
  }

  // Same kind of block, new source (typing inside it): keep the DOM, re-run after a pause.
  updateDOM(dom: HTMLElement, view: EditorView): boolean {
    const state = states.get(dom);
    if (
      !state ||
      state.widget.language !== this.language ||
      state.widget.processor.fn !== this.processor.fn
    )
      return false;
    state.view = view;
    state.widget = this;
    if (state.timer !== null) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = null;
      this.unshow(state, false);
      if (states.get(dom) === state) this.show(state);
    }, PLUGIN_BLOCK_DEBOUNCE_MS);
    return true;
  }

  destroy(dom: HTMLElement): void {
    const state = states.get(dom);
    if (!state) return;
    states.delete(dom);
    // A pending re-render means the mount is for stale source: dispose instead of parking.
    const stale = state.timer !== null;
    if (state.timer !== null) clearTimeout(state.timer);
    state.observer?.disconnect();
    this.unshow(state, !stale);
  }

  ignoreEvent(): boolean {
    return true;
  }
}

// ---------------------------------------------------------------- inline widget

export class PluginInlineWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly sourcePath: string,
  ) {
    super();
  }

  eq(other: PluginInlineWidget): boolean {
    return this.text === other.text && this.sourcePath === other.sourcePath;
  }

  toDOM(): HTMLElement {
    const key = inlineKey(this.sourcePath, this.text);
    const parked = pool.acquire(`inline\0${key}`);
    const mount = parked ?? mountInline(this.text, this.sourcePath).mount;
    // The mount's own element is the widget: Dataview fills the `<p>` inside it later (and an
    // error box lands in it), so the nodes must stay where the processors put them.
    mount.el.classList.add("cm-plugin-inline");
    mount.el.contentEditable = "false";
    inlineMounts.set(mount.el, { mount, key });
    return mount.el;
  }

  destroy(dom: HTMLElement): void {
    const held = inlineMounts.get(dom);
    if (!held) return;
    inlineMounts.delete(dom);
    pool.release(`inline\0${held.key}`, held.mount);
  }

  ignoreEvent(): boolean {
    return false;
  }
}
const inlineMounts = new WeakMap<HTMLElement, { mount: Mount; key: string }>();

/** Text of a single-line inline code span (`` `x` ``, ``` ``x`` ```), or null. */
function inlineCodeText(state: EditorState, node: SyntaxNodeRef): string | null {
  const raw = state.doc.sliceString(node.from, node.to);
  if (raw.includes("\n")) return null;
  const m = /^(`+)([\s\S]*?)\1$/.exec(raw);
  if (!m) return null;
  const text = m[2];
  return text.length === 0 || text.length > INLINE_MAX_CHARS ? null : text;
}

// ---------------------------------------------------------------- decorations

function blockDecoration(
  found: FoundBlock,
  notePath: string,
  sourcePath: string,
  touches: boolean,
) {
  const widget = new PluginBlockWidget(
    found.language,
    found.source,
    found.processor,
    notePath,
    sourcePath,
  );
  return touches
    ? Decoration.widget({ widget, block: true, side: 1 }).range(found.to, found.to)
    : Decoration.replace({ widget, block: true }).range(found.from, found.to);
}

const pluginMarkdownTheme = EditorView.baseTheme({
  ".cm-plugin-block": { padding: "6px 0", position: "relative" },
  ".cm-plugin-block-edit": {
    position: "absolute",
    top: "8px",
    right: "4px",
    opacity: "0",
    fontSize: "11px",
    padding: "1px 6px",
    cursor: "pointer",
    zIndex: "1",
  },
  ".cm-plugin-block:hover .cm-plugin-block-edit, .cm-plugin-block-edit:focus-visible": {
    opacity: "0.8",
  },
  ".cm-plugin-inline": { display: "inline" },
  ".cm-plugin-inline p": { display: "inline", margin: "0" },
  ".writer-plugin-block-error": {
    border: "1px solid var(--destructive, #c0392b)",
    borderRadius: "6px",
    padding: "6px 10px",
    fontSize: "12px",
  },
  ".writer-plugin-block-error pre": {
    margin: "4px 0 0",
    whiteSpace: "pre-wrap",
    fontFamily: "var(--font-mono, monospace)",
  },
});

/**
 * Re-evaluates the fold decorations (a selection transaction is what rebuilds them) when the
 * registered processors change, and probes visible inline code once per distinct text.
 */
const processorPlugin = (getFilePath: () => string) =>
  ViewPlugin.fromClass(
    class {
      destroyed = false;
      private unsub: () => void;
      private scanTimer: ReturnType<typeof setTimeout> | null = null;

      constructor(readonly view: EditorView) {
        this.unsub = subscribeMarkdownProcessors(() => {
          this.refresh();
          this.scheduleScan();
        });
        this.scheduleScan();
      }

      refresh(): void {
        queueMicrotask(() => {
          if (this.destroyed) return;
          this.view.dispatch({ selection: this.view.state.selection });
        });
      }

      update(u: ViewUpdate): void {
        if (u.docChanged || u.viewportChanged) this.scheduleScan();
      }

      scheduleScan(): void {
        if (this.scanTimer !== null) return;
        this.scanTimer = setTimeout(() => {
          this.scanTimer = null;
          if (!this.destroyed) this.scan();
        }, 150);
      }

      scan(): void {
        if (!hasPostProcessors()) return;
        const path = sourcePathOf(getFilePath());
        if (path === null) return;
        const state = this.view.state;
        let claimedAny = false;
        let pending = 0;
        const finish = (claimed: boolean): void => {
          claimedAny ||= claimed;
          if (--pending === 0 && claimedAny && !this.destroyed) this.refresh();
        };
        for (const { from, to } of this.view.visibleRanges) {
          syntaxTree(state).iterate({
            from,
            to,
            enter: (node) => {
              if (node.name !== "InlineCode") return;
              const text = inlineCodeText(state, node);
              if (text === null || inlineClaim(inlineKey(path, text)) !== undefined) return;
              pending++;
              probeInline(path, text, finish);
            },
          });
        }
      }

      destroy(): void {
        this.destroyed = true;
        this.unsub();
        if (this.scanTimer !== null) clearTimeout(this.scanTimer);
      }
    },
  );

/** Registered by `createEditorExtensions`; `getFilePath` gives the note's absolute path. */
export function pluginMarkdownDecorations(getFilePath: () => string) {
  return [
    foldableSyntaxFacet.of({
      nodePath: "FencedCode",
      keepDecorationOnUnfold: true,
      buildDecorations: (state, node, touches) => {
        const found = pluginBlockInFence(state, node);
        if (!found) return undefined;
        const notePath = getFilePath();
        const sourcePath = sourcePathOf(notePath);
        return sourcePath === null
          ? undefined
          : blockDecoration(found, notePath, sourcePath, touches);
      },
    }),
    foldableSyntaxFacet.of({
      nodePath: "InlineCode",
      // Touched (caret in or next to it): no decoration, the raw code shows.
      buildDecorations: (state, node) => {
        if (!hasPostProcessors()) return undefined;
        const text = inlineCodeText(state, node);
        if (text === null) return undefined;
        const sourcePath = sourcePathOf(getFilePath());
        if (sourcePath === null || inlineClaim(inlineKey(sourcePath, text)) !== true)
          return undefined;
        return Decoration.replace({ widget: new PluginInlineWidget(text, sourcePath) }).range(
          node.from,
          node.to,
        );
      },
    }),
    processorPlugin(getFilePath),
    pluginMarkdownTheme,
  ];
}

export const __testPluginMarkdown = { heightCache, states, isRegistered };
