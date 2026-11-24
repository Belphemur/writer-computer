// @vitest-environment jsdom
// One model resolver for the chip, Settings and the start: a blank model of a live backend is the
// first available model that is not switched off, resolved BEFORE the start and always passed with
// its effort; nothing available means an error and no start.
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({ get: async () => undefined, set: async () => {} })),
}));

import { resetBackendModelsForTests, resolveModel } from "@/lib/features/agent-backends";
import { backendById } from "@features/agent/web/lib/backends";
import { resolveStartModel } from "@features/agent/web/lib/live-models";
import { createMockAgentClient, type Goldens } from "@features/agent/web/lib/mock-client";
import {
  configureAgentRuntimeForTests,
  useAgentStore,
} from "@features/agent/web/stores/agent-store";
import { useSettingsStore } from "@/stores/settings-store";
import { goldens } from "@features/agent/tests/helpers/agent-goldens";
import {
  FIXTURE_ID,
  FIXTURE_KEYS,
  FIXTURE_MODELS,
  registerFixtureBackend,
} from "./helpers/fixture-backend";

const get = () => useAgentStore.getState();

describe("resolving the model of a live backend", () => {
  let unregister: () => void;
  beforeEach(() => {
    resetBackendModelsForTests();
    unregister?.();
    unregister = registerFixtureBackend();
    useSettingsStore.setState({ settings: {} });
  });

  it("resolveModel: blank is the first enabled one, an explicit model is itself", () => {
    expect(resolveModel(FIXTURE_MODELS, [], null)?.id).toBe("acme/big");
    expect(resolveModel(FIXTURE_MODELS, ["acme/big"], null)?.id).toBe("acme/plain");
    expect(resolveModel(FIXTURE_MODELS, ["acme/big"], "acme/big")?.id).toBe("acme/big");
    expect(resolveModel(FIXTURE_MODELS, [], "x/unknown")).toBeNull();
    expect(
      resolveModel(
        FIXTURE_MODELS.filter((m) => !m.available),
        [],
        null,
      ),
    ).toBeNull();
  });

  it("blank resolves to the first enabled model and keeps an effort that model takes", async () => {
    const b = backendById(FIXTURE_ID)!;
    expect(await resolveStartModel(b, { model: null, effort: "high" })).toEqual({
      model: "acme/big",
      effort: "high",
    });
    // `none` is a variant but not an effort Writer selects; a model without it drops the choice
    expect(await resolveStartModel(b, { model: null, effort: "max" })).toEqual({
      model: "acme/big",
      effort: null,
    });
  });

  it("skips a switched-off first model", async () => {
    useSettingsStore.setState({ settings: { [FIXTURE_KEYS.disabledModels]: ["acme/big"] } });
    const out = await resolveStartModel(backendById(FIXTURE_ID)!, { model: null, effort: "high" });
    expect(out).toEqual({ model: "acme/plain", effort: null });
  });

  it("an explicit model is passed as it is, without asking the list", async () => {
    const models = vi.fn(async () => FIXTURE_MODELS);
    unregister();
    unregister = registerFixtureBackend({ models });
    const out = await resolveStartModel(backendById(FIXTURE_ID)!, { model: "x/y", effort: "low" });
    expect(out).toEqual({ model: "x/y", effort: "low" });
    expect(models).not.toHaveBeenCalled();
  });

  it("nothing available: it throws", async () => {
    unregister();
    unregister = registerFixtureBackend({
      models: async () => FIXTURE_MODELS.map((m) => ({ ...m, available: false })),
    });
    await expect(
      resolveStartModel(backendById(FIXTURE_ID)!, { model: null, effort: null }),
    ).rejects.toThrow(/No Fixture model is available/);
  });

  describe("at the start of a chat", () => {
    let start: ReturnType<typeof vi.fn>;
    let mock: ReturnType<typeof createMockAgentClient>;
    beforeEach(() => {
      mock = createMockAgentClient({ goldens: goldens as unknown as Goldens });
      start = vi.fn(mock.start);
      configureAgentRuntimeForTests({ ...mock, start } as typeof mock);
      useAgentStore.setState(useAgentStore.getInitialState(), true);
      useSettingsStore.setState({ settings: { [FIXTURE_KEYS.effort]: "low" } });
      get().newChat();
      get().setChatBackend(get().activeChatId!, FIXTURE_ID);
    });

    it("passes the resolved model and its effort", async () => {
      const id = get().activeChatId!;
      await get().sendMessage("hi");
      await mock.idle(id);
      const req = start.mock.calls[0]![0] as {
        backend: string;
        settings: { model: string; effort: string };
      };
      expect(req.backend).toBe(FIXTURE_ID);
      expect(req.settings).toMatchObject({ model: "acme/big", effort: "low" });
    });

    it("refuses a switched-off model of the chat note, and says so", async () => {
      useSettingsStore.setState({ settings: { [FIXTURE_KEYS.disabledModels]: ["acme/big"] } });
      const id = get().activeChatId!;
      // what a chat note restored: the chat's own model
      useAgentStore.setState((s) => ({
        chatModels: { ...s.chatModels, [id]: { model: "acme/big#high", effort: null } },
      }));
      await get().sendMessage("hi");
      expect(start).not.toHaveBeenCalled();
      expect(get().chats[id]!.error?.message).toBe(
        "The model acme/big is switched off in Settings > Agent > Fixture",
      );
    });

    it("refuses a switched-off model of the settings, and says so", async () => {
      useSettingsStore.setState({
        settings: { [FIXTURE_KEYS.model]: "acme/big", [FIXTURE_KEYS.disabledModels]: ["acme/big"] },
      });
      const id = get().activeChatId!;
      await get().sendMessage("hi");
      expect(start).not.toHaveBeenCalled();
      expect(get().chats[id]!.error?.message).toMatch(/acme\/big is switched off/);
    });

    it("makes no start and shows the error when no model is available", async () => {
      unregister();
      unregister = registerFixtureBackend({ models: async () => [] });
      resetBackendModelsForTests();
      const id = get().activeChatId!;
      await get().sendMessage("hi");
      expect(start).not.toHaveBeenCalled();
      expect(get().chats[id]!.error?.message).toMatch(/model is available/);
    });
  });
});
