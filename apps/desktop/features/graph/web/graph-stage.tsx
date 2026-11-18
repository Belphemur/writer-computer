// The drawing area both surfaces share: the WebGL canvas, the list fallback (WebGL unavailable, a
// lost context with "Reload graph", or the Nodes toggle for screen readers), the truncated banner,
// the info card of the selected node and the edge tooltip. A surface supplies its data and what a click does.
import { useEffect, useMemo, useRef, useState } from "react";
import type { GraphCamera } from "@/components/editor-area/page-kinds";
import type { LinkIntent } from "@/lib/link-activation";
import { openNode } from "./actions";
import { GraphCanvas, webglAvailable, type CanvasApi, type GraphCanvasProps } from "./graph-canvas";
import { graphStats, type GraphStats } from "./ipc";
import { NodeCard } from "./node-card";
import type { NodeAttrs, NodeSpec } from "./model";
import { NodeList } from "./node-list";
import { type GraphSettings } from "./settings";
import type { GraphSurface } from "./use-graph-surface";

export interface GraphStageProps {
  surface: GraphSurface;
  settings: GraphSettings;
  center: string | null;
  isActive: boolean;
  matches?: ReadonlySet<string> | null;
  camera?: GraphCamera;
  pins?: Record<string, [number, number]>;
  onCameraChange?: (c: GraphCamera) => void;
  onPinsChange?: (p: Record<string, [number, number]>) => void;
  /** What a left click does besides opening (the local panel recenters through the active note). */
  onOpenNode?: (node: NodeAttrs, intent: LinkIntent) => void;
  focusHere?: (path: string) => void;
  apiRef?: React.MutableRefObject<CanvasApi | null>;
  centerRequest?: { key: string; n: number } | null;
  showBanner?: boolean;
  /** Whether the Nodes list toggle is offered (the panel keeps its chrome small). */
  listOpen: boolean;
}

function useTruncatedStats(truncated: boolean): GraphStats | null {
  const [stats, setStats] = useState<GraphStats | null>(null);
  useEffect(() => {
    if (!truncated) return;
    let stale = false;
    graphStats().then(
      (s) => !stale && setStats(s),
      () => undefined,
    );
    return () => {
      stale = true;
    };
  }, [truncated]);
  return stats;
}

export function GraphStage(p: GraphStageProps) {
  const { surface, settings } = p;
  const [unavailable] = useState(() => !webglAvailable());
  const [lost, setLost] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [edgeHover, setEdgeHover] = useState<{ title: string; x: number; y: number } | null>(null);
  const [selection, setSelection] = useState<string[]>([]);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const truncated = surface.data.slice?.truncated ?? false;
  const limit = surface.data.slice?.limit ?? 0;
  const stats = useTruncatedStats(truncated);

  const open = (node: NodeAttrs | NodeSpec, intent: LinkIntent) => {
    if ("anchor" in node) return;
    if (p.onOpenNode && "x" in node) p.onOpenNode(node, intent);
    else void openNode(node, intent);
  };

  const [, redraw] = useState(0);
  const ownApi = useRef<CanvasApi | null>(null);
  const apiRef = p.apiRef ?? ownApi;
  const selected =
    selection.length === 1
      ? (surface.spec.nodes.find((n) => n.path === selection[0]) ?? null)
      : null;

  const menuHandlers = useMemo(() => ({ focusHere: p.focusHere }), [p.focusHere]);
  const showList = unavailable || lost || p.listOpen;

  const canvasProps: GraphCanvasProps = {
    spec: surface.spec,
    groups: surface.groups,
    forces: settings.forces,
    animate: settings.animate,
    labelRatio: settings.labelRatio,
    labelMode: surface.config.display.labels,
    overview: surface.overview,
    center: p.center,
    propertyLabels: surface.labels,
    matches: p.matches ?? null,
    isActive: p.isActive,
    camera: p.camera,
    pins: p.pins,
    onCameraChange: p.onCameraChange,
    onPinsChange: p.onPinsChange,
    onOpenNode: (node, intent) => open(node, intent),
    menuHandlers,
    onEdgeHover: setEdgeHover,
    onSelection: setSelection,
    onContextLost: () => setLost(true),
    apiRef,
    centerRequest: p.centerRequest,
  };

  return (
    <div className="relative h-full w-full overflow-hidden" data-testid="graph-stage">
      {!unavailable && (
        <div
          className={showList ? "invisible absolute inset-0" : "absolute inset-0"}
          aria-hidden={showList}
        >
          {!lost && <GraphCanvas key={reloadKey} {...canvasProps} />}
        </div>
      )}
      {showList && (
        <div className="absolute inset-0 z-10 bg-[var(--surface-primary)]">
          {lost && (
            <div
              className="flex items-center gap-2 px-3 pt-2 text-[12px] text-[var(--text-muted)]"
              role="alert"
            >
              The graphics context was lost.
              <button
                type="button"
                className="rounded-md border border-[var(--line-subtle)] px-2 py-0.5 text-[var(--text-primary)]"
                onClick={() => {
                  setLost(false);
                  setReloadKey((k) => k + 1);
                }}
              >
                Reload graph
              </button>
            </div>
          )}
          {unavailable && (
            <p className="px-3 pt-2 text-[12px] text-[var(--text-muted)]">
              WebGL is not available here, so the graph is shown as a list.
            </p>
          )}
          <NodeList nodes={surface.spec.nodes} onOpen={(n, i) => void openNode(n, i)} />
        </div>
      )}
      {p.showBanner !== false && truncated && (
        <div
          role="status"
          className="absolute left-1/2 top-2 z-10 -translate-x-1/2 rounded-md border border-[var(--line-subtle)] bg-[var(--surface-card)] px-3 py-1 text-[12px] text-[var(--text-secondary)]"
        >
          Showing {limit.toLocaleString()} of {(stats?.notes ?? limit).toLocaleString()} notes,
          refine with filters
        </div>
      )}
      {selected && !showList && (
        <NodeCard
          node={selected}
          pinned={apiRef.current?.isPinned(selected.key) ?? false}
          onFocus={p.focusHere ? () => p.focusHere!(selected.path) : undefined}
          onUnpin={() => {
            apiRef.current?.unpin(selected.key);
            redraw((n) => n + 1);
          }}
        />
      )}
      {edgeHover && !showList && (
        <div
          className="pointer-events-none absolute z-10 rounded-md bg-[var(--surface-card)] px-2 py-0.5 text-[11px] text-[var(--text-primary)] shadow"
          style={{ left: edgeHover.x + 12, top: edgeHover.y + 12 }}
        >
          {edgeHover.title}
        </div>
      )}
      {surface.data.error && (
        <p
          role="alert"
          className="absolute inset-x-0 top-2 text-center text-[12px] text-[var(--danger)]"
        >
          Could not load the graph: {surface.data.error}
        </p>
      )}
    </div>
  );
}
