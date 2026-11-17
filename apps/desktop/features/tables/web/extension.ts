// Everything the editor needs for tables, loaded as one chunk by `index.ts`.
import type { Extension } from "@codemirror/state";
import { tableDecorations } from "./table-decorations";
import { tableEditing } from "./table-editing";

export function tableExtension(): Extension {
  return [tableDecorations(), tableEditing()];
}
