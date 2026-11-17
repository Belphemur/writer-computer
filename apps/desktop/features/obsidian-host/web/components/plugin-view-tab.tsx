import { usePluginMainLeaves } from "../use-plugins";
import type { PluginViewLocation } from "@/components/editor-area/page-kinds/plugin-view";
import { MountedElement } from "./plugin-view-pane";

/**
 * Editor-tab body for a view a plugin opened in a main-area leaf (e.g. Copilot's diff view).
 * Mounts the leaf's own container; the plugins store detaches the leaf when the tab closes.
 */
export function PluginViewTab({ location }: { location: PluginViewLocation; isActive: boolean }) {
  const leaf = usePluginMainLeaves().find((l) => l.id === location.leafId);
  if (!leaf) {
    return (
      <div data-plugin-view-tab-missing className="p-6 text-[13px] text-text-muted">
        This plugin view is no longer available. Close the tab.
      </div>
    );
  }
  return (
    <div data-plugin-view-tab={leaf.id} className="h-full min-h-0 pt-12">
      <MountedElement element={leaf.containerEl} />
    </div>
  );
}
