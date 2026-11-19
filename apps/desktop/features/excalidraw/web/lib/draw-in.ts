// The draw-in of new elements when a drawing reloads (ADR 2026-11-18, point 9): each element an
// agent adds is revealed over about 300 ms, so `excalidraw:add` and `excalidraw:connect` calls
// show up as being drawn. A line, an arrow or a freehand stroke is revealed along its path; a
// box, an ellipse, a diamond, a label or an image fades in. Only the elements that are new in the
// reload are touched, and with reduced motion nothing is animated at all.
//
// Pure frames, so the rule is tested without a canvas: `drawInFrame` is what the canvas shows at
// time `t`, and at `t >= 1` it is the elements themselves.
import type { SceneElement } from "./excalidraw-md";

export const DRAW_IN_MS = 300;

const LINEAR = new Set(["line", "arrow", "freedraw"]);

type Point = readonly [number, number];

/** Ease-out: fast start, soft landing. */
const ease = (t: number) => 1 - (1 - t) ** 3;

/** The part of a polyline that is drawn at progress `p` (0 to 1), by length. */
export function partialPoints(points: readonly Point[], p: number): Point[] {
  if (points.length < 2 || p >= 1) return points.map((q) => [q[0], q[1]]);
  const lengths: number[] = [];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const len = Math.hypot(points[i]![0] - points[i - 1]![0], points[i]![1] - points[i - 1]![1]);
    lengths.push(len);
    total += len;
  }
  const want = total * Math.max(p, 0);
  const out: Point[] = [[points[0]![0], points[0]![1]]];
  let walked = 0;
  for (let i = 1; i < points.length; i++) {
    const seg = lengths[i - 1]!;
    if (walked + seg <= want) {
      out.push([points[i]![0], points[i]![1]]);
      walked += seg;
      continue;
    }
    const f = seg === 0 ? 0 : (want - walked) / seg;
    out.push([
      points[i - 1]![0] + (points[i]![0] - points[i - 1]![0]) * f,
      points[i - 1]![1] + (points[i]![1] - points[i - 1]![1]) * f,
    ]);
    break;
  }
  return out.length < 2 ? [out[0]!, out[0]!] : out;
}

/** The elements as the canvas shows them at time `t` (0 to 1) of the draw-in of `fresh`. */
export function drawInFrame<T extends SceneElement>(
  elements: readonly T[],
  fresh: ReadonlySet<string>,
  t: number,
): T[] {
  if (t >= 1 || fresh.size === 0) return elements as T[];
  const p = ease(Math.max(t, 0));
  return elements.map((el) => {
    if (!fresh.has(el.id)) return el;
    if (LINEAR.has(el.type) && Array.isArray(el.points)) {
      return { ...el, points: partialPoints(el.points as Point[], p) };
    }
    const opacity = typeof el.opacity === "number" ? el.opacity : 100;
    return { ...el, opacity: Math.round(opacity * p) };
  });
}

/** The ids to animate: none with reduced motion. */
export function planDrawIn(added: ReadonlySet<string>, reducedMotion: boolean): Set<string> {
  return reducedMotion ? new Set() : new Set(added);
}

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export interface DrawInRun {
  /** Stop and show the final elements now. */
  finish: () => void;
}

export interface DrawInHost<T extends SceneElement> {
  /** Show these elements on the canvas without recording an undo step. */
  show: (elements: readonly T[]) => void;
  raf?: (cb: (now: number) => void) => number;
  caf?: (id: number) => void;
  now?: () => number;
  durationMs?: number;
}

/** Run the draw-in of `fresh` among `elements`, ending on `elements` themselves. */
export function runDrawIn<T extends SceneElement>(
  elements: readonly T[],
  fresh: ReadonlySet<string>,
  host: DrawInHost<T>,
  done: () => void = () => {},
): DrawInRun {
  const raf = host.raf ?? ((cb) => requestAnimationFrame(cb));
  const caf = host.caf ?? ((id) => cancelAnimationFrame(id));
  const now = host.now ?? (() => performance.now());
  const duration = host.durationMs ?? DRAW_IN_MS;
  let frame = 0;
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    caf(frame);
    host.show(elements);
    done();
  };
  if (fresh.size === 0) {
    end();
    return { finish: end };
  }
  const start = now();
  const step = (at: number) => {
    if (ended) return;
    const t = (at - start) / duration;
    if (t >= 1) return end();
    host.show(drawInFrame(elements, fresh, t));
    frame = raf(step);
  };
  host.show(drawInFrame(elements, fresh, 0));
  frame = raf(step);
  return { finish: end };
}
