// Named places in core UI where a feature mounts a component (the Obsidian host's ribbon icons and
// status strip, and the tab bodies of its plugin page kinds). Core renders `<FeatureSlot slot=.../>`
// there and names no feature (docs/consolidation.md: registry over per-case branches).
import type { ComponentType } from "react";
import type { Location } from "@/components/editor-area/page-kinds";
import { OwnedRegistry } from "@/lib/owned-registry";

/** What the editor area hands the tab body of a page kind a feature supplies. */
export interface PageViewProps<L extends Location = Location> {
  location: L;
  isActive: boolean;
  tabId: string;
}

/** Slot name to the props the slot's components receive. `page-view:<kind>` exists for every page
 *  kind: a kind whose view a feature supplies renders that slot instead of a core component. */
export type SlotMap = {
  /** The strip above the workspace switcher at the bottom of the sidebar. */
  "sidebar-ribbon": object;
  /** The strip pinned to the bottom right of the editor column. */
  "editor-status": object;
  /** Above a note's properties, inside the editor column (a note's icon); `path` is the note's
   *  absolute path. Draws nothing when the feature has nothing to show: no reserved space. */
  "editor-note-header": { path: string };
} & {
  [K in Location["kind"] as `page-view:${K}`]: PageViewProps<Extract<Location, { kind: K }>>;
};
export type SlotName = keyof SlotMap;

/** One entry per slot, so a component is checked against the props of the slot it names. */
export type SlotContribution = {
  [S in SlotName]: {
    /** `<feature id>.<name>`. */
    id: string;
    slot: S;
    /** A dynamic import: the chunk loads when the slot first renders. */
    load: () => Promise<ComponentType<SlotMap[S]>>;
  };
}[SlotName];

export type OwnedSlot = SlotContribution & { owner: string };

export const slotContributions = new OwnedRegistry<OwnedSlot>();
