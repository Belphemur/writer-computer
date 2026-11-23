// The typed client of the Bases Rust half: every command goes through the generated `bindings.ts`
// (tauri-specta, rewritten by `WRITER_UPDATE_BINDINGS=1 cargo test bindings`), which owns the route
// (`plugin:bases|<command>`), the camelCase argument names and the types. This is its only
// importer. Components and hooks call the wrappers below (`baseQuery`, ...); tests mock this
// module, so nothing else reaches the backend.
//
// Two calls are not Bases commands but core ones the Bases UI needs: `index_properties` (the
// property pickers) and the `.base` write (`write_file`, the app's one file write path).
// `tests/bases-ipc.test.ts` pins every wrapper to the bindings and the manifest.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import * as tauri from "@/lib/tauri";
import { commands } from "./bindings";

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

export function baseList(): Promise<BaseFileEntry[]> {
  return commands.baseList();
}

/** `document` is the parsed `Document` the Rust side serializes (`unknown` on the wire); the
 *  view model it follows is `BaseDocument` in `lib/types.ts`. */
export async function baseRead(path: string): Promise<BaseReadResult> {
  const r = await commands.baseRead(path);
  return { ...r, document: r.document as BaseDocument | null };
}

/** Parse `.base` text that is not a file (an embedded ```base block). Never rejects for bad YAML. */
export async function baseParseText(text: string): Promise<BaseParsedResult> {
  const r = await commands.baseParseText(text);
  return { ...r, document: r.document as BaseDocument | null };
}

export function baseQuery(args: BaseQueryArgs): Promise<BaseQueryResult> {
  return commands.baseQuery(
    args.path,
    args.view ?? null,
    args.thisPath ?? null,
    args.nowOffsetMinutes ?? null,
  );
}

export function baseQueryText(args: BaseQueryTextArgs): Promise<BaseQueryResult> {
  return commands.baseQueryText(
    args.text,
    args.view ?? null,
    args.thisPath ?? null,
    args.nowOffsetMinutes ?? null,
  );
}

export function noteProperties(path: string): Promise<NoteProperties> {
  return commands.noteProperties(path);
}

export async function notePropertySet(args: NotePropertySetArgs): Promise<void> {
  await commands.notePropertySet(args.path, args.name, args.value, args.valueType ?? null);
}

export async function notePropertyRemove(args: NotePropertyRemoveArgs): Promise<void> {
  await commands.notePropertyRemove(args.path, args.name);
}

/** Subscribe to the vault index's change batches. Resolves to the unsubscribe function. */
export function onIndexChanged(handler: (event: IndexChangedEvent) => void): Promise<UnlistenFn> {
  return listen<IndexChangedEvent>("index://changed", (event) => handler(event.payload));
}

/** Evaluate one expression with `thisPath` as the current row and `this`. */
export function baseEval(args: BaseEvalArgs): Promise<Cell> {
  return commands.baseEval(
    args.expression,
    args.thisPath,
    args.nowOffsetMinutes ?? null,
    args.text ?? null,
  );
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
  return commands.baseFunctions();
}
