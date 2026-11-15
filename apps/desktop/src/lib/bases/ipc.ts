// Typed `invoke` wrappers for the Bases backend, in the style of `lib/tauri.ts`.
// Tests mock this module (`vi.mock("../src/lib/bases/ipc")`), so components and
// hooks reach the backend only through these functions.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  BaseFileEntry,
  BaseQueryArgs,
  BaseQueryResult,
  BaseQueryTextArgs,
  BaseReadResult,
  IndexChangedEvent,
  NoteProperties,
  NotePropertyRemoveArgs,
  NotePropertySetArgs,
} from "./types";

export function baseList(): Promise<BaseFileEntry[]> {
  return invoke("base_list");
}

export function baseRead(path: string): Promise<BaseReadResult> {
  return invoke("base_read", { path });
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
