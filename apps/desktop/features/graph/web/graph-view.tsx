// The graph tab (spec 2.1): one compact icon toolbar (search, Whole vault or local, Fit, panel),
// the stage and one side panel (Display, Clusters, Filters) beside it. The tab opens on the current
// note's local graph (`center` and `depth` in its location); "Whole vault" drops both. Camera and
// pins are the tab's own state; filters, Display and Group by are the vault's (`store.ts`).
import {
  GlobeIcon,
  ListViewIcon,
  Maximize01Icon,
  Search01Icon,
  SidebarRightIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMemo, useRef, useState } from "react";
import type { GraphLocation } from "@/components/editor-area/page-kinds";
import { setGraphTabState } from "@/hooks/editor-api";
import type { PageViewProps } from "@/lib/features/slots";
import { clampDepth } from "./config";
import type { CanvasApi } from "./graph-canvas";
import { GraphStage } from "./graph-stage";
import { matches as queryMatches, needsProps, parseQuery } from "./query";
import { useGraphSettings } from "./settings";
import { SidePanel } from "./side-panel";
import { ToolbarButton } from "./surface-tools";
import { useGraphConfig } from "./store";
import { useGraphSurface } from "./use-graph-surface";
import { useNoteProps } from "./use-note-props";

export function GraphView({ location, isActive, tabId }: PageViewProps<GraphLocation>) {
  const settings = useGraphSettings();
  const depth = clampDepth(location.depth);
  const surface = useGraphSurface({ center: location.center ?? null, depth });
  const [search, setSearch] = useState("");
  const [listOpen, setListOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);
  const [centerRequest, setCenterRequest] = useState<{ key: string; n: number } | null>(null);
  const api = useRef<CanvasApi | null>(null);
  const remembered = surface.config.display.depth;

  const query = useMemo(() => parseQuery(search), [search]);
  const props = useNoteProps(surface.data.slice, needsProps(query));
  const matchList = useMemo(
    () =>
      query.length === 0
        ? null
        : surface.spec.nodes
            .filter((n) =>
              queryMatches(query, {
                path: n.path,
                name: n.label,
                tags: n.tags,
                props: props[n.path],
              }),
            )
            .sort((a, b) => b.degree - a.degree),
    [query, surface.spec.nodes, props],
  );
  const matches = useMemo(
    () => (matchList ? new Set(matchList.map((n) => n.key)) : null),
    [matchList],
  );

  const setDepth = (next: number) => {
    const d = clampDepth(next)!;
    setGraphTabState(tabId, { depth: d });
    useGraphConfig.getState().update((s) => ({ ...s, display: { ...s.display, depth: d } }));
  };

  return (
    <div className="relative flex h-full min-h-0 w-full flex-col" data-testid="graph-view">
      <div className="relative z-20 flex items-center gap-1 px-2 py-1.5">
        <div className="relative">
          <HugeiconsIcon
            icon={Search01Icon}
            size={13}
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--text-muted)]"
          />
          <input
            type="search"
            aria-label="Search the graph"
            placeholder="Search"
            value={search}
            className="h-7 w-44 rounded-md border border-transparent bg-[var(--surface-input)] pl-7 pr-2 text-[12px] text-[var(--text-secondary)] outline-none focus:border-[var(--focus-border)]"
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && matchList?.[0]) {
                setCenterRequest({ key: matchList[0].key, n: (centerRequest?.n ?? 0) + 1 });
              } else if (e.key === "Escape") {
                setSearch("");
              }
            }}
          />
        </div>
        <div className="flex-1" />
        <ToolbarButton
          icon={GlobeIcon}
          label="Whole vault"
          pressed={depth === undefined}
          disabled={depth === undefined && !location.center}
          onClick={() =>
            depth === undefined
              ? setGraphTabState(tabId, { depth: remembered })
              : setGraphTabState(tabId, { depth: undefined })
          }
        />
        <ToolbarButton icon={Maximize01Icon} label="Fit (F)" onClick={() => api.current?.fit()} />
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
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 min-w-0 flex-1">
          <GraphStage
            surface={surface}
            settings={settings}
            center={location.center ?? null}
            isActive={isActive}
            matches={matches}
            camera={location.camera}
            pins={location.pins}
            onCameraChange={(camera) => setGraphTabState(tabId, { camera })}
            onPinsChange={(pins) =>
              setGraphTabState(tabId, { pins: Object.keys(pins).length ? pins : undefined })
            }
            focusHere={(path) =>
              setGraphTabState(tabId, {
                center: path,
                depth: depth ?? remembered,
                camera: undefined,
              })
            }
            apiRef={api}
            centerRequest={centerRequest}
            listOpen={listOpen}
          />
        </div>
        {panelOpen && (
          <div className="w-[260px] shrink-0 border-l border-[var(--line-subtle)]">
            <SidePanel
              config={surface.config}
              labels={surface.labels}
              groups={surface.groups.groups}
              depth={depth === undefined ? null : { value: depth, onChange: setDepth }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

export default GraphView;
