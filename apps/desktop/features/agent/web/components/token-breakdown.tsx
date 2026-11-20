import type { TurnUsage } from "@features/agent/web/lib/transcript";
import { formatTokens } from "@features/agent/web/lib/timeline";

/** The four token counts of a usage as a label/value grid: the context ring's popover (last
 *  request) and the turn footer's tooltip (all requests of the turn) share it. */
export function TokenBreakdown({
  usage,
  className = "",
}: {
  usage: Pick<
    TurnUsage,
    "inputTokens" | "cacheReadTokens" | "cacheCreationTokens" | "outputTokens"
  >;
  className?: string;
}) {
  return (
    <dl className={`grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 text-text-secondary ${className}`}>
      <dt>Input</dt>
      <dd className="text-right tabular-nums">{formatTokens(usage.inputTokens)}</dd>
      <dt>Cache read</dt>
      <dd className="text-right tabular-nums">{formatTokens(usage.cacheReadTokens)}</dd>
      <dt>Cache creation</dt>
      <dd className="text-right tabular-nums">{formatTokens(usage.cacheCreationTokens)}</dd>
      <dt>Output</dt>
      <dd className="text-right tabular-nums">{formatTokens(usage.outputTokens)}</dd>
    </dl>
  );
}
