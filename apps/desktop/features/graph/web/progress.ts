// What the graph is doing before it can be looked at, from the one place that sequences it
// (`useGraphSurface`: fetch the slice, find the clusters, lay out until a frame is drawn). Pure, so
// the order of the phases is testable without a canvas; `graph-progress.tsx` only renders it.

export type GraphPhase = "loading" | "clusters" | "layout" | "ready" | "error";

/** The status line of each phase that has work in flight. */
export const PHASE_LABEL: Record<Exclude<GraphPhase, "ready" | "error">, string> = {
  loading: "Loading notes…",
  clusters: "Finding clusters…",
  layout: "Laying out…",
};

export interface PhaseInput {
  /** The saved config is read (the slice request depends on it). */
  configLoaded: boolean;
  slice: unknown | null;
  fetching: boolean;
  error: string | null;
  /** Communities are wanted and not yet computed for the current spec. */
  clustersPending: boolean;
  nodes: number;
  /** The canvas drew a frame of the current spec. */
  framed: boolean;
}

export function derivePhase(i: PhaseInput): GraphPhase {
  if (i.error !== null) return "error";
  if (!i.configLoaded || i.fetching || i.slice === null) return "loading";
  if (i.clustersPending) return "clusters";
  if (i.nodes > 0 && !i.framed) return "layout";
  return "ready";
}

/** The canvas draws nothing when WebGL is missing or lost (the list shows instead), so the layout
 *  phase never ends there and is not shown. */
export const visiblePhase = (phase: GraphPhase, canvasDraws: boolean): GraphPhase =>
  phase === "layout" && !canvasDraws ? "ready" : phase;

const plural = (n: number, one: string, many: string) =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** "1,284 notes · 3,902 links". */
export const countsLine = (notes: number, links: number) =>
  `${plural(notes, "note", "notes")} · ${plural(links, "link", "links")}`;
