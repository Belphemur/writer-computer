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
export type Tools = wire.Tools;
export type ForgeRow = wire.ForgeRow;
export type SignInResult = wire.SignInResult;
export type StepRow = wire.StepRow;
export type SyncErrorRow = wire.SyncErrorRow;
export type ConflictView = wire.ConflictViewRow;
export type ConflictPart = wire.PartRow;
export type PropertyConflict = wire.PropertyRow;
export type ConflictRow = wire.ConflictRow;

/** The event Rust emits to the window after a commit, a setup or a pause change (`git:changed`;
 *  `ctx.listen` adds the feature prefix). */
export const GIT_CHANGED = "changed";
/** The event Rust emits before a sync (or a resolution) writes files into the vault, and again
 *  when it is done (`git:applying`, vault-relative paths): the editors that have them open hold
 *  their saves, then apply what was written. */
export const GIT_APPLYING = "applying";
/** Twin of `runtime::Applying` (Rust): `done: false` before the writes (`paths` about to be
 *  written), `done: true` after (`paths` written). */
export interface ApplyingPayload {
  paths: string[];
  done: boolean;
}

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
  git_sync_now: { args: undefined; result: wire.GitStatus };
  git_set_sync_paused: { args: { paused: boolean }; result: wire.GitStatus };
  git_remote_set: { args: { url: string }; result: wire.GitStatus };
  git_remote_remove: { args: undefined; result: wire.GitStatus };
  git_tools: { args: undefined; result: wire.Tools };
  git_install_git: { args: undefined; result: null };
  git_sign_in: {
    args: { forge: string; host: string | null; name: string | null; link_existing: boolean };
    result: wire.SignInResult;
  };
  git_set_credentials: { args: { source: string }; result: wire.GitStatus };
  git_plugin_decision: { args: { plugin: string; choice: string }; result: wire.GitStatus };
  git_dismiss_notices: { args: undefined; result: wire.GitStatus };
  git_merge_text: {
    args: { path: string; base: string; mine: string; theirs: string };
    result: wire.MergedText;
  };
  git_conflict_open: {
    args: { path: string; mine: string | null };
    result: wire.ConflictViewRow;
  };
  git_conflict_save: {
    args: {
      path: string;
      mine: string;
      body: string;
      picks: wire.PickRow[];
      final_path: string | null;
    };
    result: wire.GitStatus;
  };
  git_conflict_take: { args: { path: string; side: string }; result: wire.GitStatus };
  git_conflict_record: {
    args: { path: string; base: string; mine: string };
    result: wire.GitStatus;
  };
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

export const syncNow = () => call("git_sync_now");
export const setSyncPaused = (paused: boolean) => call("git_set_sync_paused", { paused });
export const setRemote = (url: string) => call("git_remote_set", { url });
export const removeRemote = () => call("git_remote_remove");
export const tools = () => call("git_tools");
export const installGit = () => call("git_install_git");
/** The one sign-in action (remote, credential, first push). `forge`: a CLI's id from
 *  `tools().forges`; `host` for one signed in to several; `name` and `linkExisting` after a
 *  taken name. */
export const signIn = (
  forge: string,
  host: string | null = null,
  name: string | null = null,
  linkExisting = false,
) => call("git_sign_in", { forge, host, name, link_existing: linkExisting });
/** `token` (the secret) or a forge CLI's id (`gh`, `fj`) as the source of HTTPS passwords. */
export const setCredentials = (source: string) => call("git_set_credentials", { source });
/** `allow`: Sync anyway. `never`: Never sync this plugin. */
export const pluginDecision = (plugin: string, choice: "allow" | "never") =>
  call("git_plugin_decision", { plugin, choice });
export const dismissNotices = () => call("git_dismiss_notices");
/** The merge of an open note's text three ways (`text` is `null` when the two sides overlap). */
export const mergeText = async (path: string, base: string, mine: string, theirs: string) =>
  (await call("git_merge_text", { path, base, mine, theirs })).text;

/** The merge view's pieces for a conflicted file (`path` vault-relative or absolute). `mine` is the
 *  editor's buffer when the note is open; without it the file is read. Writes nothing. */
export const conflictOpen = (path: string, mine: string | null = null) =>
  call("git_conflict_open", { path, mine });
/** "Save": the result column, the side taken for each conflicting property and the path kept after
 *  a rename. Committed as `user(merge)`; the sync resumes. */
export const conflictSave = (
  path: string,
  view: { mine: string; body: string; picks: wire.PickRow[]; finalPath: string | null },
) =>
  call("git_conflict_save", {
    path,
    mine: view.mine,
    body: view.body,
    picks: view.picks,
    final_path: view.finalPath,
  });
/** Settles a whole file: `mine`, `theirs`, or `both` (a binary keeps its conflict copy). */
export const conflictTake = (path: string, side: "mine" | "theirs" | "both") =>
  call("git_conflict_take", { path, side });
/** An open note's unsaved text overlaps what a sync wrote: record the conflict (`base` the text
 *  last saved) and write `mine` as the user's version on disk. */
export const conflictRecord = (path: string, base: string, mine: string) =>
  call("git_conflict_record", { path, base, mine });
