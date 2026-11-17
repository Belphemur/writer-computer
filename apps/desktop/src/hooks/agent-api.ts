/**
 * Imperative (non-reactive) access to the agent pane for event handlers, the palette and the
 * keyboard hook (docs/react-guidelines.md: an API module, not `store.getState()` in components).
 */
import {
  regenerateChatTitle,
  useAgentStore,
  type AgentBackend,
  type AgentView,
  type Draft,
} from "@/stores/agent-store";
import type { ChatModelChoice } from "@/lib/agent/agent-settings";
import type { AgentPermissionMode, ChatId, PermissionPersist } from "@/lib/agent/events";
import { useSettingsStore } from "@/stores/settings-store";

export const toggleAgentPane = () => useAgentStore.getState().togglePane();
export const openAgentPane = () => useAgentStore.getState().openPane();
export const closeAgentPane = () => useAgentStore.getState().closePane();
export const isAgentPaneOpen = () => useAgentStore.getState().paneOpen;
export const setAgentPaneWidth = (w: number, persist = true) =>
  useAgentStore.getState().setPaneWidth(w, persist);
export const persistAgentPaneWidth = () => useAgentStore.getState().persistPaneWidth();
export const openSavedAgentChat = (id: ChatId) => useAgentStore.getState().openSavedChat(id);
export const setAgentView = (v: AgentView) => useAgentStore.getState().setView(v);
export const setAgentBackend = (b: AgentBackend) => useAgentStore.getState().setBackend(b);

/** Opens the pane on a fresh chat ("Agent: new chat"). */
export function startNewAgentChat(projectPath?: string | null) {
  const s = useAgentStore.getState();
  s.newChat(projectPath);
  s.setPaneOpen(true);
}
/** Opens the pane on the history view ("Agent: history"). Lane 4 renders the list. */
export function openAgentHistory() {
  const s = useAgentStore.getState();
  if (s.order.length === 0) s.newChat();
  s.setPaneOpen(true);
  s.setView("history");
}
/** History "Regenerate title": any chat, open or not; an open chat updates live. */
export const regenerateAgentChatTitle = regenerateChatTitle;
export const closeAgentChat = (id: ChatId) => useAgentStore.getState().closeChat(id);
export const selectAgentChat = (id: ChatId) => useAgentStore.getState().selectChat(id);
export const cycleAgentChat = (d: 1 | -1) => useAgentStore.getState().cycleChat(d);
export const setAgentDraft = (id: ChatId, patch: Partial<Draft>) =>
  useAgentStore.getState().setDraft(id, patch);
export const sendAgentMessage = (text: string) => useAgentStore.getState().sendMessage(text);
export const stopAgent = () => useAgentStore.getState().stop();
export const removeQueuedMessage = (id: ChatId) => useAgentStore.getState().removeQueued(id);
export const retryAgent = () => useAgentStore.getState().retry();
export const detectAgentBinary = (override?: string | null) =>
  useAgentStore.getState().detectBinary(override);
export const decideAgentPermission = (
  requestId: string,
  decision: "allow" | "deny",
  persist?: PermissionPersist,
  message?: string,
) => useAgentStore.getState().decidePermission(requestId, decision, persist, message);
export const setAgentPermissionMode = (m: AgentPermissionMode) =>
  useAgentStore.getState().setPermissionMode(m);
export const setAgentChatModel = (model: string | null, effort?: ChatModelChoice["effort"]) =>
  useAgentStore.getState().setChatModel(model, effort);
/** "Set as default" in the model menu: writes `agent.model` ("" is Agent default) and `agent.effort`. */
export async function setAgentDefaultModel(choice: ChatModelChoice): Promise<void> {
  const { setSetting } = useSettingsStore.getState();
  await setSetting("agent.model", choice.model ?? "");
  await setSetting("agent.effort", choice.effort ?? "default");
}
export const openNewProjectDialog = (opts?: { folder?: string | null }) =>
  useAgentStore.getState().openNewProjectDialog(opts);

export function hasPendingAgentPermission(): boolean {
  const s = useAgentStore.getState();
  const chat = s.activeChatId ? s.chats[s.activeChatId] : null;
  return (chat?.pendingPermissions.length ?? 0) > 0;
}

export const loadAgentSkills = (projectPath: string | null) =>
  useAgentStore.getState().loadSkills(projectPath);

// ---- Dock plumbing for the agent feature's dock contribution (features/agent/web) ----
export const agentPaneWidth = () => useAgentStore.getState().paneWidth;
/** Calls `listener` when the pane opens, closes or is resized. */
export const subscribeAgentPane = (listener: () => void) =>
  useAgentStore.subscribe((s, prev) => {
    if (s.paneOpen !== prev.paneOpen || s.paneWidth !== prev.paneWidth) listener();
  });
/** Adopt the saved width and open state (the `agent.pane-width` / `agent.pane-open` settings). */
export const syncAgentPane = (saved: { width: unknown; open: unknown }) => {
  const s = useAgentStore.getState();
  s.syncPaneWidth(saved.width);
  s.syncPaneOpen(saved.open);
};
/** The chats that were open in this vault come back (once per vault). */
export const restoreAgentChats = (root: string) => useAgentStore.getState().restoreChats(root);
