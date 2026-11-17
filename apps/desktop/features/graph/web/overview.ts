// The overview layer (level of detail "overview" with groups): one bubble per group sized by its
// note count and labelled "value, count", one line per pair of groups whose width follows the link
// count, drawn on a canvas layer over the stage while the sigma nodes and edges are hidden by the
// reducers. The aggregation (counts, link weights) is computed once (`aggregate.ts`); each frame
// only places a bubble at its members' centroid. A click on a bubble zooms into the group.
import type Sigma from "sigma";
import type { Overview } from "./aggregate";
import type { LodLevel } from "./lod";
import type { EdgeAttrs, GraphModel, NodeAttrs } from "./model";

export interface BubbleGeometry {
  key: string;
  count: number;
  color: string;
  x: number;
  y: number;
  r: number;
}

const LAYER = "graph-overview";
const MAX_LINES = 400;

/** Bubble radius in pixels from the note count (area follows the count), capped. */
export const bubbleRadius = (count: number) => Math.min(70, 8 + 4 * Math.sqrt(Math.max(1, count)));

/** Line width in pixels from the link count relative to the strongest pair. */
export const linkWidth = (count: number, max: number) =>
  1 + 5 * Math.sqrt(Math.max(0, count) / Math.max(1, max));

/** Each bubble at the centroid of its members (graph coordinates averaged, then projected once). */
export function bubbleGeometry(
  overview: Overview,
  graph: Pick<GraphModel, "hasNode" | "getNodeAttribute">,
  toViewport: (x: number, y: number) => { x: number; y: number },
): BubbleGeometry[] {
  const out: BubbleGeometry[] = [];
  for (const b of overview.bubbles) {
    let x = 0;
    let y = 0;
    let n = 0;
    for (const m of b.members) {
      if (!graph.hasNode(m)) continue;
      x += graph.getNodeAttribute(m, "x");
      y += graph.getNodeAttribute(m, "y");
      n++;
    }
    if (n === 0) continue;
    const p = toViewport(x / n, y / n);
    out.push({
      key: b.key,
      count: b.count,
      color: b.color,
      x: p.x,
      y: p.y,
      r: bubbleRadius(b.count),
    });
  }
  return out;
}

/** The bubble under a viewport point (the smallest when they overlap), or null. */
export function hitBubble(geoms: readonly BubbleGeometry[], x: number, y: number): string | null {
  let best: BubbleGeometry | null = null;
  for (const g of geoms) {
    if (Math.hypot(g.x - x, g.y - y) <= g.r && (!best || g.r < best.r)) best = g;
  }
  return best?.key ?? null;
}

const rgba = (hex: string, a: number) => {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1]!, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

export function drawOverview(
  ctx: CanvasRenderingContext2D,
  overview: Overview,
  geoms: readonly BubbleGeometry[],
  fade: number,
  labelColor: string,
): void {
  const at = new Map(geoms.map((g) => [g.key, g]));
  const max = overview.links[0]?.count ?? 1;
  ctx.lineCap = "round";
  for (const l of overview.links.slice(0, MAX_LINES)) {
    const a = at.get(l.a);
    const b = at.get(l.b);
    if (!a || !b) continue;
    ctx.strokeStyle = rgba("#8a8a96", 0.35 * fade);
    ctx.lineWidth = linkWidth(l.count, max);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  ctx.font = "12px sans-serif";
  ctx.textAlign = "center";
  for (const g of geoms) {
    ctx.fillStyle = rgba(g.color, 0.55 * fade);
    ctx.strokeStyle = rgba(g.color, 0.9 * fade);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(g.x, g.y, g.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.globalAlpha = fade;
    ctx.fillStyle = labelColor;
    ctx.fillText(`${g.key} (${g.count})`, g.x, g.y + g.r + 14);
    ctx.globalAlpha = 1;
  }
}

export interface OverviewSource {
  overview: () => Overview | null;
  level: () => LodLevel;
  fade: () => number;
  labelColor: () => string;
}

/** Adds the overview layer to `sigma`; returns the redraw, the bubble hit test and the disposer. */
export function attachOverview(
  sigma: Sigma<NodeAttrs, EdgeAttrs>,
  graph: GraphModel,
  source: OverviewSource,
) {
  const canvas = sigma.createCanvas(LAYER, {
    afterLayer: "stage",
    style: { inset: "0", pointerEvents: "none" },
  });
  let geoms: BubbleGeometry[] = [];
  const active = () => {
    const o = source.overview();
    return source.level() === "overview" && o?.mode === "groups" ? o : null;
  };
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
    const o = active();
    if (!o) {
      geoms = [];
      return;
    }
    geoms = bubbleGeometry(o, graph, (x, y) => sigma.graphToViewport({ x, y }));
    drawOverview(ctx, o, geoms, source.fade(), source.labelColor());
  };
  sigma.on("afterRender", redraw);
  return {
    redraw,
    hit: (x: number, y: number) => (active() ? hitBubble(geoms, x, y) : null),
    dispose() {
      sigma.off("afterRender", redraw);
      sigma.killLayer(LAYER);
    },
  };
}
