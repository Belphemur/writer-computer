// The two dialogs of the feature are overlays mounted at the app root; commands and the editor
// open them by setting this state (the same shape as the agent's dialogs).
import { create } from "zustand";
import type { EditorView } from "@codemirror/view";

/** The task line the edit dialog works on: where it is in which editor, and its text then. */
export interface EditTarget {
  view: EditorView;
  from: number;
  text: string;
}

interface TasksUi {
  quickAdd: boolean;
  edit: EditTarget | null;
  openQuickAdd: () => void;
  closeQuickAdd: () => void;
  openEdit: (target: EditTarget) => void;
  closeEdit: () => void;
}

export const useTasksUi = create<TasksUi>((set) => ({
  quickAdd: false,
  edit: null,
  openQuickAdd: () => set({ quickAdd: true }),
  closeQuickAdd: () => set({ quickAdd: false }),
  openEdit: (edit) => set({ edit }),
  closeEdit: () => set({ edit: null }),
}));
