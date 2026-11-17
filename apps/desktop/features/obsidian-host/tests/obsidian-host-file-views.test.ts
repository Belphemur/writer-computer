// @vitest-environment jsdom
// File-bound plugin views (registerExtensions, notes a plugin redirects into its own view), hosted
// in Writer tabs. A SYNTHETIC fixture plugin only: no Excalidraw here (see
// obsidian-host-excalidraw-view.test.ts for the real bundle).
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const disk = new Map<string, string>();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: { path: string }) => {
    if (cmd === "read_file") return { content: disk.get(args.path) ?? "" };
    return undefined;
  }),
}));

vi.mock("@/hooks/workspace-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/workspace-api")>()),
  getWorkspaceRoot: () => "/ws",
}));

import {
  deserializeLocation,
  locationForPath,
  serializeLocation,
} from "@/components/editor-area/page-kinds";
import { resolveFileView } from "@/lib/file-views";
import { PluginHost, type ScriptLoader } from "../web/host/loader";
import { createMemoryVaultIo, FakeHostIpc } from "../web/host/testing";
import { TextFileView, WorkspaceLeaf } from "../web/host/api/views";
import { usePluginsStore, type PluginsDeps } from "../web/stores/plugins-store";
import { useEditorStore } from "@/stores/editor-store";

type Factory = (module: { exports: any }, exports: any, require: (n: string) => any) => void;
const g = globalThis as unknown as { __writerPluginDefine: (id: string, factory: unknown) => void };

/** Records what the fixture view saw, for assertions. */
const seen = {
  loads: [] as { data: string; clear: boolean }[],
  views: [] as any[],
  patched: [] as string[],
};

const plugin: Factory = (module, _e, require) => {
  const {
    Plugin,
    TextFileView: TFV,
    WorkspaceLeaf: Leaf,
    Workspace,
    parseYaml,
  } = require("obsidian");
  class BoardView extends TFV {
    text = "";
    constructor(leaf: any) {
      super(leaf);
      seen.views.push(this);
    }
    getViewType() {
      return "board";
    }
    getDisplayText() {
      return this.file ? this.file.basename : "no file";
    }
    getIcon() {
      return "layout-dashboard";
    }
    canAcceptExtension(ext: string) {
      return ext === "board";
    }
    getViewData() {
      return this.text;
    }
    setViewData(data: string, clear: boolean) {
      seen.loads.push({ data, clear });
      this.text = data;
      this.contentEl.setText(data);
    }
    clear() {
      this.text = "";
      this.contentEl.empty();
    }
    onPaneMenu(menu: any) {
      menu.addItem((i: any) => i.setTitle("Open as markdown"));
    }
  }
  module.exports = class extends Plugin {
    async onload() {
      this.registerView("board", (leaf: any) => new BoardView(leaf));
      this.registerExtensions(["board"], "board");
      // The way Excalidraw redirects a note: a patch of WorkspaceLeaf.prototype.setViewState that
      // turns a markdown request for a flagged note into the plugin's own view type.
      const original = Leaf.prototype.setViewState;
      const plug = this;
      Leaf.prototype.setViewState = function (state: any, ...rest: any[]) {
        const file = state?.state?.file;
        if (
          state?.type === "markdown" &&
          typeof file === "string" &&
          plug.modes[file] !== "markdown"
        ) {
          const f = plug.app.vault.getFileByPath(file);
          const fm = f && plug.app.metadataCache.getFileCache(f)?.frontmatter;
          if (fm && fm["board-plugin"]) {
            seen.patched.push(file);
            return original.apply(this, [{ ...state, type: "board" }, ...rest]);
          }
        }
        return original.apply(this, [state, ...rest]);
      };
      this.register(() => {
        Leaf.prototype.setViewState = original;
      });
      // Prototype patching reaches the host's own classes (monkey-around style).
      const getLeaf = Workspace.prototype.getLeaf;
      Workspace.prototype.getLeaf = function (...a: any[]) {
        seen.patched.push("getLeaf");
        return getLeaf.apply(this, a);
      };
      this.register(() => {
        Workspace.prototype.getLeaf = getLeaf;
      });
      void parseYaml;
    }
    modes: Record<string, string> = {};
  };
};

