// @vitest-environment jsdom
import { describe, expect, it, vi } from "vite-plus/test";
import { canvasLayer } from "../web/canvas-layer";

/** A minimal stand-in for the sigma calls `canvasLayer` uses, with sigma's real kill semantics:
 *  `kill()` emits "kill", then removes every extra layer, so a later `killLayer` throws. */
function fakeSigma() {
  const layers = new Map<string, HTMLCanvasElement>();
  const listeners = new Map<string, Set<() => void>>();
  const sigma = {
    createCanvas: vi.fn((id: string) => {
      const c = document.createElement("canvas");
      layers.set(id, c);
      return c;
    }),
    killLayer: vi.fn((id: string) => {
      if (!layers.delete(id))
        throw new Error(`Sigma: cannot kill layer ${id}, which does not exist`);
    }),
    getDimensions: () => ({ width: 100, height: 50 }),
    on: (e: string, f: () => void) => listeners.set(e, (listeners.get(e) ?? new Set()).add(f)),
    off: (e: string, f: () => void) => listeners.get(e)?.delete(f),
    kill: () => {
      for (const f of listeners.get("kill") ?? []) f();
      listeners.clear();
      layers.clear();
    },
  };
  return { sigma, layers };
}

describe("canvasLayer", () => {
  it("removes its layer on dispose", () => {
    const { sigma, layers } = fakeSigma();
    const layer = canvasLayer(sigma as never, "graph-overview", { afterLayer: "stage" });
    expect(layers.has("graph-overview")).toBe(true);
    layer.dispose();
    expect(layers.has("graph-overview")).toBe(false);
  });

  it("disposing after sigma was killed (tab closed while loading) does not throw", () => {
    const { sigma } = fakeSigma();
    const layer = canvasLayer(sigma as never, "graph-overview", { afterLayer: "stage" });
    sigma.kill();
    expect(() => layer.dispose()).not.toThrow();
    expect(sigma.killLayer).not.toHaveBeenCalled();
  });

  it("a second dispose is a no-op", () => {
    const { sigma } = fakeSigma();
    const layer = canvasLayer(sigma as never, "graph-hulls", { beforeLayer: "stage" });
    layer.dispose();
    expect(() => layer.dispose()).not.toThrow();
    expect(sigma.killLayer).toHaveBeenCalledTimes(1);
  });
});
