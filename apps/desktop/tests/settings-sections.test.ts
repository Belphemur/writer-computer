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

const load = async () => ({ default: () => null });
/** What the `obsidian-host` feature contributes: Manage plugins, then one page per plugin tab. */
const hostPages = (badge?: number) => [
  {
    id: "community-plugins",
    label: "Manage plugins",
    order: 200,
    group: "Community plugins" as const,
    requiresWorkspace: true,
    badge,
    load,
  },
  {
    id: pluginSectionId("copilot", "copilot"),
    label: "Copilot",
    order: 201,
    group: "Community plugins" as const,
    requiresWorkspace: true,
    load,
  },
  {
    id: pluginSectionId("other", "main"),
    label: "Other",
    order: 202,
    group: "Community plugins" as const,
    requiresWorkspace: true,
    load,
  },
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
      "Features",
      "Privacy",
      "Secrets",
      "Command line",
      "Logs",
    ]);
  });
});

describe("buildSettingsNav", () => {
  it("hides workspace-only sections and plugin entries without a workspace", () => {
    const groups = buildSettingsNav({ hasWorkspace: false, featureSections: hostPages() });
    expect(groups.map((g) => g.group)).toEqual(["General"]);
    expect(groups[0].items.map((i) => i.id)).not.toContain("community-plugins");
  });

  it("appends one entry per plugin tab under Community plugins", () => {
    const groups = buildSettingsNav({ hasWorkspace: true, featureSections: hostPages() });
    // The host's pages do not create a Features group: they sit in Community plugins, last.
    expect(groups.map((g) => g.group)).toEqual(["General", "Community plugins"]);
    expect(groups.some((g) => g.isFeatureGroup)).toBe(false);
    const plugins = groups.find((g) => g.group === "Community plugins")!;
    expect(plugins.items.map((i) => i.label)).toEqual(["Manage plugins", "Copilot", "Other"]);
    expect(plugins.items[1].id).toBe(pluginSectionId("copilot", "copilot"));
  });

  it("badges the manage entry with the number of updates", () => {
    const groups = buildSettingsNav({ hasWorkspace: true, featureSections: hostPages(2) });
    const manage = groups.flatMap((g) => g.items).find((i) => i.id === "community-plugins");
    expect(manage?.badge).toBe(2);
    const none = buildSettingsNav({ hasWorkspace: true, featureSections: hostPages(0) });
    expect(none.flatMap((g) => g.items).find((i) => i.badge)).toBeUndefined();
  });

  it("groups feature pages after the core sections under a Features group, only when one exists", () => {
    const load = async () => ({ default: () => null });
    const none = buildSettingsNav({ hasWorkspace: true });
    expect(none.some((g) => g.isFeatureGroup)).toBe(false);
    const groups = buildSettingsNav({
      hasWorkspace: true,
      featureSections: [
        { id: "late", label: "Late", order: 50, load },
        { id: "agent", label: "Agent", order: 40, load },
        ...hostPages(),
      ],
    });
    expect(groups.map((g) => g.group)).toEqual(["General", "Features", "Community plugins"]);
    const feature = groups.find((g) => g.isFeatureGroup)!;
    expect(feature.items.map((i) => i.id)).toEqual(["agent", "late"]);
    expect(groups.filter((g) => g.isFeatureGroup)).toHaveLength(1);
  });

  it("merges feature pages with the core sections by order, and a core id wins", () => {
    const load = async () => ({ default: () => null });
    const items = (featureSections: Parameters<typeof buildSettingsNav>[0]["featureSections"]) =>
      buildSettingsNav({ hasWorkspace: true, featureSections })
        .flatMap((g) => g.items)
        .map((i) => i.id);
    const base = items([]);
    expect(base).not.toContain("agent");
    const withAgent = items([{ id: "agent", label: "Agent", order: 40, load }]);
    // behind every core section
    expect(withAgent.indexOf("agent")).toBeGreaterThan(withAgent.indexOf("logs"));
    // a page named like a core section never replaces it
    expect(items([{ id: "privacy", label: "Imposter", order: 1, load }])).toEqual(base);
  });

  it("falls back to the first item when the selection is gone", () => {
    const groups = buildSettingsNav({ hasWorkspace: true });
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
