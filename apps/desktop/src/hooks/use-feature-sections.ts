import { useEffect, useMemo } from "react";
import { preloadSections } from "@/lib/features/section-loader";
import { generatedFeatureSection } from "@/components/settings-panel/generated-feature-section";
import type { FeatureNavSection } from "@/components/settings-panel/settings-sections";
import { FEATURE_MANIFESTS, isFeatureEnabled } from "@/lib/features/manifests";
import { settingsSectionContributions } from "@/lib/features/settings-sections";
import { featureOfOwner } from "@/lib/features/id";
import { FEATURE_SETTINGS } from "@/lib/settings-schema";
import { isOffForSession, useFeatureHealth } from "@/stores/feature-health-store";
import { useAllSettings } from "@/hooks/use-settings";
import { useRegistryItems } from "@/hooks/use-registry-items";

/** The Settings sidebar pages of the features that are on: the pages features contribute (the
 *  registry holds them only while the feature is registered), plus a generated page for each
 *  enabled feature that has settings or secrets and contributes none. */
export function useFeatureSections(): FeatureNavSection[] {
  const settings = useAllSettings();
  const safeMode = useFeatureHealth((s) => s.safeMode);
  const sessionOff = useFeatureHealth((s) => s.sessionOff);
  const contributed = useRegistryItems(settingsSectionContributions);

  return useMemo(() => {
    const own = new Set(contributed.map((c) => featureOfOwner(c.owner)));
    const generated = FEATURE_MANIFESTS.filter(
      (m) =>
        !own.has(m.id) &&
        isFeatureEnabled(m, settings) &&
        !isOffForSession({ safeMode, sessionOff }, m.id),
    ).flatMap((m) => generatedFeatureSection(m, FEATURE_SETTINGS[m.id] ?? []) ?? []);
    return [...contributed, ...generated];
  }, [contributed, settings, safeMode, sessionOff]);
}

/** Preloads the chunk of every page in `sections` (the features that are on) while Settings is
 *  showing, so selecting one renders without a wait. */
export function usePreloadFeatureSections(sections: readonly FeatureNavSection[], active: boolean) {
  useEffect(() => {
    if (active) preloadSections(sections.map((s) => s.load));
  }, [sections, active]);
}
