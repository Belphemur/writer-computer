import type { Chat } from "@/hooks/use-agent";
import { formatCost } from "@/lib/agent/timeline";

/** Footer under the composer: the chat's total cost (the context fill is the ring, `context-ring.tsx`). */
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
  if (chat.totalCostUsd <= 0) return null;
  return (
    <p data-agent-usage className="px-4 pb-2 text-[11px] text-text-muted">
      {formatCost(chat.totalCostUsd)} this chat
    </p>
  );
}
