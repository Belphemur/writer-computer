// @vitest-environment jsdom
// A backend's Settings panel that throws is contained by its feature's boundary: the tab strip, the
// status card and the rest of the page keep working, and a detection that fails is "Could not check".
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { memoryOverview } from "@features/agent/tests/memory-fixture";

const invokeMock = vi.hoisted(() => vi.fn());
const openMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: openMock, ask: vi.fn() }));
vi.mock("@/lib/preferences", () => ({
  getPreference: vi.fn(async (_k: string, fallback: unknown) => fallback),
  setPreference: vi.fn(async () => {}),
}));
vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), log: vi.fn() },
  describeError: (e: unknown) => ({ message: String(e) }),
}));

import { AgentSection } from "@features/agent/web/agent-section";
import { resetBackendUsabilityForTests } from "@features/agent/web/stores/backend-usability";
import { SETTINGS_SCHEMA } from "@/lib/settings-schema";
import { useSettingsStore } from "@/stores/settings-store";
import { FIXTURE_ID, registerFixtureBackend } from "./helpers/fixture-backend";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("a contributed backend inside Settings > Agent", () => {
  let container: HTMLElement;
  let root: Root;
  let unregister: () => void;
  const q = (sel: string) => container.querySelector<HTMLElement>(sel);
  const mount = async () => {
    await act(async () => root.render(<AgentSection />));
    await act(async () => q(`[data-agent-backend-tab=${FIXTURE_ID}]`)!.click());
    await act(async () => new Promise((r) => setTimeout(r, 20)));
  };

  beforeEach(() => {
    window.matchMedia ??= ((query: string) => ({
      matches: false,
      media: query,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      onchange: null,
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "plugin:agent|agent_detect_binary")
        return { found: true, path: "/synthetic/bin/claude", version: "2.1.325", source: "path" };
      if (cmd === "plugin:agent|agent_memory_list") return memoryOverview({ vaultFiles: [] });
      return [];
    });
    useSettingsStore.setState({
      settings: Object.fromEntries(SETTINGS_SCHEMA.map((d) => [d.key, d.default])),
      isLoaded: true,
    });
    resetBackendUsabilityForTests();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    unregister();
  });

  it("a panel that throws leaves the tabs and the status card working", async () => {
    unregister = registerFixtureBackend({
      settingsPanel: async () => () => {
        throw new Error("panel exploded");
      },
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await mount();
    expect(q("[data-agent-status]")?.dataset.agentStatus).toBe("ready");
    expect(q("[data-agent-backend-tab=claude]")).not.toBeNull();
    expect(container.textContent).not.toContain("panel exploded");
    // back to Claude's tab: its body is intact
    await act(async () => q("[data-agent-backend-tab=claude]")!.click());
    expect(q('select[aria-label="Default model"]')).not.toBeNull();
  });

  it("names the backend's own program in its status text, never Claude's", async () => {
    unregister = registerFixtureBackend({
      detect: async () => ({ found: false, path: null, version: null }),
    });
    await mount();
    expect(q("[data-agent-status]")?.dataset.agentStatus).toBe("not-found");
    expect(q("[data-agent-binary-status]")?.textContent).toBe(
      "Fixture was not found on this computer.",
    );
  });

  it("a detection that fails is Could not check", async () => {
    unregister = registerFixtureBackend({
      detect: async () => {
        throw new Error("probe failed");
      },
    });
    await mount();
    expect(q("[data-agent-status]")?.dataset.agentStatus).toBe("error");
  });

  it("Locate… stores the program under the backend's own binary-path key", async () => {
    unregister = registerFixtureBackend({
      detect: async () => ({ found: false, path: null, version: null }),
    });
    openMock.mockResolvedValue("/synthetic/bin/fixture-agent");
    const setSetting = vi.fn(async () => {});
    useSettingsStore.setState({ setSetting } as never);
    await mount();
    const locate = [...container.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "Locate…",
    )!;
    await act(async () => locate.click());
    expect(setSetting).toHaveBeenCalledWith("fixture.binary-path", "/synthetic/bin/fixture-agent");
  });
});
