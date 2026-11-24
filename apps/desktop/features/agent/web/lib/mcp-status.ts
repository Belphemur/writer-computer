import type { McpState } from "@features/agent/web/ipc";

// Every wire state has a word: a state added in Rust fails the type check here.
const WORDS: Record<McpState, string> = {
  connected: "connected",
  pending: "pending",
  failed: "failed",
  "needs-auth": "needs sign-in",
  disconnected: "disconnected",
  disabled: "off",
  unknown: "unknown",
};

/** An MCP server's state as a word: the one wording of the Skills chip and the MCP servers menu. */
export const mcpStatusLabel = (status: McpState): string => WORDS[status];

/** Whether a server is worth a warning mark: anything but connected, or switched off on purpose
 *  (`disabled`). Rust twin: `config_sync::is_settled`; both read `settled` of
 *  `shared/agent-mcp/vectors.json`. */
export const mcpNeedsAttention = (status: McpState): boolean =>
  status !== "connected" && status !== "disabled";
