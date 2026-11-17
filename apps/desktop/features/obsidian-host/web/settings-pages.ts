// The Settings pages of the Obsidian host: "Manage plugins" and one page per community plugin
// settings tab, all in the "Community plugins" group (after the Features group, as before), plus
// the "Browse plugins..." footer. They are contributions of the feature (the one settings-section
// registry), added while the feature is active and removed with it. A plugin's tab appears and
// disappears as the plugin loads and unloads, so the set follows the plugins store.
import type { ComponentType } from "react";
import { settingsSectionContributions } from "@/lib/features/settings-sections";
import { ownerOf } from "@/lib/features/id";
import type { Dispose } from "@/lib/features/types";
import { pluginSectionId } from "@/components/settings-panel/settings-sections";
import { usePluginsStore } from "@/stores/plugins-store";
import { useUpdatesStore } from "@/stores/plugin-updates-store";
import { useUIStore } from "@/stores/ui-store";
import { OBSIDIAN_HOST_ID } from "./lifecycle";

export const MANAGE_PLUGINS_ID = "community-plugins";
/** After the core sections (10-130) and the Agent page; the plugin tabs follow Manage plugins. */
const MANAGE_ORDER = 200;

const owner = ownerOf(OBSIDIAN_HOST_ID);

/** `load` keeps its identity per page: the Settings page cache is keyed by it. */
const loaders = new Map<string, () => Promise<{ default: ComponentType }>>();
function loaderFor(id: string, make: () => Promise<ComponentType>) {
  let load = loaders.get(id);
  if (!load) {
    load = async () => ({ default: await make() });
    loaders.set(id, load);
  }
  return load;
}

export function syncSettingsPages(): Dispose {
  const added = new Map<string, { signature: string; remove: Dispose }>();

  const put = (id: string, signature: string, add: () => Dispose) => {
    const have = added.get(id);
    if (have?.signature === signature) return;
    have?.remove();
    added.set(id, { signature, remove: add() });
  };

  const sync = () => {
    const { settingTabs, snapshot } = usePluginsStore.getState();
    const badge = Object.keys(useUpdatesStore.getState().available).length;
    put(MANAGE_PLUGINS_ID, `manage:${badge}`, () =>
      settingsSectionContributions.add(MANAGE_PLUGINS_ID, {
        owner,
        id: MANAGE_PLUGINS_ID,
        label: "Manage plugins",
        order: MANAGE_ORDER,
        group: "Community plugins",
        requiresWorkspace: true,
        ...(badge ? { badge } : {}),
        footer: { label: "Browse plugins…", run: () => useUIStore.getState().openPluginBrowser() },
        load: loaderFor(MANAGE_PLUGINS_ID, () =>
          import("./manage-plugins-page").then((m) => m.ManagePluginsPage),
        ),
      }),
    );
    const live = new Set<string>([MANAGE_PLUGINS_ID]);
    settingTabs.forEach((entry, i) => {
      const id = pluginSectionId(entry.owner, entry.tab.id);
      live.add(id);
      const label =
        entry.tab.name ||
        snapshot?.installed.find((p) => p.id === entry.owner)?.name ||
        entry.owner;
      put(id, `${label}:${i}`, () =>
        settingsSectionContributions.add(id, {
          owner,
          id,
          label,
          order: MANAGE_ORDER + 1 + i,
          group: "Community plugins",
          requiresWorkspace: true,
          load: loaderFor(id, () =>
            import("./plugin-tab-page").then((m) => m.pluginTabPage(entry.owner, entry.tab.id)),
          ),
        }),
      );
    });
    for (const [id, have] of [...added]) {
      if (live.has(id)) continue;
      have.remove();
      added.delete(id);
      loaders.delete(id);
    }
  };

  sync();
  const unsubscribers = [usePluginsStore.subscribe(sync), useUpdatesStore.subscribe(sync)];
  return () => {
    for (const un of unsubscribers) un();
    for (const have of added.values()) have.remove();
    added.clear();
    loaders.clear();
  };
}
