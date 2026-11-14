import { beforeEach, describe, expect, it } from "vite-plus/test";
import {
  createFsModule,
  primeSyncFileContents,
  registerSyncProbePaths,
} from "../src/lib/obsidian-host/node/fs";
import { Buffer } from "../src/lib/obsidian-host/node/buffer";
import {
  DEFAULT_OS_INFO,
  resetNodeRuntimeForTests,
  setBasePath,
  setNodeIpc,
  setOsInfo,
} from "../src/lib/obsidian-host/node/state";
import { FakeNodeIpc } from "../src/lib/obsidian-host/node/testing";
import { createMemoryVaultIo } from "../src/lib/obsidian-host/testing";

type Err = Error & { code?: string; errno?: number; syscall?: string; path?: string };
const errOf = (fn: () => unknown): Err => {
  try {
    fn();
  } catch (e) {
    return e as Err;
  }
  throw new Error("did not throw");
};
const rejOf = async (p: Promise<unknown>): Promise<Err> => {
  try {
    await p;
  } catch (e) {
    return e as Err;
  }
  throw new Error("did not reject");
};

let ipc: FakeNodeIpc;
beforeEach(() => {
  resetNodeRuntimeForTests();
  ipc = new FakeNodeIpc();
  setNodeIpc(ipc);
  setBasePath("/vault");
});

describe("fs sync: read-only probe cache", () => {
  const sync = () => createFsModule().fs as unknown as Record<string, (...a: any[]) => any>;

  it("unknown paths behave like missing files", () => {
    const fs = sync();
    expect(fs.existsSync("/nope")).toBe(false);
    expect(fs.existsSync("")).toBe(false);
    expect(fs.existsSync(undefined)).toBe(false);
    for (const [fn, syscall] of [
      ["statSync", "stat"],
      ["lstatSync", "stat"],
      ["accessSync", "access"],
      ["realpathSync", "realpath"],
      ["readdirSync", "scandir"],
      ["readFileSync", "open"],
    ] as const) {
      const e = errOf(() => fs[fn]("/nope"));
      expect(e.code, fn).toBe("ENOENT");
      expect(e.syscall, fn).toBe(syscall);
      expect(e.message, fn).toBe(`ENOENT: no such file or directory, ${syscall} '/nope'`);
    }
    expect(fs.statSync("/nope", { throwIfNoEntry: false })).toBeUndefined();
  });

  it("registerSyncProbePaths fills the cache from plugin_fs_probe", async () => {
    ipc.probes["/home/u/.claude"] = { exists: true, is_dir: true };
    ipc.probes["/home/u/.claude/settings.json"] = { exists: true, is_file: true, size: 42 };
    await registerSyncProbePaths(["/home/u/.claude/", "/home/u/.claude/settings.json", "/gone"]);
    const fs = sync();
    expect(fs.existsSync("/home/u/.claude")).toBe(true); // trailing slash normalized
    expect(fs.existsSync("/home/u/.claude/settings.json")).toBe(true);
    expect(fs.existsSync("/gone")).toBe(false);
    const st = fs.statSync("/home/u/.claude/settings.json");
    expect(st.isFile()).toBe(true);
    expect(st.isDirectory()).toBe(false);
    expect(st.size).toBe(42);
    expect(fs.statSync("/home/u/.claude").isDirectory()).toBe(true);
    expect(fs.realpathSync("/home/u/./.claude")).toBe("/home/u/.claude");
    expect(
      (fs.realpathSync as unknown as { native(p: string): string }).native("/home/u/.claude"),
    ).toBe("/home/u/.claude");
    expect(() => fs.accessSync("/home/u/.claude")).not.toThrow();
    expect(fs.readdirSync("/home/u/.claude")).toEqual([]);
    expect(errOf(() => fs.readdirSync("/home/u/.claude/settings.json")).code).toBe("ENOTDIR");
    expect(ipc.probeCalls).toEqual([["/home/u/.claude", "/home/u/.claude/settings.json", "/gone"]]);
  });

  it("readFileSync serves primed content, else EACCES for known files, EISDIR for dirs", async () => {
    ipc.probes["/h/a.json"] = { exists: true, is_file: true };
    ipc.probes["/h/dir"] = { exists: true, is_dir: true };
    await registerSyncProbePaths(["/h/a.json", "/h/dir"]);
    const fs = sync();
    expect(errOf(() => fs.readFileSync("/h/a.json", "utf8")).code).toBe("EACCES");
    expect(errOf(() => fs.readFileSync("/h/dir")).code).toBe("EISDIR");
    primeSyncFileContents("/h/a.json", '{"k":1}');
    expect(fs.readFileSync("/h/a.json", "utf8")).toBe('{"k":1}');
    expect(Buffer.isBuffer(fs.readFileSync("/h/a.json"))).toBe(true);
    expect(fs.readFileSync("/h/a.json", { encoding: "utf8" })).toBe('{"k":1}');
  });

  it("priming content for an unprobed path does not make it exist", () => {
    primeSyncFileContents("/ghost", "x");
    expect(errOf(() => sync().readFileSync("/ghost")).code).toBe("ENOENT");
  });

  it("mutating sync calls and streams are unsupported (ENOSYS)", () => {
    const fs = sync();
    for (const fn of [
      "writeFileSync",
      "mkdirSync",
      "rmSync",
      "renameSync",
      "openSync",
      "unlinkSync",
    ])
      expect(errOf(() => fs[fn]("/x", "y")).code, fn).toBe("ENOSYS");
    expect(() => fs.createReadStream("/x")).toThrow(/createReadStream\(\) is not supported/);
    expect(() => fs.createWriteStream("/x")).toThrow(/createWriteStream\(\) is not supported/);
  });

  it("exposes constants (X_OK etc.) so `fs.constants.X_OK` never crashes", () => {
    expect(sync().constants).toMatchObject({ F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 });
  });
});

