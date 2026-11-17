// The list fallback (ADR "Fallback"): the visible slice as a keyboard-reachable list of notes, for
// screen readers and for WebGL being unavailable. Each row is a link: the same gestures as the
// canvas (left, middle, Cmd/Ctrl, Cmd/Ctrl+Shift click, Enter) through `linkHandlers`.
import { linkHandlers, type LinkIntent } from "@/lib/link-activation";
import type { NodeSpec } from "./model";

/** Rows rendered at once; a bigger slice is cut here (the search and filters narrow it). */
export const LIST_CAP = 500;

export function NodeList({
  nodes,
  onOpen,
  ariaLabel = "Nodes",
}: {
  nodes: readonly NodeSpec[];
  onOpen: (node: NodeSpec, intent: LinkIntent) => void;
  ariaLabel?: string;
}) {
  const sorted = [...nodes].sort((a, b) => b.degree - a.degree || a.label.localeCompare(b.label));
  const shown = sorted.slice(0, LIST_CAP);
  return (
    <div className="h-full overflow-auto p-2" data-testid="graph-node-list">
      <ul aria-label={ariaLabel} className="m-0 list-none p-0">
        {shown.map((n) => (
          <li key={n.key}>
            {n.kind === "tag" ? (
              <span className="block px-2 py-1 text-[13px] text-[var(--text-muted)]">
                {n.label}
              </span>
            ) : (
              <button
                type="button"
                title={n.path || n.label}
                className="flex w-full items-baseline justify-between gap-2 rounded-md px-2 py-1 text-left text-[13px] text-[var(--text-primary)] hover:bg-[var(--item-hover-bg)] focus-visible:bg-[var(--item-hover-bg)]"
                {...linkHandlers({ kind: "custom", open: (intent) => onOpen(n, intent) })}
              >
                <span className="truncate">{n.label}</span>
                <span className="shrink-0 text-[11px] text-[var(--text-muted)]">{n.degree}</span>
              </button>
            )}
          </li>
        ))}
      </ul>
      {sorted.length > shown.length && (
        <p className="px-2 py-1 text-[12px] text-[var(--text-muted)]">
          Showing {shown.length} of {sorted.length}. Use the search or filters to narrow the list.
        </p>
      )}
    </div>
  );
}
