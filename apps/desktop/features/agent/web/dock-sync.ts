// What keeps the agent dock in step with the app, started once at startup (`activation:
// onStartup`): the saved pane width and open state from the settings, and the chats that were open
// in the vault. Replaces the `useAgentPaneDock` hook the layout used to mount.
import { restoreAgentChats, syncAgentPane } from "@/hooks/agent-api";
import type { FeatureContext } from "@/lib/features/types";
import { useSettingsStore } from "@/stores/settings-store";
import { useWorkspaceStore } from "@/stores/workspace-store";

const WIDTH = "agent.pane-width";
const OPEN = "agent.pane-open";

export function syncAgentDock(ctx: FeatureContext): void {
  // The settings are the saved state (also edited in Settings): adopt them now and on change, so
  // the pane is applied before it renders.
  const adopt = (settings: Record<string, unknown>) =>
    syncAgentPane({ width: settings[WIDTH], open: settings[OPEN] });
  adopt(useSettingsStore.getState().settings);
  ctx.disposables.add(
    useSettingsStore.subscribe((s, prev) => {
      if (s.settings[WIDTH] !== prev.settings[WIDTH] || s.settings[OPEN] !== prev.settings[OPEN])
        adopt(s.settings);
    }),
  );

  // The chats that were open in this vault come back once per vault, whether or not the pane is open.
  const restore = (root: string | null) => {
    if (root) void restoreAgentChats(root);
  };
  restore(useWorkspaceStore.getState().root);
  ctx.disposables.add(
    useWorkspaceStore.subscribe((s, prev) => {
      if (s.root !== prev.root) restore(s.root);
    }),
  );
}
