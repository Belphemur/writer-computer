import { useEffect, type RefObject } from "react";
import { toPortableMarkdown } from "@/lib/portable-markdown";
import { useSettingsStore } from "@/stores/settings-store";
import { copyMarkdown } from "@features/agent/web/lib/copy-markdown";
import { selectionMarkdown } from "@features/agent/web/lib/selection-markdown";

const sameRange = (a: Range, b: Range) =>
  a.compareBoundaryPoints(Range.START_TO_START, b) === 0 &&
  a.compareBoundaryPoints(Range.END_TO_END, b) === 0;

/**
 * Selecting text in the transcript copies its Markdown (`agent.copy-on-select`), once per
 * selection: on mouse up, or when Shift is released after extending it with the keyboard. Cmd/Ctrl+C
 * on such a selection puts the same Markdown on the clipboard whatever the setting says.
 */
export function useCopySelection(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    let last: Range | null = null;
    const copySelection = () => {
      const selection = document.getSelection();
      const markdown = selectionMarkdown(root, selection);
      if (!markdown) {
        last = null;
        return;
      }
      const range = selection!.getRangeAt(0);
      if (last && sameRange(last, range)) return;
      last = range.cloneRange();
      void copyMarkdown(markdown);
    };
    const enabled = () => useSettingsStore.getState().settings["agent.copy-on-select"] !== false;
    let timer: number | undefined;
    const onMouseUp = () => {
      if (!enabled()) return;
      // after the browser has settled the selection (a click inside one collapses it now)
      window.clearTimeout(timer);
      timer = window.setTimeout(copySelection, 0);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Shift" && enabled()) copySelection();
    };
    const onCopy = (e: ClipboardEvent) => {
      const markdown = selectionMarkdown(root, document.getSelection());
      if (!markdown) return;
      e.preventDefault();
      e.clipboardData?.setData("text/plain", toPortableMarkdown(markdown));
    };
    document.addEventListener("mouseup", onMouseUp);
    document.addEventListener("keyup", onKeyUp);
    document.addEventListener("copy", onCopy);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("mouseup", onMouseUp);
      document.removeEventListener("keyup", onKeyUp);
      document.removeEventListener("copy", onCopy);
    };
  }, [ref]);
}
