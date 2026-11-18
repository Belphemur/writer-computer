// Group hulls: a faint padded polygon behind each Group by cluster with the value as its label,
// drawn on a canvas layer UNDER sigma's WebGL stage from node positions (no library provides hulls,
// docs/decisions/2026-11-17-render-the-graph-view-...). Redrawn after every sigma render, so pan,
// zoom and layout all follow. A note with several values draws a thin line to the other hulls.
import type Sigma from "sigma";
import { canvasLayer } from "./canvas-layer";
import { centroid, convexHull, type Point } from "./groups";
import type { Point as XY } from "./camera-fit";
import type { EdgeAttrs, GraphModel, NodeAttrs } from "./model";

export interface HullGroup {
  key: string;
  color: string;
  /** Notes in the cluster, shown after its name. */
  size?: number;
}

export interface HullSource {
  /** Every cluster that has a hull at this zoom (empty below the structure level). */
  groups: () => readonly HullGroup[];
  /** The keys among `groups()` that are drawn (`activeGroupKeys`). */
  active: () => ReadonlySet<string>;
  labelColor: () => string;
}

/** The clusters that draw a hull: those of the hovered, focused or selected notes, and the
 *  cluster whose area the pointer is over (`hoveredCluster`), nothing else (the colour of the
 *  others stays on their dots; the side panel lists them). One rule for the hull's visibility. */
export function activeGroupKeys(
  graph: Pick<GraphModel, "hasNode" | "getNodeAttribute">,
  s: {
    hovered: string | null;
    focus: string | null;
    selection: ReadonlySet<string>;
    hoveredCluster: string | null;
  },
): Set<string> {
  const out = new Set<string>();
  if (s.hoveredCluster !== null) out.add(s.hoveredCluster);
  for (const k of [s.hovered, s.focus, ...s.selection]) {
    if (k === null || !graph.hasNode(k)) continue;
    const g = graph.getNodeAttribute(k, "group");
    if (g !== null) out.add(g);
  }
  return out;
}

const LAYER = "graph-hulls";
/** How far the drawn hull reaches beyond its polygon (viewport px); the hit test uses it too. */
export const PAD = 22;

function withAlpha(color: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(color);
  if (!m) return color;
  const n = parseInt(m[1]!, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/** One cluster's hull in viewport pixels: the geometry both the drawing and the pointer hit test
 *  read (computed once per render, `attachHulls`). */
export interface HullShape {
  key: string;
  /** The convex polygon (one or two points for a tiny cluster). */
  hull: readonly Point[];
  center: Point;
  /** The topmost y of its notes (the name sits above it). */
  top: number;
  /** Area of the padded shape, to pick the smallest of overlapping hulls. */
  area: number;
}

const polygonArea = (h: readonly Point[]) => {
  let a = 0;
  for (let i = 0; i < h.length; i++) {
    const p = h[i]!;
    const q = h[(i + 1) % h.length]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a) / 2;
};

const edgeLength = (p: Point, q: Point) => Math.hypot(q[0] - p[0], q[1] - p[1]);

/** Area of the polygon grown by `pad` (Steiner: area + perimeter * pad + pi * pad^2). */
function paddedArea(h: readonly Point[], pad: number): number {
  let perimeter = 0; // a segment counts both ways round, a point zero
  for (let i = 0; i < h.length; i++) perimeter += edgeLength(h[i]!, h[(i + 1) % h.length]!);
  return polygonArea(h) + perimeter * pad + Math.PI * pad * pad;
}

/** The hull of every cluster in `groups`, from the notes' viewport positions. */
export function computeHulls(
  graph: GraphModel,
  toViewport: (x: number, y: number) => { x: number; y: number },
  groups: readonly HullGroup[],
): Map<string, HullShape> {
  const byGroup = new Map<string, Point[]>();
  graph.forEachNode((_, a) => {
    if (a.anchor || a.group === null) return;
    const p = toViewport(a.x, a.y);
    (byGroup.get(a.group) ?? byGroup.set(a.group, []).get(a.group)!).push([p.x, p.y]);
  });
  const out = new Map<string, HullShape>();
  for (const g of groups) {
    const pts = byGroup.get(g.key);
    if (!pts || pts.length === 0) continue;
    const hull = convexHull(pts);
    out.set(g.key, {
      key: g.key,
      hull,
      center: centroid(pts),
      top: Math.min(...pts.map((p) => p[1])),
      area: paddedArea(hull, PAD),
    });
  }
  return out;
}

function distanceToSegment(x: number, y: number, p: Point, q: Point): number {
  const dx = q[0] - p[0];
  const dy = q[1] - p[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - p[0]) * dx + (y - p[1]) * dy) / len2));
  return Math.hypot(x - (p[0] + t * dx), y - (p[1] + t * dy));
}

