// Close-up cards: at the closest level of detail a note grows into a small card (title, up to 3
// tags, its type or status, "Create note" on a missing note). An HTML overlay, not a sigma node
// program: at most CARD_CAP (150) absolutely positioned elements, text laid out and kept crisp by
// the browser, no GLSL to maintain, and the cost is bounded by the cap however large the graph is,
// where a node program would need an SDF text atlas for tags and statuses. The overlay does not take
// pointer events: clicks and hover still reach sigma's own node picking underneath.
import { cardsInView, CARD_CAP, type CardCandidate } from "./lod";
import type { NodeAttrs } from "./model";

export interface CardData extends CardCandidate {
  title: string;
  tags: string[];
  cardValue: string | null;
  missing: boolean;
}

export const MAX_CARD_TAGS = 3;

/** The cards to draw for the nodes of the model with their viewport positions (pure). */
export function pickCards(
  nodes: readonly { key: string; attrs: NodeAttrs; x: number; y: number }[],
  width: number,
  height: number,
  priority: ReadonlySet<string>,
  cap = CARD_CAP,
  priorityOnly = false,
): CardData[] {
  const usable = nodes.filter((n) => !n.attrs.anchor && n.attrs.kind !== "tag");
  const candidates: CardCandidate[] = usable.map((n) => ({
    key: n.key,
    x: n.x,
    y: n.y,
    degree: n.attrs.degree,
    priority: priority.has(n.key),
  }));
  const byKey = new Map(usable.map((n) => [n.key, n.attrs]));
  return cardsInView(candidates, width, height, cap, undefined, priorityOnly).map((c) => {
    const a = byKey.get(c.key)!;
    return {
      ...c,
      title: a.label,
      tags: a.tags.slice(0, MAX_CARD_TAGS),
      cardValue: a.cardValue,
      missing: a.kind === "missing",
    };
  });
}

export function CardsLayer({ cards }: { cards: readonly CardData[] }) {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" data-testid="graph-cards">
      {cards.map((c) => (
        <div
          key={c.key}
          data-testid="graph-card"
          className="absolute max-w-[180px] -translate-x-1/2 translate-y-3 rounded-md border border-[var(--line-subtle)] bg-[var(--surface-card)] px-2 py-1 text-[11px] leading-tight shadow-sm"
          style={{ left: c.x, top: c.y }}
        >
          <div className="truncate font-medium text-[var(--text-primary)]">{c.title}</div>
          {c.cardValue && (
            <div className="truncate text-[var(--text-secondary)]">{c.cardValue}</div>
          )}
          {c.missing && <div className="text-[var(--accent)]">Create note</div>}
          {c.tags.length > 0 && (
            <div className="mt-0.5 flex flex-wrap gap-1 text-[10px] text-[var(--text-muted)]">
              {c.tags.map((t) => (
                <span key={t}>#{t.replace(/^#/, "")}</span>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
