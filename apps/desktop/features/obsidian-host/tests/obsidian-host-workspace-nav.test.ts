// @vitest-environment jsdom
// Workspace leaf placement, opening notes in the main editor, and the active-note events the
// Copilot plugin relies on (bugs B, C, D found with the unmodified plugin).
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createApp, type App } from "../web/host/api/app";
import { createHostServices } from "../web/host/api/core";
import { createMemoryVaultIo } from "../web/host/testing";
import {
  detachedBridge,
  ItemView,
  MarkdownView,
  type WorkspaceBridge,
  type WorkspaceLeaf,
} from "../web/host/api/views";
import { TFile } from "../web/host/api/vault";

class DiffView extends ItemView {
  getViewType() {
    return "diff";
  }
  getDisplayText() {
    return "Diff";
  }
}

interface Rig {
  app: App;
  io: ReturnType<typeof createMemoryVaultIo>;
  opened: { path: string; newLeaf: boolean }[];
  mounted: { leaf: WorkspaceLeaf; placement: string }[];
  state: { active: string | null; pluginLeaf: WorkspaceLeaf | null };
}

async function makeRig(files: Record<string, string>): Promise<Rig> {
  const io = createMemoryVaultIo(files);
  const rig = {
    io,
    opened: [] as Rig["opened"],
    mounted: [] as Rig["mounted"],
    state: { active: null as string | null, pluginLeaf: null as WorkspaceLeaf | null },
  } as Rig;
  const bridge: WorkspaceBridge = {
    ...detachedBridge,
    mountLeaf: (leaf, placement) => void rig.mounted.push({ leaf, placement }),
    getActiveFilePath: () => rig.state.active,
    getActiveEditor: () => (rig.state.active ? stubEditor() : null),
    getActivePluginLeaf: () => rig.state.pluginLeaf,
    reapplyEditorOptions: () => {},
    openFile: async (path, opts) => void rig.opened.push({ path, ...opts }),
  };
  rig.app = createApp({
    io,
    services: createHostServices({ read: async () => null, write: async () => {} }),
    bridge,
  });
  await rig.app.vault.load();
  return rig;
}

function stubEditor() {
  return {
    getValue: () => "",
    replaceRange() {},
    getSelections: () => [],
    setSelections() {},
    focus() {},
  };
}

describe("getLeaf placement", () => {
  let rig: Rig;
  beforeEach(async () => {
    rig = await makeRig({ "a.md": "A", "b.md": "B" });
  });

  it("getLeaf(true | 'tab' | 'split' | 'window') makes a pending main-area leaf", () => {
    for (const kind of [true, "tab", "split", "window"] as const) {
      const leaf = rig.app.workspace.getLeaf(kind);
      expect(leaf.placement).toBe("main");
      expect(leaf.pendingNewTab).toBe(true);
    }
    expect(rig.mounted.every((m) => m.placement === "main")).toBe(true);
  });

  it("getRightLeaf / getLeftLeaf stay side leaves", () => {
    expect(rig.app.workspace.getRightLeaf(false).placement).toBe("right");
    expect(rig.app.workspace.getLeftLeaf(false).placement).toBe("left");
  });

  it("getLeaf() reuses the editor leaf of the active note", async () => {
    rig.state.active = "a.md";
    const a = rig.app.workspace.getLeaf();
    expect(a.view).toBeInstanceOf(MarkdownView);
    expect(a.getViewState().state?.file).toBe("a.md");
    expect(rig.app.workspace.getLeaf(false)).toBe(a);
    expect(rig.mounted).toHaveLength(0);
  });

  it("leaf.getRoot() distinguishes side splits from the main area", () => {
    const ws = rig.app.workspace;
    expect(ws.getRightLeaf(false).getRoot()).toBe(ws.rightSplit);
    expect(ws.getLeftLeaf(false).getRoot()).toBe(ws.leftSplit);
    expect(ws.getLeaf(true).getRoot()).toBe(ws.rootSplit);
  });

  it("a view opened in a main leaf keeps main placement and announces itself", async () => {
    const ws = rig.app.workspace;
    ws.registerView("diff", (leaf) => new DiffView(leaf));
    const changed = vi.spyOn(ws.bridge, "leafChanged");
    const leaf = ws.getLeaf(true);
    await leaf.setViewState({ type: "diff", active: true });
    expect(leaf.placement).toBe("main");
    expect(changed).toHaveBeenCalledWith(leaf);
    expect(ws.getLeavesOfType("diff")).toEqual([leaf]);
  });
});

