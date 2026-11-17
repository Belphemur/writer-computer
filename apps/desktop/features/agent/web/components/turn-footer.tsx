import type { Turn } from "@features/agent/web/lib/transcript";
import { formatCost, formatDuration, formatTokens } from "@features/agent/web/lib/timeline";
import { Spinner } from "./agent-icon";

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

/** "Worked for 1m 32s" with token usage; `role="status"` announces "Working" once and the
 *  outcome once (never per delta). */
export function TurnFooter({ turn }: { turn: Turn }) {
  const u = turn.usage;
  const tokens = u
    ? `${formatTokens(u.inputTokens + u.cacheReadTokens + u.cacheCreationTokens)} in, ${formatTokens(u.outputTokens)} out`
    : turn.liveOutputTokens > 0
      ? `${formatTokens(turn.liveOutputTokens)} out`
      : null;
  return (
    <div
      role="status"
      data-agent-footer
      className="flex items-center gap-2 px-1 text-[11.5px] text-text-muted"
    >
      {turn.status === "running" && <Spinner size={12} />}
      <span>{statusText(turn)}</span>
      {tokens && <span aria-label="Token usage">· {tokens}</span>}
      {u?.costUsd != null && <span>· {formatCost(u.costUsd)}</span>}
    </div>
  );
}
