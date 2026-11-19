import { percent } from "@/lib/viewer-zoom";

const iconButton =
  "flex h-6 w-6 items-center justify-center rounded text-[var(--text-muted)] hover:bg-[var(--item-hover-bg)] hover:text-[var(--text-primary)]";

/** The footer zoom control of a viewer: − Fit-or-percent + (a click on the middle returns to Fit).
 *  `testId` prefixes the three buttons' test ids (`<testId>-out`, `-fit`, `-in`). */
export function ZoomControl({
  scale,
  fitted,
  fitLabel = "Fit",
  fitTitle = "Fit to page",
  testId,
  onZoomIn,
  onZoomOut,
  onFit,
}: {
  scale: number;
  /** At Fit the control reads the fit label, not the fitted percent. */
  fitted: boolean;
  fitLabel?: string;
  fitTitle?: string;
  testId: string;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
}) {
  return (
    <span className="flex items-center gap-0.5">
      <button
        type="button"
        aria-label="Zoom out"
        data-testid={`${testId}-out`}
        className={iconButton}
        onClick={onZoomOut}
      >
        −
      </button>
      <button
        type="button"
        title={fitTitle}
        data-testid={`${testId}-fit`}
        className="min-w-12 rounded px-1 text-center tabular-nums hover:bg-[var(--item-hover-bg)] hover:text-[var(--text-primary)]"
        onClick={onFit}
      >
        {fitted ? fitLabel : `${percent(scale)}%`}
      </button>
      <button
        type="button"
        aria-label="Zoom in"
        data-testid={`${testId}-in`}
        className={iconButton}
        onClick={onZoomIn}
      >
        +
      </button>
    </span>
  );
}
