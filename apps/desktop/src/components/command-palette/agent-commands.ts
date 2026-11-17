// Palette entries for the native agent pane (spec 3.2, lane 2). They call the imperative agent
// API directly, so the shared `CommandContext` is unchanged.
import {
  openAgentHistory,
  openAgentPane,
  setAgentBackend,
  startNewAgentChat,
  toggleAgentPane,
} from "@/hooks/agent-api";
import type { CommandContext } from "./commands";

interface AgentPaletteCommand {
  id: string;
  label: string;
  description: string;
  when: (ctx: CommandContext) => boolean;
  run: (ctx: CommandContext) => void;
}

const COMMAND = "Command";
const available = (c: CommandContext) => c.hasWorkspace && !c.isCompactFileMode;

export const AGENT_PALETTE_COMMANDS: readonly AgentPaletteCommand[] = [
  {
    id: "agent-toggle-pane",
    label: "Agent: Toggle pane",
    description: COMMAND,
    when: available,
    run: () => toggleAgentPane(),
  },
  {
    id: "agent-new-chat",
    label: "Agent: New chat",
    description: COMMAND,
    when: available,
    run: () => startNewAgentChat(),
  },
  {
    id: "agent-history",
    label: "Agent: History",
    description: COMMAND,
    when: available,
    run: () => openAgentHistory(),
  },
  // Development only: runs the pane against recorded sessions (shared/agent-golden), no backend.
  {
    id: "agent-use-demo-backend",
    label: "Agent: Use demo backend (recorded sessions)",
    description: COMMAND,
    when: (c) => import.meta.env.DEV && available(c),
    run: () => {
      setAgentBackend("mock");
      openAgentPane();
    },
  },
];
