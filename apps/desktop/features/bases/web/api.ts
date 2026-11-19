// The public entry of the Bases feature: what another feature may name. The Obsidian shim's
// `registerBasesView` needs to put a view type into the Bases view registry and to evaluate a
// formula; it gets both through the service `bases.views` (`getService`, `@/lib/features/services`)
// and takes the TYPES from here with `import type` (erased: no runtime edge between the features).
// Nothing else of this folder is a contract.
import type { ComponentType } from "react";
import type { BaseEvalArgs, Cell } from "./lib/types";
import type { EmbeddedBaseProps } from "./view/embedded";
import type { BaseViewEntry } from "./lib/view-registry";
import type { ValueOption, ViewOption } from "./lib/view-options";

export type { BaseDocument, BaseQueryResult, BaseView, Cell, CellValue } from "./lib/types";
export type { BaseEmbed } from "./lib/embeds";
export type { BaseViewEntry, BaseViewProps, MountedView } from "./lib/view-registry";
export type { EmbeddedBaseProps } from "./view/embedded";
export type { ValueOption, ViewOption } from "./lib/view-options";

/** The service id, one of the manifest's `provides`. */
export const BASES_VIEWS = "bases.views";

/** The Bases view registry and the engine's formula evaluation, for a plugin host. */
export interface BasesViewsService {
  /** Register a view type: its unregister function, or `null` when the type is taken. */
  registerView(entry: BaseViewEntry): (() => void) | null;
  /** Remove every view an owner registered (plugin disable); how many went. */
  unregisterOwned(owner: string): number;
  /** Evaluate one expression with `thisPath` as the current row and `this`. */
  evaluate(args: BaseEvalArgs): Promise<Cell>;
  /** `note.x` and `x` are the same property. */
  canonicalPropertyKey(id: string): string;
  flattenOptions(options: readonly ViewOption[]): ValueOption[];
  /**
   * The component that shows a base embedded in a note (a `.base` file or inline `.base` text),
   * loaded on demand: how another feature shows a computed base (Dataview's blocks) without
   * importing this feature's internals.
   */
  loadEmbeddedBase(): Promise<ComponentType<EmbeddedBaseProps>>;
}
