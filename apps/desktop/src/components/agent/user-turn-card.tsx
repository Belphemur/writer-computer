import { formatRelativeTime } from "@/lib/relative-time";
import { contextRefLabel } from "@/lib/agent/context-text";
import type { UserMessage } from "@/lib/agent/transcript";
import { MessageText } from "./message-text";

export function UserTurnCard({ message }: { message: UserMessage }) {
  const when = formatRelativeTime(Math.floor(message.ts / 1000));
  return (
    <article
      data-agent-user-turn
      aria-label="Your message"
      className="rounded-xl border border-[var(--line-subtle)] bg-[var(--surface-card)] px-3 py-2.5"
    >
      <p className="whitespace-pre-wrap break-words text-[14px] leading-relaxed text-text-primary">
        <MessageText text={message.text} context={message.context} />
      </p>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-text-muted">
        {message.context.map((ref, i) => (
          <span
            key={i}
            className="max-w-[16rem] truncate rounded-md bg-[var(--surface-subtle)] px-1.5 py-0.5"
            title={contextRefLabel(ref)}
          >
            {contextRefLabel(ref)}
          </span>
        ))}
        {message.context.length === 0 && message.contextLabel && (
          <span className="max-w-full truncate rounded-md bg-[var(--surface-subtle)] px-1.5 py-0.5">
            {message.contextLabel}
          </span>
        )}
        {when && <span className="ml-auto">{when}</span>}
      </div>
    </article>
  );
}
