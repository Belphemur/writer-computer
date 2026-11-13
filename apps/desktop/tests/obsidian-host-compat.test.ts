// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createApp, type App } from "../src/lib/obsidian-host/api/app";
import { createHostServices, Plugin } from "../src/lib/obsidian-host/api/core";
import { installDomHelpers } from "../src/lib/obsidian-host/api/dom";
import { Platform, apiVersion, requestUrl } from "../src/lib/obsidian-host/api/functions";
import { setNetIpc } from "../src/lib/obsidian-host/api/network";
import { Menu, MenuItem } from "../src/lib/obsidian-host/api/ui";
import { FileSystemAdapter, TFile, TFolder } from "../src/lib/obsidian-host/api/vault";
import {
  detachedBridge,
  Editor,
  MarkdownView,
  type EditorBackend,
  type WorkspaceBridge,
} from "../src/lib/obsidian-host/api/views";
import { PluginHost, type ScriptLoader } from "../src/lib/obsidian-host/loader";
import { createProcessShim } from "../src/lib/obsidian-host/node-shims";
import { resetNodeRuntimeForTests } from "../src/lib/obsidian-host/node/state";
import { createObsidianModule } from "../src/lib/obsidian-host/obsidian-module";
import { createMemoryVaultIo, FakeHostIpc } from "../src/lib/obsidian-host/testing";

const FILES = { "a.md": "# A\n[[b]]", "b.md": "# B\n[[a]] and [[#B]]", "dir/c.md": "no links" };

function makeApp(bridge?: Partial<WorkspaceBridge>): App {
  const services = createHostServices({ read: async () => null, write: async () => {} });
  return createApp({
    io: createMemoryVaultIo(FILES),
    services,
    bridge: { ...detachedBridge, ...bridge },
  });
}

const nodeProto = Node.prototype as unknown as Record<string, unknown>;
const elementProto = Element.prototype as unknown as Record<string, unknown>;
const globalBag = globalThis as unknown as Record<string, unknown>;

const NODE_MEMBERS = [
  "createEl",
  "createDiv",
  "createSpan",
  "createSvg",
  "empty",
  "detach",
  "setText",
  "doc",
  "win",
  "instanceOf",
];
const ELEMENT_MEMBERS = ["addClass", "removeClass", "toggleClass", "hasClass", "setAttr"];
const GLOBALS = ["createEl", "createDiv", "createSpan", "createFragment", "createSvg"];

describe("global DOM augmentations", () => {
  afterEach(() => installDomHelpers(window)());

  it("installs prototype helpers and globals, and removes exactly those on uninstall", () => {
    for (const n of NODE_MEMBERS) expect(n in nodeProto).toBe(false);
    for (const n of GLOBALS) expect(n in globalBag).toBe(false);
    const uninstall = installDomHelpers(window);
    for (const n of NODE_MEMBERS) expect(n in nodeProto).toBe(true);
    for (const n of ELEMENT_MEMBERS) expect(n in elementProto).toBe(true);
    for (const n of GLOBALS) expect(typeof globalBag[n]).toBe("function");
    expect(activeDocument).toBe(document);
    expect(activeWindow).toBe(window);
    uninstall();
    for (const n of NODE_MEMBERS) expect(n in nodeProto).toBe(false);
    for (const n of ELEMENT_MEMBERS) expect(n in elementProto).toBe(false);
    for (const n of [...GLOBALS, "activeDocument", "activeWindow", "sleep", "nextFrame"])
      expect(n in globalBag).toBe(false);
  });

  it("is idempotent and never removes members it did not add", () => {
    Object.defineProperty(elementProto, "hasClass", {
      value: () => "preexisting",
      configurable: true,
    });
    const first = installDomHelpers(window);
    expect(installDomHelpers(window)).toBe(first);
    first();
    expect("hasClass" in elementProto).toBe(true);
    delete elementProto["hasClass"];
  });

  it("implements the helper semantics plugins rely on", () => {
    installDomHelpers(window);
    const root = document.body.createDiv({ cls: "a b" });
    const span = root.createSpan({ text: "x" });
    const svg = root.createSvg("svg", { cls: "s" });
    expect(svg.namespaceURI).toBe("http://www.w3.org/2000/svg");
    expect(span.doc).toBe(document);
    expect(span.win).toBe(window);
    expect(document.doc).toBe(document);
    expect(span.instanceOf(HTMLSpanElement)).toBe(true);
    expect(span.instanceOf(HTMLDivElement)).toBe(false);
    expect(new MouseEvent("click").instanceOf(MouseEvent)).toBe(true);
    root.addClass("c d");
    expect(root.hasClass("d")).toBe(true);
    root.removeClass("a");
    root.toggleClass("t", true);
    expect(root.className).toBe("b c d t");
    root.setAttr("data-k", 5);
    expect(root.getAttribute("data-k")).toBe("5");
    root.setText("hello");
    expect(root.textContent).toBe("hello");
    root.empty();
    expect(root.childNodes).toHaveLength(0);
    expect(
      createFragment((f) => f.appendChild(document.createElement("i"))).childNodes,
    ).toHaveLength(1);
  });
});

