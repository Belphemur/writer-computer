// @vitest-environment jsdom
// Agent configuration surface (Copilot Agent Mode: Claude, Codex, OpenCode): detection paths the
// sync fs cache is preloaded with, typed-path stats, electron shell shapes, external links.
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  AGENT_CLI_NAMES,
  configuredAgentPaths,
  primeConfiguredAgentPaths,
  agentBinDirs,
  agentCandidates,
  versionRoots,
} from "../src/lib/obsidian-host/node/agent-clis";
import { installExternalLinks } from "../src/lib/obsidian-host/node/external-links";
import { createFsModule } from "../src/lib/obsidian-host/node/fs";
import { createMemoryVaultIo } from "../src/lib/obsidian-host/testing";
import { electronModule, setOpenExternal } from "../src/lib/obsidian-host/node/misc";
import { preloadNodeRuntime } from "../src/lib/obsidian-host/node/runtime";
import {
  resetNodeRuntimeForTests,
  setBasePath,
  setNodeIpc,
} from "../src/lib/obsidian-host/node/state";
import { FakeNodeIpc, flush } from "../src/lib/obsidian-host/node/testing";

let ipc: FakeNodeIpc;
beforeEach(() => {
  resetNodeRuntimeForTests();
  ipc = new FakeNodeIpc();
  setNodeIpc(ipc);
  setBasePath("/vault");
  setOpenExternal(null);
  window.__writerPluginErrors = [];
});

const file = (size = 1) => ({ exists: true, is_file: true, size });

