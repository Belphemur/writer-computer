// The typed client of the Bases Rust half: every command goes through `featureInvoke` (route
// `plugin:bases|<command>`, manifest guard). This is the ONLY module that imports the generated
// `bindings.ts` (tauri-specta, rewritten by `WRITER_UPDATE_BINDINGS=1 cargo test bindings`), and
// only for types, so the generated runtime stays out of the app. Components and hooks call the
// wrappers below (`baseQuery`, ...); tests mock this module, so nothing else reaches the backend.
//
// Two calls are not Bases commands but core ones the Bases UI needs: `index_properties` (the
// property pickers) and the `.base` write (`write_file`, the app's one file write path).
// `tests/bases-ipc.test.ts` ties the manifest's command list, the generated bindings and the
// wrappers together.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { featureInvoke } from "@/lib/features/ipc";
import * as tauri from "@/lib/tauri";
import manifest from "../feature.json";
import type { commands } from "./bindings";

// The generated wire types, named once for the rest of the web half (`lib/types.ts` re-exports
// them): this file is the only importer of `bindings.ts`.
export type {
  BaseListEntry,
  BaseQueryResult,
  CellValueWire,
  CellWire,
  Column,
  FunctionInfo,
  Group,
  NoteProperties,
  QueryError,
  QueryErrorKind,
  Row,
  ViewInfo,
} from "./bindings";
import type {
  BaseDocument,
  BaseEvalArgs,
  BaseFileEntry,
  BaseFunctionInfo,
  BaseParsedResult,
  BaseQueryArgs,
  BaseQueryResult,
  BaseQueryTextArgs,
  BaseReadResult,
  Cell,
  IndexChangedEvent,
  NoteProperties,
  NotePropertyRemoveArgs,
  NotePropertySetArgs,
  VaultProperty,
} from "./lib/types";

type Gen = typeof commands;
type Camel<S extends string> = S extends `${infer A}_${infer B}`
  ? `${A}${Capitalize<Camel<B>>}`
  : S;
/** Result of a command, from the generated function of the same name. */
type Ret<K extends string> = Awaited<ReturnType<Gen[Camel<K> & keyof Gen]>>;
type Command<K extends string, A extends object | undefined> = { args: A; result: Ret<K> };

/** A Rust `Option<T>` argument: may be left out or null. */
type Opt<T> = T | null | undefined;

export interface BasesCommands {
  base_list: Command<"base_list", undefined>;
  base_read: Command<"base_read", { path: string }>;
  base_parse_text: Command<"base_parse_text", { text: string }>;
  base_functions: Command<"base_functions", undefined>;
  base_query: Command<
    "base_query",
    {
      path: string;
      view?: Opt<string>;
      thisPath?: Opt<string>;
      nowOffsetMinutes?: Opt<number>;
    }
  >;
  base_query_text: Command<
    "base_query_text",
    { text: string; view?: Opt<string>; thisPath?: Opt<string>; nowOffsetMinutes?: Opt<number> }
  >;
  base_eval: Command<
    "base_eval",
    { expression: string; thisPath: string; nowOffsetMinutes?: Opt<number>; text?: Opt<string> }
  >;
  note_properties: Command<"note_properties", { path: string }>;
  note_property_set: Command<
    "note_property_set",
    { path: string; name: string; value: unknown; valueType?: Opt<string> }
  >;
  note_property_remove: Command<"note_property_remove", { path: string; name: string }>;
}

/** `basesCommand("base_query", { ... })` -> `invoke("plugin:bases|base_query", ...)`. */
export const basesCommand = featureInvoke<BasesCommands>(manifest.id, manifest.rust.commands);

export function baseList(): Promise<BaseFileEntry[]> {
  return basesCommand("base_list");
}

/** `document` is the parsed `Document` the Rust side serializes (`unknown` on the wire); the
 *  view model it follows is `BaseDocument` in `lib/types.ts`. */
export async function baseRead(path: string): Promise<BaseReadResult> {
  const r = await basesCommand("base_read", { path });
  return { ...r, document: r.document as BaseDocument | null };
}

/** Parse `.base` text that is not a file (an embedded ```base block). Never rejects for bad YAML. */
export async function baseParseText(text: string): Promise<BaseParsedResult> {
  const r = await basesCommand("base_parse_text", { text });
  return { ...r, document: r.document as BaseDocument | null };
}

export function baseQuery(args: BaseQueryArgs): Promise<BaseQueryResult> {
  return basesCommand("base_query", { ...args });
}

export function baseQueryText(args: BaseQueryTextArgs): Promise<BaseQueryResult> {
  return basesCommand("base_query_text", { ...args });
}

export function noteProperties(path: string): Promise<NoteProperties> {
  return basesCommand("note_properties", { path });
}

export async function notePropertySet(args: NotePropertySetArgs): Promise<void> {
  await basesCommand("note_property_set", { ...args });
}

export async function notePropertyRemove(args: NotePropertyRemoveArgs): Promise<void> {
  await basesCommand("note_property_remove", { ...args });
}

/** Subscribe to the vault index's change batches. Resolves to the unsubscribe function. */
export function onIndexChanged(handler: (event: IndexChangedEvent) => void): Promise<UnlistenFn> {
  return listen<IndexChangedEvent>("index://changed", (event) => handler(event.payload));
}

/** Evaluate one expression with `thisPath` as the current row and `this`. */
export function baseEval(args: BaseEvalArgs): Promise<Cell> {
  return basesCommand("base_eval", { ...args });
}

/** Every frontmatter property of the vault, for the property pickers (a core command). */
export function indexProperties(): Promise<VaultProperty[]> {
  return invoke("index_properties");
}

/**
 * Write the raw text of a `.base` (the app's one file write path: atomic, recorded as the app's
 * own write so the watcher does not report it back as an external change).
 */
export function baseWriteText(path: string, content: string): Promise<unknown> {
  return tauri.writeFile(path, content);
}

/** The engine's function registry, for the expression editor's completion. */
export function baseFunctions(): Promise<BaseFunctionInfo[]> {
  return basesCommand("base_functions");
}
