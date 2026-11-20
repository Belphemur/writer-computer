import { useRef } from "react";
import { useHoverTooltip } from "@/components/hover-tooltip";
import type { Turn } from "@features/agent/web/lib/transcript";
import { formatCost, formatDuration, formatTokens } from "@features/agent/web/lib/timeline";
import { Spinner } from "./agent-icon";
import { TokenBreakdown } from "./token-breakdown";

function statusText(turn: Turn): string {
  switch (turn.status) {
    case "running":
      return "Working";
    case "completed":
      return turn.durationMs !== null ? `Worked for ${formatDuration(turn.durationMs)}` : "Done";
    case "interrupted":
      return "Stopped";
    case "max-turns":
      return "Stopped: turn limit reached";
    case "budget":
      return "Stopped: budget reached";
    case "error":
      return "Failed";
  }
}

/** "5 requests · 6k out" once the turn finished (its summed usage); the live output count while
 *  running. Context size is the ring's alone: the summed input would read as an overflow. */
export function turnTokensText(turn: Turn): string | null {
  const u = turn.usage;
  if (!u) return turn.liveOutputTokens > 0 ? `${formatTokens(turn.liveOutputTokens)} out` : null;
  const n = turn.numTurns;
  const out = `${formatTokens(u.outputTokens)} out`;
  return n == null ? out : `${n} ${n === 1 ? "request" : "requests"} · ${out}`;
}

/** "Worked for 1m 32s" with request count and output tokens; `role="status"` announces "Working"
 *  once and the outcome once (never per delta). Hovering the tokens shows the turn's summed
 *  breakdown. */
export function TurnFooter({ turn }: { turn: Turn }) {
  const u = turn.usage;
  const tokens = turnTokensText(turn);
  // `always` shows the tooltip without truncation, so the label ref is never measured
  const labelRef = useRef<HTMLElement>(null);
  const { triggerProps, tooltip } = useHoverTooltip({
    labelRef,
    always: true,
    content: {
      title: "All requests in this turn",
      body: u ? <TokenBreakdown usage={u} className="mt-1" /> : undefined,
    },
  });
  return (
    <div
      role="status"
      data-agent-footer
      className="flex items-center gap-2 px-1 text-[11.5px] text-text-muted"
    >
      {turn.status === "running" && <Spinner size={12} />}
      <span>{statusText(turn)}</span>
      {tokens && (
        <span {...(u ? triggerProps : {})} aria-label="Token usage">
          · {tokens}
        </span>
      )}
      {u && tooltip}
      {u?.costUsd != null && <span>· {formatCost(u.costUsd)}</span>}
    </div>
  );
}
