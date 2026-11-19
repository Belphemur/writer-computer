// The typed client of the tasks commands. The wire types come from the generated `bindings.ts`
// (tauri-specta, Rust half in `../rust/`), so a field change in Rust is a type error here.
// Tests mock this module, so nothing else reaches the backend.
import { featureInvoke } from "@/lib/features/ipc";
import manifest from "../feature.json";
import type * as wire from "./bindings";

export type TaskChange = wire.Change;
export type TaskFieldInput = wire.FieldInput;
export type TaskLineInfo = wire.LineInfo;
export type TaskSection = wire.Section;
export type ConvertedBlock = wire.Converted;

export interface TasksCommands {
  task_add: {
    args: { text: string; fields: TaskFieldInput[]; path: string | null };
    result: TaskChange;
  };
  task_line_info: { args: { line: string }; result: TaskLineInfo | null };
  task_line_set: { args: { line: string; edit: TaskFieldInput }; result: string };
  task_line_toggle: { args: { line: string; today: string }; result: string[] };
  task_set_field: {
    args: { path: string; line: number; expect: string | null; edit: TaskFieldInput };
    result: TaskChange;
  };
  task_toggle: {
    args: { path: string; line: number; expect: string | null; today: string };
    result: TaskChange;
  };
  tasks_convert_block: {
    args: { path: string; source: string; write: boolean };
    result: ConvertedBlock;
  };
  tasks_sections: { args: undefined; result: TaskSection[] };
}

const call = featureInvoke<TasksCommands>(manifest.id, manifest.rust.commands);

export const taskAdd = (text: string, fields: TaskFieldInput[], path: string | null = null) =>
  call("task_add", { text, fields, path });

export const taskLineInfo = (line: string) => call("task_line_info", { line });

export const taskLineSet = (line: string, edit: TaskFieldInput) =>
  call("task_line_set", { line, edit });

export const taskLineToggle = (line: string, today: string) =>
  call("task_line_toggle", { line, today });

export const taskToggle = (path: string, line: number, expect: string | null, today: string) =>
  call("task_toggle", { path, line, expect, today });

export const tasksConvertBlock = (path: string, source: string, write: boolean) =>
  call("tasks_convert_block", { path, source, write });

export const tasksSections = () => call("tasks_sections");
