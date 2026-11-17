// The tables feature: GFM table rendering, table editing (keys, toolbar, paste), and the Table
// palette and right-click commands. Import-light on purpose (host rule, SPECs/builtin-plugins-spec.md
// 7.5): everything heavy sits behind the dynamic imports below, so none of it is in the startup chunk.
import { defineFeature } from "@/lib/features/registry";
import type { CommandContribution } from "@/lib/features/types";
import manifest from "../feature.json";
import { getTableEditorView, isCaretInTable } from "./active";

/** Availability names used in `feature.json`; the manifest names them, this is their meaning. */
const WHEN = {
  editor: () => getTableEditorView() !== null,
  selection: () => {
    const view = getTableEditorView();
    return view !== null && !view.state.selection.main.empty;
  },
  "in-table": isCaretInTable,
} as const;

const commands: CommandContribution[] = manifest.contributes.commands.map((c) => ({
  id: c.id,
  label: c.label,
  description: c.description,
  when: WHEN[c.when as keyof typeof WHEN],
  run: async () => {
    const { runTablePaletteCommand } = await import("./table-commands");
    runTablePaletteCommand(c.id);
  },
}));

export default defineFeature({
  id: manifest.id,
  contributes: {
    commands,
    editorExtensions: [
      {
        id: "tables.editor",
        load: () => import("./extension").then((m) => m.tableExtension()),
      },
    ],
    menus: {
      "editor-body": [
        {
          id: "tables.table-submenu",
          items: async (view, event) =>
            (await import("./context-menu")).tableContextMenuItems(view, event),
        },
      ],
    },
  },
});
