import { useEffect, useState } from "react";
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
        <li key={c.chatId}>
          <button
            type="button"
            onClick={() => void openSavedAgentChat(c.chatId)}
            className="w-full truncate rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-[var(--item-hover-bg)]"
          >
            {c.title || "New chat"}
          </button>
        </li>
      ))}
    </ul>
  );
}
