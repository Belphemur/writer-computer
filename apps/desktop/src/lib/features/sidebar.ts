// Sidebar contributions of features: panels next to Files and toolbar buttons in the sidebar
// header. The sidebar (`components/sidebar`) reads these registries, so it names no feature
// (docs/consolidation.md: registry over per-case branches). Entries exist while a feature is on.
import { OwnedRegistry } from "@/lib/owned-registry";
import type { SidebarActionContribution, SidebarPanelContribution } from "./types";

export type OwnedSidebarPanel = SidebarPanelContribution & { owner: string };
/** `run` is already bound to the feature: it activates it first and contains a failure. */
export type OwnedSidebarAction = Omit<SidebarActionContribution, "run"> & {
  owner: string;
  run: () => void;
};

export const sidebarPanelContributions = new OwnedRegistry<OwnedSidebarPanel>();
export const sidebarActionContributions = new OwnedRegistry<OwnedSidebarAction>();
