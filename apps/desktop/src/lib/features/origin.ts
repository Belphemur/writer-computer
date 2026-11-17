// The one rule for every surface that mixes core items with feature contributions: feature
// items come after the core items, behind a divider, and the divider exists only when both
// sides have items. A surface builds its two lists from the registries (a contribution is
// a feature item by definition) and calls `withFeatureDivider`; it never decides by itself
// whether a divider is due. Spec: SPECs/builtin-plugins-spec.md section 6.5.

/** The name of the group feature pages and items are gathered under (Settings sidebar). */
export const FEATURE_GROUP_LABEL = "Features";

/** `core`, then `divider`, then `feature`; the divider only when both lists are non-empty. */
export function withFeatureDivider<T, D>(
  core: readonly T[],
  feature: readonly T[],
  divider: D,
): Array<T | D> {
  return core.length > 0 && feature.length > 0
    ? [...core, divider, ...feature]
    : [...core, ...feature];
}
