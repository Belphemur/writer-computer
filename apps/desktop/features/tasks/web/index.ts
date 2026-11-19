// The Tasks feature (SPECs/tasks-spec.md): task lines with dates, priorities and recurrence, the
// Tasks page, quick add, the edit dialog, "Convert to Base" for ```tasks blocks, and the
// `tasks.rows` service Bases uses to toggle a task row. This file is loaded at startup, so it
// imports only `defineFeature`, the manifest and `import()` thunks; the dialogs, the page and the
// actions load on first use. The grammar and every write are Rust's (`src-tauri/src/tasks/`).
//
// The page kind `tasks` is core's (the `Location` union is closed); off, its tab shows the "turned
// off" page, task lines keep core's plain checkbox, and `getService("tasks.rows")` is empty (a
// task row's checkbox in a base is then read-only).
import { TASKS_ICON } from "@/components/editor-area/page-kinds/tasks";
import { openTasksTab } from "@/hooks/editor-api";
import { defineFeature } from "@/lib/features/registry";
import manifest from "../feature.json";
import { TASKS_ROWS, type TasksRowsService } from "./api";
import { taskToggle } from "./ipc";
import { localToday } from "./lib/today";

const hasWorkspace = (c: { hasWorkspace: boolean; isCompactFileMode: boolean }) =>
  c.hasWorkspace && !c.isCompactFileMode;
const hasNote = (c: {
  hasWorkspace: boolean;
  isCompactFileMode: boolean;
  activeFilePath: string | null;
}) => hasWorkspace(c) && c.activeFilePath !== null;

const actions = () => import("./actions");

const rowsService: TasksRowsService = {
  toggle: ({ path, line, expect }) => taskToggle(path, line, expect ?? null, localToday()),
};

const RUN: Record<string, () => void> = {
  "tasks.open": () => openTasksTab(),
  "tasks.add": () => void actions().then((m) => m.openQuickAdd()),
  "tasks.toggle": () => void actions().then((m) => m.toggleTaskAtCaret()),
  "tasks.edit": () => void actions().then((m) => m.editTaskAtCaret()),
  "tasks.convert-block": () =>
    void actions().then(async (m) => {
      const { findEditorView } = await import("@/lib/editor-views");
      const { getActiveFilePath } = await import("@/hooks/editor-api");
      const view = findEditorView(getActiveFilePath());
      if (view) await m.convertTasksBlock(view);
    }),
};

export default defineFeature({
  id: manifest.id,
  contributes: {
    commands: manifest.contributes.commands.map((c) => ({
      id: c.id,
      label: c.label,
      description: c.description,
      when: c.id === "tasks.open" || c.id === "tasks.add" ? hasWorkspace : hasNote,
      run: () => RUN[c.id]!(),
    })),
    sidebarActions: [
      {
        id: "tasks.open-action",
        label: "Open tasks",
        icon: TASKS_ICON,
        order: 65,
        run: () => openTasksTab(),
      },
    ],
    overlays: [
      {
        id: "tasks.quick-add",
        load: () => import("./components/quick-add").then((m) => m.QuickAdd),
      },
      {
        id: "tasks.edit-dialog",
        load: () => import("./components/edit-dialog").then((m) => m.EditDialog),
      },
    ],
    menus: {
      "editor-body": [
        {
          id: "tasks.editor-menu",
          items: async (view, event) => {
            const m = await actions();
            const pos =
              view.posAtCoords({ x: event.clientX, y: event.clientY }) ??
              view.state.selection.main.head;
            if (!m.hasTasksBlockAt(view, pos)) return [];
            return [
              {
                kind: "item",
                id: "tasks-convert-block",
                text: "Convert to Base",
                action: () => void m.convertTasksBlock(view, pos),
              },
            ];
          },
        },
      ],
    },
    editorExtensions: [
      { id: "tasks.editor", load: () => import("./editor").then((m) => m.tasksEditor()) },
    ],
    slots: [
      {
        id: "tasks.page",
        slot: "page-view:tasks",
        load: () => import("./components/tasks-page").then((m) => m.TasksPage),
      },
    ],
    services: [{ id: TASKS_ROWS, service: rowsService }],
  },
});
