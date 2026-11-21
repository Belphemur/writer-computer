// The typed client of the git commands (`plugin:git|*`, Rust half in `../rust/`). The wire types
// come from the generated `bindings.ts` (tauri-specta); this is the only importer of it and the
// only caller of `featureInvoke`. Tests mock this module.
import { featureInvoke } from "@/lib/features/ipc";
import manifest from "../feature.json";
import type * as wire from "./bindings";

export type GitStatus = wire.GitStatus;
export type ChangeRow = wire.ChangeRow;
export type SetupMode = wire.Setup;
export type VersionRow = wire.VersionRow;
export type DeletedRow = wire.DeletedRow;
export type FileDiff = wire.FileDiff;
export type Preview = wire.Preview;

/** The event Rust emits to the window after a commit, a setup or a pause change (`git:changed`;
 *  `ctx.listen` adds the feature prefix). */
export const GIT_CHANGED = "changed";

export interface GitCommands {
  git_status: { args: { refresh: boolean }; result: wire.GitStatus };
  git_setup: { args: { mode: wire.Setup }; result: wire.GitStatus };
  git_commit_now: { args: undefined; result: wire.GitStatus };
  git_set_paused: { args: { paused: boolean }; result: wire.GitStatus };
  git_stop: { args: undefined; result: wire.GitStatus };
  git_history: { args: { path: string; limit: number | null }; result: wire.VersionRow[] };
  git_deleted: { args: undefined; result: wire.DeletedRow[] };
  git_version_diff: {
    args: { path: string; rev: string; against: string | null };
    result: wire.FileDiff;
  };
  git_version_text: { args: { path: string; rev: string }; result: string | null };
  git_turn_commit: {
    args: { chat_id: string; turn_id: string; finished_at: number | null };
    result: wire.TurnCommitRow;
  };
  git_restore: { args: { path: string; rev: string }; result: wire.RestoredRow };
}

const call = featureInvoke<GitCommands>(manifest.id, manifest.rust.commands);

/** `refresh`: ask git for the commit identity again (the settings page does when it opens). */
export const status = (refresh = false) => call("git_status", { refresh });
export const setup = (mode: SetupMode) => call("git_setup", { mode });
export const commitNow = () => call("git_commit_now");
export const setPaused = (paused: boolean) => call("git_set_paused", { paused });
export const stop = () => call("git_stop");
export const history = (path: string, limit: number | null = null) =>
  call("git_history", { path, limit });
export const deleted = () => call("git_deleted");
/** `against`: `parent` (default), `current`, or another version's id. */
export const versionDiff = (path: string, rev: string, against: string | null = null) =>
  call("git_version_diff", { path, rev, against });
export const versionText = (path: string, rev: string) => call("git_version_text", { path, rev });
export const restore = (path: string, rev: string) => call("git_restore", { path, rev });
/** The commit of an agent turn (its `Writer-Chat` and `Writer-Turn` trailers); `finishedAt` in
 *  seconds, or `null` while unknown. */
export const turnCommit = (chatId: string, turnId: string, finishedAt: number | null) =>
  call("git_turn_commit", { chat_id: chatId, turn_id: turnId, finished_at: finishedAt });
