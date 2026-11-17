// Docks contributed by features: panes at the right edge. The layout (`components/app-layout.tsx`)
// asks this registry which dock is open and how much room it takes, so it names no feature
// (docs/consolidation.md: registry over per-case branches). The plugin pane stays core and is the
// fallback when no dock is open.
import { OwnedRegistry } from "@/lib/owned-registry";
import type { DockContribution, Dispose } from "./types";

export type OwnedDock = DockContribution & { owner: string };

export const dockContributions = new OwnedRegistry<OwnedDock>();

/** The open dock with the highest priority, if any. */
export function openDock(): OwnedDock | null {
  let best: OwnedDock | null = null;
  for (const d of dockContributions.list()) {
    if (d.isOpen() && (!best || d.priority > best.priority)) best = d;
  }
  return best;
}

/** Calls `listener` when a dock is added or removed or when any dock says its state changed. */
export function subscribeDocks(listener: () => void): Dispose {
  let inner: Dispose[] = [];
  const wire = () => {
    for (const un of inner) un();
    inner = dockContributions.list().map((d) => d.subscribe(listener));
  };
  wire();
  const un = dockContributions.subscribe(() => {
    wire();
    listener();
  });
  return () => {
    un();
    for (const u of inner) u();
  };
}

/** Closes every open dock (the plugin pane opened). */
export function closeDocks(): void {
  for (const d of dockContributions.list()) if (d.isOpen()) d.close();
}