describe("PluginHost owns the DOM augmentations", () => {
  const g = globalThis as unknown as {
    __writerPluginDefine: (id: string, factory: unknown) => void;
  };

  function hostWith(bodies: Record<string, (obsidian: any) => void>): PluginHost {
    const loadScript: ScriptLoader = async (url) => {
      const id = decodeURIComponent(url.split("/")[3]);
      g.__writerPluginDefine(
        id,
        (module: { exports: unknown }, _e: unknown, require: (n: string) => any) => {
          const { Plugin: P } = require("obsidian");
          module.exports = class extends P {
            async onload() {
              bodies[id](require("obsidian"));
              (document.body as HTMLElement).createDiv({ cls: `made-by-${id}` });
              expect(activeDocument).toBe(document);
            }
          };
        },
      );
    };
    const ids = Object.keys(bodies);
    return new PluginHost({
      ipc: new FakeHostIpc({
        enabled: ids,
        plugins: ids.map((id) => ({ id, name: id })),
      }),
      io: createMemoryVaultIo(FILES),
      loadScript,
      styles: { add: () => () => {} },
    });
  }

  afterEach(() => {
    document.body.replaceChildren();
  });

  it("installs on first plugin load and removes everything when the host shuts down", async () => {
    const host = hostWith({ p: () => {} });
    expect("createDiv" in nodeProto).toBe(false);
    await host.boot();
    expect(host.getStatus("p")).toEqual({ state: "enabled" });
    expect(document.querySelector(".made-by-p")).not.toBeNull();
    expect("createDiv" in nodeProto).toBe(true);
    await host.shutdown();
    expect("createDiv" in nodeProto).toBe(false);
    expect("activeDocument" in globalBag).toBe(false);
  });

  it("stays installed while any plugin is loaded, and a failed load does not leak", async () => {
    const host = hostWith({
      a: () => {},
      bad: () => {
        throw new Error("boom");
      },
    });
    await host.boot();
    expect(host.getStatus("bad").state).toBe("failed");
    expect("createDiv" in nodeProto).toBe(true);
    await host.disable("a");
    expect("createDiv" in nodeProto).toBe(false);
    await host.shutdown();
  });
});

