// "Is this built-in feature running right now?" for code that cannot wait for a registry: the
// feature's switch (`features.<id>.enabled`, else the manifest default) and no session override
// (safe mode, repeated failures). The loader (`builtin.ts`) registers exactly the features this
// says yes to, so for a registered feature it agrees with `featureHost.list()`. Light on purpose
// (settings and health stores, the manifests): page-kind routing reads it at startup.
import { useFeatureHealth, isOffForSession } from "@/stores/feature-health-store";
import { useSettingsStore } from "@/stores/settings-store";
import { FEATURE_MANIFESTS, isFeatureEnabled } from "./manifests";

export function isFeatureActive(id: string): boolean {
  const manifest = FEATURE_MANIFESTS.find((m) => m.id === id);
  if (!manifest) return false;
  return (
    isFeatureEnabled(manifest, useSettingsStore.getState().settings) &&
    !isOffForSession(useFeatureHealth.getState(), id)
  );
}

/** [`isFeatureActive`], re-rendering when the switch or the session state changes. */
export function useFeatureActive(id: string): boolean {
  useSettingsStore((s) => s.settings);
  useFeatureHealth((s) => s.sessionOff);
  useFeatureHealth((s) => s.safeMode);
  return isFeatureActive(id);
}
