// The git IPC: every wrapper of `ipc.ts` goes through the generated bindings, and
// `describeFeatureIpc` pins the route, the command set, the camelCase argument names (`linkExisting`,
// `chatId`, `finalPath`) and the value each argument carries (a distinct sentinel each, so two
// same-typed arguments swapped in a wrapper fail).
// @vitest-environment jsdom
import { describeFeatureIpc } from "@tests/helpers/feature-ipc";
import manifest from "../feature.json";
import * as ipc from "../web/ipc";

describeFeatureIpc({
  id: manifest.id,
  commands: manifest.rust.commands,
  calls: {
    git_status: { call: () => ipc.status(true), args: { refresh: true } },
    git_setup: { call: () => ipc.setup("local"), args: { mode: "local" } },
    git_commit_now: { call: () => ipc.commitNow(), args: {} },
    git_set_paused: { call: () => ipc.setPaused(true), args: { paused: true } },
    git_set_signing: { call: () => ipc.setSigning(true), args: { on: true } },
    git_stop: { call: () => ipc.stop(), args: {} },
    git_history: { call: () => ipc.history("p1", 5), args: { path: "p1", limit: 5 } },
    git_deleted: { call: () => ipc.deleted(), args: {} },
    git_version_diff: {
      call: () => ipc.versionDiff("p1", "r1", "a1"),
      args: { path: "p1", rev: "r1", against: "a1" },
    },
    git_version_text: { call: () => ipc.versionText("p1", "r1"), args: { path: "p1", rev: "r1" } },
    git_restore: { call: () => ipc.restore("p1", "r1"), args: { path: "p1", rev: "r1" } },
    git_turn_commit: {
      call: () => ipc.turnCommit("chat1", "turn1", 12),
      args: { chatId: "chat1", turnId: "turn1", finishedAt: 12 },
    },
    git_sync_now: { call: () => ipc.syncNow(), args: {} },
    git_set_sync_paused: { call: () => ipc.setSyncPaused(true), args: { paused: true } },
    git_remote_set: { call: () => ipc.setRemote("u1"), args: { url: "u1" } },
    git_remote_remove: { call: () => ipc.removeRemote(), args: {} },
    git_tools: { call: () => ipc.tools(), args: {} },
    git_install_git: { call: () => ipc.installGit(), args: {} },
    git_sign_in: {
      call: () => ipc.signIn("f1", "h1", "n1", true),
      args: { forge: "f1", host: "h1", name: "n1", linkExisting: true },
    },
    git_set_credentials: { call: () => ipc.setCredentials("s1"), args: { source: "s1" } },
    git_plugin_decision: {
      call: () => ipc.pluginDecision("pl1", "never"),
      args: { plugin: "pl1", choice: "never" },
    },
    git_dismiss_notices: { call: () => ipc.dismissNotices(), args: {} },
    git_merge_text: {
      call: () => ipc.mergeText("p1", "base1", "mine1", "theirs1"),
      args: { path: "p1", base: "base1", mine: "mine1", theirs: "theirs1" },
    },
    git_conflict_open: {
      call: () => ipc.conflictOpen("p1", "mine1"),
      args: { path: "p1", mine: "mine1" },
    },
    git_conflict_save: {
      call: () =>
        ipc.conflictSave("p1", { mine: "mine1", body: "body1", picks: [], finalPath: "fp1" }),
      args: { path: "p1", mine: "mine1", body: "body1", picks: [], finalPath: "fp1" },
    },
    git_conflict_take: {
      call: () => ipc.conflictTake("p1", "theirs"),
      args: { path: "p1", side: "theirs" },
    },
    git_conflict_record: {
      call: () => ipc.conflictRecord("p1", "base1", "mine1"),
      args: { path: "p1", base: "base1", mine: "mine1" },
    },
  },
});
