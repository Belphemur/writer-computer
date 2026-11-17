import { createContext, useContext } from "react";
import type { useBaseEdits } from "./use-base-edits";

export type BaseEdits = ReturnType<typeof useBaseEdits>;

/** The cell-edit pipeline of the open base tab, for the views that edit cells (the table). */
export const BaseEditsContext = createContext<BaseEdits | null>(null);

export function useBaseEditsContext(): BaseEdits {
  const edits = useContext(BaseEditsContext);
  if (!edits) throw new Error("BaseEditsContext is missing: a base view rendered outside BaseView");
  return edits;
}
