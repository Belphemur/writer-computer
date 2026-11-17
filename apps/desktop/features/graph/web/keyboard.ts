// Keyboard navigation between nodes (spec section 4): an arrow key moves to the neighbour of the
// focused node that lies most in that direction on screen. Pure, so it is tested without a canvas.

export type Direction = "left" | "right" | "up" | "down";

export interface Placed {
  x: number;
  y: number;
}

const UNIT: Record<Direction, Placed> = {
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
};

export const DIRECTION_KEYS: Record<string, Direction> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
};

/** The candidate whose offset from `from` points best along `dir` (positive dot product with a
 *  tolerance of about 80 degrees), nearest first among equals; `null` when none lies that way. */
export function pickNeighbor(
  from: Placed,
  candidates: readonly { key: string; at: Placed }[],
  dir: Direction,
): string | null {
  const u = UNIT[dir];
  let best: string | null = null;
  let bestScore = -Infinity;
  for (const c of candidates) {
    const dx = c.at.x - from.x;
    const dy = c.at.y - from.y;
    const dist = Math.hypot(dx, dy) || 1e-9;
    const cos = (dx * u.x + dy * u.y) / dist;
    if (cos < 0.17) continue;
    const score = cos / (1 + dist * 0.001) - dist * 1e-6;
    if (score > bestScore) {
      bestScore = score;
      best = c.key;
    }
  }
  return best;
}
