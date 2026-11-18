// One extra 2D canvas layer on a sigma renderer (hulls under the stage, overview bubbles over it):
// creation, HiDPI resize and clear before each draw, and a disposer that is safe after sigma has
// been killed (closing the tab while the graph loads kills sigma before our effect cleanup runs).
import type Sigma from "sigma";
import type { EdgeAttrs, NodeAttrs } from "./model";

export function canvasLayer(
  sigma: Sigma<NodeAttrs, EdgeAttrs>,
  id: string,
  position: { beforeLayer: string } | { afterLayer: string },
) {
  const canvas = sigma.createCanvas(id, {
    ...position,
    style: { inset: "0", pointerEvents: "none" },
  });
  let alive = true;
  const onKill = () => {
    alive = false;
  };
  sigma.on("kill", onKill);
  return {
    /** Resizes to the renderer, clears, and returns the context (CSS pixels), or null. */
    begin(): { ctx: CanvasRenderingContext2D; width: number; height: number } | null {
      const { width, height } = sigma.getDimensions();
      const dpr = window.devicePixelRatio || 1;
      const w = Math.round(width * dpr);
      const h = Math.round(height * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      return { ctx, width, height };
    },
    dispose() {
      if (!alive) return; // sigma.kill() already removed every layer and listener
      alive = false;
      sigma.off("kill", onKill);
      sigma.killLayer(id);
    },
  };
}
