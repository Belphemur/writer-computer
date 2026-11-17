// The one registry of Settings sections. The sidebar, the content pane, the "open Settings at
// section X" entry points and the tests all derive from `SETTINGS_SECTIONS`; plugin sections
// are appended at runtime by `buildSettingsNav`. No React here so stores and hooks can import it.
import { SETTINGS_SCHEMA } from "@/lib/settings-schema";

/** What a section's content pane is made of. Each type has exactly one renderer in
 *  `settings-blocks.tsx` (a `Record` keyed by this union, so a new type cannot be forgotten). */
export type SectionBlock =
  | { type: "category"; category: string }
  | { type: "themes" }
  | { type: "community-plugins" }
  | { type: "secrets" }
  | { type: "logs" }
  | { type: "agent" };

export const SETTINGS_GROUPS = ["General", "Community plugins"] as const;
export type SettingsGroup = (typeof SETTINGS_GROUPS)[number];

export interface SettingsSection {
  id: string;
  label: string;
  group: SettingsGroup;
  blocks: readonly SectionBlock[];
  /** Hidden when no workspace is open (plugins belong to a vault). */
  requiresWorkspace?: boolean;
}

const category = (name: string): SectionBlock => ({ type: "category", category: name });

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  {
    id: "editor",
    label: "Editor",
    group: "General",
    blocks: [category("Editor"), category("Status Bar")],
  },
  {
    id: "appearance",
    label: "Appearance",
    group: "General",
    blocks: [category("Appearance"), category("Typography"), { type: "themes" }],
  },
  {
    id: "files",
    label: "Files & vault",
    group: "General",
    blocks: [category("Files"), category("Workspace"), category("Window"), category("Search")],
  },
  {
    id: "agent",
    label: "Agent",
    group: "General",
    blocks: [category("Agent"), { type: "agent" }],
  },
  {
    id: "privacy",
    label: "Privacy",
    group: "General",
    blocks: [category("Privacy")],
  },
  {
    id: "secrets",
    label: "Secrets",
    group: "General",
    blocks: [{ type: "secrets" }],
  },
  {
    id: "logs",
    label: "Logs",
    group: "General",
    blocks: [category("Logs"), { type: "logs" }],
  },
  {
    id: "community-plugins",
    label: "Manage plugins",
    group: "Community plugins",
    blocks: [category("Community plugins"), { type: "community-plugins" }],
    requiresWorkspace: true,
  },
];

export const DEFAULT_SETTINGS_SECTION = SETTINGS_SECTIONS[0].id;

/** Schema categories rendered by `ThemesSection`, not by the generic category renderer. */
export const THEME_CATEGORY = "Theme";

/** Schema categories no section claims (a new category must be added to a section above). */
export function unassignedCategories(): string[] {
  const claimed = new Set(
    SETTINGS_SECTIONS.flatMap((s) => s.blocks)
      .filter((b): b is Extract<SectionBlock, { type: "category" }> => b.type === "category")
      .map((b) => b.category),
  );
  claimed.add(THEME_CATEGORY);
  return [...new Set(SETTINGS_SCHEMA.map((d) => d.category))].filter((c) => !claimed.has(c));
}

// ---------- Plugin sections ----------

export function pluginSectionId(owner: string, tabId: string): string {
  return `plugin:${owner}:${tabId}`;
}

/** One plugin PluginSettingTab as the nav sees it. */
export interface PluginTabInfo {
  owner: string;
  tabId: string;
  /** Sidebar label: the tab's name, else the plugin's name. */
  label: string;
}

export interface NavItem {
  id: string;
  label: string;
  group: SettingsGroup;
  /** Static section, or the plugin tab this entry mounts. */
  section?: SettingsSection;
  plugin?: PluginTabInfo;
  /** Small count shown next to the label (plugin updates on "Manage plugins"). */
  badge?: number;
}

export interface NavGroup {
  group: SettingsGroup;
  items: NavItem[];
}

/** The sidebar: registry sections (minus the ones needing a workspace when none is open), then
 *  one entry per plugin settings tab, grouped in `SETTINGS_GROUPS` order. */
export function buildSettingsNav(opts: {
  hasWorkspace: boolean;
  pluginTabs: readonly PluginTabInfo[];
  /** Plugins with an update available; badges the community-plugins entry. */
  updateCount?: number;
}): NavGroup[] {
  const items: NavItem[] = [
    ...SETTINGS_SECTIONS.filter((s) => opts.hasWorkspace || !s.requiresWorkspace).map(
      (section) => ({
        id: section.id,
        label: section.label,
        group: section.group,
        section,
        ...(section.id === "community-plugins" && opts.updateCount
          ? { badge: opts.updateCount }
          : {}),
      }),
    ),
    ...(opts.hasWorkspace ? opts.pluginTabs : []).map((plugin) => ({
      id: pluginSectionId(plugin.owner, plugin.tabId),
      label: plugin.label,
      group: "Community plugins" as const,
      plugin,
    })),
  ];
  return SETTINGS_GROUPS.map((group) => ({
    group,
    items: items.filter((i) => i.group === group),
  })).filter((g) => g.items.length > 0);
}

/** The selected item: `selectedId` if it is in the nav, else the first one (e.g. a remembered
 *  plugin section whose plugin is disabled or still loading). */
export function resolveNavItem(groups: readonly NavGroup[], selectedId: string): NavItem | null {
  const flat = groups.flatMap((g) => g.items);
  return flat.find((i) => i.id === selectedId) ?? flat[0] ?? null;
}
