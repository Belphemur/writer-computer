import type { Chat } from "@features/agent/web/hooks/use-agent";

/** Footer under the composer: only a save error. The cost shows once per turn in the timeline; the context fill is the ring. */
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
  return null;
}