describe("class identity (instanceof) across the obsidian module", () => {
  const ob = createObsidianModule() as unknown as Record<string, abstract new (...a: any[]) => any>;

  it("files and folders the vault creates are instances of the module's classes", async () => {
    const app = makeApp();
    await app.vault.load();
    const file = app.vault.getAbstractFileByPath("a.md");
    const folder = app.vault.getAbstractFileByPath("dir");
    expect(file instanceof ob.TFile).toBe(true);
    expect(file instanceof ob.TAbstractFile).toBe(true);
    expect(file instanceof ob.TFolder).toBe(false);
    expect(folder instanceof ob.TFolder).toBe(true);
    expect(folder instanceof ob.TFile).toBe(false);
    expect(app.vault.getRoot() instanceof ob.TFolder).toBe(true);
    // ...and the module's classes are the same ones the host uses internally.
    expect(ob.TFile.prototype).toBe(TFile.prototype);
    expect(ob.TFolder.prototype).toBe(TFolder.prototype);
    const created = await app.vault.create("new.md", "x");
    expect(created instanceof ob.TFile).toBe(true);
    expect(await app.vault.createFolder("nf")).toBeInstanceOf(ob.TFolder);
  });

  it("vault.adapter is a FileSystemAdapter, and subclasses of module classes pass the checks", async () => {
    const app = makeApp();
    expect(app.vault.adapter instanceof ob.FileSystemAdapter).toBe(true);
    expect(app.vault.adapter instanceof ob.DataAdapter).toBe(true);
    expect(ob.FileSystemAdapter.prototype).toBe(FileSystemAdapter.prototype);
    class MyFile extends ob.TFile {}
    expect(new MyFile(app.vault, "z.md") instanceof ob.TFile).toBe(true);
    expect(new MyFile(app.vault, "z.md") instanceof TFile).toBe(true);
  });

  it("getActiveViewOfType(module MarkdownView) finds the workspace's view", async () => {
    const backend: EditorBackend = {
      getValue: () => "",
      replaceRange: () => {},
      getSelections: () => [],
      setSelections: () => {},
      focus: () => {},
    };
    const app = makeApp({ getActiveFilePath: () => "a.md", getActiveEditor: () => backend });
    await app.vault.load();
    const view = app.workspace.getActiveViewOfType(ob.MarkdownView as typeof MarkdownView);
    expect(view).not.toBeNull();
    expect(view instanceof ob.MarkdownView).toBe(true);
    expect(view instanceof MarkdownView).toBe(true);
    expect(view?.editor instanceof ob.Editor).toBe(true);
    expect(ob.MarkdownView.prototype).toBe(MarkdownView.prototype);
  });
});

describe("vault create events vs layout readiness", () => {
  it("replays create for pre-existing files before layout is ready, never to late listeners", async () => {
    const app = makeApp();
    await app.vault.load();
    app.metadataCache.start();
    const early: string[] = [];
    const late: string[] = [];
    const changed = vi.fn();
    app.metadataCache.on("changed", changed);
    app.vault.on("create", (f: { path: string }) => early.push(f.path));
    app.workspace.onLayoutReady(() => {
      app.vault.on("create", (f: { path: string }) => late.push(f.path));
    });
    expect(early).toEqual([]); // loading the index itself fires nothing
    app.workspace.markLayoutReady();
    expect(early.toSorted()).toEqual(["a.md", "b.md", "dir", "dir/c.md"]);
    expect(late).toEqual([]);
    expect(changed).not.toHaveBeenCalled(); // the cache did not re-index on the replay
    await app.vault.create("later.md", "x");
    expect(early).toContain("later.md");
    expect(late).toEqual(["later.md"]);
  });

  it("does not replay when the layout was already ready before the vault loaded", async () => {
    const app = makeApp();
    app.workspace.markLayoutReady();
    const seen: string[] = [];
    app.vault.on("create", (f: { path: string }) => seen.push(f.path));
    await app.vault.load();
    expect(seen).toEqual([]);
  });
});

