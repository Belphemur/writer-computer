import { useEffect, useRef, useState } from "react";
import { useHoverTooltip } from "@/components/hover-tooltip";
import { openSavedAgentChat } from "@features/agent/web/hooks/agent-api";
import {
  chatHistoryClient,
  type ChatHistoryClient,
} from "@features/agent/web/lib/chat-history-client";
import type { ChatSummary } from "@features/agent/web/lib/events";
import { sortChats } from "@features/agent/web/lib/chat-history";

const SHOWN = 5;

/** The project home's "Recent chats": the project's saved chats (lane 4's store), newest first.
 *  A click opens the chat from its note. */
export function ProjectRecentChats({
  projectPath,
  client = chatHistoryClient,
}: {
  projectPath: string;
  client?: ChatHistoryClient;
}) {
  const [chats, setChats] = useState<ChatSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    client
      .list({ projectPath })
      .then((list) => live && setChats(sortChats(list, "updated").slice(0, SHOWN)))
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [client, projectPath]);

  if (error)
    return (
      <p role="alert" className="mt-1.5 text-[13px] text-[var(--agent-error)]">
        Could not load chats: {error}
      </p>
    );
  if (chats === null)
    return <p className="mt-1.5 text-[13px] text-[var(--text-muted)]">Loading…</p>;
  if (chats.length === 0)
    return <p className="mt-1.5 text-[13px] text-[var(--text-muted)]">No chats yet.</p>;
  return (
    <ul className="mt-1.5" data-agent-recent-chats>
      {chats.map((c) => (
        <RecentChatRow key={c.chatId} chat={c} />
      ))}
    </ul>
  );
}

function RecentChatRow({ chat }: { chat: ChatSummary }) {
  const labelRef = useRef<HTMLSpanElement>(null);
  const title = chat.title || "New chat";
  const { triggerProps, tooltip } = useHoverTooltip({ labelRef, content: { title } });
  return (
    <li>
      <button
        type="button"
        {...triggerProps}
        onClick={() => void openSavedAgentChat(chat.chatId)}
        className="flex w-full rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-[var(--item-hover-bg)]"
      >
        <span ref={labelRef} className="min-w-0 truncate">
          {title}
        </span>
        {tooltip}
      </button>
    </li>
  );
}
