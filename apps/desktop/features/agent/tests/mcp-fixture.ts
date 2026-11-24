import type { McpMenu } from "../web/bindings";

/** What `agent_mcp_servers` answers in tests that only render Settings > Agent: already read, with
 *  Writer's own row alone. */
export const mcpMenu = (over: Partial<McpMenu> = {}): McpMenu => ({
  backend: "claude",
  setting: "agent.claude.disabled-mcp-servers",
  defaultOn: true,
  servers: [
    { name: "writer", names: ["writer"], status: "unknown", ownedByWriter: true, enabled: true },
  ],
  checkedAtMs: 1_700_000_000_000,
  error: null,
  applies: "next-start",
  ...over,
});
