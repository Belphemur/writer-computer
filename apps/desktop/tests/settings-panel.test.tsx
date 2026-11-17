// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));
vi.mock("../src/lib/preferences", () => ({
  getPreference: vi.fn(async (_k: string, fallback: unknown) => fallback),
  setPreference: vi.fn(async () => {}),
}));

import { invoke } from "@tauri-apps/api/core";
import { SettingsPanel } from "../src/components/settings-panel";
import { pluginSectionId } from "../src/components/settings-panel/settings-sections";
import { syncSettingsPages } from "../features/obsidian-host/web/settings-pages";
import { SETTINGS_SCHEMA } from "../src/lib/settings-schema";
import { usePluginsStore } from "../features/obsidian-host/web/stores/plugins-store";
import { useSettingsStore } from "../src/stores/settings-store";
import { useUIStore } from "../src/stores/ui-store";
import { useWorkspaceStore } from "../src/stores/workspace-store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;
const calls: string[] = [];

function fakeTab(id: string, name: string) {
  const containerEl = document.createElement("div");
  containerEl.textContent = `options of ${id}`;
  return {
    id,
    name,
    containerEl,
    display: () => void calls.push(`display:${id}`),
    hide: () => void calls.push(`hide:${id}`),
  };
}

// The Obsidian host's pages are contributed by its feature while it is active.
let stopHostPages: () => void;

async function mount() {
  await act(async () => {
    root.render(<SettingsPanel isActive />);
  });
  // A contributed page's chunk is a dynamic import.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
}

const tabs = () => [...container.querySelectorAll<HTMLElement>('[role="tab"]')];
const labels = () => tabs().map((t) => t.textContent);
const selected = () => tabs().find((t) => t.getAttribute("aria-selected") === "true");

beforeEach(() => {
  calls.length = 0;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  useSettingsStore.setState({
    settings: Object.fromEntries(SETTINGS_SCHEMA.map((d) => [d.key, d.default])),
    isLoaded: true,
  });
  useUIStore.setState({ settingsSection: "editor" });
  useWorkspaceStore.setState({ root: "/synthetic-vault" });
  usePluginsStore.setState({ settingTabs: [], snapshot: null });
  stopHostPages = syncSettingsPages();
});

afterEach(async () => {
  stopHostPages();
  await act(async () => root.unmount());
  container.remove();
  useWorkspaceStore.setState({ root: null });
});

describe("Auto-reveal current file row", () => {
  it("renders in Appearance, on by default, and toggles off", async () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    useUIStore.setState({ settingsSection: "appearance" });
    await mount();
    const row = [...container.querySelectorAll("*")].find(
      (el) => el.children.length > 0 && el.textContent?.startsWith("Auto-reveal current file"),
    )!;
    expect(container.textContent).toContain("expand its folders and scroll to it");
    const toggle = [...container.querySelectorAll<HTMLElement>('[role="switch"]')].find((b) =>
      b.closest("div")?.parentElement?.textContent?.includes("Auto-reveal current file"),
    )!;
    expect(row).toBeTruthy();
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await act(async () => toggle.click());
    expect(JSON.stringify(vi.mocked(invoke).mock.calls)).toContain(
      '"key":"sidebar.auto-reveal-active-file","value":false',
    );
    vi.unstubAllGlobals();
  });
});

describe("SettingsPanel sidebar", () => {
  it("shows one section at a time with a heading, and aria roles", async () => {
    await mount();
    expect(container.querySelector('[role="tablist"]')).not.toBeNull();
    expect(selected()?.textContent).toBe("Editor");
    const panel = container.querySelector('[role="tabpanel"]')!;
    expect(panel.querySelector("h1")?.textContent).toBe("Editor");
    expect(panel.getAttribute("aria-labelledby")).toBe(selected()!.id);
    // Another section's options are not rendered.
    expect(container.querySelector('[data-settings-category="Privacy"]')).toBeNull();
    expect(container.querySelector('[data-settings-category="Editor"]')).not.toBeNull();
  });

  it("selects on click and remembers it in the store", async () => {
    await mount();
    await act(async () =>
      tabs()
        .find((t) => t.textContent === "Privacy")!
        .click(),
    );
    expect(useUIStore.getState().settingsSection).toBe("privacy");
    expect(container.querySelector('[data-settings-category="Privacy"]')).not.toBeNull();
    expect(container.querySelector("h1")?.textContent).toBe("Privacy");
  });

  it("opens at the remembered section", async () => {
    useUIStore.setState({ settingsSection: "files" });
    await mount();
    expect(selected()?.textContent).toBe("Files & vault");
  });

  it("moves with arrow keys, Home and End, with a roving tabindex", async () => {
    await mount();
    const list = container.querySelector('[role="tablist"]')!;
    const key = (k: string) =>
      act(async () => {
        list.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
      });
    await key("ArrowDown");
    expect(selected()?.textContent).toBe("Appearance");
    expect(selected()?.tabIndex).toBe(0);
    expect(tabs().filter((t) => t.tabIndex === 0)).toHaveLength(1);
    await key("End");
    expect(selected()?.textContent).toBe("Manage plugins");
    await key("ArrowDown");
    expect(selected()?.textContent).toBe("Editor");
    await key("ArrowUp");
    expect(selected()?.textContent).toBe("Manage plugins");
    await key("Home");
    expect(selected()?.textContent).toBe("Editor");
  });

  it("hides the plugin group without a workspace", async () => {
    useWorkspaceStore.setState({ root: null });
    await mount();
    expect(labels()).not.toContain("Manage plugins");
  });
});

describe("plugin sections", () => {
  it("lists a plugin tab, mounts it on selection and tears it down on section change", async () => {
    const tab = fakeTab("copilot", "Copilot");
    usePluginsStore.setState({ settingTabs: [{ owner: "copilot", tab }] });
    useUIStore.setState({ settingsSection: pluginSectionId("copilot", "copilot") });
    await mount();
    expect(labels()).toContain("Copilot");
    expect(selected()?.textContent).toBe("Copilot");
    expect(container.querySelector("h1")?.textContent).toBe("Copilot");
    expect(container.textContent).toContain("options of copilot");
    expect(calls).toEqual(["display:copilot"]);

    await act(async () =>
      tabs()
        .find((t) => t.textContent === "Editor")!
        .click(),
    );
    expect(calls).toEqual(["display:copilot", "hide:copilot"]);
    expect(container.textContent).not.toContain("options of copilot");
  });

  it("hides the tab when the Settings tab unmounts", async () => {
    const tab = fakeTab("p", "Plug");
    usePluginsStore.setState({ settingTabs: [{ owner: "p", tab }] });
    useUIStore.setState({ settingsSection: pluginSectionId("p", "p") });
    await mount();
    await act(async () => root.unmount());
    expect(calls).toEqual(["display:p", "hide:p"]);
    root = createRoot(container);
  });

  it("falls back to the first section when the plugin is disabled", async () => {
    const tab = fakeTab("p", "Plug");
    usePluginsStore.setState({ settingTabs: [{ owner: "p", tab }] });
    useUIStore.setState({ settingsSection: pluginSectionId("p", "p") });
    await mount();
    await act(async () => usePluginsStore.setState({ settingTabs: [] }));
    expect(selected()?.textContent).toBe("Editor");
    expect(calls).toEqual(["display:p", "hide:p"]);
    // The remembered choice is kept so the section returns when the plugin does.
    expect(useUIStore.getState().settingsSection).toBe(pluginSectionId("p", "p"));
  });
});
