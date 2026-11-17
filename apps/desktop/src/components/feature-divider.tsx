/** The vertical hairline between core and feature items in a row (sidebar header, footer).
 *  Placement is decided by `withFeatureDivider`; menus use a native separator instead. */
export function FeatureDivider() {
  return (
    <span
      data-feature-divider
      aria-hidden="true"
      className="h-4 w-px shrink-0 self-center bg-[var(--line-subtler)]"
    />
  );
}
