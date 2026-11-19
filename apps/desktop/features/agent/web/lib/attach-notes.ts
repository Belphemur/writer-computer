// Attaches vault files and folders to a chat's draft the way picking them from `@` does (the
// pure part is `mentionPatch`): the user sees the pills and can edit before sending.
import { openAgentPane } from "@features/agent/web/hooks/agent-api";
import { useAgentStore } from "@features/agent/web/stores/agent-store";
import type { ChatId } from "./events";
import { mentionPatch, type MentionTarget } from "./mentions";

/** Adds `targets` to the draft of chat `chatId`. */
export function mentionInDraft(chatId: ChatId, targets: readonly MentionTarget[]): void {
  if (targets.length === 0) return;
  const store = useAgentStore.getState();
  const draft = store.drafts[chatId] ?? { text: "", mentions: [], activeNote: true };
  store.setDraft(chatId, mentionPatch(draft, targets));
}

/** Adds notes to the active chat's draft (a new chat when there is none) and opens the pane. */
export function attachNotesToDraft(paths: readonly string[]): void {
  const store = useAgentStore.getState();
  if (store.activeChatId === null) store.newChat();
  openAgentPane();
  const chatId = useAgentStore.getState().activeChatId;
  if (chatId !== null)
    mentionInDraft(
      chatId,
      paths.map((path) => ({ path, isDir: false })),
    );
}
