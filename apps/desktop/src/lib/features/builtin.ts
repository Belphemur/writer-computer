// Loads the built-in features: every `features/<id>/web/index.ts` is collected by glob (eager, so
// each must stay import-light) and registered while `features.<id>.enabled` is on. The setting is
// watched, so switching a feature off removes its commands, menu items and editor extensions at
// once and switching it on adds them back. Core never imports a feature by name.
import { isOffForSession, useFeatureHealth } from "@/stores/feature-health-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { startFeatureHealthBridge } from "./health-bridge";
import { createFeatureHost, featureHost } from "./registry";
import { isFeatureEnabled, MANIFEST_BY_PATH } from "./manifests";
import type { FeatureDefinition, FeatureManifest } from "./types";

type Host = ReturnType<typeof createFeatureHost>;

export { isFeatureEnabled };

type Manifest = Pick<FeatureManifest, "id" | "enabledByDefault"> & {
  /** Activation events from `feature.json`; `onStartup` and `onWorkspaceOpen` are acted on here,
   *  the rest are lazy by use. */
  activation?: string[];
};

/** Registers the enabled features that are not registered and unregisters the disabled ones; a
 * feature that lists `onStartup` is activated as it is registered. `isOff` is the session
 * override (safe mode, or switched off after failures): such a feature is not wanted whatever its
 * setting says, and the setting itself is never touched. */
export function syncBuiltinFeatures(
  host: Host,
  features: readonly { manifest: Manifest; definition: FeatureDefinition }[],
  settings: Record<string, unknown>,
  isOff: (id: string) => boolean = () => false,
  hasWorkspace: () => boolean = () => false,
): void {
  const registered = new Set(host.list());
  for (const { manifest, definition } of features) {
    const want = isFeatureEnabled(manifest, settings) && !isOff(manifest.id);
    if (want && !registered.has(manifest.id)) {
      host.register(definition);
      // A failed activation is already logged by the host.
      if (manifest.activation?.includes("onStartup"))
        void host.activate(manifest.id).catch(() => {});
    } else if (!want && registered.has(manifest.id)) void host.unregister(manifest.id);
    // `onWorkspaceOpen`: activated once a workspace is open (also when the feature is switched on
    // while one is). Activation is idempotent; a feature that failed stays failed.
    if (want && manifest.activation?.includes("onWorkspaceOpen") && hasWorkspace()) {
      if (host.state(manifest.id) === "registered") void host.activate(manifest.id).catch(() => {});
    }
  }
}

const definitions = import.meta.glob<{ default: FeatureDefinition }>("@features/*/web/index.ts", {
  eager: true,
});
export const BUILTIN_FEATURES = Object.entries(definitions).map(([path, mod]) => {
  const manifest = MANIFEST_BY_PATH[path.replace("/web/index.ts", "/feature.json")];
  return { manifest, definition: mod.default };
});

function sync() {
  const health = useFeatureHealth.getState();
  syncBuiltinFeatures(
    featureHost,
    BUILTIN_FEATURES,
    useSettingsStore.getState().settings,
    (id) => isOffForSession(health, id),
    () => useWorkspaceStore.getState().root !== null,
  );
}

sync();
useSettingsStore.subscribe((state, prev) => {
  if (state.settings !== prev.settings) sync();
});
// A workspace opening activates the features that wait for one.
useWorkspaceStore.subscribe((state, prev) => {
  if (state.root !== prev.root) sync();
});
// Safe mode, a third failure or a `features:failed` from Rust switches the web half off.
useFeatureHealth.subscribe((state, prev) => {
  if (state.sessionOff !== prev.sessionOff || state.safeMode !== prev.safeMode) sync();
});
startFeatureHealthBridge();