describe("undocumented members plugins feature-detect", () => {
  it("metadataCache.getBacklinksForFile maps linking notes to their link entries", async () => {
    const app = makeApp();
    await app.vault.load();
    await app.metadataCache.indexAll();
    const a = app.vault.getFileByPath("a.md") as TFile;
    const b = app.vault.getFileByPath("b.md") as TFile;
    const back = app.metadataCache.getBacklinksForFile(a);
    expect(back.data).toBeInstanceOf(Map);
    expect([...back.data.keys()]).toEqual(["b.md"]);
    expect(back.get("b.md")?.[0].link).toBe("a");
    // [[#B]] in b.md links to itself: not a backlink of b
    expect(app.metadataCache.getBacklinksForFile(b).keys()).toEqual(["a.md"]);
    expect(
      app.metadataCache.getBacklinksForFile(app.vault.getFileByPath("dir/c.md") as TFile).data.size,
    ).toBe(0);
  });

  it("app.commands: executeCommandById, listCommands and the commands record", () => {
    const app = makeApp();
    const plugin = new Plugin(app, { id: "demo", name: "Demo", version: "1.0.0" });
    const cb = vi.fn();
    const added = plugin.addCommand({ id: "go", name: "Go", callback: cb });
    // id/name prefixing, idempotent when already prefixed (matches opensidian's addCmd)
    expect(added.id).toBe("demo:go");
    expect(added.name).toBe("Demo: Go");
    expect(plugin.addCommand({ id: "demo:go", name: "Demo: Go", callback: cb }).id).toBe("demo:go");
    expect(app.commands.executeCommandById("demo:go")).toBe(true);
    expect(app.commands.executeCommandById("nope")).toBe(false);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(app.commands.listCommands().map((c) => c.id)).toEqual(["demo:go"]);
    expect(Object.keys(app.commands.commands)).toEqual(["demo:go"]);
    expect(app.commands.commands["demo:go"].name).toBe("Demo: Go");
  });

  it("app.plugins exposes getPlugin / enabledPlugins / plugins / manifests", async () => {
    const g = globalThis as unknown as {
      __writerPluginDefine: (id: string, factory: unknown) => void;
    };
    const host = new PluginHost({
      ipc: new FakeHostIpc({ enabled: ["p"], plugins: [{ id: "p", name: "P" }] }),
      io: createMemoryVaultIo(FILES),
      loadScript: async () =>
        g.__writerPluginDefine("p", (module: { exports: unknown }, _e: unknown, req: any) => {
          module.exports = class extends req("obsidian").Plugin {};
        }),
      styles: { add: () => () => {} },
    });
    await host.boot();
    const { plugins } = host.app;
    expect(plugins.getPlugin("p")).toBe(plugins.plugins["p"]);
    expect(plugins.getPlugin("missing")).toBeNull();
    expect([...plugins.enabledPlugins]).toEqual(["p"]);
    expect(plugins.manifests["p"].dir).toBe(".obsidian/plugins/p");
    await host.disable("p");
    expect(plugins.enabledPlugins.size).toBe(0);
    expect(plugins.manifests["p"]).toBeUndefined();
    await host.shutdown();
  });

  it("app.setting open/openTabById stubs notify the host", () => {
    const app = makeApp();
    const spy = vi.fn();
    app.setting.openRequested = spy;
    app.setting.open();
    app.setting.openTabById("demo");
    app.setting.close();
    expect(spy.mock.calls).toEqual([[null], ["demo"]]);
  });

  it("MenuItem.setSubmenu returns a fillable Menu that is also item.submenu", () => {
    installDomHelpers(window);
    const menu = new Menu();
    let item!: MenuItem;
    menu.addItem((i) => (item = i));
    const sub = item.setSubmenu();
    expect(sub).toBeInstanceOf(Menu);
    expect(item.submenu).toBe(sub);
    sub.addItem((i) => i.setTitle("child"));
    expect(item.setSubmenu()).toBe(sub);
    expect(item.dom.classList.contains("has-submenu")).toBe(true);
    installDomHelpers(window)();
  });

  it("Editor.cm is settable and defaults to null", () => {
    const backend: EditorBackend = {
      getValue: () => "",
      replaceRange: () => {},
      getSelections: () => [],
      setSelections: () => {},
      focus: () => {},
    };
    const editor = new Editor(backend);
    expect(editor.cm).toBeNull();
    const fake = { state: {} } as unknown as NonNullable<Editor["cm"]>;
    editor.cm = fake;
    expect(editor.cm).toBe(fake);
  });

  it("registerBasesView reports not registered", () => {
    const plugin = new Plugin(makeApp(), { id: "demo", name: "Demo", version: "1.0.0" });
    expect(plugin.registerBasesView("my-view", { name: "x" })).toBe(false);
  });
});

