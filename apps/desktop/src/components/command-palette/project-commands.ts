// Palette entries for agent projects (spec 4.4): both end in the one `openNewProjectDialog`
// store action, like the sidebar menu and the pane header.
import {
  folderOfFile,
  openMakeProjectForActiveFile,
  openNewProject,
} from "@/lib/agent/project-actions";
import { useWorkspaceStore } from "@/stores/workspace-store";
import type { CommandContext } from "./commands";

interface ProjectPaletteCommand {
  id: string;
  label: string;
  description: string;
  when: (ctx: CommandContext) => boolean;
  run: (ctx: CommandContext) => void;
}

const COMMAND = "Command";

export const PROJECT_PALETTE_COMMANDS: readonly ProjectPaletteCommand[] = [
  {
    id: "agent-new-project",
    label: "New project",
    description: COMMAND,
    when: (c) => c.hasWorkspace && !c.isCompactFileMode,
    run: () => openNewProject(),
  },
  {
    id: "agent-make-project-from-folder",
    label: "Make project from this folder",
    description: COMMAND,
    // The folder of the active note; not offered for a note at the vault root.
    when: (c) =>
      c.hasWorkspace &&
      !c.isCompactFileMode &&
      folderOfFile(c.activeFilePath, useWorkspaceStore.getState().root) !== null,
    run: (c) => openMakeProjectForActiveFile(c.activeFilePath),
  },
];
