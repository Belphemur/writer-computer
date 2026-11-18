// Sigma reducers: the style of every node and edge, computed per frame from graph attributes and a
// small view state, as pure functions (docs/decisions/2026-11-17-render-the-graph-view-...: no React
// component per node). Per-level styling comes from the one level-of-detail table (`lod.ts`):
// overview, structure, detail, close-up. The same attribute set yields the same style, so these are
// tested without WebGL.
import {
  atLeast,
  EDGE_DIM,
  EDGE_LOOK,
  edgeLabelShown,
  edgeOpacity,
  hubLimit,
  nodeLabel,
  type LabelMode,
  type LodLevel,
} from "./lod";
import type { EdgeAttrs, NodeAttrs, NodeKind } from "./model";
import { labelColor, type GraphTheme } from "./theme";

export interface ViewState {
  hovered: string | null;
  /** Neighbours of `hovered` (itself excluded). */
  hoverNeighbors: ReadonlySet<string>;
  /** The cluster whose hull area the pointer is over (no note hovered); its notes stay, the rest
   *  fade like on a note hover. */
  hoveredCluster: string | null;
  /** The node the keyboard is on. */
  focus: string | null;
  /** The note the graph is centered on (drawn larger, with a ring). */
  center: string | null;
  /** Search matches; `null` when no search is active. */
  matches: ReadonlySet<string> | null;
  selection: ReadonlySet<string>;
  /** The level of detail the zoom asks for (`lod.ts`). */
  level: LodLevel;
  /** How node labels show (setting `graph.labels`, decided in `lod.ts`). */
  labelMode: LabelMode;
  /** Overview with Group by (or folders): bubbles replace nodes and note-level edges. */
  groupedOverview: boolean;
  /** Notes whose links draw only while they are hovered or selected (`hubSet`, `lod.ts`). */
  hubs: ReadonlySet<string>;
  /** Hub rank per node, 0 the highest degree (`hubRanks`). */
  hubRank: ReadonlyMap<string, number>;
  /** Displayed nodes (the hub limits are shares of it). */
  order: number;
  /** Nodes whose card the close-up overlay draws (their sigma label is hidden). */
  cardKeys: ReadonlySet<string>;
  /** Opacity multiplier of the level-change fade, 0 to 1. */
  fade: number;
  theme: GraphTheme;
  /** Sorted property labels, for the label colors (shared with the legend). */
  propertyLabels: readonly string[];
}

export const CENTER_SCALE = 1.6;
export const DIM_OPACITY = 0.15;
export const FAINT_OPACITY = 0.25;
const SHAPES: Record<NodeKind, string> = {
  note: "circle",
  tag: "circle",
  missing: "circle",
  attachment: "square",
  base: "diamond",
  cluster: "circle",
};

export interface NodeStyle {
  color?: string;
  size?: number;
  shape?: string;
  opacity?: number;
  labelVisibility?: "auto" | "visible" | "hidden";
  /** Sigma draws a label black unless told otherwise, so every label sets its colour (a theme
   *  token); the ones that must read, on a plate. */
  labelColor?: string;
  labelBackgroundColor?: string;
  labelBackgroundPadding?: number;
  visibility?: "visible" | "hidden";
  highlighted?: boolean;
  zIndex?: number;
  backdropVisibility?: "visible" | "hidden";
  backdropArea?: "node";
  backdropColor?: string;
  backdropBorderColor?: string;
  backdropBorderWidth?: number;
  backdropShadowBlur?: number;
  backdropPadding?: number;
}

const isHub = (key: string, s: ViewState, kind: "overview" | "structure") =>
  (s.hubRank.get(key) ?? Infinity) < hubLimit(kind, s.order);

export function nodeStyle(key: string, a: NodeAttrs, s: ViewState): NodeStyle {
  if (a.anchor) return { visibility: "hidden", labelVisibility: "hidden" };
  if (s.level === "overview" && s.groupedOverview) {
    return { visibility: "hidden", labelVisibility: "hidden" };
  }
  const isCenter = key === s.center;
  const base =
    a.kind === "missing" || a.kind === "tag" ? s.theme.muted : (a.color ?? s.theme.accent);
  const style: NodeStyle = {
    color: base,
    size: isCenter ? a.size * CENTER_SCALE : a.size,
    shape: SHAPES[a.kind],
    opacity: a.kind === "missing" ? 0.55 : 1,
    labelVisibility: "hidden",
    labelColor: s.theme.label,
    // Sigma's hover backdrop defaults to a white box; draw it in the theme's plate colour.
    backdropColor: s.theme.labelBackground,
    backdropBorderColor: s.theme.edge,
    backdropBorderWidth: 1,
    backdropShadowBlur: 0,
  };

  const hoverActive = s.hovered !== null;
  const related = key === s.hovered || s.hoverNeighbors.has(key);
  const matched = s.matches?.has(key) ?? false;
  const emphasised = isCenter || key === s.focus || s.selection.has(key);

  // Per level and label mode: what label and weight a plain node gets.
  const hub = (kind: "overview" | "structure") => isHub(key, s, kind);
  if (s.level === "overview" && !hub("overview")) {
    // Flat overview: the top hubs alone at full weight, faint dots for the rest.
    style.opacity = FAINT_OPACITY;
    style.size = (a.size ?? 1) * 0.5;
  }
  style.labelVisibility = nodeLabel(
    s.labelMode,
    s.level,
    s.level === "overview" || s.level === "structure" ? hub(s.level) : false,
    s.cardKeys.has(key),
  );

  let dimmed = false;
  if (hoverActive && !related) dimmed = true;
  if (!hoverActive && s.hoveredCluster !== null && a.group !== s.hoveredCluster) dimmed = true;
  if (s.matches && !matched && !emphasised && !related) dimmed = true;
  if (dimmed) {
    style.opacity = DIM_OPACITY;
    style.labelVisibility = "hidden";
  }

  if (related && hoverActive) style.labelVisibility = "visible";
  if (a.kind === "cluster") style.labelVisibility = "visible";
  if (matched || emphasised || related || a.kind === "cluster") {
    style.labelColor = s.theme.text;
    style.labelBackgroundColor = s.theme.labelBackground;
    style.labelBackgroundPadding = 2;
  }
  if (matched || emphasised) {
    style.labelVisibility = "visible";
    style.opacity = 1;
    if (style.size !== undefined && s.level === "overview") style.size = a.size;
  }
  if (s.level === "closeup" && s.cardKeys.has(key)) style.labelVisibility = "hidden";
  if (s.selection.has(key) || key === s.focus) {
    style.highlighted = true;
    style.zIndex = 2;
  }
  if (isCenter) {
    style.backdropVisibility = "visible";
    style.backdropArea = "node";
    style.backdropColor = "rgba(0,0,0,0)";
    style.backdropBorderColor = s.theme.accent;
    style.backdropBorderWidth = 2;
    style.backdropShadowBlur = 0;
    style.backdropPadding = 3;
    style.zIndex = 2;
  }
  style.opacity = (style.opacity ?? 1) * s.fade;
  return style;
}

