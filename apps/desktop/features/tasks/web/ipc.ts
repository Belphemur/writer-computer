// The typed client of the tasks commands. The wire types come from the generated `bindings.ts`
// (tauri-specta, Rust half in `../rust/`), so a field change in Rust is a type error here.
// Tests mock this module, so nothing else reaches the backend.
import type * as wire from "./bindings";
import { commands } from "./bindings";

export type TaskChange = wire.Change;
export type TaskFieldInput = wire.FieldInput;
export type TaskLineInfo = wire.LineInfo;
export type TaskSection = wire.Section;
export type ConvertedBlock = wire.Converted;

export const taskAdd = (text: string, fields: TaskFieldInput[], path: string | null = null) =>
  commands.taskAdd(text, fields, path);

export const taskLineInfo = (line: string) => commands.taskLineInfo(line);

export const taskLineSet = (line: string, edit: TaskFieldInput) => commands.taskLineSet(line, edit);

export const taskLineToggle = (line: string, today: string) => commands.taskLineToggle(line, today);

export const taskToggle = (path: string, line: number, expect: string | null, today: string) =>
  commands.taskToggle(path, line, expect, today);

export const tasksConvertBlock = (path: string, source: string, write: boolean) =>
  commands.tasksConvertBlock(path, source, write);

export const tasksSections = () => commands.tasksSections();
