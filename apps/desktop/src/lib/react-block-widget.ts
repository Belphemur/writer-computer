// A React tree hosted in a CodeMirror block widget: the one implementation behind the Bases embed
// and the Excalidraw embed (docs/editor.md, block-widget patterns). A subclass says what to
// render, how to name the widget's height and which CSS class the host carries; everything that
// is easy to get wrong lives here once:
//  - the React root is created in `toDOM`, kept across `updateDOM` (a source edit updates the
//    rendered content in place) and unmounted on a microtask in `destroy` (it can run inside a
//    React commit, where a synchronous unmount is refused);
//  - the measured height is remembered per key, so scrolling past an embed whose data loads late
//    does not insert a placeholder that later snaps to size under the viewport;
//  - events inside belong to the React tree (`ignoreEvent`).
import { EditorSelection } from "@codemirror/state";
import { EditorView, WidgetType } from "@codemirror/view";
import type { ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";

/**
 * "Edit" on a block widget: range-select the whole block with a reverse anchor so its source
 * unfolds and the caret lands in it (docs/editor.md), keep the scroll position and focus the
 * editor without scrolling. The caller finds the block's range live; a widget keeps no position.
 */
export function enterBlockEditMode(view: EditorView, block: { from: number; to: number }): void {
  view.dispatch({
    selection: EditorSelection.single(block.to, block.from),
    effects: view.scrollSnapshot(),
    scrollIntoView: true,
  });
  view.contentDOM.focus({ preventScroll: true });
}

/** Last measured height per key, least recently set evicted first. */
export class HeightMemory {
  private readonly heights = new Map<string, number>();

  constructor(
    private readonly fallback: number,
    private readonly limit: number,
  ) {}

  get(key: string): number {
    return this.heights.get(key) ?? this.fallback;
  }

  remember(key: string, height: number): void {
    this.heights.delete(key);
    this.heights.set(key, height);
    if (this.heights.size > this.limit) {
      const oldest = this.heights.keys().next().value;
      if (oldest !== undefined) this.heights.delete(oldest);
    }
  }

  clear(): void {
    this.heights.clear();
  }
}

interface Mounted {
  root: Root;
  observer: ResizeObserver | null;
  unmounted: boolean;
}

// Keyed by the widget's DOM so `updateDOM` and `destroy` find the live root without going through
// CodeMirror state. Weak, so a dropped wrapper cannot leak a handle.
const mounted = new WeakMap<HTMLElement, Mounted>();

export abstract class ReactBlockWidget extends WidgetType {
  /** CSS class of the host element. */
  protected abstract readonly className: string;
  /** Where this kind of widget remembers its heights. */
  protected abstract readonly heights: HeightMemory;
  /** The key a height is remembered under (what is embedded, never a position). */
  protected abstract heightKey(): string;
  /** The React content for the host. `host` and `view` let a button reach the editor. */
  protected abstract content(host: HTMLElement, view: EditorView): ReactElement;

  get estimatedHeight(): number {
    return this.heights.get(this.heightKey());
  }

  private render(host: HTMLElement, view: EditorView): void {
    const handle = mounted.get(host);
    if (!handle || handle.unmounted) return;
    handle.root.render(this.content(host, view));
  }

  toDOM(view: EditorView): HTMLElement {
    const host = document.createElement("div");
    host.className = this.className;
    host.contentEditable = "false";
    const handle: Mounted = { root: createRoot(host), observer: null, unmounted: false };
    mounted.set(host, handle);
    // The height settles after the data loads: remember it and let CodeMirror re-measure.
    if (typeof ResizeObserver !== "undefined") {
      let last = -1;
      handle.observer = new ResizeObserver(() => {
        const height = host.getBoundingClientRect().height;
        if (height <= 0 || Math.abs(height - last) < 1) return;
        last = height;
        this.heights.remember(this.heightKey(), height);
        view.requestMeasure();
      });
      handle.observer.observe(host);
    }
    this.render(host, view);
    return host;
  }

  // Not `eq` but the same kind of block: keep the DOM and the React root, hand it the new content.
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
    queueMicrotask(() => handle.root.unmount());
  }

  ignoreEvent(): boolean {
    return true;
  }
}
