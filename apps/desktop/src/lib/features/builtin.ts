// Loads the built-in features: every `features/<id>/web/index.ts` is collected by glob (eager, so
// each must stay import-light) and registered while `features.<id>.enabled` is on. The setting is
// watched, so switching a feature off removes its commands, menu items and editor extensions at
// once and switching it on adds them back. Core never imports a feature by name.
import { useSettingsStore } from "@/stores/settings-store";
import { createFeatureHost, featureHost } from "./registry";
import { isFeatureEnabled, MANIFEST_BY_PATH } from "./manifests";
import type { FeatureDefinition, FeatureManifest } from "./types";

type Host = ReturnType<typeof createFeatureHost>;

export { isFeatureEnabled };

type Manifest = Pick<FeatureManifest, "id" | "enabledByDefault"> & {
  /** Activation events from `feature.json`; only `onStartup` is acted on here, the rest are lazy by use. */
  activation?: string[];
};

/** Registers the enabled features that are not registered and unregisters the disabled ones; a
 * feature that lists `onStartup` is activated as it is registered. */
export function syncBuiltinFeatures(
  host: Host,
  features: readonly { manifest: Manifest; definition: FeatureDefinition }[],
  settings: Record<string, unknown>,
): void {
  const registered = new Set(host.list());
  for (const { manifest, definition } of features) {
    const want = isFeatureEnabled(manifest, settings);
    if (want && !registered.has(manifest.id)) {
      host.register(definition);
      // A failed activation is already logged by the host.
      if (manifest.activation?.includes("onStartup"))
        void host.activate(manifest.id).catch(() => {});
    } else if (!want && registered.has(manifest.id)) void host.unregister(manifest.id);
  }
}

const definitions = import.meta.glob<{ default: FeatureDefinition }>(
  "../../../features/*/web/index.ts",
  { eager: true },
);
export const BUILTIN_FEATURES = Object.entries(definitions).map(([path, mod]) => {
  const manifest = MANIFEST_BY_PATH[path.replace("/web/index.ts", "/feature.json")];
  return { manifest, definition: mod.default };
});

function sync() {
  syncBuiltinFeatures(featureHost, BUILTIN_FEATURES, useSettingsStore.getState().settings);
}

sync();
useSettingsStore.subscribe((state, prev) => {
  if (state.settings !== prev.settings) sync();
});
