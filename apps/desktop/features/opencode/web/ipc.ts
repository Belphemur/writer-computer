// The typed client of the OpenCode commands (`plugin:opencode|*`, Rust half in `../rust/`). Every
// call goes through the generated `bindings.ts` (tauri-specta), which owns the route, the argument
// names and the types; this is its only importer. Tests mock this module.
import type * as wire from "./bindings";
import { commands } from "./bindings";

export type OpencodeModel = wire.OpencodeModel;
export type OpencodeStatus = wire.OpencodeStatus;
/** The saved rules and whether they are this vault's project's (false: the project is not known
 *  yet and the list is every project's, read-only). */
export type SavedRules = Awaited<ReturnType<typeof commands.opencodeSavedRules>>;
export type SavedRule = SavedRules["rules"][number];

/** Finds the program and its version; never starts a server. */
export const status = (binaryOverride: string | null) => commands.opencodeStatus(binaryOverride);
/** The server's models, live (starts the window's server: a few seconds the first time). */
export const models = () => commands.opencodeModels();
/** The "Always allow" rules saved in OpenCode for this vault's project. */
export const savedRules = () => commands.opencodeSavedRules();
export const removeSavedRule = (id: string) => commands.opencodeRemoveSavedRule(id);
