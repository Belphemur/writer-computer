// The actions behind the table palette commands declared in `feature.json` (labels, ids and
// availability are data there; this file is the lazy half that runs them). The commands act on
// the editor that last had focus: the table ones only while its caret is in a table; insert,
// convert and paste whenever an editor exists.
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { showEditorNotice } from "@/components/editor-area/editor-notice-store";
import { getTableEditorView } from "./active";
import {
  convertSelectionToTable,
  insertTableCommand,
  insertTableFromText,
  runTableCommand,
  tableCommands,
  type TableCommandId,
} from "./table-editing";

// After the palette released focus, so the editor takes it back with the caret where it was.
function onEditor(action: (view: NonNullable<ReturnType<typeof getTableEditorView>>) => void) {
  const view = getTableEditorView();
  if (!view) return;
  setTimeout(() => {
    action(view);
    view.focus();
  }, 0);
}

/** `tables.addRowBelow` -> `table.addRowBelow`, the key of `tableCommands`. */
export function tableCommandIdOf(paletteId: string): TableCommandId | null {
  const id = `table.${paletteId.replace(/^tables\./, "")}`;
  return id in tableCommands ? (id as TableCommandId) : null;
}

const SPECIAL: Record<string, () => void> = {
  "tables.insert": () =>
    onEditor(
      (view) =>
        void insertTableCommand()({ state: view.state, dispatch: (tr) => view.dispatch(tr) }),
    ),
  "tables.convert-selection": () =>
    onEditor((view) => {
      const ok = convertSelectionToTable({
        state: view.state,
        dispatch: (tr) => view.dispatch(tr),
      });
      if (!ok) showEditorNotice("The selection is not CSV, TSV or pipe-separated text");
    }),
  "tables.paste-as-table": () => {
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
};

/** Ids of every palette command this file can run: the contract test compares them with the manifest. */
export const TABLE_PALETTE_COMMAND_IDS: readonly string[] = [
  ...Object.keys(SPECIAL),
  ...Object.keys(tableCommands).map((id) => id.replace(/^table\./, "tables.")),
];

export function runTablePaletteCommand(paletteId: string): void {
  const special = SPECIAL[paletteId];
  if (special) return special();
  const id = tableCommandIdOf(paletteId);
  if (id) onEditor((view) => void runTableCommand(view, id));
}
