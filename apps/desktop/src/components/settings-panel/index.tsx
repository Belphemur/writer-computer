import { useEffect, useMemo } from "react";
import { EditorScrollContainer } from "@/components/editor-area/editor-scroll-container";
import {
  useOpenPluginBrowser,
  usePluginSettingTabs,
  usePluginUpdateCount,
  usePluginsSnapshot,
} from "@/hooks/use-plugins";
import { useFeatureSections } from "@/hooks/use-feature-sections";
import { useWorkspaceRoot } from "@/hooks/use-workspace";
import { useUIStore } from "@/stores/ui-store";
import { FeatureSectionContent } from "./feature-section-content";
import { PluginSectionContent } from "./plugin-section";
import { SectionBlocks } from "./settings-blocks";
import { SETTINGS_PANEL_ID, SettingsNav, settingsTabId } from "./settings-nav";
import { buildSettingsNav, resolveNavItem, type PluginTabInfo } from "./settings-sections";

export function SettingsPanel({ isActive }: { isActive: boolean }) {
  const root = useWorkspaceRoot();
  const snapshot = usePluginsSnapshot();
  const settingTabs = usePluginSettingTabs();
  const openBrowser = useOpenPluginBrowser();
  const updateCount = usePluginUpdateCount();
  const featureSections = useFeatureSections();
  const selectedId = useUIStore((s) => s.settingsSection);
  const selectSection = useUIStore((s) => s.selectSettingsSection);
  const hydrateSection = useUIStore((s) => s.hydrateSettingsSection);

  useEffect(() => {
    void hydrateSection();
  }, [hydrateSection]);

  const groups = useMemo(() => {
    const pluginTabs: PluginTabInfo[] = settingTabs.map((entry) => ({
      owner: entry.owner,
      tabId: entry.tab.id,
      label:
        entry.tab.name ||
        snapshot?.installed.find((p) => p.id === entry.owner)?.name ||
        entry.owner,
    }));
    return buildSettingsNav({ hasWorkspace: !!root, pluginTabs, featureSections, updateCount });
  }, [root, settingTabs, snapshot, updateCount, featureSections]);

  const current = resolveNavItem(groups, selectedId);
  const pluginEntry = current?.plugin
    ? settingTabs.find(
        (e) => e.owner === current.plugin?.owner && e.tab.id === current.plugin.tabId,
      )
    : undefined;

  return (
    <div
      data-settings-panel
      className={
        isActive ? "relative z-10 h-full" : "absolute inset-0 invisible pointer-events-none h-full"
      }
      aria-hidden={!isActive}
    >
      <div className="flex h-full flex-col md:flex-row">
        <SettingsNav
          groups={groups}
          selectedId={current?.id ?? ""}
          onSelect={selectSection}
          footer={root ? { label: "Browse plugins…", onClick: openBrowser } : undefined}
        />
        <div className="min-h-0 min-w-0 flex-1">
          <EditorScrollContainer>
            <div
              id={SETTINGS_PANEL_ID}
              role="tabpanel"
              aria-labelledby={current ? settingsTabId(current.id) : undefined}
              tabIndex={-1}
              className="mx-auto max-w-2xl px-8 pt-8 pb-24 outline-none md:pt-[9rem]"
            >
              {current && (
                <h1 className="mb-10 text-2xl font-semibold text-[var(--text-primary)]">
                  {current.label}
                </h1>
              )}
              {current?.section && <SectionBlocks section={current.section} />}
              {current?.feature && <FeatureSectionContent section={current.feature} />}
              {pluginEntry && <PluginSectionContent key={current?.id} entry={pluginEntry} />}
            </div>
          </EditorScrollContainer>
        </div>
      </div>
    </div>
  );
}