function loaderFor(scripts: Record<string, Factory>): ScriptLoader {
  return async (url) => {
    const id = decodeURIComponent(url.split("/")[3]);
    const s = scripts[id];
    if (!s) throw new Error("main.js refused or missing");
    g.__writerPluginDefine(id, (module: any, exports: any, require: any) =>
      s(module, exports, require),
    );
  };
}

const BOARD_NOTE = "---\nboard-plugin: true\n---\n# a board note\n";

function setup(files: Record<string, string> = {}) {
  const io = createMemoryVaultIo({
    "todo.board": "card one",
    "other.board": "card two",
    "note.md": "# plain note\n",
    "boardnote.md": BOARD_NOTE,
    ...files,
  });
  const ipc = new FakeHostIpc({ enabled: ["fv"], plugins: [{ id: "fv", name: "Fixture" }] });
  const hosts: PluginHost[] = [];
  const deps: PluginsDeps = {
    createHost: async (_root, _name, bridge) => {
      const host = new PluginHost({
        ipc,
        io,
        bridge,
        loadScript: loaderFor({ fv: plugin }),
        styles: { add: () => () => {} },
      });
      hosts.push(host);
      return host;
    },
  };
  return { io, ipc, hosts, deps, host: () => hosts[0] };
}

const store = () => useEditorStore.getState();
const tab = () => store().tabs.find((t) => t.id === store().activeTabId)!;
const leafOf = (tabId: string) => usePluginsStore.getState().fileLeaves.get(tabId)?.leaf ?? null;

async function boot(files?: Record<string, string>) {
  const t = setup(files);
  await usePluginsStore.getState().attach("/ws", t.deps);
  // Let the metadata index finish so frontmatter-based redirects can see the notes.
  await vi.waitFor(() =>
    expect(t.host().app.metadataCache.getCache("boardnote.md")?.frontmatter).toBeTruthy(),
  );
  return t;
}

beforeEach(async () => {
  seen.loads.length = 0;
  seen.views.length = 0;
  seen.patched.length = 0;
  disk.clear();
  await usePluginsStore.getState().detach();
  useEditorStore.setState({
    tabs: [],
    closedTabs: [],
    openFiles: new Map(),
    activeTabId: null,
    activeFilePath: null,
  });
});
afterEach(async () => {
  vi.useRealTimers();
  await usePluginsStore.getState().detach();
});

describe("routing a path to a plugin view", () => {
  it("claims nothing without a host, and a registered extension with one", async () => {
    expect(resolveFileView("/ws/todo.board")).toBeNull();
    expect(locationForPath("/ws/todo.board").kind).toBe("file");
    await boot();
    expect(locationForPath("/ws/todo.board")).toEqual({
      kind: "plugin-file",
      path: "/ws/todo.board",
      viewType: "board",
    });
    expect(locationForPath("/ws/note.md").kind).toBe("file");
    expect(locationForPath("/ws/outside.board".replace("/ws", "/elsewhere")).kind).toBe("file");
  });

  it("asks the plugin's setViewState patch for a note (frontmatter switch)", async () => {
    await boot();
    expect(locationForPath("/ws/boardnote.md")).toEqual({
      kind: "plugin-file",
      path: "/ws/boardnote.md",
      viewType: "board",
    });
    expect(locationForPath("/ws/note.md").kind).toBe("file");
  });

  it("goes back to text once the plugin is disabled", async () => {
    const t = await boot();
    expect(locationForPath("/ws/todo.board").kind).toBe("plugin-file");
    await usePluginsStore.getState().setEnabled("fv", false);
    expect(locationForPath("/ws/todo.board").kind).toBe("file");
    expect(locationForPath("/ws/boardnote.md").kind).toBe("file");
    expect(t.host().app.viewRegistry.isExtensionRegistered("board")).toBe(false);
  });

  it("round-trips through the session format", async () => {
    await boot();
    const loc = locationForPath("/ws/todo.board");
    const data = serializeLocation(loc);
    expect(data).toEqual({ kind: "plugin-file", path: "/ws/todo.board", viewType: "board" });
    expect(deserializeLocation(data)).toEqual(loc);
    expect(deserializeLocation({ kind: "plugin-file", path: "/x" })).toBeNull();
  });
});

