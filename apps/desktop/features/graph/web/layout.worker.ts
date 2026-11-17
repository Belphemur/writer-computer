// The layout worker entry (a Vite module worker, started by `layout-worker-client.ts` with
// `new Worker(new URL("./layout.worker.ts", import.meta.url), { type: "module" })`): it only wires
// messages to the handler in `layout-worker-core.ts`.
import { createLayoutHandler } from "./layout-worker-core";
import type { WorkerRequest } from "./layout-protocol";

const handle = createLayoutHandler((message, transfer) =>
  (self as unknown as Worker).postMessage(message, transfer),
);
self.onmessage = (event: MessageEvent<WorkerRequest>) => handle(event.data);
