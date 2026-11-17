/**
 * Domain hooks for the native agent pane. Components import these, never `stores/agent-store`
 * (docs/react-guidelines.md). One selector per hook; imperative actions live in `agent-api.ts`.
 */
import { useMemo } from "react";
import { skillsKey, useAgentStore } from "@/stores/agent-store";
import { useSettingsStore } from "@/stores/settings-store";
import { agentSettingsFrom, type ChatModelChoice } from "@/lib/agent/agent-settings";
import type { AgentPermissionMode } from "@/lib/agent/events";
import { useActiveFilePath } from "@/hooks/use-tabs";
import { useWorkspaceRoot } from "@/hooks/use-workspace";
import type { ChatId } from "@/lib/agent/events";
import { contextStatus, type ContextStatus } from "@/lib/agent/context-usage";

export type { SkillsEntry } from "@/stores/agent-store";
export type { Draft, AgentView, AgentBackend, QueuedMessage } from "@/stores/agent-store";
export type { Chat, Turn, Block, PermissionView } from "@/lib/agent/transcript";

export function useIsAgentPaneOpen() {
  return useAgentStore((s) => s.paneOpen);
}
export function useAgentPaneWidth() {
  return useAgentStore((s) => s.paneWidth);
}
export function useHistoryError() {
  return useAgentStore((s) => s.historyError);
}
export function useAgentView() {
  return useAgentStore((s) => s.view);
}
export function useAgentBackend() {
  return useAgentStore((s) => s.backend);
}
export function useAgentBinary() {
  return useAgentStore((s) => s.binary);
}
export function useAgentChatIds() {
  return useAgentStore((s) => s.order);
}
export function useActiveChatId() {
  return useAgentStore((s) => s.activeChatId);
}
export function useAgentChat(chatId: ChatId | null) {
  return useAgentStore((s) => (chatId ? (s.chats[chatId] ?? null) : null));
}
export function useChatTitle(chatId: ChatId) {
  return useAgentStore((s) => s.chats[chatId]?.title ?? "");
}
export function useChatState(chatId: ChatId) {
  return useAgentStore((s) => s.chats[chatId]?.state ?? "idle");
}
export function useAgentDraft(chatId: ChatId | null) {
  return useAgentStore((s) => (chatId ? s.drafts[chatId] : undefined));
}
export function useQueuedMessage(chatId: ChatId | null) {
  return useAgentStore((s) => (chatId ? s.queued[chatId] : undefined));
}
export function useFocusComposerTick() {
  return useAgentStore((s) => s.focusComposerTick);
}
export function useAgentProjectPath() {
  return useAgentStore((s) => s.currentProjectPath);
}
export function useNewProjectDialog() {
  return useAgentStore((s) => s.newProjectDialog);
}

/** The chat's permission mode: the composer choice, else the `agent.permission-mode` setting. */
export function useChatPermissionMode(chatId: ChatId | null): AgentPermissionMode {
  const override = useAgentStore((s) => (chatId ? s.modes[chatId] : undefined));
  const fromSettings = useSettingsStore((s) => s.settings["agent.permission-mode"]);
  return override ?? agentSettingsFrom({ "agent.permission-mode": fromSettings }).permissionMode;
}

/** What the model chip shows for a chat: the requested model (chat choice, else the settings) and
 *  the one the CLI reported after the last turn (the truth). */
export function useChatModel(chatId: ChatId | null): {
  choice: ChatModelChoice;
  reported: string | null;
  sessionModel: string | null;
} {
  const own = useAgentStore((s) => (chatId ? s.chatModels[chatId] : undefined));
  const reported = useAgentStore((s) => (chatId ? (s.chats[chatId]?.reportedModel ?? null) : null));
  const sessionModel = useAgentStore((s) =>
    chatId ? (s.chats[chatId]?.session?.model ?? null) : null,
  );
  const model = useSettingsStore((s) => s.settings["agent.model"]);
  const effort = useSettingsStore((s) => s.settings["agent.effort"]);
  const base = useMemo(() => {
    const d = agentSettingsFrom({ "agent.model": model, "agent.effort": effort });
    return { model: d.model, effort: d.effort };
  }, [model, effort]);
  return { choice: own ?? base, reported, sessionModel };
}

/** How full the chat's context window is (`lib/agent/context-usage.ts`); null without a chat. */
export function useChatContext(chatId: ChatId | null): ContextStatus | null {
  const chat = useAgentChat(chatId);
  const { choice } = useChatModel(chatId);
  return useMemo(() => (chat ? contextStatus(chat, choice.model) : null), [chat, choice.model]);
}

/** Is the active-note chip allowed by `agent.attach-active-note` (default on)? */
export function useAttachActiveNoteSetting(): boolean {
  return useSettingsStore((s) => s.settings["agent.attach-active-note"]) !== false;
}

/** Skills on disk for a chat's project (vault root when null), as last loaded. */
export function useDiskSkills(projectPath: string | null) {
  return useAgentStore((s) => s.skills[skillsKey(projectPath)]);
}

/** The note open in the editor, vault-relative; null when none is open or it is outside the vault. */
export function useActiveNoteRelative(): string | null {
  const path = useActiveFilePath();
  const root = useWorkspaceRoot();
  if (!path || !root) return null;
  const base = root.endsWith("/") ? root : `${root}/`;
  return path.startsWith(base) ? path.slice(base.length) : null;
}

/** The CLI's last reported slash commands and skills in this window (null before any chat started). */
export function useCliCatalog() {
  return useAgentStore((s) => s.cliCatalog);
}
