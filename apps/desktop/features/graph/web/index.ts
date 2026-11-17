// The graph feature (SPECs/graph-view-spec.md): the global graph tab (the body of the `graph` page
// kind, `page-view:graph`), the local graph sidebar panel, the "Open graph" command and sidebar
// action. This file is loaded at startup, so it imports only `defineFeature`, the manifest and
// `import()` thunks: sigma, graphology and ForceAtlas2 live in the lazy chunks (a test keeps them
// out of the startup graph). The page kind itself is core's (the `Location` union is closed); off,
// the tab shows the "turned off" page.
import { HierarchyCircle01Icon } from "@hugeicons/core-free-icons";
import { openGraphTab } from "@/hooks/editor-api";
import { getWorkspaceRoot } from "@/hooks/workspace-api";
import { getActiveFilePath } from "@/hooks/editor-api";
import { defineFeature } from "@/lib/features/registry";
import manifest from "../feature.json";

const hasWorkspace = (c: { hasWorkspace: boolean; isCompactFileMode: boolean }) =>
  c.hasWorkspace && !c.isCompactFileMode;

/** Opens the graph tab centered on the active note, when there is one in the vault. */
function openGraph() {
  const root = getWorkspaceRoot();
  const active = getActiveFilePath();
  const prefix = root ? `${root.replace(/[\\/]+$/, "")}/` : null;
  const center =
    prefix && active?.startsWith(prefix) && /\.md$/i.test(active)
      ? active.slice(prefix.length)
      : undefined;
  openGraphTab(center ? { center } : {});
}

export default defineFeature({
  id: manifest.id,
  contributes: {
    commands: manifest.contributes.commands.map((c) => ({
      id: c.id,
      label: c.label,
      description: c.description,
      when: hasWorkspace,
      run: () => openGraph(),
    })),
    sidebarActions: [
      {
        id: "graph.open-action",
        label: "Open graph",
        icon: HierarchyCircle01Icon,
        order: 60,
        run: () => openGraph(),
      },
    ],
    sidebarPanels: [
      {
        id: "graph.local",
        label: "Local graph",
        icon: HierarchyCircle01Icon,
        order: 60,
        load: () => import("./local-panel").then((m) => m.LocalGraphPanel),
      },
    ],
    slots: [
      {
        id: "graph.graph-tab",
        slot: "page-view:graph",
        load: () => import("./graph-view").then((m) => m.GraphView),
      },
    ],
  },
});
