import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const prefs = new Map<string, unknown>();
vi.mock("../src/lib/preferences", () => ({
  getPreference: vi.fn(async (k: string, fallback: unknown) => prefs.get(k) ?? fallback),
  setPreference: vi.fn(async (k: string, v: unknown) => void prefs.set(k, v)),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import {
  buildSettingsNav,
  DEFAULT_SETTINGS_SECTION,
  pluginSectionId,
  resolveNavItem,
  SETTINGS_SECTIONS,
  unassignedCategories,
} from "../src/components/settings-panel/settings-sections";
import { SETTINGS_SCHEMA } from "../src/lib/settings-schema";
import { SETTINGS_SECTION_PREFERENCE, useUIStore } from "../src/stores/ui-store";

const tabs = [
  { owner: "copilot", tabId: "copilot", label: "Copilot" },
  { owner: "other", tabId: "main", label: "Other" },
];

describe("settings section registry", () => {
  it("has unique ids and a first section that is the default", () => {
    const ids = SETTINGS_SECTIONS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(DEFAULT_SETTINGS_SECTION).toBe(ids[0]);
  });

  it("claims every schema category exactly once (a new category must be assigned)", () => {
    expect(unassignedCategories()).toEqual([]);
    const claimed = SETTINGS_SECTIONS.flatMap((s) => s.blocks)
      .filter((b) => b.type === "category")
      .map((b) => (b as { category: string }).category);
    expect(new Set(claimed).size).toBe(claimed.length);
    for (const c of claimed) expect(SETTINGS_SCHEMA.some((d) => d.category === c)).toBe(true);
  });

  it("lists the expected sections", () => {
    expect(SETTINGS_SECTIONS.map((s) => s.label)).toEqual([
      "Editor",
      "Appearance",
      "Files & vault",
      "Privacy",
      "Secrets",
      "Manage plugins",
    ]);
  });
});

describe("buildSettingsNav", () => {
  it("hides workspace-only sections and plugin entries without a workspace", () => {
    const groups = buildSettingsNav({ hasWorkspace: false, pluginTabs: tabs });
    expect(groups.map((g) => g.group)).toEqual(["General"]);
    expect(groups[0].items.map((i) => i.id)).not.toContain("community-plugins");
  });

  it("appends one entry per plugin tab under Community plugins", () => {
    const groups = buildSettingsNav({ hasWorkspace: true, pluginTabs: tabs });
    const plugins = groups.find((g) => g.group === "Community plugins")!;
    expect(plugins.items.map((i) => i.label)).toEqual(["Manage plugins", "Copilot", "Other"]);
    expect(plugins.items[1].id).toBe(pluginSectionId("copilot", "copilot"));
    expect(plugins.items[1].plugin?.owner).toBe("copilot");
  });

  it("badges the manage entry with the number of updates", () => {
    const groups = buildSettingsNav({ hasWorkspace: true, pluginTabs: [], updateCount: 2 });
    const manage = groups.flatMap((g) => g.items).find((i) => i.id === "community-plugins");
    expect(manage?.badge).toBe(2);
    const none = buildSettingsNav({ hasWorkspace: true, pluginTabs: [], updateCount: 0 });
    expect(none.flatMap((g) => g.items).find((i) => i.badge)).toBeUndefined();
  });

  it("falls back to the first item when the selection is gone", () => {
    const groups = buildSettingsNav({ hasWorkspace: true, pluginTabs: [] });
    expect(resolveNavItem(groups, "plugin:gone:x")?.id).toBe("editor");
    expect(resolveNavItem(groups, "privacy")?.id).toBe("privacy");
    expect(resolveNavItem([], "x")).toBeNull();
  });
});

describe("selected section persistence", () => {
  beforeEach(() => {
    prefs.clear();
    useUIStore.setState({ settingsSection: DEFAULT_SETTINGS_SECTION });
  });

  it("writes the selection to preferences once and ignores repeats", () => {
    useUIStore.getState().selectSettingsSection("privacy");
    useUIStore.getState().selectSettingsSection("privacy");
    expect(prefs.get(SETTINGS_SECTION_PREFERENCE)).toBe("privacy");
    expect(useUIStore.getState().settingsSection).toBe("privacy");
  });

  it("restores the stored selection, unless the user already chose one", async () => {
    prefs.set(SETTINGS_SECTION_PREFERENCE, "files");
    await useUIStore.getState().hydrateSettingsSection();
    expect(useUIStore.getState().settingsSection).toBe("files");

    useUIStore.setState({ settingsSection: "privacy" });
    await useUIStore.getState().hydrateSettingsSection();
    expect(useUIStore.getState().settingsSection).toBe("privacy");
  });

  it("ignores a malformed stored value", async () => {
    prefs.set(SETTINGS_SECTION_PREFERENCE, 42);
    await useUIStore.getState().hydrateSettingsSection();
    expect(useUIStore.getState().settingsSection).toBe(DEFAULT_SETTINGS_SECTION);
  });
});
