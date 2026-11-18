// Level of detail (SPECs/graph-view-spec.md section 12): what the graph draws depends on how far
// the user has zoomed, in four levels from one table. The measure is the on-screen spacing between
// neighbouring nodes in pixels (`min(width, height) / (sqrt(nodes) * cameraRatio)`), not the raw
// camera ratio, so a 50-note graph and a 10,000-note graph both show detail when notes are far
// enough apart to read. Hysteresis keeps the view from flickering at a boundary. The label mode
// (setting `graph.labels`) decides how much of the level's text is drawn at all: this module is the
// one place that answers "which labels, which edge labels, which cards". Pure.

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

/** How node labels show: only around the pointer and the selection (`hover`, the default), as the
 *  zoom level allows (`zoom`), or every node the label grid has room for (`always`). */
export const LABEL_MODES = ["hover", "zoom", "always"] as const;
export type LabelMode = (typeof LABEL_MODES)[number];
export const DEFAULT_LABEL_MODE: LabelMode = "hover";

export const isLabelMode = (v: unknown): v is LabelMode =>
  (LABEL_MODES as readonly unknown[]).includes(v);

export type LabelVisibility = "auto" | "visible" | "hidden";

/** The label of a plain node (no hover, selection or search involved): by mode and level. `hub` is
 *  whether the node is a hub at the level (overview and structure show hubs); `card` whether the
 *  close-up overlay already shows its title. Hovered, selected, focused, center and matching nodes
 *  are labelled by the reducer on top of this. */
export function nodeLabel(
  mode: LabelMode,
  level: LodLevel,
  hub: boolean,
  card: boolean,
): LabelVisibility {
  if (mode === "hover") return "hidden";
  switch (level) {
    case "overview":
    case "structure":
      return hub ? "visible" : mode === "always" ? "auto" : "hidden";
    case "detail":
      return "auto";
    case "closeup":
      return card ? "hidden" : "auto";
  }
}

/** Whether sigma draws edge labels (property names) at all: in `hover` from the detail level, with
 *  the reducer limiting them to the edges of the hovered or selected node; otherwise in close-up. */
export const edgeLabelsRendered = (mode: LabelMode, level: LodLevel): boolean =>
  mode === "hover" ? atLeast(level, "detail") : level === "closeup";

/** Whether an edge draws its label: in `hover` only when it touches the hovered or selected node. */
export const edgeLabelShown = (mode: LabelMode, level: LodLevel, touchesFocus: boolean): boolean =>
  edgeLabelsRendered(mode, level) && (mode !== "hover" || touchesFocus);

/** The notes a close-up card is for first: in `hover` only the hovered, focused and selected ones
 *  (nothing else gets a card), otherwise those plus the center, topped up to `CARD_CAP`. */
export function cardPriorityKeys(
  mode: LabelMode,
  s: {
    center: string | null;
    hovered: string | null;
    focus: string | null;
    selection: ReadonlySet<string>;
  },
): Set<string> {
  const keys = [s.hovered, s.focus, ...s.selection, ...(mode === "hover" ? [] : [s.center])];
  return new Set(keys.filter((k): k is string => k !== null));
}

/** How an edge looks at each level (one table): faint and thin when zoomed out so a dense graph is
 *  not a grey ball, full strength from close-up. `width` is null where the link count sets it. */
export const EDGE_LOOK = {
  overview: { opacity: 0.12, width: 0.3 },
  structure: { opacity: 0.18, width: 0.4 },
  detail: { opacity: 0.55, width: null },
  closeup: { opacity: 0.85, width: null },
} as const satisfies Record<LodLevel, { opacity: number; width: number | null }>;

/** Opacity of the edges that do not touch the hovered, focused or selected node. */
export const EDGE_DIM = 0.05;

/** The edge opacity: with something hovered, focused or selected only its edges keep full
 *  strength (`touches`) and the rest is dimmed; without one the level's own look applies. */
export function edgeOpacity(level: LodLevel, active: boolean, touches: boolean): number {
  if (!active) return EDGE_LOOK[level].opacity;
  return touches ? 1 : EDGE_DIM;
}

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
 *  then by degree, at most `cap`; with `priorityOnly` the priority nodes alone. */
export function cardsInView(
  nodes: readonly CardCandidate[],
  width: number,
  height: number,
  cap = CARD_CAP,
  margin = 40,
  priorityOnly = false,
): CardCandidate[] {
  const inside = nodes.filter(
    (n) =>
      (n.priority || !priorityOnly) &&
      n.x >= -margin &&
      n.y >= -margin &&
      n.x <= width + margin &&
      n.y <= height + margin,
  );
  inside.sort((a, b) => Number(b.priority) - Number(a.priority) || b.degree - a.degree);
  return inside.slice(0, cap);
}
