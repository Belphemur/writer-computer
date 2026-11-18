// The layout worker's message handler, run directly (a worker is not needed): it moves unpinned
// nodes, keeps pinned ones fixed, posts a transferable Float32Array; and the supervisor over a fake
// worker applies the batches, ignores a stale run and shuts down cleanly.
import { describe, expect, it, vi } from "vite-plus/test";
import { DEFAULT_FORCES, forcesToSettings } from "../web/layout";
import {
  PPN,
  applyPositions,
  buildMatrices,
  type WorkerRequest,
  type WorkerResponse,
} from "../web/layout-protocol";
import { createLayoutHandler } from "../web/layout-worker-core";
import { createWorkerSupervisor, type WorkerLike } from "../web/layout-worker-client";
import { applySpec, buildSpec, createModel } from "../web/model";
import { smallSlice, WITH_PROPERTIES } from "./fixtures";

function model() {
  const m = createModel();
  applySpec(m, buildSpec(smallSlice(), WITH_PROPERTIES));
  return m;
}
const settings = forcesToSettings(DEFAULT_FORCES, 4);

describe("matrices", () => {
  it("round-trips positions, flags pins and carries mass and weights", () => {
    const m = model();
    m.mergeNodeAttributes("People/Ana.md", { fixed: true });
    const { nodes, edges, keys } = buildMatrices(m);
    expect(nodes.length).toBe(m.order * PPN);
    expect(edges.length).toBe(m.size * 3);
    const i = keys.indexOf("People/Ana.md");
    expect(nodes[i * PPN + 9]).toBe(1);
    expect(nodes[i * PPN + 6]).toBeGreaterThan(1);
    nodes[i * PPN] = 99;
    nodes[keys.indexOf("People/Ben.md") * PPN] = 7;
    expect(applyPositions(m, keys, nodes)).toBe(true);
    expect(m.getNodeAttribute("People/Ana.md", "x")).not.toBe(99); // pinned keeps its place
    expect(m.getNodeAttribute("People/Ben.md", "x")).toBe(7);
    expect(applyPositions(m, keys, new Float32Array(3))).toBe(false);
  });
});

describe("worker handler", () => {
  it("moves unpinned nodes, keeps pinned ones fixed and posts a transferable Float32Array", () => {
    const m = model();
    m.mergeNodeAttributes("People/Ana.md", { x: 5, y: 6, fixed: true });
    const { nodes, edges, keys } = buildMatrices(m);
    const before = Array.from(nodes);
    const posted: { message: WorkerResponse; transfer: Transferable[] }[] = [];
    const handle = createLayoutHandler(
      (message, transfer) => posted.push({ message, transfer }),
      30,
    );

    handle({ type: "init", nodes, edges, settings });
    expect(posted).toHaveLength(1);
    const out = (posted[0]!.message as { nodes: Float32Array }).nodes;
    expect(out).toBeInstanceOf(Float32Array);
    expect(posted[0]!.transfer).toEqual([out.buffer]);
    const at = (k: string) => keys.indexOf(k) * PPN;
    expect([out[at("People/Ana.md")], out[at("People/Ana.md") + 1]]).toEqual([5, 6]);
    const moved = keys.filter(
      (k) =>
        k !== "People/Ana.md" &&
        (out[at(k)] !== before[at(k)] || out[at(k) + 1] !== before[at(k) + 1]),
    );
    expect(moved.length).toBeGreaterThan(0);

    // The next batch continues from the matrix handed back, with the edges the worker kept.
    handle({ type: "step", nodes: out });
    expect(posted).toHaveLength(2);
    expect((posted[1]!.message as { nodes: Float32Array }).nodes[at("People/Ana.md")]).toBe(5);
  });
});

function fakeWorker() {
  const sent: WorkerRequest[] = [];
  let listener: (e: MessageEvent<WorkerResponse>) => void = () => {};
  const terminate = vi.fn();
  const worker: WorkerLike = {
    postMessage: (m) => void sent.push(m),
    addEventListener: (_t, l) => {
      listener = l;
    },
    terminate,
  };
  const reply = (nodes: Float32Array) =>
    listener({ data: { nodes } } as MessageEvent<WorkerResponse>);
  return { worker, sent, reply, terminate };
}

describe("worker supervisor", () => {
  it("sends init, applies each reply and asks for the next batch until stopped", () => {
    const m = model();
    const f = fakeWorker();
    const s = createWorkerSupervisor(m, settings, () => f.worker);
    s.start();
    expect(s.isRunning()).toBe(true);
    const init = f.sent[0] as Extract<WorkerRequest, { type: "init" }>;
    expect(init.type).toBe("init");
    const keys = m.nodes();
    const reply = new Float32Array(m.order * PPN);
    reply[0] = 42;
    f.reply(reply);
    expect(m.getNodeAttribute(keys[0]!, "x")).toBe(42);
    expect(f.sent[1]!.type).toBe("step");
    s.stop();
    f.reply(new Float32Array(m.order * PPN));
    expect(f.sent).toHaveLength(2);
    s.kill();
    expect(f.terminate).toHaveBeenCalled();
  });

  it("stops a run whose graph changed structure under it", () => {
    const m = model();
    const f = fakeWorker();
    const s = createWorkerSupervisor(m, settings, () => f.worker);
    s.start();
    m.dropNode("Lonely.md");
    f.reply(new Float32Array((m.order + 1) * PPN));
    expect(s.isRunning()).toBe(false);
    expect(f.sent).toHaveLength(1);
    s.kill();
  });
});
