// The agent's web half turns off cleanly (ADR 2026-11-20): the `agent:event` listener and the pump
// go, the store's subscriptions are released, the chats are saved and dropped, and turning it on
// again starts clean. Rust has already killed the processes by then.
// @vitest-environment jsdom
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@/lib/preferences", () => ({
  getPreference: vi.fn(async (_k: string, fallback: unknown) => fallback),
  setPreference: vi.fn(async () => {}),
}));

import { createFeatureHost, defineFeature } from "@/lib/features/registry";
import { createMockAgentClient, type Goldens } from "@features/agent/web/lib/mock-client";
import { attachAgentStore } from "@features/agent/web/lib/store-lifecycle";
import {
  configureAgentRuntimeForTests,
  configureChatPersistenceForTests,
  getAgentClient,
  useAgentStore,
} from "@features/agent/web/stores/agent-store";
import { usePaneStore } from "@features/agent/web/stores/pane-store";
import { goldens } from "@features/agent/tests/helpers/agent-goldens";

describe("the agent store follows the feature's lifetime", () => {
  it("unsubscribes the runtime, drops the chats and stops reacting while off", async () => {
    const host = createFeatureHost({ onError: () => {}, listen: (async () => () => {}) as never });
    host.register(defineFeature({ id: "agent", activate: (ctx) => void attachAgentStore(ctx) }));
    await host.activate("agent");

    const unsubscribe = vi.fn();
    const inner = createMockAgentClient({ goldens: goldens as unknown as Goldens });
    configureAgentRuntimeForTests({
      ...inner,
      subscribe: async (h) => {
        const off = await inner.subscribe(h);
        return () => {
          unsubscribe();
          off();
        };
      },
    });
    configureChatPersistenceForTests({
      chatsIo: { load: async () => null, save: async () => {} },
      delayMs: 2,
    });
    await getAgentClient();
    usePaneStore.setState({ open: false });
    expect(unsubscribe).not.toHaveBeenCalled();

    // wired: opening the pane makes a chat tab
    usePaneStore.getState().setOpen(true);
    expect(useAgentStore.getState().order).toHaveLength(1);

    await host.deactivate("agent");
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(useAgentStore.getState().order).toEqual([]);
    expect(Object.keys(useAgentStore.getState().chats)).toEqual([]);

    // unwired: the pane opening no longer touches the store
    usePaneStore.getState().setOpen(false);
    usePaneStore.getState().setOpen(true);
    expect(useAgentStore.getState().order).toEqual([]);

    // turned back on: wired again, starting clean
    await host.activate("agent");
    usePaneStore.getState().setOpen(false);
    usePaneStore.getState().setOpen(true);
    expect(useAgentStore.getState().order).toHaveLength(1);
    await host.unregister("agent");
  });
});
