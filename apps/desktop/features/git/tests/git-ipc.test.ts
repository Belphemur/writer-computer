// The git IPC: every wrapper of `ipc.ts` goes through the generated bindings (`describeFeatureIpc`
// pins the route, the command set and the camelCase argument names: `linkExisting`, `chatId`,
// `finalPath`), and the multi-word arguments are spelled out here as the cases that were broken.
// @vitest-environment jsdom
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { describeFeatureIpc } from "@tests/helpers/feature-ipc";
import { afterEach, describe, expect, it } from "vite-plus/test";
import manifest from "../feature.json";
import * as ipc from "../web/ipc";

afterEach(() => clearMocks());

describeFeatureIpc({
  id: manifest.id,
  commands: manifest.rust.commands,
  calls: {
    git_status: () => ipc.status(true),
    git_setup: () => ipc.setup("local"),
    git_commit_now: () => ipc.commitNow(),
    git_set_paused: () => ipc.setPaused(true),
    git_set_signing: () => ipc.setSigning(true),
    git_stop: () => ipc.stop(),
    git_history: () => ipc.history("a.md", 5),
    git_deleted: () => ipc.deleted(),
    git_version_diff: () => ipc.versionDiff("a.md", "abc", "current"),
    git_version_text: () => ipc.versionText("a.md", "abc"),
    git_restore: () => ipc.restore("a.md", "abc"),
    git_turn_commit: () => ipc.turnCommit("chat", "turn", 12),
    git_sync_now: () => ipc.syncNow(),
    git_set_sync_paused: () => ipc.setSyncPaused(true),
    git_remote_set: () => ipc.setRemote("https://x/y.git"),
    git_remote_remove: () => ipc.removeRemote(),
    git_tools: () => ipc.tools(),
    git_install_git: () => ipc.installGit(),
    git_sign_in: () => ipc.signIn("fj", "codeberg.org", "Notes", true),
    git_set_credentials: () => ipc.setCredentials("fj"),
    git_plugin_decision: () => ipc.pluginDecision("p", "allow"),
    git_dismiss_notices: () => ipc.dismissNotices(),
    git_merge_text: () => ipc.mergeText("a.md", "b", "m", "t"),
    git_conflict_open: () => ipc.conflictOpen("a.md", "mine"),
    git_conflict_save: () =>
      ipc.conflictSave("a.md", { mine: "m", body: "b", picks: [], finalPath: "b.md" }),
    git_conflict_take: () => ipc.conflictTake("a.md", "mine"),
    git_conflict_record: () => ipc.conflictRecord("a.md", "b", "m"),
  },
});

describe("the multi-word arguments", () => {
  it("send the multi-word arguments in camelCase", async () => {
    const seen: Record<string, Record<string, unknown>> = {};
    mockIPC((cmd, args) => {
      seen[cmd] = args as Record<string, unknown>;
      return null;
    });
    await ipc.signIn("fj", "codeberg.org", "Notes", true).catch(() => {});
    await ipc.turnCommit("c", "t", 3).catch(() => {});
    await ipc
      .conflictSave("a.md", { mine: "m", body: "b", picks: [], finalPath: "b.md" })
      .catch(() => {});
    expect(seen["plugin:git|git_sign_in"]).toEqual({
      forge: "fj",
      host: "codeberg.org",
      name: "Notes",
      linkExisting: true,
    });
    expect(seen["plugin:git|git_turn_commit"]).toEqual({
      chatId: "c",
      turnId: "t",
      finishedAt: 3,
    });
    expect(seen["plugin:git|git_conflict_save"]).toMatchObject({ finalPath: "b.md" });
  });
});
