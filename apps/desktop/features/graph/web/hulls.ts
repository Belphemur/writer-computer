// Group hulls: a faint padded polygon behind each Group by cluster with the value as its label,
// drawn on a canvas layer UNDER sigma's WebGL stage from node positions (no library provides hulls,
// docs/decisions/2026-11-17-render-the-graph-view-...). Redrawn after every sigma render, so pan,
// zoom and layout all follow. A note with several values draws a thin line to the other hulls.
import type Sigma from "sigma";
import { centroid, convexHull, type Point } from "./groups";
import type { EdgeAttrs, GraphModel, NodeAttrs } from "./model";

export interface HullGroup {
  key: string;
  color: string;
}

export interface HullSource {
  groups: () => readonly HullGroup[];
  labelColor: () => string;
}

const LAYER = "graph-hulls";
const PAD = 22;

function withAlpha(color: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(color);
  if (!m) return color;
  const n = parseInt(m[1]!, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

export function drawHulls(
  ctx: CanvasRenderingContext2D,
  graph: GraphModel,
  toViewport: (x: number, y: number) => { x: number; y: number },
  groups: readonly HullGroup[],
  labelColor: string,
): void {
  const byGroup = new Map<string, Point[]>();
  graph.forEachNode((_, a) => {
    if (a.anchor || a.group === null) return;
    const p = toViewport(a.x, a.y);
    (byGroup.get(a.group) ?? byGroup.set(a.group, []).get(a.group)!).push([p.x, p.y]);
  });
  const centers = new Map<string, Point>();
  for (const g of groups) {
    const pts = byGroup.get(g.key);
    if (!pts || pts.length === 0) continue;
    const hull = convexHull(pts);
    const c = centroid(pts);
    centers.set(g.key, c);
    ctx.beginPath();
    hull.forEach((p, i) => (i === 0 ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1])));
    if (hull.length === 1) ctx.arc(hull[0]![0], hull[0]![1], 1, 0, Math.PI * 2);
    ctx.closePath();
    ctx.lineJoin = "round";
    ctx.lineWidth = PAD * 2;
    ctx.fillStyle = withAlpha(g.color, 0.08);
    ctx.strokeStyle = withAlpha(g.color, 0.08);
    ctx.fill();
    ctx.stroke();
  }
  ctx.font = "12px sans-serif";
  ctx.textAlign = "center";
  ctx.fillStyle = labelColor;
  for (const g of groups) {
    const pts = byGroup.get(g.key);
    const c = centers.get(g.key);
    if (!pts || !c) continue;
    const top = Math.min(...pts.map((p) => p[1]));
    ctx.fillText(g.key, c[0], top - PAD - 4);
  }
  ctx.lineWidth = 0.6;
  graph.forEachNode((_, a) => {
    if (a.anchor || a.groupExtra.length === 0) return;
    const from = toViewport(a.x, a.y);
    for (const extra of a.groupExtra) {
      const to = centers.get(extra);
      if (!to) continue;
      const color = groups.find((g) => g.key === extra)?.color ?? labelColor;
      ctx.strokeStyle = withAlpha(color, 0.35);
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to[0], to[1]);
      ctx.stroke();
    }
  });
}

/** Adds the hull layer to `sigma`; returns the redraw and the disposer. */
export function attachHulls(
  sigma: Sigma<NodeAttrs, EdgeAttrs>,
  graph: GraphModel,
  source: HullSource,
) {
  const canvas = sigma.createCanvas(LAYER, {
    beforeLayer: "stage",
    style: { inset: "0", pointerEvents: "none" },
  });
  const redraw = () => {
    const { width, height } = sigma.getDimensions();
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const groups = source.groups();
    if (groups.length === 0) return;
    drawHulls(ctx, graph, (x, y) => sigma.graphToViewport({ x, y }), groups, source.labelColor());
  };
  sigma.on("afterRender", redraw);
  return {
    redraw,
    dispose() {
      sigma.off("afterRender", redraw);
      sigma.killLayer(LAYER);
    },
  };
}
