// The public entry of the agent feature that another feature may name: the service `agent.context`
// lets a view (the graph's "Attach to agent chat") attach notes to the chat being written without
// importing anything of the agent. Consumers use `getService` (`@/lib/features/services`) and take
// the TYPE from here with `import type` (erased: no runtime edge between the features); the service
// is absent while the agent feature is off.

/** The service id, one of the manifest's `provides`. */
export const AGENT_CONTEXT = "agent.context";

export interface AgentContextService {
  /** Attach notes (vault-relative paths) to the draft of the active chat, as `@` mentions do, and
   *  show the pane. A new chat is made when none is open. */
  attachNotes(paths: readonly string[]): Promise<void>;
}
