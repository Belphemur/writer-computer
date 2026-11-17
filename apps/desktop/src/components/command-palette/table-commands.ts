// Palette entries for table editing. The commands act on the editor that last had focus: the
// table ones only while its caret is in a table; insert, convert and paste whenever an editor exists.
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { showEditorNotice } from "@/components/editor-area/editor-notice-store";
import {
  TABLE_MENU_LAYOUT,
  convertSelectionToTable,
  getTableEditorView,
  insertTableCommand,
  insertTableFromText,
  runTableCommand,
  tableCommands,
  tableContextAt,
  type TableCommandId,
} from "@/components/editor-area/table-editing";

interface TablePaletteCommand {
  id: string;
  label: string;
  description: string;
  when: () => boolean;
  run: () => void;
}

const COMMAND = "Command";

// After the palette released focus, so the editor takes it back with the caret where it was.
function onEditor(action: (view: NonNullable<ReturnType<typeof getTableEditorView>>) => void) {
  const view = getTableEditorView();
  if (!view) return;
  setTimeout(() => {
    action(view);
    view.focus();
  }, 0);
}

const inTable = () => {
  const view = getTableEditorView();
  return view !== null && tableContextAt(view.state) !== null;
};

const tableEntries: TablePaletteCommand[] = (
  [...new Set(TABLE_MENU_LAYOUT.filter((e) => e !== "---"))] as TableCommandId[]
).map((id) => ({
  id: id.replace(/^table\./, "table-"),
  label: `Table: ${tableCommands[id].label}`,
  description: COMMAND,
  when: inTable,
  run: () => onEditor((view) => void runTableCommand(view, id)),
}));

export const TABLE_PALETTE_COMMANDS: readonly TablePaletteCommand[] = [
  {
    id: "table-insert",
    label: "Table: Insert table",
    description: COMMAND,
    when: () => getTableEditorView() !== null,
    run: () =>
      onEditor(
        (view) =>
          void insertTableCommand()({ state: view.state, dispatch: (tr) => view.dispatch(tr) }),
      ),
  },
  {
    id: "table-convert-selection",
    label: "Table: Convert selection to table",
    description: COMMAND,
    when: () => {
      const view = getTableEditorView();
      return view !== null && !view.state.selection.main.empty;
    },
    run: () =>
      onEditor((view) => {
        const ok = convertSelectionToTable({
          state: view.state,
          dispatch: (tr) => view.dispatch(tr),
        });
        if (!ok) showEditorNotice("The selection is not CSV, TSV or pipe-separated text");
      }),
  },
  {
    id: "table-paste-as-table",
    label: "Table: Paste clipboard as table",
    description: COMMAND,
    when: () => getTableEditorView() !== null,
    run: () => {
      const view = getTableEditorView();
      if (!view) return;
      void readText().then((text) => {
        const spec = text ? insertTableFromText(view.state, text) : null;
        if (!spec) {
          showEditorNotice("The clipboard is not CSV, TSV or pipe-separated text");
          return;
        }
        view.dispatch(spec);
        view.focus();
      });
    },
  },
  ...tableEntries,
];
