// The "Table" submenu of the editor's right-click menu. Contributed to the `editor-body` surface
// by `index.ts`; it is built only when the click landed in a table, after moving the caret into
// the clicked cell.
import type { EditorView } from "@codemirror/view";
import type { MenuItemSpec } from "@/components/editor-area/editor-context-menu";
import { chordToAccelerator } from "@/components/editor-area/markdown-formatting";
import {
  TABLE_MENU_LAYOUT,
  prepareTableContextMenu,
  runTableCommand,
  tableCommands,
} from "./table-editing";

export function tableContextMenuItems(view: EditorView, event: MouseEvent): MenuItemSpec[] {
  if (!prepareTableContextMenu(view, event)) return [];
  return [
    { kind: "separator" },
    {
      kind: "submenu",
      text: "Table",
      items: TABLE_MENU_LAYOUT.map((entry): MenuItemSpec => {
        if (entry === "---") return { kind: "separator" };
        const command = tableCommands[entry];
        return {
          kind: "item",
          id: entry,
          text: command.label,
          action: () => {
            view.focus();
            runTableCommand(view, entry);
          },
          ...("chord" in command ? { accelerator: chordToAccelerator(command.chord) } : {}),
        };
      }),
    },
  ];
}
