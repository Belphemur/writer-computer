// The typed client of the Dataview Rust half: every command goes through the generated `bindings.ts`
// (tauri-specta, rewritten by `WRITER_UPDATE_BINDINGS=1 cargo test bindings`), which owns the route,
// the camelCase argument names and the types. This is its only importer. Tests mock this module.
import { commands } from "./bindings";

export type { DqlLine, DqlLowered, DqlUnmapped } from "./bindings";

/** A query as the live `.base` text a block renders, plus whether and why it can convert. */
export function dqlLower(text: string) {
  return commands.dqlLower(text);
}

/** Write the query as a plain `.base` beside the note; resolves to its vault-relative path. */
export function dqlConvert(text: string, notePath: string): Promise<string> {
  return commands.dqlConvert(text, notePath);
}
