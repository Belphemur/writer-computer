import { WorkspaceSwitcher } from "./workspace-switcher";
import { PluginRibbon } from "@/components/plugins/plugin-strips";
import { useWorkspaceGeneration } from "@/hooks/use-workspace";
import { useAutoRevealActiveFile } from "@/hooks/use-auto-reveal-active-file";
import { useSidebarSurface } from "./use-sidebar-surface";
import { SidebarBody } from "./sidebar-body";

export function Sidebar() {
  const workspaceGeneration = useWorkspaceGeneration();

  return <SidebarSurface key={workspaceGeneration} />;
}

function SidebarSurface() {
  const surface = useSidebarSurface();
  useAutoRevealActiveFile({
    renamingPath: surface.tree.renamingPath,
    everythingCollapsed: surface.tree.everythingCollapsed,
  });

  return (
    <div
      data-sidebar-surface
      data-workspace-open={surface.hasWorkspace ? "true" : "false"}
      className="relative h-full overflow-hidden"
      onContextMenu={surface.onContextMenu}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute right-0 top-px bottom-px w-px bg-[var(--sidebar-divider-right)]"
      />
      <div className="flex h-full flex-col overflow-hidden">
        <div
          data-sidebar-surface-top
          data-tauri-drag-region
          className="shrink-0"
          style={{
            height: "calc(var(--chrome-control-height) + var(--chrome-control-padding) * 2)",
          }}
        />
        <div data-sidebar-surface-content className="min-h-0 flex-1 overflow-hidden">
          <SidebarBody
            renamingPath={surface.tree.renamingPath}
            onRenamingPathChange={surface.tree.onRenamingPathChange}
            everythingCollapsed={surface.tree.everythingCollapsed}
            onEverythingCollapsedChange={surface.tree.onEverythingCollapsedChange}
          />
        </div>
        <div data-sidebar-surface-bottom className="shrink-0 px-3 py-3">
          <PluginRibbon />
          <WorkspaceSwitcher />
        </div>
      </div>
    </div>
  );
}
