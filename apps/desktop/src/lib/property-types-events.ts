// The backend's notice that it changed the property type record on its own (an enum gained the
// values the notes hold, `commands/index.rs`): the property type store reloads on it.
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export function onPropertyTypesChanged(handler: () => void): Promise<UnlistenFn> {
  return listen("property-types://changed", () => handler());
}
