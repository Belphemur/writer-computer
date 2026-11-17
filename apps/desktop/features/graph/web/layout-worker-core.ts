// The ForceAtlas2 worker's logic, without the worker: a handler that takes a request and posts a
// response. It mirrors what `FA2Layout` of `graphology-layout-forceatlas2/worker` ran (the package's
// own synchronous `iterate` over the same matrices, in batches), but as our module so the app
// bundle holds a real worker file and the CSP needs no `blob:`. `layout.worker.ts` only wires it to
// `self`; tests call it directly.
import defaults from "graphology-layout-forceatlas2/defaults.js";
import iterate from "graphology-layout-forceatlas2/iterate.js";
import {
  BATCH_ITERATIONS,
  type FA2Settings,
  type WorkerRequest,
  type WorkerResponse,
} from "./layout-protocol";

export type Post = (message: WorkerResponse, transfer: Transferable[]) => void;

export function createLayoutHandler(post: Post, batch = BATCH_ITERATIONS) {
  let edges: Float32Array = new Float32Array(0);
  let settings: Record<string, unknown> = { ...defaults };

  return function handle(request: WorkerRequest): void {
    let nodes: Float32Array;
    if (request.type === "init") {
      edges = request.edges;
      settings = { ...defaults, ...(request.settings satisfies FA2Settings) };
      nodes = request.nodes;
    } else {
      nodes = request.nodes;
    }
    for (let i = 0; i < batch; i++) iterate(settings, nodes, edges);
    post({ nodes }, [nodes.buffer]);
  };
}
