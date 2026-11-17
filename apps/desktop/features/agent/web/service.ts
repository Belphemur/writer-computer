// The `agent.context` service (`api.ts`). Import-light: it is registered with the feature at
// startup, so the chat store and everything under `lib/` load only when the service is first used.
import type { AgentContextService } from "./api";

export const agentContextService: AgentContextService = {
  async attachNotes(paths) {
    if (paths.length === 0) return;
    const { attachNotesToDraft } = await import("./lib/attach-notes");
    attachNotesToDraft(paths);
  },
};
