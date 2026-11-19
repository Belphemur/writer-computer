// The typed client of the Dataview Rust half: every command goes through `featureInvoke` (route
// `plugin:dataview|<command>`, manifest guard). This is the ONLY module that imports the generated
// `bindings.ts` (tauri-specta, rewritten by `WRITER_UPDATE_BINDINGS=1 cargo test bindings`), and
// only for types. Tests mock this module, so nothing else reaches the backend.
import { featureInvoke } from "@/lib/features/ipc";
import manifest from "../feature.json";
import type { commands } from "./bindings";

export type { DqlLine, DqlLowered, DqlUnmapped } from "./bindings";

type Gen = typeof commands;
type Camel<S extends string> = S extends `${infer A}_${infer B}`
  ? `${A}${Capitalize<Camel<B>>}`
  : S;
type Ret<K extends string> = Awaited<ReturnType<Gen[Camel<K> & keyof Gen]>>;

interface DataviewCommands {
  dql_lower: { args: { text: string }; result: Ret<"dql_lower"> };
  dql_convert: { args: { text: string; notePath: string }; result: Ret<"dql_convert"> };
}

const call = featureInvoke<DataviewCommands>(manifest.id, manifest.rust.commands);

/** A query as the live `.base` text a block renders, plus whether and why it can convert. */
export function dqlLower(text: string) {
  return call("dql_lower", { text });
}

/** Write the query as a plain `.base` beside the note; resolves to its vault-relative path. */
export function dqlConvert(text: string, notePath: string): Promise<string> {
  return call("dql_convert", { text, notePath });
}