/** Whether (x, y) is on the hull's polygon or within `pad` of it: the area `drawHulls` fills. */
export function hullContains(shape: HullShape, x: number, y: number, pad = PAD): boolean {
  const h = shape.hull;
  if (h.length >= 3) {
    let inside = false;
    for (let i = 0, j = h.length - 1; i < h.length; j = i++) {
      const [xi, yi] = h[i]!;
      const [xj, yj] = h[j]!;
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    if (inside) return true;
  }
  for (let i = 0; i < h.length; i++) {
    const p = h[i]!;
    if (distanceToSegment(x, y, p, h[(i + 1) % h.length]!) <= pad) return true;
  }
  return false;
}

/** The hull under (x, y): the smallest one when several contain it, or null. */
export function pickHull(shapes: Iterable<HullShape>, x: number, y: number): string | null {
  let best: HullShape | null = null;
  for (const s of shapes) {
    if (hullContains(s, x, y) && (best === null || s.area < best.area)) best = s;
  }
  return best?.key ?? null;
}

/** The notes of cluster `key` as points (`toPoint` picks the space), for the camera fit. */
export function groupPoints(
  graph: GraphModel,
  key: string,
  toPoint: (x: number, y: number) => XY,
): XY[] {
  const out: XY[] = [];
  graph.forEachNode((_, a) => {
    if (!a.anchor && a.group === key) out.push(toPoint(a.x, a.y));
  });
  return out;
}

/** Draws the hulls of `drawn` (a subset of the shapes) with their names and the thin links of
 *  notes that have several values. */
export function drawHulls(
  ctx: CanvasRenderingContext2D,
  graph: GraphModel,
  toViewport: (x: number, y: number) => { x: number; y: number },
  shapes: ReadonlyMap<string, HullShape>,
  drawn: readonly HullGroup[],
  labelColor: string,
): void {
  const centers = new Map<string, Point>();
  for (const g of drawn) {
    const shape = shapes.get(g.key);
    if (!shape) continue;
    const { hull } = shape;
    centers.set(g.key, shape.center);
    ctx.beginPath();
    hull.forEach((p, i) => (i === 0 ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1])));
    if (hull.length === 1) ctx.arc(hull[0]![0], hull[0]![1], 1, 0, Math.PI * 2);
    ctx.closePath();
    ctx.lineJoin = "round";
    ctx.lineWidth = PAD * 2;
    ctx.fillStyle = withAlpha(g.color, 0.14);
    ctx.strokeStyle = withAlpha(g.color, 0.14);
    ctx.fill();
    ctx.stroke();
  }
  ctx.font = "12px sans-serif";
  ctx.textAlign = "center";
  ctx.fillStyle = labelColor;
  for (const g of drawn) {
    const shape = shapes.get(g.key);
    if (!shape) continue;
    ctx.fillText(
      g.size === undefined ? g.key : `${g.key} \u00b7 ${g.size}`,
      shape.center[0],
      shape.top - PAD - 4,
    );
  }
  ctx.lineWidth = 0.6;
  graph.forEachNode((_, a) => {
    if (a.anchor || a.groupExtra.length === 0) return;
    const from = toViewport(a.x, a.y);
    for (const extra of a.groupExtra) {
      const to = centers.get(extra);
      if (!to) continue;
      const color = drawn.find((g) => g.key === extra)?.color ?? labelColor;
      ctx.strokeStyle = withAlpha(color, 0.35);
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to[0], to[1]);
      ctx.stroke();
    }
  });
}

/** Adds the hull layer to `sigma`; returns the redraw, the pointer hit test and the disposer. */
export function attachHulls(
  sigma: Sigma<NodeAttrs, EdgeAttrs>,
  graph: GraphModel,
  source: HullSource,
) {
  const layer = canvasLayer(sigma, LAYER, { beforeLayer: "stage" });
  const toViewport = (x: number, y: number) => sigma.graphToViewport({ x, y });
  // The one geometry of the current frame: drawing and hit testing read it, it is computed on
  // first use after a redraw (so a still graph with no hull shown costs nothing per frame).
  let shapes: Map<string, HullShape> | null = null;
  const geometry = () => (shapes ??= computeHulls(graph, toViewport, source.groups()));
  const redraw = () => {
    shapes = null;
    const frame = layer.begin();
    if (!frame) return;
    const active = source.active();
    const drawn = source.groups().filter((g) => active.has(g.key));
    if (drawn.length === 0) return;
    drawHulls(frame.ctx, graph, toViewport, geometry(), drawn, source.labelColor());
  };
  sigma.on("afterRender", redraw);
  return {
    redraw,
    /** The cluster whose hull area holds the viewport point (smallest first), or null. */
    hullAt: (x: number, y: number): string | null =>
      source.groups().length === 0 ? null : pickHull(geometry().values(), x, y),
    dispose() {
      sigma.off("afterRender", redraw);
      layer.dispose();
    },
  };
}
