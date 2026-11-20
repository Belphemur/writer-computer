// The typed client of the lint commands (`plugin:lint|*`, Rust half in `../rust/`). The wire types
// come from the generated `bindings.ts` (tauri-specta), so a field change in Rust is a type error
// here; this is the only importer of it and the only caller of `featureInvoke`. Tests mock this
// module, so nothing else reaches the backend.
import { featureInvoke } from "@/lib/features/ipc";
import manifest from "../feature.json";
import type * as wire from "./bindings";

export type Finding = wire.Finding;
export type Edit = wire.Edit;
export type Fixed = wire.Fixed;
export type FixScope = wire.FixRequest["scope"];

export interface LintCommands {
  lint_check: { args: { request: wire.CheckRequest }; result: wire.CheckResponse };
  lint_fix: { args: { request: wire.FixRequest }; result: wire.Fixed };
}

const call = featureInvoke<LintCommands>(manifest.id, manifest.rust.commands);

/** Lints a note's text with the rules that are on; findings are UTF-16 offsets into `text`. */
export async function check(text: string): Promise<Finding[]> {
  return (await call("lint_check", { request: { text } })).findings;
}

/** Fixes a note's text; `edits` turn `text` into `fixed.text` (UTF-16 offsets of `text`). */
export function fix(text: string, scope: FixScope): Promise<Fixed> {
  return call("lint_fix", { request: { text, scope } });
}
