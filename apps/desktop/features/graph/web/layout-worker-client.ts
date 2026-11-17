// The supervisor's side of the layout worker: builds the matrices once per run, sends them, applies
// each batch of positions to the graph and asks for the next, until stopped. A change to the graph's
// structure while it runs makes the matrices stale: the run stops (the owner, `layout.ts`, starts a
// fresh one after every structural change). Same contract as `FA2Layout`: start, stop, kill, running.
import {
  applyPositions,
  buildMatrices,
  type FA2Settings,
  type Matrices,
  type WorkerRequest,
  type WorkerResponse,
} from "./layout-protocol";
import type { GraphModel } from "./model";

/** The part of `Worker` the client uses (a fake in tests). */
export interface WorkerLike {
  postMessage(message: WorkerRequest, transfer: Transferable[]): void;
  terminate(): void;
  addEventListener(type: "message", listener: (event: MessageEvent<WorkerResponse>) => void): void;
}

const STRUCTURE_EVENTS = ["nodeAdded", "nodeDropped", "edgeAdded", "edgeDropped"] as const;

export function createWorkerSupervisor(
  graph: GraphModel,
  settings: FA2Settings,
  spawn: () => WorkerLike,
) {
  let worker: WorkerLike | null = null;
  let matrices: Matrices | null = null;
  let running = false;
  let stale = false;
  const markStale = () => {
    stale = true;
  };

  const onMessage = (event: MessageEvent<WorkerResponse>) => {
    if (!running || !matrices) return;
    const nodes = event.data.nodes;
    if (stale || !applyPositions(graph, matrices.keys, nodes)) {
      running = false;
      return;
    }
    worker?.postMessage({ type: "step", nodes }, [nodes.buffer]);
  };

  const detach = () => {
    for (const e of STRUCTURE_EVENTS) graph.removeListener(e, markStale);
  };

  return {
    start() {
      if (running) return;
      worker ??= spawn();
      if (!worker) return;
      if (matrices === null) worker.addEventListener("message", onMessage);
      matrices = buildMatrices(graph);
      stale = false;
      for (const e of STRUCTURE_EVENTS) graph.on(e, markStale);
      running = true;
      worker.postMessage({ type: "init", nodes: matrices.nodes, edges: matrices.edges, settings }, [
        matrices.nodes.buffer,
        matrices.edges.buffer,
      ]);
    },
    stop() {
      running = false;
      detach();
    },
    kill() {
      running = false;
      detach();
      worker?.terminate();
      worker = null;
      matrices = null;
    },
    isRunning: () => running,
  };
}

/** The real worker, a module worker bundled as its own file. */
export const spawnLayoutWorker = (): WorkerLike =>
  new Worker(new URL("./layout.worker.ts", import.meta.url), { type: "module" }) as WorkerLike;
