// The named contexts a keybinding can require. A binding whose context is false does not match at
// all (the key falls through to the next binding and the editor), exactly like the old early
// `return`s that came before `preventDefault`. Names, not functions, so two bindings on one chord
// can be told apart statically by the conflict check.
import { useWorkspaceStore } from "@/stores/workspace-store";
import { getWorkspaceChromeMode } from "@/lib/compact-mode";

export type WhenName = "not-compact" | "editor-not-focused" | "outside-agent-pane";

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

export const WHEN: Record<WhenName, (e: KeyboardEvent) => boolean> = {
  "not-compact": () => !isCompactFileMode(),
  "editor-not-focused": () => !isEditableTargetFocused(),
  // The agent pane keeps Cmd+[ / Cmd+] for its chat switcher.
  "outside-agent-pane": (e) =>
    !(e.target instanceof Element && e.target.closest("[data-agent-pane]")),
};