describe("requestUrl", () => {
  /** Backs requestUrl with a fake plugin_http_request returning the given response. */
  const respond = (status: number, body: string, headers: Record<string, string> = {}) => {
    const mock = vi.fn(async (r: { url: string; method?: string; headers?: unknown }) => ({
      status,
      headers: Object.entries(headers),
      body_base64: btoa(body),
      url: r.url,
    }));
    setNetIpc({
      request: mock,
      streamStart: async () => 0,
      streamCancel: async () => false,
    });
    return mock;
  };

  afterEach(() => setNetIpc(null));

  it("resolves with status, lower-cased headers and text/json/arrayBuffer", async () => {
    const mock = respond(200, '{"ok":true}', { "Content-Type": "application/json" });
    const res = await requestUrl({
      url: "https://x.test/api",
      method: "POST",
      contentType: "application/json",
      body: "{}",
      headers: { "X-A": "1" },
    });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json");
    expect(res.text).toBe('{"ok":true}');
    expect(res.json).toEqual({ ok: true });
    expect(res.arrayBuffer.byteLength).toBe(11);
    const sent = mock.mock.calls[0][0];
    expect(sent.method).toBe("POST");
    expect(sent.headers).toEqual({ "X-A": "1", "Content-Type": "application/json" });
    expect(await requestUrl("https://x.test/api").json).toEqual({ ok: true });
    expect(await requestUrl("https://x.test/api").text).toBe('{"ok":true}');
  });

  it("throws on status >= 400 unless throw:false", async () => {
    respond(404, "nope");
    await expect(requestUrl("https://x.test/missing")).rejects.toMatchObject({ status: 404 });
    const res = await requestUrl({ url: "https://x.test/missing", throw: false });
    expect(res.status).toBe(404);
    expect(res.text).toBe("nope");
    respond(399, "edge");
    expect((await requestUrl("https://x.test/e")).status).toBe(399);
  });

  it("does not leak unhandled rejections from the shortcut properties", async () => {
    respond(500, "err");
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    await expect(requestUrl("https://x.test/boom")).rejects.toThrow(/500/);
    await new Promise((r) => setTimeout(r, 10));
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});

describe("Platform, apiVersion and the process shim", () => {
  it("separates UI mode from the Electron app", () => {
    expect(Platform.isDesktop).toBe(true);
    expect(Platform.isMobile).toBe(false);
    // The host always wires the Node surface (require/process/Buffer), so Copilot-style
    // `isDesktopApp && !isMobile` gates open.
    expect(Platform.isDesktopApp).toBe(true);
    expect(Platform.isMobileApp).toBe(false);
    expect(typeof Platform.resourcePathPrefix).toBe("string");
  });

  it("claims at least the version the reference plugin needs", () => {
    expect(apiVersion.split(".").map(Number)).toEqual(expect.arrayContaining([1]));
    const mod = createObsidianModule() as { requireApiVersion: (v: string) => boolean };
    expect(mod.requireApiVersion("1.11.4")).toBe(true);
    expect(mod.requireApiVersion("99.0.0")).toBe(false);
  });

  it("process exposes the fields plugin bundles read", async () => {
    resetNodeRuntimeForTests();
    const p = createProcessShim() as {
      platform: string;
      env: Record<string, string>;
      versions: Record<string, string>;
      cwd(): string;
      nextTick(cb: (...a: number[]) => void, ...args: number[]): void;
      once(): void;
      emit(): boolean;
    };
    expect(typeof p.platform).toBe("string");
    expect(p.env).toEqual({});
    expect(p.versions.node).toBeUndefined();
    expect(p.cwd()).toBe("/");
    const seen: number[] = [];
    p.nextTick((n) => seen.push(n), 7);
    expect(seen).toEqual([]);
    await Promise.resolve();
    expect(seen).toEqual([7]);
    expect(p.emit()).toBe(false);
    expect(() => p.once()).not.toThrow();
  });
});
