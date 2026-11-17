import { useCallback, useEffect, useState } from "react";
import { useWorkspaceRoot } from "@/hooks/use-workspace";
import {
  cycleAgentChat,
  persistAgentPaneWidth,
  restoreAgentChats,
  setAgentPaneWidth,
  setAgentView,
  startNewAgentChat,
} from "@features/agent/web/hooks/agent-api";
import {
  useActiveChatId,
  useAgentBinary,
  useAgentChat,
  useAgentDraft,
  useAgentPaneWidth,
  useAgentView,
  useIsAgentPaneOpen,
  useQueuedMessage,
} from "@features/agent/web/hooks/use-agent";
import { AGENT_PANE_MAX_WIDTH, AGENT_PANE_MIN_WIDTH } from "@features/agent/web/stores/pane-store";
import { AgentHeader } from "./agent-header";
import { ChatTabs, requestCloseChat } from "./chat-tabs";
import { Composer } from "./composer";
import { EmptyState } from "./empty-state";
import { PinnedStack } from "./pinned-stack";
import { HistorySlot, ProjectHomeSlot } from "./slots";
import { Transcript } from "./transcript";
import { UsageLine } from "./usage-line";
import { useDetectBinaryOnMount } from "./use-detect-binary";

/**
 * Right-dock host for the native agent (spec 3.1). `AppLayout` renders it instead of
 * `PluginViewPane` while it is open; width is resizable 320-640 px and persisted.
 * Pane-scoped shortcuts (only while focus is inside): Cmd+Shift+N new chat, Cmd+Shift+H
 * history, Cmd+[ / Cmd+] previous/next chat, Cmd+W close chat.
 */
export function AgentPane() {
  const open = useIsAgentPaneOpen();
  const width = useAgentPaneWidth();
  const view = useAgentView();
  const chatId = useActiveChatId();
  const chat = useAgentChat(chatId);
  const draft = useAgentDraft(chatId);
  const queued = useQueuedMessage(chatId);
  const binary = useAgentBinary();
  const [dragging, setDragging] = useState(false);
  // The chats open in this vault come back when the pane first mounts (and on a vault switch).
  const root = useWorkspaceRoot();
  useEffect(() => {
    if (root) void restoreAgentChats(root);
  }, [root]);
  useDetectBinaryOnMount(binary !== null || !open);

  const onResizeStart = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      setDragging(true);
      const startX = event.clientX;
      const startWidth = width;
      const prev = document.body.style.userSelect;
      document.body.style.userSelect = "none";
      const onMove = (e: PointerEvent) => setAgentPaneWidth(startWidth + startX - e.clientX, false);
      const finish = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", finish);
        document.body.style.userSelect = prev;
        setDragging(false);
        persistAgentPaneWidth();
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", finish);
    },
    [width],
  );

  function onKeyDown(e: React.KeyboardEvent<HTMLElement>) {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    const key = e.key.toLowerCase();
    const handled = () => {
      e.preventDefault();
      e.stopPropagation(); // keep the global shortcut hook (Cmd+W, ...) out of it
    };
    if (e.shiftKey && key === "n") {
      handled();
      startNewAgentChat();
    } else if (e.shiftKey && key === "h") {
      handled();
      setAgentView("history");
    } else if (!e.shiftKey && (e.key === "[" || e.key === "]")) {
      handled();
      cycleAgentChat(e.key === "]" ? 1 : -1);
    } else if (!e.shiftKey && key === "w" && chat) {
      handled();
      void requestCloseChat(
        chat.chatId,
        chat.state !== "idle" && chat.state !== "ended" && chat.state !== "error",
      );
    }
  }

  if (!open) return null;

  return (
    <aside
      role="complementary"
      aria-label="Agent"
      data-agent-pane
      onKeyDown={onKeyDown}
      className="relative flex h-full shrink-0 flex-col bg-bg text-text-primary"
      style={{ width }}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize agent pane"
        aria-valuemin={AGENT_PANE_MIN_WIDTH}
        aria-valuemax={AGENT_PANE_MAX_WIDTH}
        aria-valuenow={width}
        tabIndex={0}
        data-dragging={dragging || undefined}
        onPointerDown={onResizeStart}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
            e.preventDefault();
            setAgentPaneWidth(width + (e.key === "ArrowLeft" ? 16 : -16));
          }
        }}
        className="absolute inset-y-0 left-0 z-10 w-1 cursor-col-resize bg-[var(--line-subtle)] opacity-60 hover:opacity-100 focus-visible:opacity-100 data-[dragging]:opacity-100"
      />
      <AgentHeader projectPath={chat?.projectPath ?? null} />
      <ChatTabs />
      <div
        id="agent-chat-panel"
        role="tabpanel"
        aria-labelledby={chatId ? `agent-tab-${chatId}` : undefined}
        className="flex min-h-0 flex-1 flex-col"
      >
        {view === "project" ? (
          <ProjectHomeSlot />
        ) : view === "history" ? (
          <HistorySlot />
        ) : chat ? (
          <>
            {chat.turns.length === 0 && !chat.error && !chat.localNotice ? (
              <EmptyState chatId={chat.chatId} />
            ) : (
              <Transcript chat={chat} />
            )}
            <PinnedStack chat={chat} queued={queued} />
            <Composer chat={chat} draft={draft} hasQueued={queued !== undefined} />
            <UsageLine chat={chat} />
          </>
        ) : null}
      </div>
    </aside>
  );
}
