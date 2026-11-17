// The layout supervisor: ForceAtlas2 in its Web Worker (our own module worker, `layout.worker.ts`, over ForceAtlas2's synchronous iteration), so
// the main thread never runs a layout iteration. It starts on load and on structural change, stops
// when the layout has settled (a time budget scaled by size) or the view is hidden, and keeps pinned
// nodes fixed. The worker factory is injected (the default builds the real supervisor), which is
// what the tests replace. Positions are frontend state: pins go to the tab, never to the vault.
import { createWorkerSupervisor, spawnLayoutWorker } from "./layout-worker-client";
import type { FA2Settings } from "./layout-protocol";
import type { GraphModel } from "./model";
import { anchorWeight } from "./groups";

export interface Forces {
  center: number;
  repel: number;
  linkDistance: number;
  groupPull: number;
}

export const DEFAULT_FORCES: Forces = { center: 20, repel: 10, linkDistance: 50, groupPull: 40 };

/** Settings sliders (0 to 100) to ForceAtlas2 parameters. A higher link distance lowers how much
 *  edge weight pulls; large graphs use the Barnes-Hut approximation. */
export function forcesToSettings(f: Forces, order: number): FA2Settings {
  return {
    gravity: f.center / 20,
    scalingRatio: Math.max(0.2, f.repel / 5),
    edgeWeightInfluence: Math.max(0, (100 - f.linkDistance) / 50),
    barnesHutOptimize: order > 500,
    slowDown: 1 + Math.log10(Math.max(1, order)),
  };
}

/** What `createLayout` needs from a running layout (the worker supervisor, or a fake). */
export interface Supervisor {
  start(): void;
  stop(): void;
  kill(): void;
  isRunning(): boolean;
}
export type SupervisorFactory = (graph: GraphModel, settings: FA2Settings) => Supervisor;

export const fa2Factory: SupervisorFactory = (graph, settings) =>
  createWorkerSupervisor(graph, settings, spawnLayoutWorker);

export interface LayoutDeps {
  factory?: SupervisorFactory;
  /** Injected for tests. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}

/** Time the layout runs after a change before it is stopped as settled. */
export function settleBudgetMs(order: number, animate: boolean): number {
  if (!animate) return 800;
  return Math.min(20_000, 2_500 + order * 2);
}

export interface Layout {
  /** Runs (or keeps running) until it settles. Call after any structural change. */
  start(): void;
  stop(): void;
  setForces(forces: Forces): void;
  setAnimate(animate: boolean): void;
  /** The view is hidden or shown again; hidden stops the worker. */
  setVisible(visible: boolean): void;
  pin(key: string, x: number, y: number): void;
  unpin(key: string): void;
  unpinAll(): void;
  pins(): Record<string, [number, number]>;
  isRunning(): boolean;
  destroy(): void;
}

export function createLayout(graph: GraphModel, initial: Forces, deps: LayoutDeps = {}): Layout {
  const factory = deps.factory ?? fa2Factory;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((id) => clearTimeout(id as number));
  let forces = initial;
  let animate = true;
  let visible = true;
  let wanted = false;
  let supervisor: Supervisor | null = null;
  let timer: unknown = null;
  let destroyed = false;

  const clear = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  const kill = () => {
    clear();
    supervisor?.kill();
    supervisor = null;
  };
  const run = () => {
    if (destroyed || !visible || !wanted || graph.order === 0) return;
    // A fresh supervisor reads fixed flags and new nodes: rebuilt on every start.
    kill();
    supervisor = factory(graph, forcesToSettings(forces, graph.order));
    supervisor.start();
    timer = setTimer(
      () => {
        timer = null;
        wanted = false;
        supervisor?.stop();
      },
      settleBudgetMs(graph.order, animate),
    );
  };

  return {
    start() {
      wanted = true;
      run();
    },
    stop() {
      wanted = false;
      kill();
    },
    setForces(next) {
      forces = next;
      graph.forEachEdge((key, a) => {
        if (a.kind === "group") graph.setEdgeAttribute(key, "weight", anchorWeight(next.groupPull));
      });
      wanted = true;
      run();
    },
    setAnimate(next) {
      animate = next;
    },
    setVisible(next) {
      visible = next;
      if (!next) kill();
      else if (wanted) run();
    },
    pin(key, x, y) {
      if (!graph.hasNode(key)) return;
      graph.mergeNodeAttributes(key, { x, y, fixed: true });
      wanted = true;
      run();
    },
    unpin(key) {
      if (!graph.hasNode(key)) return;
      graph.removeNodeAttribute(key, "fixed");
      wanted = true;
      run();
    },
    unpinAll() {
      graph.forEachNode((key, a) => {
        if (a.fixed) graph.removeNodeAttribute(key, "fixed");
      });
      wanted = true;
      run();
    },
    pins() {
      const out: Record<string, [number, number]> = {};
      graph.forEachNode((key, a) => {
        if (a.fixed && !a.anchor) out[key] = [a.x, a.y];
      });
      return out;
    },
    isRunning: () => supervisor?.isRunning() ?? false,
    destroy() {
      destroyed = true;
      kill();
    },
  };
}
