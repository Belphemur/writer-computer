// Palette entries for a note's display title (the frontmatter `title` property). Both open the one
// display-title dialog, like the tab and sidebar menus; neither renames the file.
import { getOpenFile } from "@/hooks/editor-api";
import { isMarkdownPath, openNoteTitleDialog } from "@/stores/note-title-dialog-store";
import type { CommandContext } from "./commands";

interface TitlePaletteCommand {
  id: string;
  label: string;
  description: string;
  when: (ctx: CommandContext) => boolean;
  run: (ctx: CommandContext) => void;
}

const COMMAND = "Command";

const hasNote = (c: CommandContext) =>
  c.hasWorkspace &&
  !c.isCompactFileMode &&
  c.activeFilePath !== null &&
  isMarkdownPath(c.activeFilePath);

export const TITLE_PALETTE_COMMANDS: readonly TitlePaletteCommand[] = [
  {
    id: "note-set-display-title",
    label: "Note: Set display title",
    description: COMMAND,
    when: hasNote,
    run: (c) => c.activeFilePath && openNoteTitleDialog(c.activeFilePath),
  },
  {
    id: "note-clear-display-title",
    label: "Note: Clear display title",
    description: COMMAND,
    // Only a note that has an override (its live frontmatter `title`) offers it.
    when: (c) => hasNote(c) && Boolean(getOpenFile(c.activeFilePath ?? "")?.title),
    run: (c) => c.activeFilePath && openNoteTitleDialog(c.activeFilePath, { clear: true }),
  },
];
