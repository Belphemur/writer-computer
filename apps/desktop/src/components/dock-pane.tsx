import { lazy, Suspense, type ComponentType, type LazyExoticComponent } from "react";
import { dockContributions, type OwnedDock } from "@/lib/features/docks";
import { featureOfOwner } from "@/lib/features/id";
import { FeatureBoundary } from "./feature-boundary";

// One lazy wrapper per dock, so the pane's chunk is requested once and the component identity is
// stable across renders.
const wrappers = new WeakMap<OwnedDock, LazyExoticComponent<ComponentType>>();

function wrapperFor(dock: OwnedDock): LazyExoticComponent<ComponentType> {
  let w = wrappers.get(dock);
  if (!w) wrappers.set(dock, (w = lazy(async () => ({ default: await dock.load() }))));
  return w;
}

/** The pane of the dock `id` (a contributed dock; the layout falls back to the plugin pane). */
export function DockPane({ id }: { id: string }) {
  const dock = dockContributions.get(id);
  if (!dock) return null;
  const Pane = wrapperFor(dock);
  const pane = (
    <Suspense fallback={null}>
      <Pane />
    </Suspense>
  );
  const feature = featureOfOwner(dock.owner);
  return feature ? <FeatureBoundary feature={feature}>{pane}</FeatureBoundary> : pane;
}
