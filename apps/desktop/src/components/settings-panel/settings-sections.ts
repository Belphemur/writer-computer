// The one registry of Settings sections. The sidebar, the content pane, the "open Settings at
// section X" entry points and the tests all derive from `SETTINGS_SECTIONS`; plugin sections
// are appended at runtime by `buildSettingsNav`. No React here so stores and hooks can import it.
import type { ComponentType } from "react";
import { FEATURE_GROUP_LABEL } from "@/lib/features/origin";
import { SETTINGS_SCHEMA } from "@/lib/settings-schema";

/** What a section's content pane is made of. Each type has exactly one renderer in
 *  `settings-blocks.tsx` (a `Record` keyed by this union, so a new type cannot be forgotten). */
export type SectionBlock =
  | { type: "category"; category: string }
  | { type: "themes" }
  | { type: "community-plugins" }
  | { type: "secrets" }
  | { type: "logs" }
  /** Generated from the feature manifests: a toggle per feature, its info and failure state. */
  | { type: "features" };

/** Core groups, then the feature pages (the one origin rule, `lib/features/origin.ts`), then the
 *  community plugins' pages (which the "Browse plugins" footer button follows). */
export const SETTINGS_GROUPS = ["General", FEATURE_GROUP_LABEL, "Community plugins"] as const;
export type SettingsGroup = (typeof SETTINGS_GROUPS)[number];

export interface SettingsSection {
  id: string;
  label: string;
  group: SettingsGroup;
  blocks: readonly SectionBlock[];
  /** Sidebar position among all sections, features' ones included (`FeatureNavSection.order`). */
  order: number;
  /** Hidden when no workspace is open (plugins belong to a vault). */
  requiresWorkspace?: boolean;
}

const category = (name: string): SectionBlock => ({ type: "category", category: name });

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  {
    id: "editor",
    order: 10,
    label: "Editor",
    group: "General",
    blocks: [category("Editor"), category("Status Bar")],
  },
  {
    id: "appearance",
    order: 20,
    label: "Appearance",
    group: "General",
    blocks: [category("Appearance"), category("Typography"), { type: "themes" }],
  },
  {
    id: "files",
    order: 30,
    label: "Files & vault",
    group: "General",
    blocks: [category("Files"), category("Workspace"), category("Window"), category("Search")],
  },
  {
    id: "features",
    order: 100,
    label: "Features",
    group: "General",
    blocks: [{ type: "features" }],
  },
  {
    id: "privacy",
    order: 110,
    label: "Privacy",
    group: "General",
    blocks: [category("Privacy")],
  },
  {
    id: "secrets",
    order: 120,
    label: "Secrets",
    group: "General",
    blocks: [{ type: "secrets" }],
  },
  {
    id: "logs",
    order: 130,
    label: "Logs",
    group: "General",
    blocks: [category("Logs"), { type: "logs" }],
  },
  {
    id: "community-plugins",
    order: 200,
    label: "Manage plugins",
    group: "Community plugins",
    blocks: [category("Community plugins"), { type: "community-plugins" }],
    requiresWorkspace: true,
  },
];

export const DEFAULT_SETTINGS_SECTION = SETTINGS_SECTIONS[0].id;

/** Schema categories rendered by `ThemesSection`, not by the generic category renderer. */
export const THEME_CATEGORY = "Theme";

/** Schema category rendered by the Agent feature's own section, not by the generic category renderer. */
export const AGENT_CATEGORY = "Agent";

/** Schema category of the features' kill switches, rendered by `FeaturesSection`. */
export const FEATURES_CATEGORY = "Features";

/** Schema categories no section claims (a new category must be added to a section above). */
export function unassignedCategories(): string[] {
  const claimed = new Set(
    SETTINGS_SECTIONS.flatMap((s) => s.blocks)
      .filter((b): b is Extract<SectionBlock, { type: "category" }> => b.type === "category")
      .map((b) => b.category),
  );
  claimed.add(THEME_CATEGORY);
  claimed.add(AGENT_CATEGORY);
  claimed.add(FEATURES_CATEGORY);
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

/** A sidebar page a feature contributes (its own, or the generated one for a feature with
 *  settings or secrets and no page of its own). Shown only while the feature is on. */
export interface FeatureNavSection {
  id: string;
  label: string;
  order: number;
  load: () => Promise<{ default: ComponentType }>;
}

export interface NavItem {
  id: string;
  label: string;
  group: SettingsGroup;
  /** Static section, or the plugin tab this entry mounts. */
  section?: SettingsSection;
  plugin?: PluginTabInfo;
  /** The feature page this entry mounts. */
  feature?: FeatureNavSection;
  /** Small count shown next to the label (plugin updates on "Manage plugins"). */
  badge?: number;
}

export interface NavGroup {
  group: SettingsGroup;
  /** The group of feature pages: the nav draws a divider above its label. */
  isFeatureGroup: boolean;
  items: NavItem[];
}

/** The sidebar: registry sections (minus the ones needing a workspace when none is open), the
 *  feature pages under their own "Features" group, then one entry per plugin settings tab, grouped
 *  in `SETTINGS_GROUPS` order (an empty group is not listed, so no feature page, no divider). */
export function buildSettingsNav(opts: {
  hasWorkspace: boolean;
  pluginTabs: readonly PluginTabInfo[];
  /** Pages of the features that are on, merged with the core sections by `order`. A page whose id
   *  is a core section's id is ignored (the core page wins). */
  featureSections?: readonly FeatureNavSection[];
  /** Plugins with an update available; badges the community-plugins entry. */
  updateCount?: number;
}): NavGroup[] {
  const coreIds = new Set(SETTINGS_SECTIONS.map((s) => s.id));
  const sorted: (NavItem & { order: number })[] = [
    ...SETTINGS_SECTIONS.filter((s) => opts.hasWorkspace || !s.requiresWorkspace).map(
      (section) => ({
        id: section.id,
        label: section.label,
        group: section.group,
        order: section.order,
        section,
        ...(section.id === "community-plugins" && opts.updateCount
          ? { badge: opts.updateCount }
          : {}),
      }),
    ),
    ...(opts.featureSections ?? [])
      .filter((f) => !coreIds.has(f.id))
      .map((feature) => ({
        id: feature.id,
        label: feature.label,
        group: FEATURE_GROUP_LABEL as SettingsGroup,
        order: feature.order,
        feature,
      })),
  ].sort((a, b) => a.order - b.order);
  const items: NavItem[] = [
    ...sorted,
    ...(opts.hasWorkspace ? opts.pluginTabs : []).map((plugin) => ({
      id: pluginSectionId(plugin.owner, plugin.tabId),
      label: plugin.label,
      group: "Community plugins" as const,
      plugin,
    })),
  ];
  return SETTINGS_GROUPS.map((group) => ({
    group,
    isFeatureGroup: group === FEATURE_GROUP_LABEL,
    items: items.filter((i) => i.group === group),
  })).filter((g) => g.items.length > 0);
}

/** The selected item: `selectedId` if it is in the nav, else the first one (e.g. a remembered
 *  plugin section whose plugin is disabled or still loading). */
export function resolveNavItem(groups: readonly NavGroup[], selectedId: string): NavItem | null {
  const flat = groups.flatMap((g) => g.items);
  return flat.find((i) => i.id === selectedId) ?? flat[0] ?? null;
}
