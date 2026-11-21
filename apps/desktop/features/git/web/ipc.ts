// The typed client of the git commands (`plugin:git|*`, Rust half in `../rust/`). The wire types
// come from the generated `bindings.ts` (tauri-specta); this is the only importer of it and the
// only caller of `featureInvoke`. Tests mock this module.
import { featureInvoke } from "@/lib/features/ipc";
import manifest from "../feature.json";
import type * as wire from "./bindings";

export type GitStatus = wire.GitStatus;
export type ChangeRow = wire.ChangeRow;
export type SetupMode = wire.Setup;

/** The event Rust emits to the window after a commit, a setup or a pause change (`git:changed`;
 *  `ctx.listen` adds the feature prefix). */
export const GIT_CHANGED = "changed";

export interface GitCommands {
  git_status: { args: { refresh: boolean }; result: wire.GitStatus };
  git_setup: { args: { mode: wire.Setup }; result: wire.GitStatus };
  git_commit_now: { args: undefined; result: wire.GitStatus };
  git_set_paused: { args: { paused: boolean }; result: wire.GitStatus };
}

const call = featureInvoke<GitCommands>(manifest.id, manifest.rust.commands);

/** `refresh`: ask git for the commit identity again (the settings page does when it opens). */
export const status = (refresh = false) => call("git_status", { refresh });
export const setup = (mode: SetupMode) => call("git_setup", { mode });
export const commitNow = () => call("git_commit_now");
export const setPaused = (paused: boolean) => call("git_set_paused", { paused });