describe("agent detection preload", () => {
  it("lists claude, codex, codex-acp and opencode", () => {
    expect([...AGENT_CLI_NAMES]).toEqual(["claude", "codex", "codex-acp", "opencode"]);
    const dirs = agentBinDirs("/Users/test", "/opt/bin:/usr/bin:relative");
    expect(dirs).toContain("/opt/bin");
    expect(dirs).not.toContain("relative");
    expect(dirs).toContain("/opt/homebrew/bin");
    expect(dirs).toContain("/Users/test/.opencode/bin");
    expect(agentCandidates(["/a"])).toEqual([
      "/a/claude",
      "/a/codex",
      "/a/codex-acp",
      "/a/opencode",
    ]);
  });

  it("preloads every agent candidate so existsSync is truthful for Claude, Codex and OpenCode", async () => {
    ipc.whichMap = {
      claude: "/opt/bin/claude",
      codex: null,
      "codex-acp": "/Users/test/.local/bin/codex-acp",
      opencode: "/opt/homebrew/bin/opencode",
    };
    ipc.probes = {
      "/opt/bin/claude": file(),
      "/Users/test/.local/bin/codex-acp": file(),
      "/opt/homebrew/bin/opencode": file(),
      "/opt/homebrew/bin/claude": file(), // a candidate that is NOT what `which` returned
    };
    await preloadNodeRuntime({ ipc, basePath: "/vault" });
    const { fs } = createFsModule();
    const f = fs as unknown as Record<string, (p: string) => boolean>;
    for (const p of [
      "/opt/bin/claude",
      "/opt/homebrew/bin/claude",
      "/Users/test/.local/bin/codex-acp",
      "/opt/homebrew/bin/opencode",
    ])
      expect(f.existsSync(p), p).toBe(true);
    expect(f.existsSync("/opt/homebrew/bin/codex")).toBe(false);
  });

  it("splits probes into batches below Rust's 256-path limit", async () => {
    await preloadNodeRuntime({
      ipc,
      basePath: "/vault",
      extraProbePaths: Array.from({ length: 450 }, (_, i) => `/extra/${i}`),
    });
    expect(ipc.probeCalls.length).toBeGreaterThan(1);
    expect(Math.max(...ipc.probeCalls.map((c) => c.length))).toBeLessThanOrEqual(200);
  });

  it("enumerates nvm / fnm version roots from the probe listing, then probes their bins", async () => {
    const root = versionRoots("/Users/test")[0].root;
    ipc.probes = {
      [root]: { exists: true, is_dir: true, entries: ["v20.1.0", "v22.0.0"] },
      [`${root}/v22.0.0/bin/codex-acp`]: file(),
    };
    await preloadNodeRuntime({ ipc, basePath: "/vault" });
    const fs = createFsModule().fs as unknown as Record<string, (p: string) => any>;
    expect(fs.readdirSync(root)).toEqual(["v20.1.0", "v22.0.0"]);
    expect(fs.existsSync(`${root}/v22.0.0/bin/codex-acp`)).toBe(true);
    expect(fs.existsSync(`${root}/v20.1.0/bin/codex-acp`)).toBe(false);
  });

  it("a failing which() for one agent does not stop the others", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    ipc.failWith.which = "boom";
    await expect(preloadNodeRuntime({ ipc, basePath: "/vault" })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("typed agent path (Save path button)", () => {
  it("stat on an executable outside the probe allow-list is confirmed through plugin_which", async () => {
    const asked: string[] = [];
    const real = ipc.which.bind(ipc);
    ipc.which = async (n) => {
      asked.push(n);
      if (n === "/Users/test/tools/codex-acp") {
        ipc.probes[n] = file(42);
        return n;
      }
      return real(n);
    };
    const { promises } = createFsModule();
    const st = await promises.stat("/Users/test/tools/codex-acp");
    expect(st.isFile()).toBe(true);
    expect(st.size).toBe(42);
    await promises.access("/Users/test/tools/codex-acp");
    expect(asked).toContain("/Users/test/tools/codex-acp");
  });

  it("a path that is not an executable stays ENOENT, and traversal never reaches the probe", async () => {
    const { promises } = createFsModule();
    await expect(promises.stat("/Users/test/tools/missing")).rejects.toMatchObject({
      code: "ENOENT",
    });
    ipc.which = async () => {
      throw "EINVAL: bad executable name";
    };
    await expect(promises.stat("/a/../b")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("electron shell", () => {
  it("openExternal goes through the backend (scheme checked before and by Rust)", async () => {
    await electronModule.shell.openExternal("https://example.com/p");
    await electronModule.shell.openExternal("mailto:a@b.c");
    expect(ipc.openedUrls).toEqual(["https://example.com/p", "mailto:a@b.c"]);
    await expect(electronModule.shell.openExternal("file:///etc/passwd")).rejects.toMatchObject({
      code: "EPERM",
    });
    expect(ipc.openedUrls).toHaveLength(2);
  });

  it("openPath resolves '' on success and the error text on failure (Electron's shape)", async () => {
    expect(await electronModule.shell.openPath("/vault/AGENTS.md")).toBe("");
    expect(ipc.openedPaths).toEqual([{ path: "/vault/AGENTS.md", reveal: false }]);
    ipc.openRejection = "EACCES: only the vault and agent config folders can be opened";
    expect(await electronModule.shell.openPath("/etc/hosts")).toMatch(/EACCES/);
  });

  it("showItemInFolder reveals, never throws, and records a failure", async () => {
    electronModule.shell.showItemInFolder("/vault/copilot");
    await flush();
    expect(ipc.openedPaths).toEqual([{ path: "/vault/copilot", reveal: true }]);
    ipc.openRejection = "EPERM";
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => electronModule.shell.showItemInFolder("/x")).not.toThrow();
    await flush();
    expect(window.__writerPluginErrors?.some((e) => e.phase === "show-item-in-folder")).toBe(true);
    err.mockRestore();
  });

  it("require('electron') has no remote and an inert ipcRenderer", () => {
    expect(electronModule.remote).toBeUndefined();
    expect(electronModule.ipcRenderer.sendSync()).toBeUndefined();
  });
});

describe("external links from plugin UI", () => {
  it("routes window.open and target=_blank anchors to the system browser", async () => {
    const open = vi.fn(async (_url: string) => {});
    setOpenExternal(open);
    const original = window.open;
    const remove = installExternalLinks(window as never);
    expect(window.open("https://example.com/plans", "_blank")).toBeNull();
    const a = document.createElement("a");
    a.href = "https://example.com/login";
    a.target = "_blank";
    document.body.appendChild(a);
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    a.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    await flush();
    expect(open.mock.calls.map((c) => c[0])).toEqual([
      "https://example.com/plans",
      "https://example.com/login",
    ]);
    remove();
    expect(window.open).toBe(original);
    a.remove();
  });

  it("leaves handled, same-origin, non-web and middle clicks alone", async () => {
    const open = vi.fn(async (_url: string) => {});
    setOpenExternal(open);
    const remove = installExternalLinks(window as never);
    const mk = (href: string) => {
      const a = document.createElement("a");
      a.setAttribute("href", href);
      document.body.appendChild(a);
      return a;
    };
    const click = (a: HTMLElement, init: MouseEventInit = {}) =>
      a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
    click(mk("#section"));
    click(mk("/local/path"));
    click(mk("javascript:void(0)"));
    click(mk("https://example.com/mid"), { button: 1 });
    const handled = mk("https://example.com/handled");
    handled.addEventListener("click", (e) => e.preventDefault());
    click(handled);
    await flush();
    expect(open).not.toHaveBeenCalled();
    remove();
  });

  it("an open failure is logged and recorded, not swallowed", async () => {
    setOpenExternal(async () => {
      throw new Error("no browser");
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const remove = installExternalLinks(window as never);
    window.open("https://example.com");
    await flush();
    expect(window.__writerPluginErrors?.some((e) => e.phase === "open-external")).toBe(true);
    expect(err).toHaveBeenCalled();
    remove();
    err.mockRestore();
  });
});

describe("codex adapter validation reads (sync realpath + package metadata)", () => {
  const link = "/Users/test/tools/bin/codex-acp";
  const real = "/Users/test/tools/lib/node_modules/@acme/codex-acp/dist/index.js";
  const pkgJson = "/Users/test/tools/lib/node_modules/@acme/codex-acp/package.json";

  it("a vouched program resolves to its real path and its package.json is readable synchronously", async () => {
    ipc.which = async (n) => {
      if (n !== link) return null;
      ipc.probes[link] = { ...file(), real };
      ipc.probes[real] = { ...file(), real };
      ipc.probes[pkgJson] = { ...file(30), text: '{"name":"@acme/codex-acp"}' };
      return n;
    };
    const { promises, fs } = createFsModule();
    await promises.stat(link);
    const sync = fs as unknown as Record<string, (...a: any[]) => any>;
    expect(sync.realpathSync(link)).toBe(real);
    expect(await promises.realpath(link)).toBe(real);
    expect(sync.readFileSync(pkgJson, "utf8")).toBe('{"name":"@acme/codex-acp"}');
    // metadata Rust did not vouch for stays unreadable
    expect(() => sync.readFileSync("/Users/test/tools/other/package.json", "utf8")).toThrow(
      /ENOENT/,
    );
  });

  it("configuredAgentPaths picks absolute path-like values under agentMode only", () => {
    const json = JSON.stringify({
      openAIApiKey: "/not/agentMode/path",
      agentMode: {
        deviceProfiles: { d1: { claudeCliPath: "/opt/homebrew/bin/claude", note: "/skip" } },
        backends: { codex: { binaryPath: "/Users/t/.nvm/x/bin/codex-acp" }, bad: { path: "rel" } },
        opencode: { command: "/usr/local/bin/opencode" },
      },
    });
    expect(configuredAgentPaths(json).sort()).toEqual([
      "/Users/t/.nvm/x/bin/codex-acp",
      "/opt/homebrew/bin/claude",
      "/usr/local/bin/opencode",
    ]);
    expect(configuredAgentPaths("not json")).toEqual([]);
    expect(configuredAgentPaths(null)).toEqual([]);
  });

  it("primeConfiguredAgentPaths vouches via which and never rejects", async () => {
    const asked: string[] = [];
    ipc.which = async (n) => {
      asked.push(n);
      throw "EINVAL";
    };
    await expect(primeConfiguredAgentPaths(["/a/codex-acp", "/b/opencode"])).resolves.toBe(
      undefined,
    );
    expect(asked).toEqual(["/a/codex-acp", "/b/opencode"]);
  });
});

describe("sync cache follows what the async side has seen", () => {
  it("a vault path stat-ed (or missing) is reflected by existsSync", async () => {
    const io = createMemoryVaultIo({ "agents/opencode": "#!/bin/sh" });
    const { fs, promises } = createFsModule({ io });
    const sync = fs as unknown as Record<string, (p: string) => boolean>;
    expect(sync.existsSync("/vault/agents/opencode")).toBe(false); // never looked at
    await promises.stat("/vault/agents/opencode");
    expect(sync.existsSync("/vault/agents/opencode")).toBe(true); // Copilot's "is it installed" check
    await io.remove("agents/opencode");
    await expect(promises.stat("/vault/agents/opencode")).rejects.toMatchObject({ code: "ENOENT" });
    expect(sync.existsSync("/vault/agents/opencode")).toBe(false);
  });
});
