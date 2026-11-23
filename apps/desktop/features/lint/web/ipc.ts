// The typed client of the lint commands (`plugin:lint|*`, Rust half in `../rust/`). The wire types
// come from the generated `bindings.ts` (tauri-specta), so a field change in Rust is a type error
// here; it owns the route and the argument names, and this is its only importer. Tests mock this
// module, so nothing else reaches the backend.
import type * as wire from "./bindings";
import { commands } from "./bindings";

export type Finding = wire.Finding;
export type Edit = wire.Edit;
export type Fixed = wire.Fixed;
export type KeepRange = wire.KeepRange;
export type FixScope = wire.FixRequest["scope"];

/** Lints a note's text with the rules that are on; findings are UTF-16 offsets into `text`. */
export async function check(text: string): Promise<Finding[]> {
  return (await commands.lintCheck({ text })).findings;
}

/** Fixes a note's text; `edits` turn `text` into `fixed.text` (UTF-16 offsets of `text`). A fix
 *  that would touch a `keep` range (UTF-16 offsets of `text`) is dropped whole. */
export function fix(
  text: string,
  scope: FixScope,
  keep: readonly KeepRange[] = [],
): Promise<Fixed> {
  return commands.lintFix({ text, scope, keep: [...keep] });
}
