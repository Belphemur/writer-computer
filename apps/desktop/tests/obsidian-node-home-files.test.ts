// Real home files an agent plugin may read and replace (node/home-files.ts): Copilot's approved
// rules in ~/.claude/settings.json. The fake IPC models the Rust gates (exact path, plugin id,
// spawn consent, restricted mode, stale version). Synthetic content only.
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { createFsModule } from "../src/lib/obsidian-host/node/fs";
import {
  HOME_FILES,
  matchHomeFile,
  matchStagingPrefix,
} from "../src/lib/obsidian-host/node/home-files";
import {
  resetNodeRuntimeForTests,
  setBasePath,
  setNodeIpc,
  setOsInfo,
} from "../src/lib/obsidian-host/node/state";
import { FakeNodeIpc } from "../src/lib/obsidian-host/node/testing";
import { createMemoryVaultIo } from "../src/lib/obsidian-host/testing";

type Err = Error & { code?: string };
const rej = async (p: Promise<unknown>): Promise<Err> => {
  try {
    await p;
  } catch (e) {
    return e as Err;
  }
  throw new Error("did not reject");
};
const thrown = (fn: () => unknown): Err => {
  try {
    fn();
  } catch (e) {
    return e as Err;
  }
  throw new Error("did not throw");
};

const HOME = "/Users/test";
const SETTINGS = `${HOME}/.claude/settings.json`;
const RULES = JSON.stringify({ permissions: { allow: ["Bash(ls:*)", "Bash(git status)"] } });

let ipc: FakeNodeIpc;
beforeEach(() => {
  resetNodeRuntimeForTests();
  ipc = new FakeNodeIpc();
  setNodeIpc(ipc);
  setOsInfo(ipc.osinfo);
  setBasePath("/vault");
  ipc.homeSettings = RULES;
  ipc.homeConsent.add("copilot");
});

const fsFor = (pluginId: string) => {
  const m = createFsModule({ io: createMemoryVaultIo({}), pluginId });
  return { promises: m.promises as any, fs: m.fs as any };
};

describe("home-files allowlist (pure)", () => {
  it("is one exact file for copilot", () => {
    expect(HOME_FILES.map((e) => [e.home, e.plugins])).toEqual([
      [".claude/settings.json", ["copilot"]],
    ]);
    expect(matchHomeFile(HOME, SETTINGS, "copilot")).not.toBeNull();
    expect(matchHomeFile(`${HOME}/`, SETTINGS, "copilot")).not.toBeNull();
    for (const p of [
      `${HOME}/.claude/settings.local.json`,
      `${HOME}/.claude.json`,
      `${HOME}/.claude/../.ssh/x`,
      `${HOME}/.claude/../.claude/settings.json`,
      `${HOME}/.claude/settings.json/`,
      `${HOME}/.claude`,
      `/other/.claude/settings.json`,
      ".claude/settings.json",
    ])
      expect(matchHomeFile(HOME, p, "copilot"), p).toBeNull();
    expect(matchHomeFile(HOME, SETTINGS, "dataview")).toBeNull();
    expect(matchStagingPrefix(HOME, `${HOME}/.claude/.copilot-rules-`, "copilot")).not.toBeNull();
    expect(matchStagingPrefix(HOME, `${HOME}/.claude/.other-`, "copilot")).toBeNull();
    expect(matchStagingPrefix(HOME, `${HOME}/.copilot-rules-`, "copilot")).toBeNull();
  });
});

