// The local graph (spec 2.2): a sidebar panel that follows the active note. A depth slider (1 to 3,
// the setting's default), the same filters and groups as the tab but stored apart, the active note
// drawn larger with a ring, and "Open in graph tab". Clicking a note opens it; since the panel
// follows the active note, it recenters by itself.
import { useMemo, useState } from "react";
import { useEditorStore } from "@/stores/editor-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { openGlobalGraph } from "./actions";
import { GraphStage } from "./graph-stage";
import { toRelativePath } from "./paths";
import { useGraphSettings } from "./settings";
import { SurfaceTools, TOOL_BUTTON } from "./surface-tools";
import { useGraphSurface } from "./use-graph-surface";

type Depth = 1 | 2 | 3;

export function LocalGraphPanel() {
  const settings = useGraphSettings();
  const root = useWorkspaceStore((s) => s.root);
  const active = useEditorStore((s) => s.activeFilePath);
  const center = useMemo(
    () => (root && active && /\.md$/i.test(active) ? toRelativePath(root, active) : null),
    [root, active],
  );
  const [chosen, setChosen] = useState<Depth | null>(null);
  const depth: Depth = chosen ?? settings.localDepth;
  const surface = useGraphSurface({ surface: "local", center, depth });
  const [listOpen, setListOpen] = useState(false);

  if (center === null) {
    return (
      <p className="p-4 text-[13px] text-[var(--text-muted)]" data-testid="graph-local-empty">
        Open a note to see its links
      </p>
    );
  }
  return (
    <div className="flex h-full min-h-[280px] flex-col" data-testid="graph-local">
      <div className="relative flex flex-wrap items-center gap-1 px-2 py-1.5">
        <label className="flex items-center gap-1 text-[12px] text-[var(--text-secondary)]">
          Depth
          <input
            type="range"
            min={1}
            max={3}
            step={1}
            value={depth}
            aria-label="Depth"
            onChange={(e) => setChosen(Number(e.target.value) as Depth)}
          />
          {depth}
        </label>
        <SurfaceTools surface="local" config={surface.config} labels={surface.labels} />
        <button
          type="button"
          className={TOOL_BUTTON}
          aria-pressed={listOpen}
          onClick={() => setListOpen(!listOpen)}
        >
          Nodes
        </button>
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
      <div className="border-t border-[var(--line-subtle)] px-2 py-1.5">
        <button type="button" className={TOOL_BUTTON} onClick={() => openGlobalGraph(center)}>
          Open in graph tab
        </button>
      </div>
    </div>
  );
}

export default LocalGraphPanel;
