// Everything the graph tab draws from: the saved config, the slice request it implies, the slice,
// the frontmatter the config needs, and the spec and groups the canvas draws.
import { useCallback, useEffect, useMemo, useState } from "react";
import { collapsedSpec, drilledSpec } from "./drill";
import { topLinks } from "./strength";
import type { GraphSliceArgs } from "./ipc";
import { EDGE_KINDS, KIND_FILTER, type Depth, type SurfaceConfig } from "./config";
import { aggregate, type Overview } from "./aggregate";
import { surfaceGroups } from "./clusters";
import type { GroupsResult } from "./groups";
import { buildSpec, filtersNeedProps, propertyLabels, type GraphSpec } from "./model";
import { needsProps, parseQuery } from "./query";
import { useGraphSettings } from "./settings";
import { useGraphConfig } from "./store";
import { useGraphData, type GraphData } from "./use-graph-data";
import { useCommunities } from "./use-clusters";
import { useNoteProps } from "./use-note-props";
import { derivePhase, type GraphPhase } from "./progress";

export interface SurfaceArgs {
  /** Vault-relative center note; with `depth` the slice is its neighbourhood. */
  center: string | null;
  depth?: Depth;
  /** A search is typed: the notes are drawn (never the collapsed clusters), so matches can show. */
  searching?: boolean;
}

/** Where the whole-vault graph is in its clusters: collapsed to bubbles, or opened on one. */
export interface Drill {
  /** The cluster that is open, or null while they are all collapsed. */
  open: string | null;
  openCluster: (key: string) => void;
  back: () => void;
}

export interface GraphSurface {
  data: GraphData;
  config: SurfaceConfig;
  /** What the canvas draws: the notes, the collapsed clusters or one opened cluster. */
  spec: GraphSpec;
  /** The notes of the slice (search, legend counts), whatever is drawn. */
  fullSpec: GraphSpec;
  /** The groups of every note (the legend). */
  groups: GroupsResult;
  /** The groups the canvas draws (none while collapsed). */
  canvasGroups: GroupsResult;
  drill: Drill | null;
  /** The aggregation the overview level draws (computed once per graph or grouping change). */
  overview: Overview;
  labels: string[];
  loaded: boolean;
  /** Where the graph is on its way to a first drawn frame (`progress.ts`); the one source. */
  phase: GraphPhase;
  /** A frame was drawn at least once: later phases are redraws that keep the graph on screen. */
  drawn: boolean;
  /** The canvas reports a drawn frame of `spec`. */
  onFrame: (spec: GraphSpec) => void;
}

/** The slice request of a surface's filters (what the backend can narrow; the rest is `buildSpec`). */
export function sliceArgs(
  a: SurfaceArgs,
  config: SurfaceConfig,
  cardProperties: readonly string[] = [],
): GraphSliceArgs {
  const f = config.filters;
  const args: GraphSliceArgs = {
    kinds: EDGE_KINDS.filter((k) => f[KIND_FILTER[k]]),
    includeUnresolved: f.missing,
    ...(cardProperties.length ? { cardProperties: [...cardProperties] } : {}),
    ...(f.includeFolders.length ? { folders: f.includeFolders } : {}),
  };
  if (a.depth !== undefined && a.center) {
    args.center = a.center;
    args.depth = a.depth;
  }
  return args;
}

export function useGraphSurface(a: SurfaceArgs): GraphSurface {
  const loaded = useGraphConfig((s) => s.loaded);
  const config = useGraphConfig((s) => s.config.global);
  useEffect(() => {
    void useGraphConfig.getState().load();
  }, []);

  const cardKey = useGraphSettings().cardProperties.join(",");
  const args = useMemo(
    () => (loaded ? sliceArgs(a, config, cardKey ? cardKey.split(",") : []) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [loaded, a.center, a.depth, config.filters, cardKey],
  );
  const data = useGraphData(args);

  const needProps =
    filtersNeedProps(config.filters) ||
    config.rules.some((r) => needsProps(parseQuery(r.query))) ||
    (config.groupBy.property !== null &&
      config.groupBy.property !== "tags" &&
      config.groupBy.property !== "folder");
  const props = useNoteProps(data.slice, needProps);

  const base = useMemo(
    () =>
      data.slice
        ? buildSpec(data.slice, config.filters, { center: a.center, props })
        : { nodes: [], edges: [] },
    [data.slice, config.filters, a.center, props],
  );
  const { communities, pending: clustersPending } = useCommunities(
    base,
    config.groupBy.property === null && config.display.clusterBy === "communities",
  );
  const groups = useMemo(
    () => surfaceGroups(base, config, props, communities),
    [base, config, props, communities],
  );
  const colors = useMemo(() => new Map(groups.groups.map((g) => [g.key, g.color])), [groups]);
  const groupOfPath = useCallback(
    (path: string) => groups.nodes.get(path)?.group ?? null,
    [groups],
  );
  const colorOf = useCallback((key: string) => colors.get(key) ?? "#8a8a96", [colors]);
  // Whole vault only: the clusters start collapsed and a click opens one (`drill.ts`).
  const [opened, setOpened] = useState<string | null>(null);
  useEffect(() => setOpened(null), [a.center]);
  const collapsible = a.center === null && !a.searching && groups.groups.length >= 2;
  const open = collapsible && groups.groups.some((g) => g.key === opened) ? opened : null;
  const k = config.display.linksPerNote;
  const groupByKey = useMemo(
    () => new Map(base.nodes.map((n) => [n.key, groupOfPath(n.path)])),
    [base, groupOfPath],
  );
  const { spec, canvasGroups } = useMemo(() => {
    const groupOf = (key: string) => groupByKey.get(key) ?? null;
    if (collapsible && open === null) {
      return {
        spec: collapsedSpec(aggregate(base, groupOfPath, colorOf)),
        canvasGroups: { nodes: new Map(), groups: [] } satisfies GroupsResult,
      };
    }
    if (open !== null) {
      return {
        spec: topLinks(drilledSpec(base, groupOf, colorOf, open), k, groupOf),
        canvasGroups: { nodes: groups.nodes, groups: groups.groups.filter((g) => g.key === open) },
      };
    }
    return { spec: topLinks(base, k, groupOf), canvasGroups: groups };
  }, [collapsible, open, base, groups, groupOfPath, groupByKey, colorOf, k]);
  const drill = useMemo<Drill | null>(
    () => (collapsible ? { open, openCluster: setOpened, back: () => setOpened(null) } : null),
    [collapsible, open],
  );
  // Overview bubbles of the LOD overview level: one per cluster; fewer than two means hubs.
  const overview = useMemo(
    () => aggregate(spec, groupOfPath, colorOf),
    [spec, groupOfPath, colorOf],
  );
  const labels = useMemo(() => (data.slice ? propertyLabels(data.slice) : []), [data.slice]);
  const [frame, setFrame] = useState<{ spec: GraphSpec | null; ever: boolean }>({
    spec: null,
    ever: false,
  });
  const onFrame = useCallback((drawn: GraphSpec) => setFrame({ spec: drawn, ever: true }), []);
  const phase = derivePhase({
    configLoaded: loaded,
    slice: data.slice,
    fetching: data.loading,
    error: data.error,
    clustersPending,
    nodes: spec.nodes.length,
    framed: frame.spec === spec,
  });
  return {
    data,
    config,
    spec,
    fullSpec: base,
    groups,
    canvasGroups,
    drill,
    overview,
    labels,
    loaded,
    phase,
    drawn: frame.ever,
    onFrame,
  };
}