describe("a file-bound tab", () => {
  it("opens the view in a leaf bound to the tab, without loading the file as text", async () => {
    const t = await boot();
    await store().openFile("/ws/todo.board");
    expect(tab().location.kind).toBe("plugin-file");
    expect(store().openFiles.has("/ws/todo.board")).toBe(false);
    // The tab body asks for the leaf; here the store does what the body's effect does.
    await usePluginsStore.getState().ensureFileLeaf(tab().id, tab().location as never);
    const leaf = leafOf(tab().id)!;
    expect(leaf.view.getViewType()).toBe("board");
    expect(leaf.tabId).toBe(tab().id);
    expect((leaf.view as TextFileView).file?.path).toBe("todo.board");
    expect(leaf.view.containerEl.getAttribute("data-type")).toBe("board");
    expect(leaf.containerEl.textContent).toContain("card one");
    expect(seen.loads).toEqual([{ data: "card one", clear: true }]);
    expect(t.host().app.workspace.getLeavesOfType("board")).toContain(leaf);
    // The tab is not a transient plugin-view tab.
    expect(store().tabs.some((x) => x.location.kind === "plugin-view")).toBe(false);
  });

  it("is the active leaf and file view of its tab", async () => {
    const t = await boot();
    await store().openFile("/ws/todo.board");
    await usePluginsStore.getState().ensureFileLeaf(tab().id, tab().location as never);
    const ws = t.host().app.workspace;
    await vi.waitFor(() => expect(ws.activeLeaf).toBe(leafOf(tab().id)));
    expect(ws.getActiveFile()?.path).toBe("todo.board");
    expect(ws.getActiveFileView()).toBe(leafOf(tab().id)!.view);
    expect(ws.getActiveViewOfType(TextFileView)).toBe(leafOf(tab().id)!.view);
    expect(ws.getLeaf()).toBe(leafOf(tab().id));
    // No fake note editor for a file that is shown by a view.
    expect(ws.getLeavesOfType("markdown")).toEqual([]);
  });

  it("saves requestSave after 2 s, and does not echo its own write back", async () => {
    const t = await boot();
    await store().openFile("/ws/todo.board");
    await usePluginsStore.getState().ensureFileLeaf(tab().id, tab().location as never);
    const view = leafOf(tab().id)!.view as any;
    vi.useFakeTimers();
    view.text = "card one edited";
    view.requestSave();
    await vi.advanceTimersByTimeAsync(1900);
    expect(t.io.files.get("todo.board")).toBe("card one");
    await vi.advanceTimersByTimeAsync(200);
    expect(t.io.files.get("todo.board")).toBe("card one edited");
    vi.useRealTimers();
    await new Promise((r) => setTimeout(r, 20));
    expect(seen.loads).toHaveLength(1); // the modify event of our own write did not reload
  });

  it("reloads a change made outside the view with setViewData(data, false)", async () => {
    const t = await boot();
    await store().openFile("/ws/todo.board");
    await usePluginsStore.getState().ensureFileLeaf(tab().id, tab().location as never);
    t.io.files.set("todo.board", "changed elsewhere");
    await t.host().app.vault.notifyExternal("modify", "todo.board");
    await vi.waitFor(() =>
      expect(seen.loads.at(-1)).toEqual({ data: "changed elsewhere", clear: false }),
    );
    expect((leafOf(tab().id)!.view as any).text).toBe("changed elsewhere");
  });

  it("flushes a pending edit and detaches the leaf when the tab closes", async () => {
    const t = await boot();
    await store().openFile("/ws/todo.board");
    await usePluginsStore.getState().ensureFileLeaf(tab().id, tab().location as never);
    const id = tab().id;
    const leaf = leafOf(id)!;
    (leaf.view as any).text = "typed just before closing";
    (leaf.view as any).requestSave();
    store().closeTab(id);
    expect(leaf.detached).toBe(true);
    await vi.waitFor(() => expect(t.io.files.get("todo.board")).toBe("typed just before closing"));
    expect(usePluginsStore.getState().fileLeaves.has(id)).toBe(false);
    expect(t.host().app.workspace.getLeavesOfType("board")).toEqual([]);
  });

  it("navigating the tab to another file swaps the leaf", async () => {
    const t = await boot();
    await store().openFile("/ws/todo.board");
    await usePluginsStore.getState().ensureFileLeaf(tab().id, tab().location as never);
    const first = leafOf(tab().id)!;
    await store().navigateToFile("/ws/other.board");
    expect((tab().location as { path: string }).path).toBe("/ws/other.board");
    await usePluginsStore.getState().ensureFileLeaf(tab().id, tab().location as never);
    expect(first.detached).toBe(true);
    const second = leafOf(tab().id)!;
    expect(second).not.toBe(first);
    expect((second.view as TextFileView).file?.path).toBe("other.board");
    expect(t.host().app.workspace.getLeavesOfType("board")).toEqual([second]);
  });

  it("falls back to text when the view's plugin is not there", async () => {
    await boot();
    useEditorStore.setState({
      tabs: [
        {
          id: "r1",
          location: { kind: "plugin-file", path: "/ws/todo.board", viewType: "gone-view" },
          back: [],
          forward: [],
        },
      ],
      activeTabId: "r1",
      activeFilePath: "/ws/todo.board",
    });
    disk.set("/ws/todo.board", "card one");
    await usePluginsStore.getState().ensureFileLeaf("r1", {
      path: "/ws/todo.board",
      viewType: "gone-view",
    });
    expect(usePluginsStore.getState().fileLeaves.get("r1")?.status).toBe("no-view");
  });

  it("disabling the plugin turns the tab into the text editor", async () => {
    await boot();
    disk.set("/ws/todo.board", "card one");
    await store().openFile("/ws/todo.board");
    await usePluginsStore.getState().ensureFileLeaf(tab().id, tab().location as never);
    const id = tab().id;
    await usePluginsStore.getState().setEnabled("fv", false);
    await vi.waitFor(() => expect(tab().location.kind).toBe("file"));
    expect(tab().id).toBe(id);
    expect(usePluginsStore.getState().fileLeaves.has(id)).toBe(false);
  });

  it("keeps the tab's kind when the whole host goes away", async () => {
    await boot();
    await store().openFile("/ws/todo.board");
    await usePluginsStore.getState().ensureFileLeaf(tab().id, tab().location as never);
    await usePluginsStore.getState().detach();
    expect(tab().location.kind).toBe("plugin-file");
  });
});

