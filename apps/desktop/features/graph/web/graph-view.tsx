// The global graph tab (spec 2.1): the stage, a search field that highlights matches (Enter
// centers the best one), Filters, Groups, Fit and a Nodes list toggle. Camera and pins are the tab's
// own state (saved in its location); filters, rules and Group by are the vault's (`store.ts`).
import { useMemo, useRef, useState } from "react";
import type { GraphLocation } from "@/components/editor-area/page-kinds";
import { setGraphTabState } from "@/hooks/editor-api";
import type { PageViewProps } from "@/lib/features/slots";
import type { CanvasApi } from "./graph-canvas";
import { GraphStage } from "./graph-stage";
import { matches as queryMatches, needsProps, parseQuery } from "./query";
import { useGraphSettings } from "./settings";
import { SurfaceTools, TOOL_BUTTON } from "./surface-tools";
import { useGraphSurface } from "./use-graph-surface";
import { useNoteProps } from "./use-note-props";

type Depth = 1 | 2 | 3;
const asDepth = (d: number | undefined): Depth | undefined =>
  d === 1 || d === 2 || d === 3 ? d : undefined;

export function GraphView({ location, isActive, tabId }: PageViewProps<GraphLocation>) {
  const settings = useGraphSettings();
  const depth = asDepth(location.depth);
  const surface = useGraphSurface({ surface: "global", center: location.center ?? null, depth });
  const [search, setSearch] = useState("");
  const [listOpen, setListOpen] = useState(false);
  const [centerRequest, setCenterRequest] = useState<{ key: string; n: number } | null>(null);
  const api = useRef<CanvasApi | null>(null);

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

  return (
    <div className="relative flex h-full min-h-0 w-full flex-col" data-testid="graph-view">
      <div className="relative z-20 flex flex-wrap items-center gap-1 px-2 py-1.5">
        <input
          type="search"
          aria-label="Search the graph"
          placeholder="Search notes"
          value={search}
          className="h-7 w-48 rounded-md border border-transparent bg-[var(--surface-input)] px-2 text-[12px] text-[var(--text-secondary)] outline-none focus:border-[var(--focus-border)]"
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && matchList?.[0]) {
              setCenterRequest({ key: matchList[0].key, n: (centerRequest?.n ?? 0) + 1 });
            } else if (e.key === "Escape") {
              setSearch("");
            }
          }}
        />
        <div className="flex-1" />
        <SurfaceTools surface="global" config={surface.config} labels={surface.labels} />
        <button
          type="button"
          className={TOOL_BUTTON}
          onClick={() => api.current?.fit()}
          title="Fit (F)"
        >
          Fit
        </button>
        <button
          type="button"
          className={TOOL_BUTTON}
          aria-pressed={listOpen}
          onClick={() => setListOpen(!listOpen)}
        >
          Nodes
        </button>
        {depth !== undefined && (
          <button
            type="button"
            className={TOOL_BUTTON}
            onClick={() => setGraphTabState(tabId, { center: undefined, depth: undefined })}
          >
            Show whole vault
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1">
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
            setGraphTabState(tabId, { center: path, depth: settings.localDepth, camera: undefined })
          }
          apiRef={api}
          centerRequest={centerRequest}
          showLegend
          listOpen={listOpen}
        />
      </div>
    </div>
  );
}

export default GraphView;
