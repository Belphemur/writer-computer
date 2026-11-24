// Settings sections contributed by features (the Agent's page). The Settings sidebar
// (`components/settings-panel`) merges this registry with the core sections, so it names no
// feature (docs/consolidation.md: registry over per-case branches). Entries are added while a
// feature is registered, i.e. while it is on, and removed with it.
import { OwnedRegistry } from "@/lib/owned-registry";
import { featureOfOwner } from "./id";
import type { SettingsSectionContribution } from "./types";

export type OwnedSettingsSection = SettingsSectionContribution & { owner: string };

export const settingsSectionContributions = new OwnedRegistry<OwnedSettingsSection>();

/** The features whose Settings page is their own, so none is generated for them: those that
 *  contribute a `settingsSection`, and those that contribute an agent backend (its tab body is
 *  part of Settings > Agent). The one rule; the sidebar reads it. */
export function featuresWithOwnPage(
  ...contributions: readonly (readonly { owner: string }[])[]
): Set<string> {
  return new Set(contributions.flat().flatMap((c) => featureOfOwner(c.owner) ?? []));
}
