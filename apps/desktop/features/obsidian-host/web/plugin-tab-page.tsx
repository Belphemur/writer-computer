import type { ComponentType } from "react";
import { PluginSectionContent } from "@/components/settings-panel/plugin-section";
import { usePluginSettingTabs } from "@/hooks/use-plugins";

/** The page of one plugin settings tab; it reads the live entry, so a reload swaps the tab. */
export function pluginTabPage(pluginId: string, tabId: string): ComponentType {
  return function PluginTabPage() {
    const entry = usePluginSettingTabs().find((e) => e.owner === pluginId && e.tab.id === tabId);
    return entry ? <PluginSectionContent key={`${pluginId}:${tabId}`} entry={entry} /> : null;
  };
}
