// The local graph (spec 2.2): a sidebar panel that follows the active note. Icon toolbar (node list,
// panel, open in the graph tab), the same SidePanel as the tab with its depth slider (1 to 5, the
// remembered depth), filters and Display stored apart from the tab's, and the active note drawn
// larger with a ring. Clicking a note selects it (the card opens it); since the panel follows the
// active note, it recenters by itself.
import { ListViewIcon, SidebarRightIcon, ArrowUpRight01Icon } from "@hugeicons/core-free-icons";
import { useMemo, useState } from "react";
import { useEditorStore } from "@/stores/editor-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { openGlobalGraph } from "./actions";
import { GraphStage } from "./graph-stage";
import { toRelativePath } from "./paths";
import { useGraphSettings } from "./settings";
import { SidePanel } from "./side-panel";
import { ToolbarButton } from "./surface-tools";
import { useGraphConfig } from "./store";
import { useGraphSurface } from "./use-graph-surface";

export function LocalGraphPanel() {
  const settings = useGraphSettings();
  const root = useWorkspaceStore((s) => s.root);
  const active = useEditorStore((s) => s.activeFilePath);
  const center = useMemo(
    () => (root && active && /\.md$/i.test(active) ? toRelativePath(root, active) : null),
    [root, active],
  );
  const depth = useGraphConfig((s) => s.config.local.display.depth);
  const surface = useGraphSurface({ surface: "local", center, depth });
  const [listOpen, setListOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);

  if (center === null) {
    return (
      <p className="p-4 text-[13px] text-[var(--text-muted)]" data-testid="graph-local-empty">
        Open a note to see its links
      </p>
    );
  }
  return (
    <div className="flex h-full min-h-[280px] flex-col" data-testid="graph-local">
      <div className="flex items-center justify-end gap-1 px-2 py-1.5">
        <ToolbarButton
          icon={ListViewIcon}
          label="Node list"
          pressed={listOpen}
          onClick={() => setListOpen(!listOpen)}
        />
        <ToolbarButton
          icon={SidebarRightIcon}
          label="Panel"
          pressed={panelOpen}
          onClick={() => setPanelOpen(!panelOpen)}
        />
        <ToolbarButton
          icon={ArrowUpRight01Icon}
          label="Open in graph tab"
          onClick={() => void openGlobalGraph(center)}
        />
      </div>
      <div className="min-h-0 flex-1">
        <GraphStage
          surface={surface}
          settings={settings}
          center={center}
          isActive
          showBanner={false}
          listOpen={listOpen}
        />
      </div>
      {panelOpen && (
        <div className="max-h-[50%] border-t border-[var(--line-subtle)]">
          <SidePanel
            surface="local"
            config={surface.config}
            labels={surface.labels}
            groups={surface.groups.groups}
            depth={{
              value: depth,
              onChange: (d) =>
                useGraphConfig
                  .getState()
                  .update("local", (s) => ({ ...s, display: { ...s.display, depth: d } })),
            }}
          />
        </div>
      )}
    </div>
  );
}

export default LocalGraphPanel;
