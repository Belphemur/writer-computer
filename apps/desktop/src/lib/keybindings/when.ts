// The named contexts a keybinding can require. A binding whose context is false does not match at
// all (the key falls through to the next binding and the editor), exactly like the old early
// `return`s that came before `preventDefault`. Names, not functions, so two bindings on one chord
// can be told apart statically by the conflict check.
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useEditorStore } from "@/stores/editor-store";
import { isFeatureActive } from "@/lib/features/active";
import { getWorkspaceChromeMode } from "@/lib/compact-mode";

export type WhenName =
  | "not-compact"
  | "editor-not-focused"
  | "outside-agent-pane"
  | "image-viewer"
  | "pdf-viewer"
  | "no-viewer";

export function isEditableTargetFocused(): boolean {
  const active = document.activeElement;
  if (!active) return false;
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return true;
  if ((active as HTMLElement).isContentEditable) return true;
  // CodeMirror editors render a contenteditable inside .cm-editor
  return active.closest(".cm-editor") !== null;
}

/** The single note window has no sidebar or tabs. Read at event time. */
export function isCompactFileMode(): boolean {
  const { root, chromeMode } = useWorkspaceStore.getState();
  return getWorkspaceChromeMode(root, chromeMode) === "compact-file";
}

/** The active tab is an image shown by the `images` feature's viewer (off, its tab is the off page
 *  and the editor's keys apply). */
export function isImageViewerActive(): boolean {
  const { tabs, activeTabId } = useEditorStore.getState();
  const tab = tabs.find((t) => t.id === activeTabId);
  return tab?.location.kind === "image" && isFeatureActive("images");
}

/** The active tab is a PDF shown by the `pdf` feature's reader (off, its tab is the off page and
 *  the editor's keys apply). */
export function isPdfViewerActive(): boolean {
  const { tabs, activeTabId } = useEditorStore.getState();
  const tab = tabs.find((t) => t.id === activeTabId);
  return tab?.location.kind === "pdf" && isFeatureActive("pdf");
}

/** Focus is in a drawing's canvas, the tab's or an embed's (`features/excalidraw`, which marks its
 *  stage `data-drawing-canvas`): Excalidraw has its own zoom chords there. */
export function isDrawingCanvasFocused(): boolean {
  return document.activeElement?.closest("[data-drawing-canvas]") != null;
}

export const WHEN: Record<WhenName, (e: KeyboardEvent) => boolean> = {
  "not-compact": () => !isCompactFileMode(),
  "editor-not-focused": () => !isEditableTargetFocused(),
  // The agent pane keeps Cmd+[ / Cmd+] for its chat switcher.
  // A viewer takes the zoom chords in its own tab (`features/images`, `features/pdf`), the editor
  // elsewhere.
  "image-viewer": () => isImageViewerActive(),
  "pdf-viewer": () => isPdfViewerActive(),
  "no-viewer": () => !isImageViewerActive() && !isPdfViewerActive() && !isDrawingCanvasFocused(),
  "outside-agent-pane": (e) =>
    !(e.target instanceof Element && e.target.closest("[data-agent-pane]")),
};
