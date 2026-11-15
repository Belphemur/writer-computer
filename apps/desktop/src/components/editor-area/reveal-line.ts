import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import * as editorApi from "@/hooks/editor-api";
import { findEditorView } from "@/lib/obsidian-host/editor-bridge";
import { consumePendingLine, setPendingLine } from "@/lib/pending-anchor";
import { findOuterScroller, scrollPosToSafeTop } from "./editor-scroll";

/** Select 1-based `line` (clamped to the document) and scroll it to the top of the safe zone. */
export function revealLine(
  view: EditorView,
  line: number,
  scroller: HTMLElement | null = findOuterScroller(view.dom),
  behavior: ScrollBehavior = "auto",
) {
  const doc = view.state.doc;
  const target = doc.line(Math.max(1, Math.min(line, doc.lines)));
  view.dispatch({ selection: EditorSelection.range(target.from, target.to) });
  if (scroller) scrollPosToSafeTop(view, scroller, target.from, behavior);
}

/** Editor-side half of `openFileAtLine`: reveal the line a search hit asked for, if any. */
export function applyPendingLine(
  view: EditorView,
  filePath: string,
  scroller: HTMLElement | null,
): boolean {
  const line = consumePendingLine(filePath);
  if (line === undefined) return false;
  requestAnimationFrame(() => {
    if (view.dom.isConnected) revealLine(view, line, scroller);
  });
  return true;
}

/**
 * Open `path` (in the current tab, or a new one) and reveal `line`. A file that is already
 * showing is revealed directly; otherwise the line is parked as a pending line and the editor
 * that loads the file consumes it, like heading anchors.
 */
export async function openFileAtLine(
  path: string,
  line: number | null,
  options: { newTab: boolean },
): Promise<void> {
  if (line === null) {
    await (options.newTab ? editorApi.openFileInNewTab(path) : editorApi.navigateToFile(path));
    return;
  }
  const view = findEditorView(path);
  if (!options.newTab && view && editorApi.getActiveFilePath() === path) {
    revealLine(view, line, undefined, "smooth");
    view.focus();
    return;
  }
  setPendingLine(path, line);
  try {
    await (options.newTab ? editorApi.openFileInNewTab(path) : editorApi.navigateToFile(path));
  } catch (e) {
    consumePendingLine(path); // never leave a stale line for a later open
    throw e;
  }
}
