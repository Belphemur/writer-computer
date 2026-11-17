// The agent feature (pilot 3): its palette commands, the Cmd+Shift+A binding and the right-hand
// dock. The chat pane itself is a dynamic import, so the startup chunk holds none of the chat UI;
// the store behind the dock is light enough to be loaded at startup, where it has to be (the saved
// open state must apply before the first paint).
import {
  agentPaneWidth,
  closeAgentPane,
  isAgentPaneOpen,
  openAgentHistory,
  openAgentPane,
  setAgentBackend,
  startNewAgentChat,
  subscribeAgentPane,
  toggleAgentPane,
} from "@/hooks/agent-api";
import { defineFeature } from "@/lib/features/registry";
import type { CommandContribution, KeybindingContribution } from "@/lib/features/types";
import { isCompactFileMode } from "@/lib/keybindings/when";
import { useWorkspaceStore } from "@/stores/workspace-store";
import manifest from "../feature.json";

type Availability = { hasWorkspace: boolean; isCompactFileMode: boolean };
const workspaceWindow = (c: Availability) => c.hasWorkspace && !c.isCompactFileMode;

/** Availability names used in `feature.json`; the manifest names them, this is their meaning. */
const WHEN = {
  "workspace-window": workspaceWindow,
  // Development only: runs the pane against recorded sessions, no backend.
  "dev-workspace-window": (c: Availability) => import.meta.env.DEV && workspaceWindow(c),
} as const;

/** What each command does; the manifest holds the ids, labels and availability. */
const ACTIONS: Record<string, () => void> = {
  "agent.toggle-pane": toggleAgentPane,
  "agent.new-chat": () => startNewAgentChat(),
  "agent.history": openAgentHistory,
  "agent.use-demo-backend": () => {
    setAgentBackend("mock");
    openAgentPane();
  },
};

const commands: CommandContribution[] = manifest.contributes.commands.map((c) => ({
  id: c.id,
  label: c.label,
  description: c.description,
  when: WHEN[c.when as keyof typeof WHEN],
  run: () => ACTIONS[c.id]!(),
}));

const keybindings: KeybindingContribution[] = manifest.contributes.keybindings.map((k) => ({
  ...k,
  // Works from anywhere in a workspace window; the single-note window has no pane.
  run: () => {
    if (useWorkspaceStore.getState().root !== null && !isCompactFileMode()) ACTIONS[k.id]!();
  },
}));

export default defineFeature({
  id: manifest.id,
  contributes: {
    commands,
    keybindings,
    docks: [
      {
        id: manifest.contributes.docks[0]!,
        // Above the plugin pane: the agent wins while both are open.
        priority: 20,
        isOpen: isAgentPaneOpen,
        width: agentPaneWidth,
        close: closeAgentPane,
        subscribe: subscribeAgentPane,
        load: () => import("@/components/agent/agent-pane").then((m) => m.AgentPane),
      },
    ],
  },
  activate: async (ctx) => (await import("./dock-sync")).syncAgentDock(ctx),
});