describe("fs async: vault-confined", () => {
  const setup = (
    files: Record<string, string> = { "a.md": "# A", "dir/b.md": "B", "dir/sub/c.md": "C" },
  ) => {
    const io = createMemoryVaultIo(files);
    const { fs, promises } = createFsModule({ io });
    return { io, fs: fs as unknown as Record<string, (...a: any[]) => any>, p: promises };
  };

  it("readFile returns a Buffer or a string; errors carry Node codes", async () => {
    const { p } = setup();
    const b = await p.readFile("/vault/a.md");
    expect(Buffer.isBuffer(b)).toBe(true);
    expect(b.toString()).toBe("# A");
    expect(await p.readFile("/vault/a.md", "utf8")).toBe("# A");
    expect(await p.readFile("/vault/dir/../a.md", { encoding: "utf8" })).toBe("# A");
    expect((await rejOf(p.readFile("/vault/missing.md"))).code).toBe("ENOENT");
    expect((await rejOf(p.readFile("/vault/dir"))).code).toBe("EISDIR");
  });

  it("relative paths resolve against the vault base", async () => {
    const { p } = setup();
    expect(await p.readFile("dir/b.md", "utf8")).toBe("B");
  });

  it("confines to the vault: outside paths and .. escapes are EACCES", async () => {
    const { p } = setup();
    for (const path of ["/etc/passwd", "/vault/../etc/passwd", "/vaultx/a.md", "../x"]) {
      const e = await rejOf(p.readFile(path));
      expect(e.code, path).toBe("EACCES");
    }
    expect((await rejOf(p.writeFile("/tmp/x", "y"))).code).toBe("EACCES");
    // outside the vault: a path that is not there is ENOENT (rm force succeeds), one that exists
    // is refused
    expect((await rejOf(p.rm("/tmp/x"))).code).toBe("ENOENT");
    await expect(p.rm("/tmp/x", { force: true, recursive: true })).resolves.toBeUndefined();
    ipc.probes["/tmp/x"] = { exists: true, is_file: true, size: 1 };
    expect((await rejOf(p.rm("/tmp/x", { force: true }))).code).toBe("EACCES");
    expect((await rejOf(p.unlink("/tmp/x"))).code).toBe("EACCES");
    expect((await rejOf(p.rename("/vault/a.md", "/tmp/a.md"))).code).toBe("EACCES");
    expect((await rejOf(p.readdir("/"))).code).toBe("EACCES");
  });

  it("serves a plugin's home-directory data (~/.obsidian-copilot) from inside the vault", async () => {
    setOsInfo({ ...DEFAULT_OS_INFO, homedir: "/Users/test" });
    const { p, io } = setup();
    const dir = "/Users/test/.obsidian-copilot/vaults/ab12cd34";
    const file = `${dir}/agent-chat-index.json`;
    expect((await rejOf(p.readFile(file))).code).toBe("ENOENT");
    expect(await p.mkdir(dir, { recursive: true })).toBe("/Users/test/.obsidian-copilot");
    await p.writeFile(file, '{"version":1}');
    // Persisted in the vault's plugin folder, not the real home directory.
    expect(
      io.files.get(
        ".obsidian/plugins/copilot/home/.obsidian-copilot/vaults/ab12cd34/agent-chat-index.json",
      ),
    ).toBe('{"version":1}');
    expect(await p.readFile(file, "utf8")).toBe('{"version":1}');
    expect((await p.stat(file)).isFile()).toBe(true);
    expect((await p.stat(dir)).isDirectory()).toBe(true);
    // Other home paths stay confined.
    expect((await rejOf(p.writeFile("/Users/test/.ssh/x", "y"))).code).toBe("EACCES");
    expect((await rejOf(p.writeFile("/Users/test/.obsidian-copilotx/x", "y"))).code).toBe("EACCES");
  });

  it("writeFile/appendFile accept strings, Buffers and Uint8Arrays", async () => {
    const { p, io } = setup();
    await p.writeFile("/vault/new.md", "hello");
    await p.writeFile("/vault/buf.md", Buffer.from("héllo"));
    await p.appendFile("/vault/new.md", " world");
    await p.writeFile("/vault/new.md", "!", { flag: "a" });
    expect(io.files.get("new.md")).toBe("hello world!");
    expect(io.files.get("buf.md")).toBe("héllo");
    await p.writeFile("/vault/u8.md", new Uint8Array([104, 105]));
    expect(io.files.get("u8.md")).toBe("hi");
  });

  it("stat/lstat/access", async () => {
    const { p } = setup();
    const f = await p.stat("/vault/a.md");
    expect(f.isFile()).toBe(true);
    expect(f.isDirectory()).toBe(false);
    expect(f.size).toBe(3);
    expect(f.mtime).toBeInstanceOf(Date);
    expect((await p.lstat("/vault/dir")).isDirectory()).toBe(true);
    expect((await p.stat("/vault")).isDirectory()).toBe(true);
    await expect(p.access("/vault/a.md")).resolves.toBeUndefined();
    const e = await rejOf(p.access("/vault/zzz"));
    expect(e).toMatchObject({ code: "ENOENT", syscall: "access", errno: -2 });
    expect((await rejOf(p.stat("/vault/zzz"))).message).toBe(
      "ENOENT: no such file or directory, stat '/vault/zzz'",
    );
  });

  it("mkdir (plain, recursive, EEXIST), rm (force/recursive), rmdir/unlink, rename", async () => {
    const { p, io } = setup();
    await p.mkdir("/vault/newdir");
    expect(io.folders.has("newdir")).toBe(true);
    expect((await rejOf(p.mkdir("/vault/newdir"))).code).toBe("EEXIST");
    await expect(p.mkdir("/vault/newdir", { recursive: true })).resolves.toBeUndefined();
    const first = await p.mkdir("/vault/x/y/z", { recursive: true });
    expect(first).toBe("/vault/x");
    expect(io.folders.has("x/y/z")).toBe(true);

    await expect(p.rm("/vault/nothing")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(p.rm("/vault/nothing", { force: true })).resolves.toBeUndefined();
    expect((await rejOf(p.rm("/vault/dir"))).code).toBe("ERR_FS_EISDIR");
    await p.rm("/vault/dir", { recursive: true });
    expect(io.files.has("dir/b.md")).toBe(false);
    expect((await rejOf(p.rm("/vault", { recursive: true }))).code).toBe("EPERM");

    await p.unlink("/vault/a.md");
    expect(io.files.has("a.md")).toBe(false);
    expect((await rejOf(p.unlink("/vault/x"))).code).toBe("EISDIR");
    expect((await rejOf(p.rmdir("/vault/zzz"))).code).toBe("ENOENT");
    await p.rmdir("/vault/x");
    expect(io.folders.has("x")).toBe(false);

    await p.writeFile("/vault/r1.md", "R");
    await p.rename("/vault/r1.md", "/vault/r2.md");
    expect(io.files.get("r2.md")).toBe("R");
    expect((await rejOf(p.rename("/vault/ghost", "/vault/other"))).code).toBe("ENOENT");
  });

  it("readdir returns names or Dirents; ENOENT/ENOTDIR", async () => {
    const { p } = setup();
    expect(
      ((await p.readdir("/vault/dir")) as string[]).sort((a, b) => a.localeCompare(b)),
    ).toEqual(["b.md", "sub"]);
    const ents = await p.readdir("/vault/dir", { withFileTypes: true });
    const byName = Object.fromEntries(ents.map((e: any) => [e.name, e.isDirectory()]));
    expect(byName).toEqual({ "b.md": false, sub: true });
    expect((await rejOf(p.readdir("/vault/zzz"))).code).toBe("ENOENT");
    expect((await rejOf(p.readdir("/vault/a.md"))).code).toBe("ENOTDIR");
  });

  it("realpath, copyFile and unsupported operations", async () => {
    const { p, io } = setup();
    expect(await p.realpath("/vault/dir/../a.md")).toBe("/vault/a.md");
    expect((await rejOf(p.realpath("/vault/nope"))).code).toBe("ENOENT");
    await p.copyFile("/vault/a.md", "/vault/copy.md");
    expect(io.files.get("copy.md")).toBe("# A");
    expect((await rejOf(p.copyFile("/vault/a.md", "/vault/copy.md", 1))).code).toBe("EEXIST");
    for (const fn of ["mkdtemp", "open", "symlink", "chmod"] as const)
      expect((await rejOf((p[fn] as () => Promise<never>)())).code, fn).toBe("ENOSYS");
  });

  it("callback forms mirror the promise API", async () => {
    const { fs } = setup();
    const r = await new Promise<unknown[]>((res) =>
      fs.readFile("/vault/a.md", "utf8", (...a: unknown[]) => res(a)),
    );
    expect(r).toEqual([null, "# A"]);
    const e = await new Promise<Err>((res) => fs.stat("/vault/missing", (err: Err) => res(err)));
    expect(e.code).toBe("ENOENT");
    expect(await new Promise((res) => fs.exists("/vault/a.md", res))).toBe(true);
    expect(await new Promise((res) => fs.exists("/vault/zz", res))).toBe(false);
    expect(() => fs.readFile("/vault/a.md")).toThrow(/cb/);
    expect(fs.promises).toBeDefined();
  });

  it("stat/access outside the vault go through plugin_fs_probe (and refresh the sync cache)", async () => {
    const { p, fs } = setup();
    ipc.probes["/home/u/.claude/local/claude"] = { exists: true, is_file: true, size: 9 };
    const st = await p.stat("/home/u/.claude/local/claude");
    expect(st.isFile()).toBe(true);
    expect(st.size).toBe(9);
    await expect(p.access("/home/u/.claude/local/claude", 1)).resolves.toBeUndefined();
    expect(fs.existsSync("/home/u/.claude/local/claude")).toBe(true);
    expect((await rejOf(p.stat("/home/u/missing"))).code).toBe("ENOENT");
    ipc.failWith.fsProbe = "not allow-listed";
    expect((await rejOf(p.stat("/etc/hosts"))).code).toBe("EACCES");
    // reading outside the vault stays forbidden even for probed files
    expect((await rejOf(p.readFile("/home/u/.claude/local/claude"))).code).toBe("EACCES");
  });

  it("without a vault, async calls fail with EACCES", async () => {
    const { promises } = createFsModule();
    expect((await rejOf(promises.readFile("/vault/a.md"))).code).toBe("EACCES");
  });
});
