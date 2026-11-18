// The layout supervisor with a fake worker (jsdom has none): it starts, stops when settled or
// hidden, rebuilds on change, and pinned nodes are fixed in the graph the worker reads.
import { describe, expect, it } from "vite-plus/test";
import {
  createLayout,
  forcesToSettings,
  settleBudgetMs,
  DEFAULT_FORCES,
  type Supervisor,
} from "../web/layout";
import { applySpec, buildSpec, createModel } from "../web/model";
import { smallSlice, WITH_PROPERTIES } from "./fixtures";

function setup() {
  const model = createModel();
  applySpec(model, buildSpec(smallSlice(), WITH_PROPERTIES));
  const made: (Supervisor & { running: boolean; fixedAtStart: string[] })[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const layout = createLayout(model, DEFAULT_FORCES, {
    factory: (graph) => {
      const s = {
        running: false,
        fixedAtStart: [] as string[],
        start() {
          this.running = true;
          this.fixedAtStart = graph.filterNodes((_, a) => !!a.fixed);
        },
        stop() {
          this.running = false;
        },
        kill() {
          this.running = false;
        },
        isRunning() {
          return this.running;
        },
      };
      made.push(s);
      return s;
    },
    setTimer: (fn, ms) => timers.push({ fn, ms }),
    clearTimer: () => {},
  });
  return { model, layout, made, timers };
}

describe("layout supervisor", () => {
  it("starts a worker and stops it when the layout settles", () => {
    const { layout, made, timers } = setup();
    layout.start();
    expect(made).toHaveLength(1);
    expect(layout.isRunning()).toBe(true);
    timers[0]!.fn();
    expect(made[0]!.running).toBe(false);
  });

  it("restarts on a structural change with a fresh worker", () => {
    const { layout, made } = setup();
    layout.start();
    layout.start();
    expect(made).toHaveLength(2);
  });

  it("stops while hidden and resumes when shown", () => {
    const { layout, made } = setup();
    layout.start();
    layout.setVisible(false);
    expect(layout.isRunning()).toBe(false);
    layout.setVisible(true);
    expect(made.length).toBe(2);
    expect(layout.isRunning()).toBe(true);
  });

  it("pinned nodes are fixed when the worker reads the graph, and unpin releases them", () => {
    const { model, layout, made } = setup();
    layout.pin("People/Ana.md", 5, 6);
    expect(made.at(-1)!.fixedAtStart).toEqual(["People/Ana.md"]);
    expect(model.getNodeAttributes("People/Ana.md")).toMatchObject({ x: 5, y: 6 });
    expect(layout.pins()).toEqual({ "People/Ana.md": [5, 6] });
    layout.unpin("People/Ana.md");
    expect(layout.pins()).toEqual({});
    layout.pin("People/Ben.md", 1, 1);
    layout.unpinAll();
    expect(layout.pins()).toEqual({});
  });

  it("destroy kills the worker and later starts do nothing", () => {
    const { layout, made } = setup();
    layout.start();
    layout.destroy();
    layout.start();
    expect(made).toHaveLength(1);
    expect(layout.isRunning()).toBe(false);
  });

  it("maps the sliders to ForceAtlas2 and shortens the run without animation", () => {
    expect(forcesToSettings(DEFAULT_FORCES, 100)).toMatchObject({
      gravity: 0.5,
      scalingRatio: 4,
      barnesHutOptimize: false,
    });
    expect(forcesToSettings(DEFAULT_FORCES, 5000).barnesHutOptimize).toBe(true);
    expect(forcesToSettings({ ...DEFAULT_FORCES, linkDistance: 100 }, 10).edgeWeightInfluence).toBe(
      0,
    );
    expect(settleBudgetMs(1000, false)).toBeLessThan(settleBudgetMs(1000, true));
  });
});