describe("fs: allowlisted home file", () => {
  it("reads, stats and accesses the exact file", async () => {
    const { promises, fs } = fsFor("copilot");
    expect(await promises.readFile(SETTINGS, "utf8")).toBe(RULES);
    const st = await promises.stat(SETTINGS);
    expect(st.isFile()).toBe(true);
    expect(st.size).toBe(RULES.length);
    expect(st.mode & 0o777).toBe(0o644);
    await promises.access(SETTINGS, 2);
    expect(await promises.realpath(SETTINGS)).toBe(SETTINGS); // never leaves the allowlisted path
    expect(fs.readFileSync(SETTINGS, "utf8")).toBe(RULES); // primed by the async read
    expect(ipc.probeCalls).toEqual([]); // not routed through plugin_fs_probe
  });

  it("a missing file is ENOENT", async () => {
    ipc.homeSettings = null;
    const { promises } = fsFor("copilot");
    expect((await rej(promises.readFile(SETTINGS, "utf8"))).code).toBe("ENOENT");
    expect((await rej(promises.stat(SETTINGS))).code).toBe("ENOENT");
  });

  it("writeFile replaces it with a stale check against the last read", async () => {
    const { promises } = fsFor("copilot");
    await promises.readFile(SETTINGS, "utf8");
    await promises.writeFile(SETTINGS, "{}");
    expect(ipc.homeSettings).toBe("{}");
    expect(ipc.homeCalls.at(-1)).toMatchObject({ op: "write", expected: "v1" });
    ipc.homeSettings = '{"cli":true}'; // the claude CLI wrote meanwhile
    ipc.homeVersion += 1;
    expect((await rej(promises.writeFile(SETTINGS, "{}"))).code).toBe("ESTALE");
    expect(ipc.homeSettings).toBe('{"cli":true}');
  });

  it("serves Copilot's exact save sequence (mkdtemp, open wx, close, readFileSync, renameSync, rm)", async () => {
    const { promises, fs } = fsFor("copilot");
    const text = (await promises.readFile(SETTINGS, "utf8")) as string;
    const real = await promises.realpath(SETTINGS);
    await promises.access(real, fs.constants.W_OK);
    const mode = (await promises.stat(real)).mode & 511;
    const dir = await promises.mkdtemp(`${HOME}/.claude/.copilot-rules-`);
    expect(dir).toMatch(/^\/Users\/test\/\.claude\/\.copilot-rules-[A-Za-z0-9]{6}$/);
    const next = JSON.stringify({ permissions: { allow: ["Bash(git status)"] } }, null, 2) + "\n";
    const h = await promises.open(`${dir}/settings.json`, "wx", mode);
    try {
      await h.writeFile(next);
      await h.chmod(mode);
      await h.sync();
    } finally {
      await h.close();
    }
    expect(fs.readFileSync(real, "utf8")).toBe(text); // plugin's own change check still passes
    fs.renameSync(`${dir}/settings.json`, real);
    await promises.rm(dir, { recursive: true, force: true });
    expect(ipc.homeSettings).toBe(next);
    expect(fs.readFileSync(SETTINGS, "utf8")).toBe(next); // cache refreshed by the rename
    expect(ipc.homeCalls.filter((c) => c.op === "write")).toHaveLength(1);
  });

  it("a stale save fails at close, before anything is renamed", async () => {
    const { promises, fs } = fsFor("copilot");
    await promises.readFile(SETTINGS, "utf8");
    ipc.homeSettings = '{"cli":true}';
    ipc.homeVersion += 1;
    const dir = await promises.mkdtemp(`${HOME}/.claude/.copilot-rules-`);
    const h = await promises.open(`${dir}/settings.json`, "wx", 0o644);
    await h.writeFile("{}");
    expect((await rej(h.close())).code).toBe("ESTALE");
    expect(thrown(() => fs.renameSync(`${dir}/settings.json`, SETTINGS)).code).toBe("EIO");
    expect(ipc.homeSettings).toBe('{"cli":true}');
  });

  it("staged files only go to the allowlisted target", async () => {
    const { promises, fs } = fsFor("copilot");
    const dir = await promises.mkdtemp(`${HOME}/.claude/.copilot-rules-`);
    const h = await promises.open(`${dir}/settings.json`, "wx");
    await h.writeFile("{}");
    await h.close();
    for (const to of [`${HOME}/.claude/settings.local.json`, `${HOME}/.claude.json`, "/vault/x"])
      expect(thrown(() => fs.renameSync(`${dir}/settings.json`, to)).code, to).toBe("EACCES");
    expect((await rej(promises.rename(`${dir}/settings.json`, `${HOME}/.claude.json`))).code).toBe(
      "EACCES",
    );
    // another file name in the staged dir, or another prefix: unsupported as before
    expect((await rej(promises.open(`${dir}/other.json`, "wx"))).code).toBe("ENOSYS");
    expect((await rej(promises.mkdtemp(`${HOME}/.claude/.evil-`))).code).toBe("ENOSYS");
    expect((await rej(promises.mkdtemp(`${HOME}/.ssh/.copilot-rules-`))).code).toBe("ENOSYS");
    expect(ipc.homeSettings).toBe("{}"); // only the allowlisted write happened
  });

  it("everything else outside the vault stays EACCES and never reaches Rust", async () => {
    const { promises, fs } = fsFor("copilot");
    for (const p of [
      `${HOME}/.claude/settings.local.json`,
      `${HOME}/.claude.json`,
      `${HOME}/.claude/../.ssh/x`,
      `${HOME}/.claude/projects/p/s.jsonl`,
      `${HOME}/.claude/.credentials.json`,
    ]) {
      expect((await rej(promises.readFile(p, "utf8"))).code, p).toBe("EACCES");
      expect((await rej(promises.writeFile(p, "x"))).code, p).toBe("EACCES");
      expect((await rej(promises.unlink(p))).code, p).not.toBeUndefined();
    }
    // the allowlisted file itself cannot be deleted or renamed away
    expect((await rej(promises.unlink(SETTINGS))).code).toBe("EACCES");
    expect((await rej(promises.rm(SETTINGS))).code).toBe("EACCES");
    expect((await rej(promises.rename(SETTINGS, `${HOME}/.claude/x.json`))).code).toBe("EACCES");
    expect(thrown(() => fs.renameSync(SETTINGS, `${HOME}/.claude/x.json`)).code).toBe("ENOSYS");
    // only (read-only) existence checks of the allowlisted file itself reached Rust
    expect(ipc.homeCalls.every((c) => c.op === "read" && c.path === SETTINGS)).toBe(true);
    expect(ipc.homeSettings).toBe(RULES);
  });

  it("other plugin ids get EACCES without an IPC call", async () => {
    for (const id of ["dataview", "unknown"]) {
      const { promises } = fsFor(id);
      expect((await rej(promises.readFile(SETTINGS, "utf8"))).code, id).toBe("EACCES");
      expect((await rej(promises.writeFile(SETTINGS, "{}"))).code, id).toBe("EACCES");
      expect((await rej(promises.mkdtemp(`${HOME}/.claude/.copilot-rules-`))).code, id).toBe(
        "ENOSYS",
      );
    }
    const noId = createFsModule({ io: createMemoryVaultIo({}) }).promises as any;
    expect((await rej(noId.readFile(SETTINGS, "utf8"))).code).toBe("EACCES");
    expect(ipc.homeCalls).toEqual([]);
    expect(ipc.homeSettings).toBe(RULES);
  });

  it("without spawn consent, or in restricted mode, Rust refuses and the plugin sees EACCES", async () => {
    const { promises } = fsFor("copilot");
    ipc.homeConsent.clear();
    expect((await rej(promises.readFile(SETTINGS, "utf8"))).code).toBe("EACCES");
    expect((await rej(promises.writeFile(SETTINGS, "{}"))).code).toBe("EACCES");
    ipc.homeConsent.add("copilot");
    ipc.homeRestricted = true;
    expect((await rej(promises.readFile(SETTINGS, "utf8"))).code).toBe("EACCES");
    expect(ipc.homeSettings).toBe(RULES);
  });

  it("mkdir of ~/.claude when absent is deferred to the write; a present one is EEXIST", async () => {
    const { promises } = fsFor("copilot");
    ipc.probes[`${HOME}/.claude`] = { exists: false };
    await expect(promises.mkdir(`${HOME}/.claude`, { recursive: true })).resolves.toBeUndefined();
    ipc.probes[`${HOME}/.claude`] = { exists: true, is_dir: true };
    await expect(promises.mkdir(`${HOME}/.claude`, { recursive: true })).resolves.toBeUndefined();
    expect((await rej(promises.mkdir(`${HOME}/.claude`))).code).toBe("EEXIST");
    expect((await rej(promises.mkdir(`${HOME}/.ssh`, { recursive: true }))).code).toBe("EACCES");
  });
});
