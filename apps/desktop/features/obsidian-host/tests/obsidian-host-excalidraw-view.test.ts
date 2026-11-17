// @vitest-environment jsdom
// The REAL installed Excalidraw plugin (read-only, never copied or modified) through PluginHost,
// Writer's stores and a synthetic in-memory vault: opening a drawing note shows the plugin's drawing
// view in a Writer tab, saves it back in the plugin's own format, and toggles to markdown and back.
// Skipped when the plugin is not installed at the usual place on this machine.
//
// jsdom is not a browser: it has no canvas, fonts, IndexedDB or ResizeObserver, so those are small
// stubs here (see `installBrowserStubs`) and nothing is drawn. What this proves is the HOST side:
// routing, leaf and view lifecycle, the TextFileView contract, the plugin's own patches of
// WorkspaceLeaf, and that the plugin mounts its React tree. Real rendering, pointer drawing,
// fonts/assets through the writer-plugin scheme and the CSP are NOT covered (see the spec).
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

const disk = new Map<string, string>();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: { path: string }) =>
    cmd === "read_file" ? { content: disk.get(args.path) ?? "" } : undefined,
  ),
}));
vi.mock("../../../src/hooks/workspace-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/hooks/workspace-api")>()),
  getWorkspaceRoot: () => "/ws",
}));

import { locationForPath } from "../../../src/components/editor-area/page-kinds";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { registerEditorView } from "../../../src/lib/editor-views";
import { installDomHelpers } from "../web/host/api/dom";
import { PluginHost, type ScriptLoader } from "../web/host/loader";
import { createMemoryVaultIo, FakeHostIpc } from "../web/host/testing";
import { usePluginsStore, type PluginsDeps } from "../web/stores/plugins-store";
import { useEditorStore } from "../../../src/stores/editor-store";

const ID = "obsidian-excalidraw-plugin";
const PLUGIN_DIR = join(homedir(), "Documents/Vault/PersonalVault/.obsidian/plugins", ID);
const FIXTURES = join(__dirname, "fixtures/excalidraw");
const g = globalThis as any;

