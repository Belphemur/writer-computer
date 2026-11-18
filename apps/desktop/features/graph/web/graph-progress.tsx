// The progress of the graph tab, drawn over the canvas area: a centred spinner with one status line
// and the counts while nothing has been drawn yet, a small pill at the top while the graph is
// redrawn after a change (the drawn graph stays), the error with Retry. All state comes from
// `GraphSurface.phase`; nothing is inferred here.
import { Loading03Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { countsLine, PHASE_LABEL, type GraphPhase } from "./progress";

export interface GraphProgressProps {
  phase: GraphPhase;
  /** A frame was drawn before: the graph is on screen and must not be blanked. */
  drawn: boolean;
  nodes: number;
  links: number;
  error: string | null;
  onRetry: () => void;
}

function Spin() {
  return (
    <HugeiconsIcon
      icon={Loading03Icon}
      size={16}
      color="currentColor"
      strokeWidth={2}
      className="animate-spin motion-reduce:animate-none"
      aria-hidden="true"
    />
  );
}

export function GraphProgress({ phase, drawn, nodes, links, error, onRetry }: GraphProgressProps) {
  if (phase === "error") {
    return (
      <div
        role="alert"
        className="absolute inset-x-0 top-2 z-20 flex items-center justify-center gap-2 text-[12px] text-[var(--danger)]"
      >
        Could not load the graph: {error}
        <button
          type="button"
          className="rounded-md border border-[var(--line-subtle)] px-2 py-0.5 text-[var(--text-primary)]"
          onClick={onRetry}
        >
          Retry
        </button>
      </div>
    );
  }
  if (phase === "ready") return null;
  const label = PHASE_LABEL[phase];
  const counts = nodes > 0 ? countsLine(nodes, links) : null;
  if (drawn) {
    return (
      <div
        role="status"
        data-testid="graph-progress"
        className="pointer-events-none absolute left-1/2 top-2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-md border border-[var(--line-subtle)] bg-[var(--surface-card)] px-2.5 py-1 text-[12px] text-[var(--text-secondary)]"
      >
        <Spin />
        {label}
      </div>
    );
  }
  return (
    <div
      role="status"
      data-testid="graph-progress"
      className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 text-[var(--text-muted)]"
    >
      <Spin />
      <p className="text-[13px] text-[var(--text-secondary)]">{label}</p>
      {counts && <p className="text-[12px]">{counts}</p>}
    </div>
  );
}
