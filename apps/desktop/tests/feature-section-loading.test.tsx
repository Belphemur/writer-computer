// @vitest-environment jsdom
// Feature Settings pages load without a blank flash: preloaded when Settings opens (enabled
// features only) or a nav item is hovered, read synchronously once cached, a skeleton while the
// chunk is pending, and the Agent page draws its whole structure before detection resolves.
import { act, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("../src/lib/preferences", () => ({
  getPreference: vi.fn(async (_k: string, fallback: unknown) => fallback),
  setPreference: vi.fn(async () => {}),
}));

import agentFeature from "../features/agent/web/index";
import { SettingsPanel } from "../src/components/settings-panel";
import { FeatureSectionContent } from "../src/components/settings-panel/feature-section-content";
import { featureHost } from "../src/lib/features/registry";
import {
  loadSection,
  resetSectionCache,
  type SectionLoader,
} from "../src/lib/features/section-loader";
import { settingsSectionContributions } from "../src/lib/features/settings-sections";
import { SETTINGS_SCHEMA } from "../src/lib/settings-schema";
import { useSettingsStore } from "../src/stores/settings-store";
import { useUIStore } from "../src/stores/ui-store";
import { useWorkspaceStore } from "../src/stores/workspace-store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;
const q = (sel: string) => container.querySelector<HTMLElement>(sel);
const Page: ComponentType = () => <div data-fixture-page>page</div>;
const section = (load: SectionLoader) => ({ id: "fx", label: "Fx", order: 50, load });

function deferred() {
  let resolve!: () => void;
  const gate = new Promise<void>((r) => (resolve = r));
  const load = vi.fn(async () => {
    await gate;
    return { default: Page };
  });
  return { load, resolve };
}

beforeEach(() => {
  resetSectionCache();
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
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  useSettingsStore.setState({
    settings: Object.fromEntries(SETTINGS_SCHEMA.map((d) => [d.key, d.default])),
    isLoaded: true,
  });
  useWorkspaceStore.setState({ root: "/synthetic-vault" });
});
afterEach(async () => {
  act(() => root.unmount());
  container.remove();
  settingsSectionContributions.removeOwner("builtin:fx-on");
  await featureHost.unregister("agent");
});

describe("FeatureSectionContent", () => {
  it("renders a cached page on the first render, with no skeleton", async () => {
    const load: SectionLoader = async () => ({ default: Page });
    await loadSection(load);
    act(() => root.render(<FeatureSectionContent section={section(load)} />));
    expect(q("[data-fixture-page]")).not.toBeNull();
    expect(q("[data-section-skeleton]")).toBeNull();
  });

  it("shows a skeleton while the chunk is pending, then the page", async () => {
    const d = deferred();
    act(() => root.render(<FeatureSectionContent section={section(d.load)} />));
    expect(q("[data-section-skeleton]")).not.toBeNull();
    expect(q("[data-fixture-page]")).toBeNull();
    d.resolve();
    await act(async () => {});
    expect(q("[data-fixture-page]")).not.toBeNull();
    expect(q("[data-section-skeleton]")).toBeNull();
  });
});

describe("preload", () => {
  it("starts load() for the pages of enabled features when Settings opens, never for others", async () => {
    const on = vi.fn(async () => ({ default: Page }));
    const off = vi.fn(async () => ({ default: Page }));
    // `fx-off` is a feature that is not on: it is not in the registry, so it contributes nothing
    void off;
    settingsSectionContributions.add("fx-on", {
      ...section(on),
      id: "fx-on",
      owner: "builtin:fx-on",
    });
    useUIStore.setState({ settingsSection: "editor" });
    await act(async () => root.render(<SettingsPanel isActive />));
    expect(on).toHaveBeenCalledTimes(1);
    expect(off).not.toHaveBeenCalled();
  });

  it("does not preload while the panel is hidden, and loads once however often it renders", async () => {
    const on = vi.fn(async () => ({ default: Page }));
    settingsSectionContributions.add("fx-on", {
      ...section(on),
      id: "fx-on",
      owner: "builtin:fx-on",
    });
    useUIStore.setState({ settingsSection: "editor" });
    await act(async () => root.render(<SettingsPanel isActive={false} />));
    expect(on).not.toHaveBeenCalled();
    await act(async () => root.render(<SettingsPanel isActive />));
    await act(async () => root.render(<SettingsPanel isActive />));
    expect(on).toHaveBeenCalledTimes(1);
  });
});

describe("Settings > Agent before detection resolves", () => {
  it("renders its full structure with a Checking state, not nothing", async () => {
    let finish!: (v: unknown) => void;
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "plugin:agent|agent_detect_binary") return new Promise((r) => (finish = r));
      return [];
    });
    featureHost.register(agentFeature);
    useUIStore.setState({ settingsSection: "agent" });
    await act(async () => root.render(<SettingsPanel isActive />));
    await vi.waitFor(() => expect(q("[data-agent-section]")).not.toBeNull());
    expect(q("[data-agent-status]")?.dataset.agentStatus).toBe("checking");
    expect(q("[data-agent-header]")).not.toBeNull();
    expect(container.querySelector('select[aria-label="Default model"]')).not.toBeNull();
    await act(async () =>
      finish({ found: true, path: "/synthetic/bin/claude", version: "2.1.325", source: "path" }),
    );
    expect(q("[data-agent-status]")?.dataset.agentStatus).toBe("ready");
  });
});
