// The typed client of the git commands (`plugin:git|*`, Rust half in `../rust/`). Every call goes
// through the generated `bindings.ts` (tauri-specta), which owns the route, the argument names
// (camelCase, as Tauri reads them) and the types, so a key cannot drift from the Rust command; this
// is its only importer. Tests mock this module.
import type * as wire from "./bindings";
import { commands } from "./bindings";

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

/** `refresh`: ask git for the commit identity again (the settings page does when it opens). */
export const status = (refresh = false) => commands.gitStatus(refresh);
export const setup = (mode: SetupMode) => commands.gitSetup(mode);
export const commitNow = () => commands.gitCommitNow();
export const setPaused = (paused: boolean) => commands.gitSetPaused(paused);
export const stop = () => commands.gitStop();
export const history = (path: string, limit: number | null = null) =>
  commands.gitHistory(path, limit);
export const deleted = () => commands.gitDeleted();
/** `against`: `parent` (default), `current`, or another version's id. */
export const versionDiff = (path: string, rev: string, against: string | null = null) =>
  commands.gitVersionDiff(path, rev, against);
export const versionText = (path: string, rev: string) => commands.gitVersionText(path, rev);
export const restore = (path: string, rev: string) => commands.gitRestore(path, rev);
/** The commit of an agent turn (its `Writer-Chat` and `Writer-Turn` trailers); `finishedAt` in
 *  seconds, or `null` while unknown. */
export const turnCommit = (chatId: string, turnId: string, finishedAt: number | null) =>
  commands.gitTurnCommit(chatId, turnId, finishedAt);

export const syncNow = () => commands.gitSyncNow();
export const setSyncPaused = (paused: boolean) => commands.gitSetSyncPaused(paused);
export const setRemote = (url: string) => commands.gitRemoteSet(url);
export const removeRemote = () => commands.gitRemoteRemove();
export const tools = () => commands.gitTools();
export const installGit = () => commands.gitInstallGit();
/** The one sign-in action (remote, credential, first push). `forge`: a CLI's id from
 *  `tools().forges`; `host` for one signed in to several; `name` and `linkExisting` after a
 *  taken name. */
export const signIn = (
  forge: string,
  host: string | null = null,
  name: string | null = null,
  linkExisting = false,
) => commands.gitSignIn(forge, host, name, linkExisting);
/** `token` (the secret) or a forge CLI's id (`gh`, `fj`) as the source of HTTPS passwords. */
export const setCredentials = (source: string) => commands.gitSetCredentials(source);
/** `allow`: Sync anyway. `never`: Never sync this plugin. */
export const pluginDecision = (plugin: string, choice: "allow" | "never") =>
  commands.gitPluginDecision(plugin, choice);
export const dismissNotices = () => commands.gitDismissNotices();
/** The merge of an open note's text three ways (`text` is `null` when the two sides overlap). */
export const mergeText = async (path: string, base: string, mine: string, theirs: string) =>
  (await commands.gitMergeText(path, base, mine, theirs)).text;

/** The merge view's pieces for a conflicted file (`path` vault-relative or absolute). `mine` is the
 *  editor's buffer when the note is open; without it the file is read. Writes nothing. */
export const conflictOpen = (path: string, mine: string | null = null) =>
  commands.gitConflictOpen(path, mine);
/** "Save": the result column, the side taken for each conflicting property and the path kept after
 *  a rename. Committed as `user(merge)`; the sync resumes. */
export const conflictSave = (
  path: string,
  view: { mine: string; body: string; picks: wire.PickRow[]; finalPath: string | null },
) => commands.gitConflictSave(path, view.mine, view.body, view.picks, view.finalPath);
/** Settles a whole file: `mine`, `theirs`, or `both` (a binary keeps its conflict copy). */
export const conflictTake = (path: string, side: "mine" | "theirs" | "both") =>
  commands.gitConflictTake(path, side);
/** An open note's unsaved text overlaps what a sync wrote: record the conflict (`base` the text
 *  last saved) and write `mine` as the user's version on disk. */
export const conflictRecord = (path: string, base: string, mine: string) =>
  commands.gitConflictRecord(path, base, mine);
