// Every built-in feature's `feature.json`, collected by glob: the facts the loader and the
// Features settings section read. A feature with no `web/index.ts` (a Rust-only one) is listed
// too. Core never imports a feature by name.
import type { FeatureManifest } from "./types";

const files = import.meta.glob<FeatureManifest>("@features/*/feature.json", {
  eager: true,
  import: "default",
});

/** Keyed by the manifest's path, so the loader can pair it with `web/index.ts` of the same folder. */
export const MANIFEST_BY_PATH: Readonly<Record<string, FeatureManifest>> = files;

/** All manifests, by name. */
export const FEATURE_MANIFESTS: readonly FeatureManifest[] = Object.values(files).sort((a, b) =>
  a.name.localeCompare(b.name),
);

export const enabledKey = (id: string) => `features.${id}.enabled`;

/** Does the feature have a Rust half (commands, events, hooks, or commands the app registers and
 *  the feature gates)? Its web half registers only once Rust reports it started. */
export function hasRustHalf(manifest: Pick<FeatureManifest, "rust">): boolean {
  const r = manifest.rust;
  return (
    (r?.commands?.length ?? 0) > 0 ||
    (r?.events?.length ?? 0) > 0 ||
    (r?.hooks?.length ?? 0) > 0 ||
    (r?.gatedCommands?.length ?? 0) > 0
  );
}

/** The kill switch: `features.<id>.enabled`, else the manifest's default. */
export function isFeatureEnabled(
  manifest: Pick<FeatureManifest, "id" | "enabledByDefault">,
  settings: Record<string, unknown>,
): boolean {
  const v = settings[enabledKey(manifest.id)];
  return typeof v === "boolean" ? v : (manifest.enabledByDefault ?? true);
}
