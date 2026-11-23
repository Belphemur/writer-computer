import type { ComponentType } from "react";
import type { FeatureSecretDecl } from "@/lib/features/types";
import type { FeatureManifest } from "@/lib/features/types";
import { appliesHere, type SettingDef } from "@/lib/settings-schema";
import { FeatureSecretRows } from "./feature-secret-rows";
import { SettingRows } from "./setting-rows";
import type { FeatureNavSection } from "./settings-sections";

/** The page of a feature that has settings (a fragment) or secrets but no page of its own: the
 *  fragment's rows, then the "Secrets" group. A feature with its own page embeds
 *  `FeatureSecretRows` itself. */
function GeneratedFeatureSection({
  featureId,
  defs,
  secrets,
}: {
  featureId: string;
  defs: readonly SettingDef[];
  secrets: readonly FeatureSecretDecl[];
}) {
  const here = defs.filter((def) => appliesHere(def));
  return (
    <>
      {here.length > 0 && <SettingRows defs={here} />}
      {secrets.length > 0 && <FeatureSecretRows featureId={featureId} secrets={secrets} />}
    </>
  );
}

/** Where a generated page sits among the feature pages (a group of its own after the core pages). */
export const GENERATED_SECTION_ORDER = 90;

const cache = new Map<string, FeatureNavSection>();

/** The generated page of `manifest`, or `null` when it has neither settings nor secrets (then the
 *  feature has no sidebar item). Memoised per feature id: the `load` identity must stay stable. */
export function generatedFeatureSection(
  manifest: Pick<FeatureManifest, "id" | "name" | "contributes">,
  defs: readonly SettingDef[],
): FeatureNavSection | null {
  const secrets = manifest.contributes?.secrets ?? [];
  if (defs.length === 0 && secrets.length === 0) return null;
  const id = `feature:${manifest.id}`;
  const hit = cache.get(id);
  if (hit) return hit;
  const Page: ComponentType = () => (
    <GeneratedFeatureSection featureId={manifest.id} defs={defs} secrets={secrets} />
  );
  const section: FeatureNavSection = {
    id,
    label: manifest.name,
    order: GENERATED_SECTION_ORDER,
    load: async () => ({ default: Page }),
  };
  cache.set(id, section);
  return section;
}
