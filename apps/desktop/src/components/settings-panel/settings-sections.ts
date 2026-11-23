// The one registry of Settings sections. The sidebar, the content pane, the "open Settings at
// section X" entry points and the tests all derive from `SETTINGS_SECTIONS`; the pages features
// contribute (the Obsidian host's plugin pages among them) are merged in by `buildSettingsNav`. No React here so stores and hooks can import it.
import type { ComponentType } from "react";
import { FEATURE_GROUP_LABEL } from "@/lib/features/origin";
import { FEATURE_SETTINGS, SETTINGS_SCHEMA } from "@/lib/settings-schema";

/** What a section's content pane is made of. Each type has exactly one renderer in
 *  `settings-blocks.tsx` (a `Record` keyed by this union, so a new type cannot be forgotten). */
export type SectionBlock =
  | { type: "category"; category: string }
  | { type: "themes" }
  | { type: "secrets" }
  | { type: "logs" }
  /** Install or remove the `writer` command on the PATH (macOS and Linux). */
  | { type: "cli" }
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
    id: "command-line",
    order: 125,
    label: "Command line",
    group: "General",
    blocks: [{ type: "cli" }],
  },
  {
    id: "logs",
    order: 130,
    label: "Logs",
    group: "General",
    blocks: [category("Logs"), { type: "logs" }],
  },
];

export const DEFAULT_SETTINGS_SECTION = SETTINGS_SECTIONS[0].id;

/** Schema categories rendered by `ThemesSection`, not by the generic category renderer. */
export const THEME_CATEGORY = "Theme";

/** Schema category rendered by the Agent feature's own section, not by the generic category renderer. */
export const AGENT_CATEGORY = "Agent";

/** Schema category of the community plugins' settings, rendered by the Obsidian host feature's
 *  "Manage plugins" page (the Obsidian host feature). */
export const COMMUNITY_PLUGINS_CATEGORY = "Community plugins";

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
  claimed.add(COMMUNITY_PLUGINS_CATEGORY);
  // A feature's own settings fragment is rendered by its generated page (or its own section).
  for (const def of Object.values(FEATURE_SETTINGS).flat()) claimed.add(def.category);
  return [...new Set(SETTINGS_SCHEMA.map((d) => d.category))].filter((c) => !claimed.has(c));
}

// ---------- Plugin sections ----------

export function pluginSectionId(owner: string, tabId: string): string {
  return `plugin:${owner}:${tabId}`;
}

/** A sidebar page a feature contributes (its own, or the generated one for a feature with
 *  settings or secrets and no page of its own). Shown only while the feature is on. */
export interface FeatureNavSection {
  id: string;
  label: string;
  order: number;
  load: () => Promise<{ default: ComponentType }>;
  /** The sidebar group (`SettingsSectionContribution.group`), "Features" when absent. */
  group?: SettingsGroup;
  /** Hidden when no workspace is open. */
  requiresWorkspace?: boolean;
  /** Small count next to the label (plugin updates on "Manage plugins"). */
  badge?: number;
  /** A plain button after the last group while this page is in the sidebar. */
  footer?: { label: string; run: () => void };
}

export interface NavItem {
  id: string;
  label: string;
  group: SettingsGroup;
  /** Static section this entry mounts. */
  section?: SettingsSection;
  /** The feature page this entry mounts. */
  feature?: FeatureNavSection;
  badge?: number;
}

export interface NavGroup {
  group: SettingsGroup;
  /** The group of feature pages: the nav draws a divider above its label. */
  isFeatureGroup: boolean;
  items: NavItem[];
}

/** The sidebar: registry sections, the pages of the features that are on (merged by `order`; a
 *  page sits in the "Features" group unless it names another, the Obsidian host's pages name
 *  "Community plugins"), grouped in `SETTINGS_GROUPS` order (an empty group is not listed, so no
 *  feature page, no divider). A page that needs a workspace is hidden without one. */
export function buildSettingsNav(opts: {
  hasWorkspace: boolean;
  /** Pages of the features that are on, merged with the core sections by `order`. A page whose id
   *  is a core section's id is ignored (the core page wins). */
  featureSections?: readonly FeatureNavSection[];
}): NavGroup[] {
  const coreIds = new Set(SETTINGS_SECTIONS.map((s) => s.id));
  const items: NavItem[] = [
    ...SETTINGS_SECTIONS.map((section) => ({
      id: section.id,
      label: section.label,
      group: section.group,
      order: section.order,
      section,
    })),
    ...(opts.featureSections ?? [])
      .filter((f) => !coreIds.has(f.id) && (opts.hasWorkspace || !f.requiresWorkspace))
      .map((feature) => ({
        id: feature.id,
        label: feature.label,
        group: feature.group ?? (FEATURE_GROUP_LABEL as SettingsGroup),
        order: feature.order,
        feature,
        ...(feature.badge ? { badge: feature.badge } : {}),
      })),
  ].sort((a, b) => a.order - b.order);
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
