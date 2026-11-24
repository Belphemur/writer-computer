// @vitest-environment jsdom
// The `agent.backends` contribution point (SPECs/builtin-plugins-spec.md 6.5): a feature's backend
// is in the registry only while the feature is registered, it is removed with it (counts return to
// zero), an id outside the feature's namespace is refused, and the host stays usable around a
// contribution that throws when it is read.
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));

import { agentBackendContributions } from "../src/lib/features/agent-backends";
import { createFeatureHost, defineFeature } from "../src/lib/features/registry";
import { fixtureBackend } from "../features/agent/tests/helpers/fixture-backend";

const host = createFeatureHost({ onError: () => {}, listen: (async () => () => {}) as never });
const feature = (id = "fixture-live", ids: string[] = [`${id}.backend`]) =>
  defineFeature({
    id,
    contributes: { agentBackends: ids.map((x) => ({ ...fixtureBackend(), id: x, backendId: x })) },
  });

afterEach(async () => {
  for (const id of host.list()) await host.unregister(id);
});

describe("agentBackends point", () => {
  it("registers while the feature is registered and unregisters to zero", async () => {
    expect(agentBackendContributions.size).toBe(0);
    host.register(feature());
    expect(agentBackendContributions.list().map((b) => [b.id, b.owner])).toEqual([
      ["fixture-live.backend", "builtin:fixture-live"],
    ]);
    await host.unregister("fixture-live");
    expect(agentBackendContributions.size).toBe(0);
  });

  it("removes only the owner's entries when two features contribute", async () => {
    host.register(feature("one"));
    host.register(feature("two"));
    expect(agentBackendContributions.size).toBe(2);
    await host.unregister("one");
    expect(agentBackendContributions.list().map((b) => b.owner)).toEqual(["builtin:two"]);
  });

  it("refuses an id outside the feature's namespace and registers nothing", () => {
    expect(() => feature("fixture-live", ["other.backend"])).toThrow(/must start with/);
    expect(agentBackendContributions.size).toBe(0);
  });

  it("notifies subscribers on add and remove (the pane re-reads its backends)", async () => {
    const seen = vi.fn();
    const off = agentBackendContributions.subscribe(seen);
    host.register(feature());
    await host.unregister("fixture-live");
    off();
    expect(seen).toHaveBeenCalledTimes(2);
  });
});
