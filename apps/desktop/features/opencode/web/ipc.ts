// The typed client of the OpenCode commands (`plugin:opencode|*`, Rust half in `../rust/`). Every
// call goes through the generated `bindings.ts` (tauri-specta), which owns the route, the argument
// names and the types; this is its only importer. Tests mock this module.
import type * as wire from "./bindings";
import { commands } from "./bindings";

export type OpencodeModel = wire.OpencodeModel;
export type OpencodeStatus = wire.OpencodeStatus;
/** One provider tab: `off` when the user switched it off (an off provider is no longer listed by
 *  the server, so the row comes from the setting). */
export type ProviderRow = wire.ProviderRow;
/** Whether the user's own OpenCode config is loaded: `loaded`, or `skipped-mcp-policy` (their
 *  config sets an `mcp.use` policy, so this window's server runs on Writer's config alone). */
export type GlobalConfig = wire.GlobalConfig;
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
/** The provider tabs: the server's providers together with the switched-off ones (starts the
 *  window's server). */
export const providers = () => commands.opencodeProviders();
/** After a provider switch is written (`agent.opencode.disabled-providers`): the server renders its
 *  configuration again and reads it when no turn runs. */
export const reconfigure = () => commands.opencodeReconfigure();