describe("opening notes in the main editor", () => {
  let rig: Rig;
  beforeEach(async () => {
    rig = await makeRig({ "a.md": "A", "b.md": "B", "dir/c.md": "C" });
  });
  const file = (p: string) => rig.app.vault.getFileByPath(p) as TFile;

  it("getLeaf(true).openFile opens a new tab and drops the empty leaf", async () => {
    const leaf = rig.app.workspace.getLeaf(true);
    await leaf.openFile(file("b.md"));
    expect(rig.opened).toEqual([{ path: "b.md", newLeaf: true }]);
    expect(leaf.detached).toBe(true);
  });

  it("getLeaf().openFile reuses the current tab", async () => {
    rig.state.active = "a.md";
    await rig.app.workspace.getLeaf().openFile(file("b.md"));
    expect(rig.opened).toEqual([{ path: "b.md", newLeaf: false }]);
  });

  it("openLinkText honours newLeaf (true, 'tab', 'split', false)", async () => {
    const ws = rig.app.workspace;
    await ws.openLinkText("b", "", "tab");
    await ws.openLinkText("c", "a.md", true);
    await ws.openLinkText("a", "", "split");
    await ws.openLinkText("a#Heading", "", false);
    expect(rig.opened).toEqual([
      { path: "b.md", newLeaf: true },
      { path: "dir/c.md", newLeaf: true },
      { path: "a.md", newLeaf: true },
      { path: "a.md", newLeaf: false },
    ]);
  });

  it("openLinkText to a missing note rejects explicitly", async () => {
    await expect(rig.app.workspace.openLinkText("nope", "", "tab")).rejects.toThrow(/no such note/);
  });

  it('setViewState({type: "markdown", state: {file}}) opens the note', async () => {
    rig.state.active = "a.md";
    const leaf = rig.app.workspace.getLeaf();
    await leaf.setViewState({ type: "markdown", state: { file: "b.md" } });
    expect(rig.opened).toEqual([{ path: "b.md", newLeaf: false }]);
    await expect(leaf.setViewState({ type: "markdown" })).rejects.toThrow(/state\.file/);
  });

  it("a leaf kept by the plugin lists in iterateAllLeaves with getRoot and state.file", () => {
    rig.state.active = "a.md";
    const seen: { file: unknown; root: unknown }[] = [];
    rig.app.workspace.iterateAllLeaves((l) =>
      seen.push({ file: l.getViewState().state?.file, root: l.getRoot() }),
    );
    expect(seen).toEqual([{ file: "a.md", root: rig.app.workspace.rootSplit }]);
  });
});

describe("active note follows Writer's navigation", () => {
  let rig: Rig;
  let events: string[];
  beforeEach(async () => {
    rig = await makeRig({ "a.md": "A", "b.md": "B" });
    events = [];
    const ws = rig.app.workspace;
    ws.on("file-open", (f) => events.push(`file-open:${f?.path ?? null}`));
    ws.on("active-leaf-change", (l) =>
      events.push(
        `leaf:${l === null ? "null" : l.view instanceof MarkdownView ? `md(${l.view.file?.path})` : l.view.getViewType()}`,
      ),
    );
    ws.on("layout-change", () => events.push("layout"));
  });

  it("emits file-open, active-leaf-change and layout-change once per navigation", async () => {
    const ws = rig.app.workspace;
    rig.state.active = "a.md";
    await ws.syncActiveDocument();
    await ws.syncActiveDocument(); // duplicate store notifications are deduped
    expect(events).toEqual(["file-open:a.md", "leaf:md(a.md)", "layout"]);
    expect(ws.getActiveFile()?.path).toBe("a.md");
    expect(ws.getActiveViewOfType(MarkdownView)?.file?.path).toBe("a.md");

    events.length = 0;
    rig.state.active = "b.md";
    await ws.syncActiveDocument();
    expect(events).toEqual(["file-open:b.md", "leaf:md(b.md)", "layout"]);
    expect(ws.getActiveFile()?.path).toBe("b.md");
    expect(ws.activeLeaf?.view).toBeInstanceOf(MarkdownView);
    const view = ws.activeLeaf?.view as MarkdownView | undefined;
    expect(view?.file?.path).toBe("b.md");
  });

  it("fires file-open(null) and active-leaf-change(null) when no file is open", async () => {
    const ws = rig.app.workspace;
    rig.state.active = "a.md";
    await ws.syncActiveDocument();
    events.length = 0;
    rig.state.active = null;
    await ws.syncActiveDocument();
    expect(events).toEqual(["file-open:null", "leaf:null", "layout"]);
    expect(ws.getActiveFile()).toBeNull();
    expect(ws.getActiveViewOfType(MarkdownView)).toBeNull();
  });

  it("the active plugin tab becomes the active leaf without a file-open for the same note", async () => {
    const ws = rig.app.workspace;
    ws.registerView("diff", (leaf) => new DiffView(leaf));
    rig.state.active = "a.md";
    await ws.syncActiveDocument();
    const leaf = ws.getLeaf(true);
    await leaf.setViewState({ type: "diff" });
    events.length = 0;
    rig.state.pluginLeaf = leaf;
    await ws.syncActiveDocument();
    expect(events).toEqual(["leaf:diff", "layout"]);
    expect(ws.activeLeaf).toBe(leaf);
  });

  it("indexes a note Writer just created before announcing it", async () => {
    const ws = rig.app.workspace;
    rig.io.files.set("new.md", "N");
    rig.state.active = "new.md";
    await ws.syncActiveDocument();
    expect(events[0]).toBe("file-open:new.md");
    expect(ws.getActiveFile()?.path).toBe("new.md");
  });

  it("a superseded sync does not emit stale events", async () => {
    const ws = rig.app.workspace;
    rig.io.files.set("slow.md", "S");
    rig.state.active = "slow.md";
    const first = ws.syncActiveDocument();
    rig.state.active = "b.md";
    await Promise.all([first, ws.syncActiveDocument()]);
    expect(events.filter((e) => e.startsWith("file-open"))).toEqual(["file-open:b.md"]);
  });

  it("editor.cm and the editor follow the live backend (never stale)", async () => {
    const ws = rig.app.workspace;
    rig.state.active = "a.md";
    await ws.syncActiveDocument();
    const view = ws.getActiveViewOfType(MarkdownView) as MarkdownView;
    expect(view.editor.cm).toBeNull();
    expect(view.editor.getValue()).toBe("");
  });
});
