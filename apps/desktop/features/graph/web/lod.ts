// Level of detail (SPECs/graph-view-spec.md section 12): what the graph draws depends on how far
// the user has zoomed, in four levels from one table. The measure is the on-screen spacing between
// neighbouring nodes in pixels (`min(width, height) / (sqrt(nodes) * cameraRatio)`), not the raw
// camera ratio, so a 50-note graph and a 10,000-note graph both show detail when notes are far
// enough apart to read. Hysteresis keeps the view from flickering at a boundary. Pure.

export type LodLevel = "overview" | "structure" | "detail" | "closeup";

/** The one table. `minSpacing` is the spacing (px) from which a level starts. */
export const LOD_TABLE = [
  { level: "overview", minSpacing: 0 },
  { level: "structure", minSpacing: 8 },
  { level: "detail", minSpacing: 28 },
  { level: "closeup", minSpacing: 110 },
] as const satisfies readonly { level: LodLevel; minSpacing: number }[];

/** Entering a finer level takes this much more zoom than the boundary, leaving it this much less. */
export const LOD_HYSTERESIS = 0.15;

/** Share of nodes that count as hubs: drawn alone in the flat overview, labelled in structure. */
export const HUB_FRACTION = { overview: 0.015, structure: 0.05 } as const;
export const HUB_MIN = { overview: 5, structure: 10 } as const;

/** At most this many cards in the close-up level. */
export const CARD_CAP = 150;

export const levelIndex = (level: LodLevel): number =>
  LOD_TABLE.findIndex((r) => r.level === level);
export const atLeast = (level: LodLevel, min: LodLevel): boolean =>
  levelIndex(level) >= levelIndex(min);

export function spacingPx(ratio: number, nodes: number, width: number, height: number): number {
  const side = Math.max(1, Math.min(width, height));
  return side / (Math.sqrt(Math.max(1, nodes)) * Math.max(ratio, 1e-6));
}

/** The camera ratio at which the spacing is `spacing` (inverse of `spacingPx`). */
export function ratioForSpacing(
  spacing: number,
  nodes: number,
  width: number,
  height: number,
): number {
  const side = Math.max(1, Math.min(width, height));
  return side / (Math.sqrt(Math.max(1, nodes)) * Math.max(spacing, 1e-6));
}

/** The level for `spacing` given the level before (hysteresis). `scale` multiplies the spacing: the
 *  "Label zoom" setting moves every boundary at once. */
export function levelFor(spacing: number, previous: LodLevel, scale = 1): LodLevel {
  const s = spacing * scale;
  let i = levelIndex(previous);
  while (i < LOD_TABLE.length - 1 && s >= LOD_TABLE[i + 1]!.minSpacing * (1 + LOD_HYSTERESIS)) i++;
  while (i > 0 && s < LOD_TABLE[i]!.minSpacing * (1 - LOD_HYSTERESIS)) i--;
  return LOD_TABLE[i]!.level;
}

/** Hub rank per node (0 is the highest degree; ties by key so it is stable). */
export function hubRanks(nodes: readonly { key: string; degree: number }[]): Map<string, number> {
  const sorted = [...nodes].sort((a, b) => b.degree - a.degree || a.key.localeCompare(b.key));
  return new Map(sorted.map((n, i) => [n.key, i]));
}

/** How many of the top-ranked nodes are hubs at `level` (overview or structure). */
export function hubLimit(kind: keyof typeof HUB_FRACTION, order: number): number {
  return Math.min(order, Math.max(HUB_MIN[kind], Math.ceil(order * HUB_FRACTION[kind])));
}

/** Opacity multiplier `t` seconds into a level change: the scene fades in; instant without motion. */
export function fadeAt(elapsedMs: number, animate: boolean, durationMs = 220): number {
  if (!animate) return 1;
  return Math.min(1, 0.3 + 0.7 * (elapsedMs / durationMs));
}

export interface CardCandidate {
  key: string;
  x: number;
  y: number;
  degree: number;
  /** Always shown first: the center, hovered or focused node. */
  priority: boolean;
}

/** The nodes that get a card: those inside the viewport (with `margin` px), priority nodes first,
 *  then by degree, at most `cap`. */
export function cardsInView(
  nodes: readonly CardCandidate[],
  width: number,
  height: number,
  cap = CARD_CAP,
  margin = 40,
): CardCandidate[] {
  const inside = nodes.filter(
    (n) => n.x >= -margin && n.y >= -margin && n.x <= width + margin && n.y <= height + margin,
  );
  inside.sort((a, b) => Number(b.priority) - Number(a.priority) || b.degree - a.degree);
  return inside.slice(0, cap);
}
