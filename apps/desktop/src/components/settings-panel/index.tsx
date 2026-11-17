import { useEffect, useMemo } from "react";
import { EditorScrollContainer } from "@/components/editor-area/editor-scroll-container";
import { useFeatureSections, usePreloadFeatureSections } from "@/hooks/use-feature-sections";
import { preloadSections } from "@/lib/features/section-loader";
import { useWorkspaceRoot } from "@/hooks/use-workspace";
import { useUIStore } from "@/stores/ui-store";
import { FeatureSectionContent } from "./feature-section-content";
import { SectionBlocks } from "./settings-blocks";
import { SETTINGS_PANEL_ID, SettingsNav, settingsTabId } from "./settings-nav";
import { buildSettingsNav, resolveNavItem } from "./settings-sections";

export function SettingsPanel({ isActive }: { isActive: boolean }) {
  const root = useWorkspaceRoot();
  const featureSections = useFeatureSections();
  usePreloadFeatureSections(featureSections, isActive);
  const selectedId = useUIStore((s) => s.settingsSection);
  const selectSection = useUIStore((s) => s.selectSettingsSection);
  const hydrateSection = useUIStore((s) => s.hydrateSettingsSection);

  useEffect(() => {
    void hydrateSection();
  }, [hydrateSection]);

  const groups = useMemo(
    () => buildSettingsNav({ hasWorkspace: !!root, featureSections }),
    [root, featureSections],
  );
  // A page's footer button ("Browse plugins...") shows while its page is in the sidebar.
  const footer = groups.flatMap((g) => g.items).find((i) => i.feature?.footer)?.feature?.footer;

  const current = resolveNavItem(groups, selectedId);

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
          onIntent={(id) =>
            preloadSections(featureSections.filter((f) => f.id === id).map((f) => f.load))
          }
          footer={footer ? { label: footer.label, onClick: footer.run } : undefined}
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
            </div>
          </EditorScrollContainer>
        </div>
      </div>
    </div>
  );
}
