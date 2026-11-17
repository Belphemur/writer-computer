import type { Chat } from "@/hooks/use-agent";
import { formatCost, formatTokens } from "@/lib/agent/timeline";

const DEFAULT_WINDOW = 200_000;

/** Footer under the composer: context fill after the last turn and the chat's total cost. The
 *  numbers are what the CLI reported ("~" because the window is a model property, not exact). */
export function UsageLine({ chat }: { chat: Chat }) {
  if (chat.saveError)
    return (
      <p
        role="alert"
        data-agent-save-error
        className="px-4 pb-2 text-[11px] text-[var(--agent-error)]"
      >
        This chat could not be saved: {chat.saveError}
      </p>
    );
  if (chat.contextTokens === null) return null;
  const window = chat.contextWindow ?? DEFAULT_WINDOW;
  const pct = Math.min(100, Math.round((chat.contextTokens / window) * 100));
  return (
    <p data-agent-usage className="px-4 pb-2 text-[11px] text-text-muted">
      Context ~{formatTokens(chat.contextTokens)} of {formatTokens(window)} ({pct}%)
      {chat.totalCostUsd > 0 && ` · ${formatCost(chat.totalCostUsd)} this chat`}
    </p>
  );
}
