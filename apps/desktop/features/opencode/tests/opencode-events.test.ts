// @vitest-environment jsdom
// The server's `model.updated` reaches the web as `opencode:models-updated`: the feature listens
// while it is active (released on deactivate) and forgets the cached model list, so the chip and
// Settings ask again. The history list names a chat's own agent in a refusal.
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));

import {
  loadBackendModels,
  onBackendModelsInvalidated,
  resetBackendModelsForTests,
} from "@/lib/features/agent-backends";
import { createFeatureHost } from "@/lib/features/registry";
import { refusalText } from "@features/agent/web/lib/auto-title";
import opencodeFeature from "../web/index";

describe("opencode:models-updated", () => {
  it("invalidates the cached list while the feature is active, and stops after", async () => {
    resetBackendModelsForTests();
    const handlers = new Map<string, (e: { payload: undefined }) => void>();
    const unlisten = vi.fn();
    const listen = vi.fn(async (name: string, fn: (e: { payload: undefined }) => void) => {
      handlers.set(name, fn);
      return unlisten;
    });
    const host = createFeatureHost({ onError: () => {}, listen: listen as never });
    host.register(opencodeFeature);
    await host.activate("opencode");
    expect([...handlers.keys()]).toEqual(["opencode:models-updated"]);

    const models = vi.fn(async () => [{ id: "a/b", label: "B", variants: [], available: true }]);
    const backend = { backendId: "opencode", models };
    await loadBackendModels(backend);
    await loadBackendModels(backend);
    expect(models).toHaveBeenCalledTimes(1);

    const seen = vi.fn();
    const off = onBackendModelsInvalidated(seen);
    handlers.get("opencode:models-updated")!({ payload: undefined });
    off();
    expect(seen).toHaveBeenCalledTimes(1);
    await loadBackendModels(backend);
    expect(models).toHaveBeenCalledTimes(2);

    await host.deactivate("opencode");
    expect(unlisten).toHaveBeenCalledTimes(1);
    await host.unregister("opencode");
  });
});

describe("refusal wording", () => {
  it("names the chat's own agent, Claude's when it is not known", () => {
    expect(refusalText("no-binary", "OpenCode")).toBe(
      "OpenCode was not found. Check Settings > Agent.",
    );
    expect(refusalText("unavailable", "OpenCode")).toContain("OpenCode is turned off");
    expect(refusalText("no-binary")).toContain("Claude Code");
  });
});
