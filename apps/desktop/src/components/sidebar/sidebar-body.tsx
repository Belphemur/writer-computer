import { FeaturePane } from "@/components/feature-pane";
import { useRegistryItems } from "@/hooks/use-registry-items";
import { sidebarPanelContributions } from "@/lib/features/sidebar";
import { useUIStore } from "@/stores/ui-store";
import { FileBrowser } from "./file-browser";
import { SidebarHeader } from "./sidebar-header";
import { buildSidebarPanels, resolveSidebarPanel } from "./sidebar-panels";

type FileBrowserProps = Parameters<typeof FileBrowser>[0];

/** Header plus the selected panel. Files is core and stays mounted (hidden) while a feature panel
 *  shows, so the tree keeps its expansion and scroll; a feature panel mounts only while selected,
 *  inside its feature's error boundary. */
export function SidebarBody(filesProps: FileBrowserProps) {
  const contributed = useRegistryItems(sidebarPanelContributions);
  const selectedId = useUIStore((s) => s.sidebarPanel);
  const select = useUIStore((s) => s.selectSidebarPanel);
  const panels = buildSidebarPanels(contributed);
  const active = resolveSidebarPanel(panels, selectedId);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SidebarHeader panels={panels} selectedId={active.id} onSelect={select} />
      <div className="min-h-0 flex-1" hidden={active.contribution !== null}>
        <FileBrowser {...filesProps} />
      </div>
      {active.contribution && (
        <div data-sidebar-panel={active.id} className="min-h-0 flex-1 overflow-y-auto px-3">
          <FeaturePane contribution={active.contribution} />
        </div>
      )}
    </div>
  );
}
