// What keeps the agent dock in step with the app, started once at startup (`activation:
// onStartup`): the saved pane width and open state from the settings. The chats that were open in
// the vault come back when the pane mounts (`components/agent-pane.tsx`), so this path never loads
// the chat store. Also starts the project list that feeds the sidebar badge.
import type { FeatureContext } from "@/lib/features/types";
import { useSettingsStore } from "@/stores/settings-store";
import {
  AGENT_PANE_OPEN_SETTING as OPEN,
  AGENT_PANE_WIDTH_SETTING as WIDTH,
  usePaneStore,
} from "@features/agent/web/stores/pane-store";
import { attachAgentStore } from "@features/agent/web/lib/store-lifecycle";
import { watchProjects } from "@features/agent/web/stores/projects-store";

export function syncAgentDock(ctx: FeatureContext): void {
  // The settings are the saved state (also edited in Settings): adopt them now and on change, so
  // the pane is applied before it renders.
  const adopt = (settings: Record<string, unknown>) => {
    const pane = usePaneStore.getState();
    pane.syncWidth(settings[WIDTH]);
    pane.syncOpen(settings[OPEN]);
  };
  adopt(useSettingsStore.getState().settings);
  ctx.subscribe(useSettingsStore, (s, prev) => {
    if (s.settings[WIDTH] !== prev.settings[WIDTH] || s.settings[OPEN] !== prev.settings[OPEN])
      adopt(s.settings);
  });
  watchProjects(ctx);
  // the chat store (loaded with the pane) is wired to this activation and reset with it
  attachAgentStore(ctx);
}
