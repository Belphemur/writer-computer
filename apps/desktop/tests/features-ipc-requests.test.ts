// The `ipcRequests` contribution point: a feature answers the socket command its Rust half
// declares (`Feature::ipc_commands`), after it is activated, and the handler goes with the feature.
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));

import { handleIpcRequest, ipcRequestHandlers } from "../src/lib/features/ipc-requests";
import { createFeatureHost, defineFeature } from "../src/lib/features/registry";

const host = createFeatureHost({
  onError: () => {},
  listen: (async () => vi.fn()) as never,
});

afterEach(async () => {
  for (const id of host.list()) await host.unregister(id);
});

function demo(handle = vi.fn((payload: unknown, _feature?: unknown) => ({ echoed: payload }))) {
  const activate = vi.fn();
  const def = defineFeature({
    id: "demo",
    activate,
    contributes: { ipcRequests: [{ id: "demo.export", topic: "demo:export", handle }] },
  });
  return { def, activate, handle };
}

describe("ipcRequests", () => {
  it("rejects a topic that is not namespaced by the feature and an id that is not either", () => {
    expect(() =>
      defineFeature({
        id: "demo",
        contributes: { ipcRequests: [{ id: "demo.x", topic: "export", handle: () => 1 }] },
      }),
    ).toThrow(/must start with "demo:"/);
    expect(() =>
      defineFeature({
        id: "demo",
        contributes: { ipcRequests: [{ id: "x.x", topic: "demo:x", handle: () => 1 }] },
      }),
    ).toThrow(/must start with "demo\."/);
  });

  it("registers at once, activates the feature on the first request and answers", async () => {
    const { def, activate, handle } = demo();
    host.register(def);
    expect(ipcRequestHandlers.has("demo:export")).toBe(true);
    expect(activate).not.toHaveBeenCalled();
    await expect(handleIpcRequest("demo:export", { path: "a" })).resolves.toEqual({
      echoed: { path: "a" },
    });
    await handleIpcRequest("demo:export", 1);
    expect(activate).toHaveBeenCalledTimes(1);
    expect(handle).toHaveBeenCalledTimes(2);
    expect(handle.mock.calls[0]?.[1]).toMatchObject({ id: "demo" });
  });

  it("is removed with the feature, and an unknown topic is an error", async () => {
    host.register(demo().def);
    await host.unregister("demo");
    expect(ipcRequestHandlers.has("demo:export")).toBe(false);
    await expect(handleIpcRequest("demo:export", {})).rejects.toThrow("no handler for demo:export");
    await expect(handleIpcRequest("nope", {})).rejects.toThrow("no handler for nope");
  });

  it("a handler that throws rejects the request", async () => {
    host.register(
      demo(
        vi.fn(() => {
          throw new Error("export failed");
        }),
      ).def,
    );
    await expect(handleIpcRequest("demo:export", {})).rejects.toThrow("export failed");
  });
});
