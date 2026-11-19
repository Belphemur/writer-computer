import { CheckListIcon } from "@hugeicons/core-free-icons";
import { definePageKind } from "./types";

/** The Tasks page's icon: the tab, the sidebar action and the palette show this one. */
export const TASKS_ICON = CheckListIcon;

/**
 * The Tasks page (SPECs/tasks-spec.md): sections of tasks over the whole vault. It has no state
 * of its own and claims no path. The view is the `tasks` feature's, registered in `./views`; off,
 * the tab shows the "turned off" page.
 */
export type TasksLocation = { kind: "tasks" };

export const tasksKind = definePageKind<"tasks", TasksLocation>({
  kind: "tasks",
  title: () => "Tasks",
  description: "Tasks across your notes",
  icon: TASKS_ICON,
  keepAlive: true,
  loadsDocument: false,
  feature: "tasks",
});
