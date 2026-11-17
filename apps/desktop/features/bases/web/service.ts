// The `bases.views` service (`api.ts`): the view registry and the formula call. Import-light on
// purpose: it is registered with the feature, at startup, so everything here is small and none of
// it pulls a view component (the built-in views register when the view chunk first loads).
import type { BasesViewsService } from "./api";
import { baseEval } from "./ipc";
import { canonicalPropertyKey } from "./lib/cells";
import { flattenOptions } from "./lib/view-options";
import {
  registerBaseView,
  sweepPluginBaseViews,
  unregisterBaseViewsOwnedBy,
} from "./lib/view-registry";

export const basesViewsService: BasesViewsService = {
  registerView: registerBaseView,
  unregisterOwned: unregisterBaseViewsOwnedBy,
  evaluate: baseEval,
  canonicalPropertyKey,
  flattenOptions,
};

/** Switching the feature off removes what plugins registered, so a stale entry never comes back
 *  with the feature (the built-ins register once with their module and stay). */
export const disposeBasesViews = sweepPluginBaseViews;
