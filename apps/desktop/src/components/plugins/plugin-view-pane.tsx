import { useCallback, useEffect, useRef, useState } from "react";
import {
  PANE_MAX_WIDTH,
  PANE_MIN_WIDTH,
  useActivePluginLeaf,
  useClosePluginPane,
  useIsPluginPaneOpen,
  usePluginLeafRevision,
  usePluginLeaves,
  usePluginPaneWidth,
  useSelectPluginLeaf,
  useSetPluginPaneWidth,
} from "@/hooks/use-plugins";

/** Mounts a plugin-owned element for as long as it is the active one. */
function MountedElement({ element }: { element: HTMLElement }) {
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.replaceChildren(element);
    return () => {
      if (element.parentElement === host) element.remove();
    };
  }, [element]);
  return <div ref={hostRef} className="h-full min-h-0 overflow-auto" />;
}

/**
 * Right-hand pane for views plugins open in a leaf (ItemView). Renders nothing until a plugin
 * reveals a leaf; the "Toggle Plugin Side Pane" command and the close button flip the store flag.
 */
export function PluginViewPane() {
  const isOpen = useIsPluginPaneOpen();
  const leaves = usePluginLeaves();
  const activeLeaf = useActivePluginLeaf();
  const width = usePluginPaneWidth();
  const setWidth = useSetPluginPaneWidth();
  const close = useClosePluginPane();
  const selectLeaf = useSelectPluginLeaf();
  // Title/icon changes keep the leaf identity; the revision makes the header re-read them.
  usePluginLeafRevision();
  const [isDragging, setIsDragging] = useState(false);

  const handleResizeStart = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      setIsDragging(true);
      const startX = event.clientX;
      const startWidth = width;
      const previousUserSelect = document.body.style.userSelect;
      document.body.style.userSelect = "none";
      const onMove = (e: PointerEvent) => setWidth(startWidth + startX - e.clientX);
      const finish = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", finish);
        document.body.style.userSelect = previousUserSelect;
        setIsDragging(false);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", finish);
    },
    [setWidth, width],
  );

  if (!isOpen || !activeLeaf) return null;

  return (
    <aside
      data-plugin-view-pane
      className="relative flex h-full shrink-0 flex-col bg-bg text-text-primary"
      style={{ width }}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-valuemin={PANE_MIN_WIDTH}
        aria-valuemax={PANE_MAX_WIDTH}
        aria-valuenow={width}
        data-dragging={isDragging || undefined}
        onPointerDown={handleResizeStart}
        className="absolute inset-y-0 left-0 z-10 w-1 cursor-col-resize bg-[var(--line-subtle)] opacity-60 hover:opacity-100 data-[dragging]:opacity-100"
      />
      <div className="flex shrink-0 items-center gap-1 border-b border-[var(--line-subtler)] px-3 pt-10 pb-2 text-[13px]">
        <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
          {leaves.map((leaf) => (
            <button
              key={leaf.id}
              type="button"
              onClick={() => selectLeaf(leaf)}
              aria-pressed={leaf === activeLeaf}
              className="truncate rounded-md px-2 py-1 text-text-muted aria-pressed:bg-[var(--surface-card)] aria-pressed:text-text-primary"
            >
              {leaf.view.getDisplayText() || leaf.view.getViewType() || "Plugin view"}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={close}
          aria-label="Close plugin pane"
          className="rounded-md px-2 py-1 text-text-muted hover:text-text-primary"
        >
          ×
        </button>
      </div>
      <div className="min-h-0 flex-1">
        <MountedElement element={activeLeaf.containerEl} />
      </div>
    </aside>
  );
}