describe("Open as markdown and back", () => {
  async function openBoardNote() {
    const t = await boot();
    disk.set("/ws/boardnote.md", BOARD_NOTE);
    await store().openFile("/ws/boardnote.md");
    expect(tab().location.kind).toBe("plugin-file");
    await usePluginsStore.getState().ensureFileLeaf(tab().id, tab().location as never);
    return t;
  }

  it("a view asking for markdown turns its tab into the text editor, saving first", async () => {
    const t = await openBoardNote();
    const id = tab().id;
    const leaf = leafOf(id)!;
    expect(seen.patched).toContain("boardnote.md");
    (leaf.view as any).text = "---\nboard-plugin: true\n---\n# edited in the view\n";
    (leaf.view as any).requestSave();
    // The plugin's own "open as markdown" mode flag (what Excalidraw's patch consults).
    (t.host().getPlugin("fv") as any).modes["boardnote.md"] = "markdown";
    disk.set("/ws/boardnote.md", "(read from disk by the editor)");
    await leaf.setViewState({ type: "markdown", state: { file: "boardnote.md", mode: "source" } });
    expect(tab().id).toBe(id);
    expect(tab().location).toEqual({ kind: "file", path: "/ws/boardnote.md" });
    // The view was unloaded (and flushed) before the tab changed.
    expect(t.io.files.get("boardnote.md")).toContain("edited in the view");
    expect(store().openFiles.has("/ws/boardnote.md")).toBe(true);
    await vi.waitFor(() => expect(leaf.detached).toBe(true));
    expect(usePluginsStore.getState().fileLeaves.has(id)).toBe(false);
  });

  it("the note editor asking for the view turns the tab back into the plugin view", async () => {
    const t = await openBoardNote();
    const id = tab().id;
    (t.host().getPlugin("fv") as any).modes["boardnote.md"] = "markdown";
    await leafOf(id)!.setViewState({ type: "markdown", state: { file: "boardnote.md" } });
    expect(tab().location.kind).toBe("file");
    const ws = t.host().app.workspace;
    await vi.waitFor(() => expect(ws.getActiveFile()?.path).toBe("boardnote.md"));
    // `getLeaf()` is the note editor's leaf now, like Obsidian's active leaf.
    (t.host().getPlugin("fv") as any).modes["boardnote.md"] = "board";
    const editorLeaf = ws.getLeaf();
    expect(ws.isEditorLeaf(editorLeaf)).toBe(true);
    await editorLeaf.setViewState({ type: "board", state: { file: "boardnote.md" } });
    expect(tab().id).toBe(id);
    expect(tab().location).toEqual({
      kind: "plugin-file",
      path: "/ws/boardnote.md",
      viewType: "board",
    });
    const again = leafOf(id)!;
    expect(again.view.getViewType()).toBe("board");
    expect((again.view as TextFileView).file?.path).toBe("boardnote.md");
  });
});

