import { ask } from "@tauri-apps/plugin-dialog";
import { Add01Icon, Alert02Icon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { closeAgentChat, selectAgentChat, startNewAgentChat } from "@/hooks/agent-api";
import { useActiveChatId, useAgentChatIds, useChatState, useChatTitle } from "@/hooks/use-agent";
import type { ChatId } from "@/lib/agent/events";
import { Ico, Spinner } from "./agent-icon";

export async function requestCloseChat(chatId: ChatId, busy: boolean) {
  if (busy) {
    const ok = await ask("This chat is still working. Stop it and close the chat?", {
      title: "Close chat",
      kind: "warning",
    });
    if (!ok) return;
  }
  closeAgentChat(chatId);
}

function Tab({
  id,
  active,
  index,
  count,
}: {
  id: ChatId;
  active: boolean;
  index: number;
  count: number;
}) {
  const title = useChatTitle(id);
  const state = useChatState(id);
  const busy =
    state === "running" ||
    state === "starting" ||
    state === "cancelling" ||
    state === "reconnecting";
  const status =
    state === "awaiting-permission"
      ? "needs permission"
      : state === "error"
        ? "error"
        : busy
          ? "working"
          : "";
  return (
    <div
      role="tab"
      id={`agent-tab-${id}`}
      aria-selected={active}
      aria-controls="agent-chat-panel"
      tabIndex={active ? 0 : -1}
      data-agent-tab
      data-tab-index={index}
      onClick={() => selectAgentChat(id)}
      onAuxClick={(e) => {
        if (e.button === 1) void requestCloseChat(id, busy || state === "awaiting-permission");
      }}
      onKeyDown={(e) => {
        const delta = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
        if (delta) {
          e.preventDefault();
          const siblings =
            e.currentTarget.parentElement?.querySelectorAll<HTMLElement>("[role=tab]");
          const next = siblings?.[(index + delta + count) % count];
          next?.focus();
          next?.click();
        } else if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          selectAgentChat(id);
        }
      }}
      className="group flex max-w-[11rem] shrink-0 cursor-default items-center gap-1.5 rounded-md px-2 py-1 text-[12.5px] text-text-muted aria-selected:bg-[var(--surface-card)] aria-selected:text-text-primary"
    >
      {busy && <Spinner size={12} />}
      {state === "awaiting-permission" && (
        <span
          aria-hidden="true"
          className="size-1.5 shrink-0 rounded-full bg-[var(--agent-warn)]"
        />
      )}
      {state === "error" && (
        <Ico icon={Alert02Icon} size={12} className="text-[var(--agent-error)]" />
      )}
      <span className="truncate">{title}</span>
      {status && <span className="sr-only">({status})</span>}
      <button
        type="button"
        aria-label={`Close ${title}`}
        tabIndex={-1}
        onClick={(e) => {
          e.stopPropagation();
          void requestCloseChat(id, busy || state === "awaiting-permission");
        }}
        className="rounded p-0.5 opacity-0 group-hover:opacity-100 group-aria-selected:opacity-100 hover:bg-[var(--item-hover-bg)]"
      >
        <Ico icon={Cancel01Icon} size={11} />
      </button>
    </div>
  );
}

export function ChatTabs() {
  const ids = useAgentChatIds();
  const active = useActiveChatId();
  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-[var(--line-subtler)] px-2 py-1.5">
      <div role="tablist" aria-label="Chats" className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
        {ids.map((id, i) => (
          <Tab key={id} id={id} index={i} count={ids.length} active={id === active} />
        ))}
      </div>
      <button
        type="button"
        aria-label="New chat"
        title="New chat"
        onClick={() => startNewAgentChat()}
        className="rounded-md p-1 text-text-muted hover:bg-[var(--item-hover-bg)] hover:text-text-primary"
      >
        <Ico icon={Add01Icon} size={14} />
      </button>
    </div>
  );
}
