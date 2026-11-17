// @vitest-environment jsdom
import { describe, expect, it, vi } from "vite-plus/test";
import { EditorState, Facet, type EditorStateConfig } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { Editor } from "../web/host/api/views";
import {
  createWorkspaceBridge,
  toAbsolutePath,
  toVaultPath,
  type AppWorkspace,
  type PluginPane,
} from "../web/host/workspace-bridge";
import {
  editorBackendFor,
  getPluginEditorExtensions,
  pluginExtensionCompartment,
  setPluginEditorExtensions,
} from "../web/host/editor-bridge";
import { findEditorView, registerEditorView } from "@/lib/editor-views";

function makePane() {
  const fns = {
    mountLeaf: vi.fn(),
    revealLeaf: vi.fn(),
    leafChanged: vi.fn(),
    detachLeaf: vi.fn(),
    activePluginLeaf: vi.fn(() => null),
  };
  const pane: PluginPane = { ...fns };
  return { fns, pane };
}

function makeView(doc: string, extra: EditorStateConfig = {}) {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  return new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [pluginExtensionCompartment.of([])],
      ...extra,
    }),
  });
}

describe("path mapping", () => {
  it("maps between absolute and vault-relative paths", () => {
    expect(toVaultPath("/ws", "/ws/notes/a.md")).toBe("notes/a.md");
    expect(toVaultPath("/ws/", "/ws/a.md")).toBe("a.md");
    expect(toVaultPath("/ws", "/wsx/a.md")).toBeNull();
    expect(toVaultPath("/ws", "/other/a.md")).toBeNull();
    expect(toAbsolutePath("/ws/", "/notes/a.md")).toBe("/ws/notes/a.md");
  });
});

describe("createWorkspaceBridge", () => {
  function setup(over: Partial<AppWorkspace> = {}) {
    const openFile = vi.fn(async () => {});
    const app: AppWorkspace = {
      getRoot: () => "/ws",
      getActiveFilePath: () => "/ws/notes/a.md",
      getEditorView: () => null,
      openFile,
      ...over,
    };
    const { fns, pane } = makePane();
    return { app, openFile, pane: fns, bridge: createWorkspaceBridge(app, pane) };
  }

  it("reports the active file relative to the vault", () => {
    expect(setup().bridge.getActiveFilePath()).toBe("notes/a.md");
    expect(setup({ getRoot: () => null }).bridge.getActiveFilePath()).toBeNull();
    expect(
      setup({ getActiveFilePath: () => "/elsewhere/x.md" }).bridge.getActiveFilePath(),
    ).toBeNull();
  });

  it("opens vault paths as absolute paths, and refuses without a workspace", async () => {
    const { openFile, bridge } = setup();
    await bridge.openFile("notes/b.md", { newLeaf: true });
    expect(openFile).toHaveBeenCalledWith("/ws/notes/b.md", { newLeaf: true });
    const none = setup({ getRoot: () => null });
    await expect(none.bridge.openFile("x.md", { newLeaf: false })).rejects.toThrow(/no workspace/);
  });

  it("forwards leaf events to the pane", () => {
    const { pane, bridge } = setup();
    const leaf = {} as never;
    bridge.mountLeaf(leaf, "right");
    bridge.revealLeaf(leaf);
    bridge.leafChanged(leaf);
    bridge.detachLeaf(leaf);
    expect(pane.mountLeaf).toHaveBeenCalledWith(leaf, "right");
    expect(pane.revealLeaf).toHaveBeenCalledWith(leaf);
    expect(pane.leafChanged).toHaveBeenCalledWith(leaf);
    expect(pane.detachLeaf).toHaveBeenCalledWith(leaf);
  });

  it("gives plugins the active CodeMirror view as editor.cm and edits through it", () => {
    const view = makeView("hello world");
    const { bridge } = setup({ getEditorView: () => view });
    const backend = bridge.getActiveEditor()!;
    const editor = new Editor(backend);
    expect(editor.cm).toBe(view);
    expect(editor.getValue()).toBe("hello world");
    editor.replaceRange("HELLO", { line: 0, ch: 0 }, { line: 0, ch: 5 });
    expect(view.state.doc.toString()).toBe("HELLO world");
    editor.setSelection({ line: 0, ch: 6 }, { line: 0, ch: 11 });
    expect(editor.getSelection()).toBe("world");
    view.destroy();
  });

  it("has no editor when no view shows the active file", () => {
    expect(setup().bridge.getActiveEditor()).toBeNull();
  });
});

describe("editor view registry and plugin extensions", () => {
  it("finds the view for a path and forgets it on unregister", () => {
    const view = makeView("x");
    const off = registerEditorView(view, () => "/ws/a.md");
    expect(findEditorView("/ws/a.md")).toBe(view);
    expect(findEditorView("/ws/b.md")).toBeNull();
    expect(findEditorView(null)).toBeNull();
    off();
    expect(findEditorView("/ws/a.md")).toBeNull();
    view.destroy();
  });

  it("prefers the visible pane when two panes show one file", () => {
    const hidden = makeView("x");
    const shown = makeView("x");
    const pane = document.createElement("div");
    pane.setAttribute("data-pane", "");
    pane.className = "invisible";
    hidden.dom.parentElement!.replaceWith(pane);
    pane.appendChild(hidden.dom);
    const offA = registerEditorView(hidden, () => "/ws/a.md");
    const offB = registerEditorView(shown, () => "/ws/a.md");
    expect(findEditorView("/ws/a.md")).toBe(shown);
    offA();
    offB();
    hidden.destroy();
    shown.destroy();
  });

  it("reconfigures every live view, and clears them again", () => {
    const facet = Facet.define<number, number>({ combine: (v) => v.length });
    const view = makeView("x");
    const off = registerEditorView(view, () => "/ws/a.md");
    expect(view.state.facet(facet)).toBe(0);
    expect(setPluginEditorExtensions([facet.of(1)])).toBeNull();
    expect(view.state.facet(facet)).toBe(1);
    expect(getPluginEditorExtensions()).toHaveLength(1);
    setPluginEditorExtensions([]);
    expect(view.state.facet(facet)).toBe(0);
    off();
    view.destroy();
  });

  it("survives an invalid plugin extension: resets the view and reports the error", () => {
    const view = makeView("x");
    const off = registerEditorView(view, () => "/ws/a.md");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = setPluginEditorExtensions([{ nonsense: true } as never]);
    expect(failure).toBeInstanceOf(Error);
    expect(getPluginEditorExtensions()).toEqual([]);
    view.dispatch({ changes: { from: 0, insert: "ok" } });
    expect(view.state.doc.toString()).toBe("okx");
    spy.mockRestore();
    off();
    view.destroy();
  });

  it("editorBackendFor clamps selections and ignores empty input", () => {
    const view = makeView("abc");
    const backend = editorBackendFor(view);
    backend.setSelections([]);
    backend.setSelections([{ anchor: -5, head: 99 }]);
    expect(backend.getSelections()).toEqual([{ anchor: 0, head: 3 }]);
    view.destroy();
  });
});
