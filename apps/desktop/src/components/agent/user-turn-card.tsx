import { formatRelativeTime } from "@/lib/relative-time";
import { contextRefLabel } from "@/lib/agent/context-text";
import type { UserMessage } from "@/lib/agent/transcript";
import { vaultLinkHandlers } from "./agent-links";
import { ChatImageThumb } from "./chat-image-thumb";
import { MessageText } from "./message-text";

export function UserTurnCard({ message }: { message: UserMessage }) {
  const when = formatRelativeTime(Math.floor(message.ts / 1000));
  const images = message.context.flatMap((r) => (r.kind === "image" ? [r.path] : []));
  const others = message.context.filter((r) => r.kind !== "image");
  return (
    <article
      data-agent-user-turn
      aria-label="Your message"
      className="rounded-xl border border-[var(--line-subtle)] bg-[var(--surface-card)] px-3 py-2.5"
    >
      {images.length > 0 && (
        <div data-agent-turn-images className="mb-2 flex flex-wrap gap-1.5">
          {images.map((path) => (
            <button
              key={path}
              type="button"
              title={path}
              aria-label={`Open ${path.slice(path.lastIndexOf("/") + 1)}`}
              {...vaultLinkHandlers(path)}
              className="overflow-hidden rounded-lg border border-[var(--line-subtle)] hover:border-[var(--focus-border)]"
            >
              <ChatImageThumb path={path} className="size-16" />
            </button>
          ))}
        </div>
      )}
      <div className="break-words text-[14px] leading-relaxed text-text-primary">
        <MessageText text={message.text} context={message.context} />
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-text-muted">
        {others.map((ref, i) => (
          <span
            key={i}
            className="max-w-[16rem] truncate rounded-md bg-[var(--surface-subtle)] px-1.5 py-0.5"
            title={contextRefLabel(ref)}
          >
            {contextRefLabel(ref)}
          </span>
        ))}
        {others.length === 0 && message.contextLabel && (
          <span className="max-w-full truncate rounded-md bg-[var(--surface-subtle)] px-1.5 py-0.5">
            {message.contextLabel}
          </span>
        )}
        {when && <span className="ml-auto">{when}</span>}
      </div>
    </article>
  );
}
