// Settings sections contributed by features (the Agent's page). The Settings sidebar
// (`components/settings-panel`) merges this registry with the core sections, so it names no
// feature (docs/consolidation.md: registry over per-case branches). Entries are added while a
// feature is registered, i.e. while it is on, and removed with it.
import { OwnedRegistry } from "@/lib/owned-registry";
import type { SettingsSectionContribution } from "./types";

export type OwnedSettingsSection = SettingsSectionContribution & { owner: string };

export const settingsSectionContributions = new OwnedRegistry<OwnedSettingsSection>();
