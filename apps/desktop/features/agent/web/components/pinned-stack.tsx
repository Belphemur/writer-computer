import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { removeQueuedMessage, sendAgentNow } from "@features/agent/web/hooks/agent-api";
import type { Chat, QueuedMessage } from "@features/agent/web/hooks/use-agent";
import { Ico } from "./agent-icon";
import { PermissionCard } from "./permission-card";

/** Between the transcript and the composer: the permission card (first request, "+N more"),
 *  then the queued-message chip. Precedes the composer in DOM order (spec 3.7). */
export function PinnedStack({ chat, queued }: { chat: Chat; queued: QueuedMessage | undefined }) {
  const [first, ...rest] = chat.pendingPermissions;
  if (!first && !queued) return null;
  return (
    <div data-agent-pinned className="space-y-2 px-3 pt-2">
      {first && <PermissionCard key={first.requestId} request={first} more={rest.length} />}
      {queued && (
        <div
          data-agent-queued
          className="flex items-center gap-2 rounded-lg bg-[var(--surface-subtle)] px-2.5 py-1.5 text-[12px] text-text-secondary"
        >
          <span className="rounded bg-[var(--surface-selected)] px-1.5 py-0.5 text-[10.5px] font-medium">
            Queued
          </span>
          <span className="min-w-0 flex-1 truncate">{queued.text}</span>
          <button
            type="button"
            title="Cmd+Enter"
            onClick={() => void sendAgentNow("")}
            className="rounded px-1.5 py-0.5 text-[11px] font-medium text-text-secondary hover:bg-[var(--surface-selected)] hover:text-text-primary"
          >
            Send now
          </button>
          <button
            type="button"
            aria-label="Remove queued message"
            onClick={() => removeQueuedMessage(chat.chatId)}
            className="rounded p-0.5 text-text-muted hover:text-text-primary"
          >
            <Ico icon={Cancel01Icon} size={12} />
          </button>
        </div>
      )}
    </div>
  );
}