/** Dash pattern variables of the edge program (`sigma-options.ts` declares them): a very long dash
 *  with a one pixel gap draws solid. */
export const SOLID = { dash: 100000, gap: 1 } as const;
export const DASHED = { dash: 5, gap: 4 } as const;

export interface EdgeStyle {
  color?: string;
  size?: number;
  opacity?: number;
  visibility?: "visible" | "hidden";
  head?: string;
  zIndex?: number;
  dash?: number;
  gap?: number;
  label?: string;
  labelVisibility?: "auto" | "visible" | "hidden";
  labelColor?: string;
  labelBackgroundColor?: string;
  labelBackgroundPadding?: number;
}

export function edgeColor(a: EdgeAttrs, s: ViewState): string {
  if (a.kind === "property" && a.label) return labelColor(a.label, s.propertyLabels);
  return a.kind === "tag" ? s.theme.muted : s.theme.edge;
}

/** Width grows slightly with the number of links the edge stands for. */
export function edgeSize(count: number): number {
  return 0.6 + Math.min(Math.max(count, 1) - 1, 4) * 0.25;
}

export function edgeStyle(a: EdgeAttrs, source: string, target: string, s: ViewState): EdgeStyle {
  if (a.kind === "group") return { visibility: "hidden" };
  if (s.level === "overview") {
    // Note-level edges are replaced by the aggregated lines (grouped), or kept only between hubs.
    if (s.groupedOverview || !(isHub(source, s, "overview") && isHub(target, s, "overview"))) {
      return { visibility: "hidden" };
    }
  }
  const touches = (k: string) => k === s.hovered || k === s.focus || s.selection.has(k);
  // A hub's links draw only while the hub is hovered, focused or selected.
  if (
    (s.hubs.has(source) || s.hubs.has(target)) &&
    !(touches(source) && s.hubs.has(source)) &&
    !(touches(target) && s.hubs.has(target))
  ) {
    return { visibility: "hidden" };
  }
  const detailed = atLeast(s.level, "detail");
  const look = EDGE_LOOK[s.level];
  const touching = touches(source) || touches(target);
  const active = s.hovered !== null || s.focus !== null || s.selection.size > 0;
  const style: EdgeStyle = {
    color: edgeColor(a, s),
    size: look.width ?? edgeSize(a.count),
    opacity: edgeOpacity(s.level, active, touching),
    // Below detail the kinds differ by color only: no dashes, no arrows.
    ...(detailed && a.kind === "embed" ? DASHED : SOLID),
  };
  // One arrow, only when every link of the pair runs the same way.
  if (detailed && a.kind !== "tag" && a.directed) style.head = "arrow";
  if (touching && edgeLabelShown(s.labelMode, s.level, touching)) {
    style.label = edgeTitle(a);
    style.labelVisibility = "visible";
    style.labelColor = s.theme.text;
    style.labelBackgroundColor = s.theme.labelBackground;
    style.labelBackgroundPadding = 2;
  }
  if (touching && active) {
    style.size = (style.size ?? 1) * 1.6;
    style.zIndex = 1;
    if (a.kind === "link" || a.kind === "embed") style.color = s.theme.edgeStrong;
  } else if (!active && s.matches) {
    const hit = s.matches.has(source) || s.matches.has(target);
    if (!hit) style.opacity = EDGE_DIM;
  }
  style.opacity = (style.opacity ?? 1) * s.fade;
  return style;
}

const partTitle = (kind: EdgeAttrs["kind"], label: string | null) =>
  kind === "property"
    ? (label ?? "property")
    : kind === "embed"
      ? "embeds"
      : kind === "tag"
        ? "tagged"
        : "links to";

/** What makes the link, one terse line (spec 3.2): "links to · embeds · owner", each kind once. */
export function edgeTitle(a: Pick<EdgeAttrs, "kind" | "label" | "parts">): string {
  const parts = a.parts?.length ? a.parts : [{ kind: a.kind, label: a.label }];
  return [...new Set(parts.map((p) => partTitle(p.kind, p.label)))].join(" · ");
}

/** The neighbours of `key` in the model, out and in. */
export function neighborsOf(
  graph: { neighbors(node: string): string[]; hasNode(node: string): boolean },
  key: string | null,
): Set<string> {
  return key !== null && graph.hasNode(key) ? new Set(graph.neighbors(key)) : new Set();
}
