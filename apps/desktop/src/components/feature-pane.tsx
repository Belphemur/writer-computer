import { createElement, lazy, Suspense, type ComponentType, type LazyExoticComponent } from "react";
import { featureOfOwner } from "@/lib/features/id";
import { FeatureBoundary } from "./feature-boundary";

/** What every UI contribution with a lazy component has: an owner and a dynamic import. */
export interface LazyContribution<P extends object> {
  owner: string;
  load: () => Promise<ComponentType<P>>;
}

// One lazy wrapper per contribution, so the chunk is requested once and the component identity is
// stable across renders.
const wrappers = new WeakMap<object, LazyExoticComponent<ComponentType<object>>>();

function wrapperFor<P extends object>(
  c: LazyContribution<P>,
): LazyExoticComponent<ComponentType<P>> {
  let w = wrappers.get(c);
  if (!w) {
    w = lazy(async () => ({ default: (await c.load()) as ComponentType<object> }));
    wrappers.set(c, w);
  }
  return w as unknown as LazyExoticComponent<ComponentType<P>>;
}

/** The one place a contributed component is rendered (docks, sidebar panels, status items):
 *  lazy, inside its feature's error boundary, so a throwing contribution shows a placeholder and
 *  counts toward the feature's three strikes while the rest of the window keeps working. */
export function FeaturePane<P extends object>({
  contribution,
  ...props
}: { contribution: LazyContribution<P> } & P) {
  const Pane = wrapperFor(contribution);
  const pane = (
    <Suspense fallback={null}>
      {createElement(Pane as unknown as ComponentType<object>, props)}
    </Suspense>
  );
  const feature = featureOfOwner(contribution.owner);
  return feature ? <FeatureBoundary feature={feature}>{pane}</FeatureBoundary> : pane;
}
