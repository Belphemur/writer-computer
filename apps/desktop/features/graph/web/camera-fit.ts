// Keeping the graph in view (SPECs/graph-view-spec.md, "Camera"): the one fit function and the
// follow state around it. Sigma rescales every node position into its framed-graph space, so the
// fit is a camera target in that space: the centre of the notes' bounding box and the ratio that
// holds it with padding. While a layout runs the camera follows the growing box; the first user
// gesture (wheel, press, drag) hands the camera over until the next new layout. Pure, so the
// follow rules and the fit are tested without a canvas.

export interface Point {
  x: number;
  y: number;
}

export interface CameraTarget {
  x: number;
  y: number;
  ratio: number;
}

/** Slack around the bounding box (1.12 is 6% on each side, on top of sigma's own stage padding). */
export const FIT_PADDING = 1.12;
/** Camera ratio bounds of a fit (sigma's own limits are `SIGMA_SETTINGS.min/maxCameraRatio`). */
export const FIT_RATIO = { min: 0.05, max: 2 } as const;
/** A fit closer than this to the camera is not applied (stops follow-on-render from looping). */
const SAME = 1e-4;

/** The bounding box of `points` (finite ones only) as a camera target, or null when none is. */
export function fitTarget(points: Iterable<Point>): CameraTarget | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  if (x0 === Infinity) return null;
  const span = Math.max(x1 - x0, y1 - y0) * FIT_PADDING;
  return {
    x: (x0 + x1) / 2,
    y: (y0 + y1) / 2,
    ratio: Math.min(FIT_RATIO.max, Math.max(FIT_RATIO.min, span)),
  };
}

export const sameTarget = (a: CameraTarget, b: CameraTarget): boolean =>
  Math.abs(a.x - b.x) < SAME && Math.abs(a.y - b.y) < SAME && Math.abs(a.ratio - b.ratio) < SAME;

/** Whether any of `points` (viewport pixels) lies inside the viewport: false is an empty view. */
export function anyInView(points: Iterable<Point>, width: number, height: number): boolean {
  for (const p of points) if (p.x >= 0 && p.y >= 0 && p.x <= width && p.y <= height) return true;
  return false;
}

/** Who owns the camera: the layout's follow, or the user after a gesture. */
export function createFollow() {
  let following = true;
  return {
    /** A new layout began: the camera follows it again. */
    newLayout: () => {
      following = true;
    },
    /** The user panned, zoomed or dragged: the camera is theirs. */
    userMoved: () => {
      following = false;
    },
    isFollowing: () => following,
    /** The camera was restored from a saved view: it stays theirs until the next new layout. */
    restore: () => {
      following = false;
    },
  };
}
export type Follow = ReturnType<typeof createFollow>;
