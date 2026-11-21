// The `agent.context` service (`api.ts`). Import-light: it is registered with the feature at
// startup, so the chat store and everything under `lib/` load only when the service is first used.
import type { AgentChatsService, AgentContextService } from "./api";

export const agentContextService: AgentContextService = {
  async attachNotes(paths) {
    if (paths.length === 0) return;
    const { attachNotesToDraft } = await import("./lib/attach-notes");
    attachNotesToDraft(paths);
  },
};

export const agentChatsService: AgentChatsService = {
  async openChat(chatId) {
    const { useAgentStore } = await import("@features/agent/web/stores/agent-store");
    await useAgentStore.getState().openSavedChat(chatId);
  },
};
