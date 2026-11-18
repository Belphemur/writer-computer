// The agent feature (pilot 3): its palette commands, the Cmd+Shift+A binding, the right-hand dock,
// the project entry points (palette, folder menu, tree badge, dialog) and the Settings page. This
// file is loaded at startup, so it imports only light modules: the pane's open state and width
// (`stores/pane-store.ts`, what the dock reads, applied before the first paint), the project badge
// hook and path helpers. The chat store and everything under `web/lib` and `web/components` are
// dynamic imports that load the first time a command runs or the pane opens
// (SPECs/builtin-plugins-spec.md, "Step 5: projects").
import { defineFeature } from "@/lib/features/registry";
import type { CommandContribution, KeybindingContribution } from "@/lib/features/types";
import { isCompactFileMode } from "@/lib/keybindings/when";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { folderOfFile } from "@features/agent/web/lib/project-sources";
import { useProjectBadge } from "@features/agent/web/project-badge";
import { usePaneStore } from "@features/agent/web/stores/pane-store";
import manifest from "../feature.json";
import { AGENT_CONTEXT } from "./api";
import { agentContextService } from "./service";

type Availability = {
  hasWorkspace: boolean;
  isCompactFileMode: boolean;
  activeFilePath: string | null;
};
const workspaceWindow = (c: Availability) => c.hasWorkspace && !c.isCompactFileMode;

/** Availability names used in `feature.json`; the manifest names them, this is their meaning. */
const WHEN = {
  "workspace-window": workspaceWindow,
  // Development only: runs the pane against recorded sessions, no backend.
  "dev-workspace-window": (c: Availability) => import.meta.env.DEV && workspaceWindow(c),
  // "Make project from this folder": the folder of the active note; not offered for a note at the
  // vault root.
  "workspace-window-in-folder": (c: Availability) =>
    workspaceWindow(c) &&
    folderOfFile(c.activeFilePath, useWorkspaceStore.getState().root) !== null,
} as const;

/** The chat store's modules load when a command needs them, not at startup. */
const agentApi = () => import("@features/agent/web/hooks/agent-api");
const projectActions = () => import("@features/agent/web/lib/project-actions");

/** What each command does; the manifest holds the ids, labels and availability. */
const ACTIONS: Record<string, (c: Availability) => void | Promise<void>> = {
  // Closing never needs the chat store; opening loads it (it also makes the first chat tab).
  "agent.toggle-pane": async () =>
    usePaneStore.getState().open
      ? usePaneStore.getState().setOpen(false)
      : (await agentApi()).openAgentPane(),
  "agent.new-chat": async () => (await agentApi()).startNewAgentChat(),
  "agent.history": async () => (await agentApi()).openAgentHistory(),
  "agent.reload-session": async () => (await agentApi()).reloadAgentSession(),
  "agent.use-demo-backend": async () => {
    const api = await agentApi();
    api.setAgentBackend("mock");
    api.openAgentPane();
  },
  "agent.new-project": async () => (await projectActions()).openNewProject(),
  "agent.archive-project": async () => (await projectActions()).openArchiveProject(),
  "agent.unarchive-project": async () => (await projectActions()).openArchivedProjects(),
  "agent.make-project-from-folder": async (c) =>
    (await projectActions()).openMakeProjectForActiveFile(c.activeFilePath),
};

const commands: CommandContribution[] = manifest.contributes.commands.map((c) => ({
  id: c.id,
  label: c.label,
  description: c.description,
  when: WHEN[c.when as keyof typeof WHEN],
  run: (ctx) => ACTIONS[c.id]!(ctx),
}));

const keybindings: KeybindingContribution[] = manifest.contributes.keybindings.map((k) => ({
  ...k,
  // Works from anywhere in a workspace window; the single-note window has no pane.
  run: () => {
    if (useWorkspaceStore.getState().root !== null && !isCompactFileMode()) {
      void ACTIONS[k.id]!({ hasWorkspace: true, isCompactFileMode: false, activeFilePath: null });
    }
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
        isOpen: () => usePaneStore.getState().open,
        width: () => usePaneStore.getState().width,
        close: () => usePaneStore.getState().setOpen(false),
        subscribe: (listener) =>
          usePaneStore.subscribe((s, prev) => {
            if (s.open !== prev.open || s.width !== prev.width) listener();
          }),
        load: () => import("./components/agent-pane").then((m) => m.AgentPane),
      },
    ],
    // The dialog behind "New project" (palette, folder menu, pane header): shows itself when its
    // store state opens it.
    overlays: [
      {
        id: "agent.new-project-dialog",
        load: () => import("./components/new-project-dialog").then((m) => m.NewProjectDialog),
      },
    ],
    // "Make project" in a folder's context menu in the sidebar.
    menus: {
      "sidebar-folder": [
        {
          id: "agent.make-project",
          items: (entry) => [
            {
              kind: "item",
              id: "agent-make-project",
              text: "Make project",
              action: () =>
                void projectActions().then((m) => m.openMakeProjectForFolder(entry.path)),
            },
          ],
        },
      ],
    },
    // What other features use to attach notes to the chat (the graph's "Attach to agent chat").
    services: [{ id: AGENT_CONTEXT, service: agentContextService }],
    // The badge on a folder that holds a project.
    fileTreeDecorations: [{ id: "agent.project-badge", useBadge: useProjectBadge }],
    // The Agent page of Settings: backend tabs, Claude status, models and the generic rows.
    settingsSection: {
      id: "agent",
      label: "Agent",
      order: 40,
      load: () => import("./agent-section").then((m) => ({ default: m.AgentSection })),
    },
  },
  activate: async (ctx) => (await import("./dock-sync")).syncAgentDock(ctx),
});
