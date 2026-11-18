import { useEffect } from "react";
import { usePluginsStore } from "../stores/plugins-store";
import { replaceTabLocation } from "@/hooks/editor-api";
import type { PluginFileLocation } from "@/components/editor-area/page-kinds/plugin-file";
import { MountedElement } from "./plugin-view-pane";

/**
 * Editor-tab body for a vault file shown by a plugin's view (an Excalidraw drawing, a Kanban board).
 * The plugins store opens the file through the registered view in a leaf bound to this tab and
 * detaches the leaf when the tab closes, navigates elsewhere or turns into the text editor. The
 * tab stays mounted while inactive so the view keeps its state (zoom, selection).
 */
export function PluginFileTab({
  location,
  isActive,
  tabId,
}: {
  location: PluginFileLocation;
  isActive: boolean;
  tabId: string;
}) {
  const { path, viewType } = location;
  const ready = usePluginsStore((s) => s.fileViewsReady);
  const entry = usePluginsStore((s) => s.fileLeaves.get(tabId));
  const ensureFileLeaf = usePluginsStore((s) => s.ensureFileLeaf);
  const leaf = entry?.leaf ?? null;
  const noView = ready && entry?.status === "no-view";

  useEffect(() => {
    if (ready) void ensureFileLeaf(tabId, { path, viewType });
  }, [ready, ensureFileLeaf, tabId, path, viewType]);

  // The plugin that registered the view is off (or not installed): the file opens as text.
  useEffect(() => {
    if (noView) void replaceTabLocation(tabId, { kind: "file", path });
  }, [noView, tabId, path]);

  // A view sized while hidden needs a nudge when its tab comes back.
  useEffect(() => {
    if (isActive && leaf) leaf.onResize();
  }, [isActive, leaf]);

  const hidden = isActive ? "" : "hidden";
  if (leaf && entry?.status === "ready") {
    return (
      <div data-plugin-file-tab={path} className={`h-full min-h-0 ${hidden}`}>
        <MountedElement element={leaf.containerEl} />
      </div>
    );
  }
  const message =
    entry?.status === "error"
      ? `This file could not be opened by its plugin view: ${entry.error ?? "unknown error"}`
      : "Loading…";
  return (
    <div
      data-plugin-file-tab-pending={path}
      role="status"
      className={`flex h-full flex-col items-start gap-3 p-6 text-[13px] text-text-muted ${hidden}`}
    >
      <span>{message}</span>
      {entry?.status === "error" ? (
        <button
          type="button"
          className="rounded border border-[var(--line-subtle)] px-2 py-1 text-[var(--text-secondary)]"
          onClick={() => void replaceTabLocation(tabId, { kind: "file", path })}
        >
          Open as text
        </button>
      ) : null}
    </div>
  );
}