describe("a leaf a plugin opens itself", () => {
  it("getLeaf('tab') + setViewState({type, state: {file}}) becomes a persistable file tab", async () => {
    const t = await boot();
    const leaf = t.host().app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: "board", state: { file: "todo.board" }, active: true });
    expect(tab().location).toEqual({
      kind: "plugin-file",
      path: "/ws/todo.board",
      viewType: "board",
    });
    expect(leaf.tabId).toBe(tab().id);
    expect(leafOf(tab().id)).toBe(leaf);
    expect(serializeLocation(tab().location)).not.toBeNull();
    // The tab body's own request finds the adopted leaf instead of opening a second view.
    await usePluginsStore.getState().ensureFileLeaf(tab().id, tab().location as never);
    expect(t.host().app.workspace.getLeavesOfType("board")).toEqual([leaf]);
    store().closeTab(tab().id);
    expect(leaf.detached).toBe(true);
  });
});

describe("prototype patching reaches the host classes", () => {
  it("a plugin's patches of Workspace.prototype.getLeaf and WorkspaceLeaf.prototype.setViewState run, and are undone on unload", async () => {
    const t = await boot();
    const patchedSet = WorkspaceLeaf.prototype.setViewState;
    t.host().app.workspace.getLeaf(true);
    expect(seen.patched).toContain("getLeaf");
    await usePluginsStore.getState().setEnabled("fv", false);
    expect(WorkspaceLeaf.prototype.setViewState).not.toBe(patchedSet);
    seen.patched.length = 0;
    t.host().app.workspace.getLeaf(true);
    expect(seen.patched).not.toContain("getLeaf");
  });
});
