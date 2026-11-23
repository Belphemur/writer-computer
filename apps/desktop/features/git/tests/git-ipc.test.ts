// The git IPC: every wrapper of `ipc.ts` goes through the generated bindings, so each command
// reaches `plugin:git|<command>` with the argument names Tauri reads (camelCase: `linkExisting`,
// `chatId`, `finalPath`), and the wrappers cover exactly the manifest's commands. A hand-written
// snake_case key (the bug this test pins) cannot pass: Tauri would drop it and the Rust command
// would fail.
// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { DESKTOP } from "@tests/helpers/import-graph";
import { afterEach, describe, expect, it } from "vite-plus/test";
import manifest from "../feature.json";
import { commands } from "../web/bindings";
import * as ipc from "../web/ipc";

afterEach(() => clearMocks());

const snake = (camel: string) => camel.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** Every wrapper called once with plausible arguments. */
const CALLS: Record<string, () => Promise<unknown>> = {
  git_status: () => ipc.status(true),
  git_setup: () => ipc.setup("local"),
  git_commit_now: () => ipc.commitNow(),
  git_set_paused: () => ipc.setPaused(true),
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
};

describe("the git commands", () => {
  it("are the same set in the manifest, the generated bindings and the wrappers", () => {
    const declared = [...manifest.rust.commands].sort();
    expect(Object.keys(commands).map(snake).sort()).toEqual(declared);
    expect(Object.keys(CALLS).sort()).toEqual(declared);
  });

  it("are invoked on the plugin route with the argument names Tauri reads", async () => {
    const seen: [string, Record<string, unknown> | undefined][] = [];
    mockIPC((cmd, args) => {
      seen.push([cmd, args as Record<string, unknown> | undefined]);
      return null;
    });
    for (const [name, call] of Object.entries(CALLS)) {
      seen.length = 0;
      await call().catch(() => {});
      expect(seen, name).toHaveLength(1);
      expect(seen[0]![0]).toBe(`plugin:git|${name}`);
      for (const key of Object.keys(seen[0]![1] ?? {})) {
        expect(key, `${name}: ${key}`).toMatch(/^[a-z][A-Za-z0-9]*$/);
      }
    }
  });

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

  it("are never invoked by hand in ipc.ts", () => {
    const source = readFileSync(resolve(DESKTOP, "features/git/web/ipc.ts"), "utf8");
    expect(source).not.toMatch(/featureInvoke|invoke\(/);
  });
});
