// Keeping the graph in view (SPECs/graph-view-spec.md, "Camera"): the fit target with padding, who
// owns the camera (layout follow or the user), the level of detail at the fit, the layout's settle
// signal and its guard against a divergent step.
import { describe, expect, it, vi } from "vite-plus/test";
import { anyInView, createFollow, FIT_PADDING, fitTarget, sameTarget } from "../web/camera-fit";
import { createLayout, DEFAULT_FORCES, type Supervisor } from "../web/layout";
import { createWorkerSupervisor, type WorkerLike } from "../web/layout-worker-client";
import { PPN, buildMatrices, nonFinitePositions } from "../web/layout-protocol";
import { levelFor, spacingPx } from "../web/lod";
import { applySpec, buildSpec, createModel } from "../web/model";
import { smallSlice, WITH_PROPERTIES } from "./fixtures";

describe("fit target", () => {
  it("centres on the bounding box and pads it", () => {
    const t = fitTarget([
      { x: 0.2, y: 0.4 },
      { x: 0.6, y: 0.5 },
    ])!;
    expect(t.x).toBeCloseTo(0.4);
    expect(t.y).toBeCloseTo(0.45);
    expect(t.ratio).toBeCloseTo(0.4 * FIT_PADDING);
  });

  it("ignores a non-finite point and gives null for no points", () => {
    expect(fitTarget([{ x: NaN, y: 0 }])).toBeNull();
    expect(fitTarget([])).toBeNull();
    expect(
      fitTarget([
        { x: 0.5, y: 0.5 },
        { x: Infinity, y: 0 },
      ])!.x,
    ).toBe(0.5);
  });

  it("is the same target within a hair, so following on render settles", () => {
    expect(sameTarget({ x: 0.5, y: 0.5, ratio: 1 }, { x: 0.50001, y: 0.5, ratio: 1 })).toBe(true);
    expect(sameTarget({ x: 0.5, y: 0.5, ratio: 1 }, { x: 0.6, y: 0.5, ratio: 1 })).toBe(false);
  });

  it("shows notes, not an empty overview, at the post-layout fit (250 and 1000 notes)", () => {
    for (const n of [250, 1000]) {
      const ratio = fitTarget([
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ])!.ratio;
      const level = levelFor(spacingPx(ratio, n, 800, 700), "detail");
      expect(level, `${n} notes`).not.toBe("overview");
    }
  });

  it("detects an empty view (a saved camera pointing at nothing)", () => {
    expect(anyInView([{ x: -50, y: 10 }], 400, 300)).toBe(false);
    expect(
      anyInView(
        [
          { x: -50, y: 10 },
          { x: 20, y: 10 },
        ],
        400,
        300,
      ),
    ).toBe(true);
  });
});

describe("follow", () => {
  it("follows until the user moves the camera, again after a new layout", () => {
    const f = createFollow();
    expect(f.isFollowing()).toBe(true);
    f.userMoved();
    expect(f.isFollowing()).toBe(false);
    f.newLayout();
    expect(f.isFollowing()).toBe(true);
  });

  it("a restored saved view is the user's until the next new layout", () => {
    const f = createFollow();
    f.restore();
    expect(f.isFollowing()).toBe(false);
  });
});

describe("layout settle", () => {
  it("signals when the time budget ends, once per run", () => {
    const model = createModel();
    applySpec(model, buildSpec(smallSlice(), WITH_PROPERTIES));
    const timers: (() => void)[] = [];
    const onSettle = vi.fn();
    const fake: Supervisor = { start() {}, stop() {}, kill() {}, isRunning: () => true };
    const layout = createLayout(model, DEFAULT_FORCES, {
      factory: () => fake,
      setTimer: (fn) => timers.push(fn),
      clearTimer: () => {},
      onSettle,
    });
    layout.start();
    expect(onSettle).not.toHaveBeenCalled();
    timers[0]!();
    expect(onSettle).toHaveBeenCalledTimes(1);
  });
});

describe("divergent step", () => {
  it("is not applied: positions stay finite and the run stops", () => {
    const model = createModel();
    applySpec(model, buildSpec(smallSlice(), WITH_PROPERTIES));
    const posted: unknown[] = [];
    let listener: ((e: MessageEvent) => void) | null = null;
    const worker: WorkerLike = {
      postMessage: (m) => posted.push(m),
      terminate: () => {},
      addEventListener: (_t, l) => {
        listener = l;
      },
    };
    const sup = createWorkerSupervisor(model, {} as never, () => worker);
    sup.start();
    const before = model.nodes().map((k) => model.getNodeAttribute(k, "x"));
    const { nodes } = buildMatrices(model);
    nodes[0] = NaN;
    expect(nonFinitePositions(nodes)).toBe(1);
    listener!({ data: { nodes } } as MessageEvent);
    expect(sup.isRunning()).toBe(false);
    expect(model.nodes().map((k) => model.getNodeAttribute(k, "x"))).toEqual(before);
    expect(posted).toHaveLength(1); // only the init, no next step
    expect(PPN).toBe(10);
  });
});
