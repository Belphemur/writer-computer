// Docks contributed by features: panes at the right edge. The layout (`components/app-layout.tsx`)
// asks this registry which dock is open and how much room it takes, so it names no feature
// (docs/consolidation.md: registry over per-case branches). The agent pane and the Obsidian
// host's plugin pane are docks; there is one right-hand column, so the dock opened last wins.
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

/** Ids of the docks that are open now. */
export function openDockIds(): Set<string> {
  return new Set(
    dockContributions
      .list()
      .filter((d) => d.isOpen())
      .map((d) => d.id),
  );
}

/** One column: when a dock has just opened (it is in `now` but was not in `before`), every other
 *  open dock is closed, so the one opened last wins whatever its priority. */
export function closeDocksOpenedBefore(
  before: ReadonlySet<string>,
  now: ReadonlySet<string>,
): void {
  const opened = [...now].filter((id) => !before.has(id));
  if (opened.length === 0) return;
  for (const d of dockContributions.list()) {
    if (d.isOpen() && !opened.includes(d.id)) d.close();
  }
}
