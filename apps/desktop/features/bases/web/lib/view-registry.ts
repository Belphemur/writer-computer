// The one registry of Bases view types. The built-in table, cards and list register through
// `registerBaseView` exactly like a plugin's `registerBasesView` does (the host calls this with
// the plugin id as `owner`); the view tab dispatches on the view's `type`. An unregistered type
// (kanban, map, anything unknown) gets the placeholder, never a guess.
import type { ComponentType } from "react";
import type { LinkIntent } from "@/lib/link-activation";
import type { ViewOption } from "./view-options";
import { propertyOptionValues } from "./view-options";
import type { BaseDocument, BaseQueryResult, BaseView, Cell } from "./types";

/** What opening something from a view does: links and file cells open in a new tab, in the
 *  background for a middle or Cmd/Ctrl click (`LinkIntent`, `lib/link-activation.ts`). */
export interface ViewActions {
  openFile: (relativePath: string, intent?: LinkIntent) => void;
  openLink: (link: { target: string; resolved: string | null }, intent?: LinkIntent) => void;
}

/** The config edits a view can request; each writes the `.base` and reloads (one write path). */
export interface ViewConfig {
  /** Header click: cycle that column's sort (asc, desc, none); `append` adds to a multi-sort. */
  cycleSort(columnId: string, append: boolean): void;
  /** Persist a resized column (`columnSize`). */
  setColumnWidth(columnId: string, px: number): void;
  /** Persist one view option under its key (`undefined` removes it). */
  setOption(key: string, value: unknown): void;
}

export interface BaseViewProps {
  /** Absolute path of the `.base`. */
  path: string;
  /** Latest query result, including trailing columns requested through `extraProperties`. */
  result: BaseQueryResult;
  /** How many leading columns are the view's own `order` (the rest are hidden extras). */
  shown: number;
  view: BaseView | undefined;
  viewIndex: number | null;
  document: BaseDocument | null;
  label: string;
  actions: ViewActions;
  config: ViewConfig;
}

/** A view mounted into a plain DOM container (plugin views). */
export interface MountedView {
  update(props: BaseViewProps): void;
  destroy(): void;
}

export interface BaseViewEntry {
  /** The `type` written in the `.base` view. */
  type: string;
  /** Name shown in the view menu. */
  name: string;
  /** Icon id (`lucide` names, as plugins pass them). */
  icon: string;
  /** `"core"` for the built-ins, the plugin id otherwise; owners are swept together. */
  owner: string;
  /** Option controls shown in the view-settings popover. */
  options?: (view: BaseView | undefined) => ViewOption[];
  /** Property ids whose values the view needs although it does not show them. */
  extraProperties?: (view: BaseView | undefined) => string[];
  /** A React view (built-ins). Exactly one of `Component` and `mount`. */
  Component?: ComponentType<BaseViewProps>;
  /** A DOM view (plugins). */
  mount?: (container: HTMLElement, props: BaseViewProps) => MountedView;
}

const entries = new Map<string, BaseViewEntry>();
const listeners = new Set<() => void>();
let snapshot: readonly BaseViewEntry[] = [];

function publish(): void {
  snapshot = [...entries.values()];
  for (const l of listeners) l();
}

/**
 * Register a view type. Returns the unregister function, or `null` when the type is already
 * registered (the first registration wins; Obsidian's `registerBasesView` reports that as `false`).
 */
export function registerBaseView(entry: BaseViewEntry): (() => void) | null {
  if (!entry.type) throw new Error("A Bases view type needs a non-empty id");
  if (!entry.Component === !entry.mount)
    throw new Error(`Bases view "${entry.type}" needs exactly one of Component and mount`);
  if (entries.has(entry.type)) return null;
  entries.set(entry.type, entry);
  publish();
  return () => {
    if (entries.get(entry.type) === entry) {
      entries.delete(entry.type);
      publish();
    }
  };
}

/** Remove every view registered by `owner` (plugin disable). Returns how many were removed. */
export function unregisterBaseViewsOwnedBy(owner: string): number {
  let n = 0;
  for (const [type, entry] of entries) {
    if (entry.owner === owner) {
      entries.delete(type);
      n++;
    }
  }
  if (n > 0) publish();
  return n;
}

/** The owner of the built-in views; everything else belongs to a plugin. */
export const CORE_OWNER = "core";

/** Remove every view that is not a built-in (the feature is switched off). */
export function sweepPluginBaseViews(): number {
  let n = 0;
  for (const [type, entry] of entries) {
    if (entry.owner !== CORE_OWNER) {
      entries.delete(type);
      n++;
    }
  }
  if (n > 0) publish();
  return n;
}

export function getBaseView(type: string): BaseViewEntry | undefined {
  return entries.get(type);
}

export function subscribeBaseViews(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** Stable between changes (for `useSyncExternalStore`). */
export function listBaseViews(): readonly BaseViewEntry[] {
  return snapshot;
}

/** Property ids a view type needs beyond its `order`: its own list plus `property` options. */
export function extraPropertiesOf(entry: BaseViewEntry, view: BaseView | undefined): string[] {
  return [
    ...(entry.extraProperties?.(view) ?? []),
    ...propertyOptionValues(view, entry.options?.(view) ?? []),
  ];
}

export type { Cell };