function installBrowserStubs(): void {
  // Just enough IndexedDB for the plugin's cache: every request succeeds with nothing.
  const request = (result?: unknown) => {
    const r: any = { result, error: null };
    setTimeout(() => r.onsuccess?.({ target: r }), 0);
    return r;
  };
  const store: any = new Proxy({}, { get: () => () => request(undefined) });
  const tx: any = { objectStore: () => store, oncomplete: null, commit() {}, abort() {} };
  setTimeout(() => tx.oncomplete?.(), 0);
  const db: any = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => store,
    transaction: () => tx,
    close() {},
  };
  g.indexedDB ??= { open: () => request(db) };
  g.Path2D ??= class {
    addPath() {}
    moveTo() {}
    lineTo() {}
    closePath() {}
    rect() {}
    arc() {}
    bezierCurveTo() {}
    quadraticCurveTo() {}
  };
  g.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  g.FontFace ??= class {
    constructor(
      public family: string,
      public source: unknown,
      public descriptors?: unknown,
    ) {}
    load() {
      return Promise.resolve(this);
    }
  };
  if (!(document as any).fonts)
    (document as any).fonts = {
      has: () => false,
      add() {},
      delete() {},
      load: async () => [],
      ready: Promise.resolve(),
      check: () => true,
      forEach() {},
    };
  // A recording 2d context: text measuring works (8 px per character), nothing is drawn.
  const ctx: any = new Proxy(
    { font: "", canvas: null },
    {
      get: (t: any, k) =>
        k in t
          ? t[k]
          : k === "measureText"
            ? (txt: string) => ({
                width: txt.length * 8,
                actualBoundingBoxAscent: 10,
                actualBoundingBoxDescent: 3,
                fontBoundingBoxAscent: 12,
                fontBoundingBoxDescent: 4,
              })
            : () => undefined,
      set: (t: any, k, v) => ((t[k] = v), true),
    },
  );
  HTMLCanvasElement.prototype.getContext = (() => ctx) as never;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe.skipIf(!existsSync(join(PLUGIN_DIR, "main.js")))(
  "real Excalidraw plugin, file view",
  () => {
    const missingApi: string[] = [];
    const hosts: PluginHost[] = [];
    let io: ReturnType<typeof createMemoryVaultIo>;
    const host = () => hosts[0];
    const ws = () => host().app.workspace;
    const store = () => useEditorStore.getState();
    const tab = () => store().tabs.find((t) => t.id === store().activeTabId)!;
    const leafOf = (tabId: string) =>
      usePluginsStore.getState().fileLeaves.get(tabId)?.leaf ?? null;
    const plugin = (): any => host().getPlugin(ID);
    const plain = readFileSync(join(FIXTURES, "plain.excalidraw.md"), "utf8");
    const compressed = readFileSync(join(FIXTURES, "compressed.excalidraw.md"), "utf8");

    /** Opens `abs` through Writer's own open path and waits for the plugin view to be loaded. */
    async function openDrawing(abs: string): Promise<any> {
      await store().openFile(abs);
      const id = tab().id;
      expect(tab().location.kind).toBe("plugin-file");
      await usePluginsStore.getState().ensureFileLeaf(id, tab().location as never);
      await vi.waitFor(() => expect(leafOf(id)?.view.getViewType()).toBe("excalidraw"), {
        timeout: 10_000,
      });
      const view: any = leafOf(id)!.view;
      await vi.waitFor(() => expect(view.isLoaded).toBe(true), { timeout: 20_000 });
      return view;
    }

    beforeAll(async () => {
      installDomHelpers(window);
      installBrowserStubs();
      g.__WRITER_PLUGIN_DEBUG__ = true;
      const source = readFileSync(join(PLUGIN_DIR, "main.js"), "utf8");
      const manifest = JSON.parse(readFileSync(join(PLUGIN_DIR, "manifest.json"), "utf8"));
      const loadScript: ScriptLoader = async (url) => {
        const pid = decodeURIComponent(url.split("/")[3]);
        const script = `__writerPluginDefine(${JSON.stringify(pid)}, function (module, exports, require, process, global, Buffer) {\n${source}\n});`;
        // oxlint-disable-next-line typescript/no-implied-eval -- evaluates the wrapper like a script tag
        new Function(script)();
      };
      io = createMemoryVaultIo({
        "Excalidraw/plain.excalidraw.md": plain,
        "Excalidraw/compressed.excalidraw.md": compressed,
        "Excalidraw/legacy.excalidraw": JSON.stringify({
          type: "excalidraw",
          version: 2,
          source: "synthetic",
          elements: [],
          appState: { viewBackgroundColor: "#ffffff" },
          files: {},
        }),
        "note.md": "# A plain note\n",
      });
      // The release-notes dialog is the plugin's first-run behaviour; settings say it was seen.
      const ipc = new FakeHostIpc({
        enabled: [ID],
        plugins: [{ ...manifest, id: ID }],
        data: {
          [ID]: JSON.stringify({ showReleaseNotes: false, previousRelease: manifest.version }),
        },
      });
      const deps: PluginsDeps = {
        createHost: async (_root, _name, bridge) => {
          const h = new PluginHost({
            ipc,
            io,
            bridge,
            loadScript,
            styles: { add: () => () => {} },
            onMissingApi: (_plugin: string, path: string) => void missingApi.push(path),
          } as never);
          hosts.push(h);
          return h;
        },
      };
      await usePluginsStore.getState().attach("/ws", deps);
      // The plugin installs its WorkspaceLeaf patch once its own initialization is done (~3 s here).
      await vi.waitFor(
        () => expect(ws().resolveFileView("Excalidraw/plain.excalidraw.md")).toBe("excalidraw"),
        { timeout: 30_000, interval: 100 },
      );
      for (const [path, text] of io.files) disk.set(`/ws/${path}`, text);
    }, 60_000);

    afterAll(async () => {
      await usePluginsStore.getState().detach();
    });

    it("loads cleanly: no plugin errors and no missing host API", () => {
      expect(usePluginsStore.getState().snapshot?.status[ID]).toEqual({ state: "enabled" });
      expect(g.__writerPluginErrors ?? []).toEqual([]);
      expect(missingApi).toEqual([]);
      expect(host().app.viewRegistry.getTypeByExtension("excalidraw")).toBe("excalidraw");
    });

    it("routes a drawing note and a .excalidraw file to the plugin view, a plain note to text", () => {
      expect(locationForPath("/ws/Excalidraw/plain.excalidraw.md")).toEqual({
        kind: "plugin-file",
        path: "/ws/Excalidraw/plain.excalidraw.md",
        viewType: "excalidraw",
      });
      expect(locationForPath("/ws/Excalidraw/legacy.excalidraw").kind).toBe("plugin-file");
      expect(locationForPath("/ws/note.md").kind).toBe("file");
    });

    it("opens a plain-json drawing note in a leaf bound to a Writer tab and mounts the view", async () => {
      plugin().settings.compress = false; // keep the JSON readable so the saved text can be inspected
      const view = await openDrawing("/ws/Excalidraw/plain.excalidraw.md");
      const leaf = view.leaf;
      expect(leaf.tabId).toBe(tab().id);
      expect(view.file.path).toBe("Excalidraw/plain.excalidraw.md");
      expect(ws().getLeavesOfType("excalidraw")).toContain(leaf);
      expect(ws().getActiveViewOfType(view.constructor)).toBe(view);
      expect(store().openFiles.has("/ws/Excalidraw/plain.excalidraw.md")).toBe(false);
      // The plugin's own wrapper and React tree are in the leaf (no canvas drawing in jsdom).
      expect(leaf.view.containerEl.getAttribute("data-type")).toBe("excalidraw");
      expect(leaf.containerEl.querySelector(".excalidraw-wrapper")).not.toBeNull();
      expect(leaf.containerEl.querySelector(".excalidraw.excalidraw-container")).not.toBeNull();
      expect(leaf.containerEl.querySelector(".App-toolbar")).not.toBeNull();
      // getViewData() round-trips the plugin's markdown format (the plugin prepares its text on
      // demand: `prepareGetViewData`, which its own save path calls).
      await view.prepareGetViewData();
      const data: string = view.getViewData();
      expect(data).toContain("excalidraw-plugin: parsed");
      expect(data).toContain("## Text Elements");
      expect(data).toContain("Synthetic ^txt00001");
      expect(data).toContain("## Drawing");
      expect(data).toContain("rect0001");
      expect(data.startsWith("---\n\nexcalidraw-plugin: parsed\n")).toBe(true);
      // The drawing's title is the note name like in Obsidian.
      expect(view.getDisplayText()).toBe("plain.excalidraw");
      store().closeTab(tab().id);
      await vi.waitFor(() => expect(leaf.detached).toBe(true));
    }, 60_000);

    it("opens an lz-string compressed drawing note and keeps its format", async () => {
      plugin().settings.compress = true;
      const view = await openDrawing("/ws/Excalidraw/compressed.excalidraw.md");
      await view.prepareGetViewData();
      const data: string = view.getViewData();
      expect(data).toContain("```compressed-json");
      expect(data).toContain("excalidraw-plugin: parsed");
      expect(data).toContain("Synthetic ^txt00001");
      // The scene was decompressed and parsed: the plugin knows the text element's id.
      expect(view.excalidrawData.scene.elements.map((e: { id: string }) => e.id)).toEqual([
        "rect0001",
        "txt00001",
      ]);
      store().closeTab(tab().id);
    }, 60_000);

    it("saves an edit back to the file in the plugin's own markdown format", async () => {
      plugin().settings.compress = false;
      const view = await openDrawing("/ws/Excalidraw/plain.excalidraw.md");
      const before = io.files.get("Excalidraw/plain.excalidraw.md")!;
      const api = view.excalidrawAPI;
      expect(api).toBeTruthy();
      const elements = api.getSceneElements();
      api.updateScene({
        elements: [
          ...elements,
          {
            ...elements[0],
            id: "newrect01",
            x: 400,
            y: 400,
            version: 5,
            versionNonce: 5,
            index: "a2",
          },
        ],
      });
      await view.forceSave(true);
      await vi.waitFor(
        () => expect(io.files.get("Excalidraw/plain.excalidraw.md")).not.toBe(before),
        {
          timeout: 10_000,
        },
      );
      const saved = io.files.get("Excalidraw/plain.excalidraw.md")!;
      expect(saved).toMatch(/^---\n\nexcalidraw-plugin: parsed\n/);
      expect(saved).toContain("# Excalidraw Data");
      expect(saved).toContain("## Text Elements");
      expect(saved).toContain("Synthetic ^txt00001");
      expect(saved).toContain("## Drawing");
      expect(saved).toContain("newrect01");
      expect(saved).toContain("rect0001");
      store().closeTab(tab().id);
    }, 60_000);

    it("'Open as Markdown' turns the tab into the text editor, and the toggle command brings the drawing back", async () => {
      const view = await openDrawing("/ws/Excalidraw/plain.excalidraw.md");
      const id = tab().id;
      const abs = "/ws/Excalidraw/plain.excalidraw.md";
      disk.set(abs, io.files.get("Excalidraw/plain.excalidraw.md")!);
      await view.openAsMarkdown();
      await vi.waitFor(() => expect(tab().location).toEqual({ kind: "file", path: abs }), {
        timeout: 10_000,
      });
      expect(tab().id).toBe(id);
      expect(store().openFiles.get(abs)?.isLoading).toBe(false);
      expect(usePluginsStore.getState().fileLeaves.has(id)).toBe(false);
      await vi.waitFor(() => expect(view.leaf.detached).toBe(true));

      // jsdom mounts no editor pane: a real CodeMirror view stands for the text tab's editor.
      const editor = new EditorView({ state: EditorState.create({ doc: disk.get(abs) ?? "" }) });
      const unregister = registerEditorView(editor, () => abs);
      // The plugin's command: toggle to the drawing from the note editor of the active tab.
      await vi.waitFor(() =>
        expect(ws().getActiveFile()?.path).toBe("Excalidraw/plain.excalidraw.md"),
      );
      const toggle = `${ID}:toggle-excalidraw-view`;
      expect(host().services.commands.get(toggle)?.isAvailable()).toBe(true);
      host().services.commands.execute(toggle);
      await vi.waitFor(() => expect(tab().location.kind).toBe("plugin-file"), { timeout: 10_000 });
      expect(tab().id).toBe(id);
      await vi.waitFor(() => expect(leafOf(id)?.view.getViewType()).toBe("excalidraw"), {
        timeout: 10_000,
      });
      const again: any = leafOf(id)!.view;
      await vi.waitFor(() => expect(again.isLoaded).toBe(true), { timeout: 20_000 });
      expect(again.file.path).toBe("Excalidraw/plain.excalidraw.md");
      unregister();
      editor.destroy();
      store().closeTab(id);
    }, 90_000);

    it("opens a legacy .excalidraw file through the registered extension", async () => {
      const view = await openDrawing("/ws/Excalidraw/legacy.excalidraw");
      expect(view.file.extension).toBe("excalidraw");
      expect(view.compatibilityMode).toBe(true);
      store().closeTab(tab().id);
    }, 60_000);

    it("falls back to text for the same files once the plugin is disabled", async () => {
      await usePluginsStore.getState().setEnabled(ID, false);
      expect(locationForPath("/ws/Excalidraw/plain.excalidraw.md").kind).toBe("file");
      expect(locationForPath("/ws/Excalidraw/legacy.excalidraw").kind).toBe("file");
      await sleep(0);
    }, 60_000);
  },
);
