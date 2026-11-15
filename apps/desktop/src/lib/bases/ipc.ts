// Typed `invoke` wrappers for the Bases backend, in the style of `lib/tauri.ts`.
// Tests mock this module (`vi.mock("../src/lib/bases/ipc")`), so components and
// hooks reach the backend only through these functions.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  BaseEvalArgs,
  BaseFileEntry,
  BaseQueryArgs,
  BaseQueryResult,
  Cell,
  BaseQueryTextArgs,
  BaseParsedResult,
  BaseReadResult,
  IndexChangedEvent,
  NoteProperties,
  NotePropertyRemoveArgs,
  NotePropertySetArgs,
  VaultProperty,
} from "./types";

export function baseList(): Promise<BaseFileEntry[]> {
  return invoke("base_list");
}

export function baseRead(path: string): Promise<BaseReadResult> {
  return invoke("base_read", { path });
}

/** Parse `.base` text that is not a file (an embedded ```base block). Never rejects for bad YAML. */
export function baseParseText(text: string): Promise<BaseParsedResult> {
  return invoke("base_parse_text", { text });
}

export function baseQuery(args: BaseQueryArgs): Promise<BaseQueryResult> {
  return invoke("base_query", { ...args });
}

export function baseQueryText(args: BaseQueryTextArgs): Promise<BaseQueryResult> {
  return invoke("base_query_text", { ...args });
}

export function noteProperties(path: string): Promise<NoteProperties> {
  return invoke("note_properties", { path });
}

export function notePropertySet(args: NotePropertySetArgs): Promise<void> {
  return invoke("note_property_set", { ...args });
}

export function notePropertyRemove(args: NotePropertyRemoveArgs): Promise<void> {
  return invoke("note_property_remove", { ...args });
}

/** Subscribe to the vault index's change batches. Resolves to the unsubscribe function. */
export function onIndexChanged(handler: (event: IndexChangedEvent) => void): Promise<UnlistenFn> {
  return listen<IndexChangedEvent>("index://changed", (event) => handler(event.payload));
}

/** Evaluate one expression with `thisPath` as the current row and `this`. */
export function baseEval(args: BaseEvalArgs): Promise<Cell> {
  return invoke("base_eval", { ...args });
}

/** Every frontmatter property of the vault, for the property pickers. */
export function indexProperties(): Promise<VaultProperty[]> {
  return invoke("index_properties");
}

/**
 * Write the raw text of a `.base` (the app's one file write path: atomic, recorded as the app's
 * own write so the watcher does not report it back as an external change).
 */
export function baseWriteText(path: string, content: string): Promise<unknown> {
  return invoke("write_file", { path, content });
}
