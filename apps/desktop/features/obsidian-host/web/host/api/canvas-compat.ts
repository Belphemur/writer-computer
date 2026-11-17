// A stand-in for Obsidian's core "Canvas" plugin, only as far as community plugins reach into it.
//
// Excalidraw embeds a note inside a drawing by asking the core Canvas plugin for a canvas view and
// creating a file node on it (`app.internalPlugins.plugins.canvas.views.canvas(leaf).canvas
// .createFileNode({file, subpath})`), then moving that node's `containerEl` into its own element.
// Its view setup stops at `canvasNodeFactory.initialize()` when that fails, so the whole drawing
// view would be half set up. Writer has no Canvas plugin: this shim lets that initialization
// succeed and shows an embedded note READ-ONLY, rendered through the host's markdown renderer
// (`isEditable()` is false, so the plugin never starts editing it). Public API only: the shapes
// are those the Excalidraw plugin calls, nothing of Obsidian's Canvas code is involved.
import { createEl } from "./dom";
import { MarkdownRenderer } from "./markdown";
import { Component } from "./core";
import type { App } from "./app";
import type { TFile } from "./vault";

export class CanvasFileNodeStub {
  containerEl: HTMLElement;
  /** The editor child Excalidraw peeks at while editing; there is never an editor here. */
  child = { editor: null as unknown, showPreview(): void {} };
  isEditing = false;
  file: TFile | null;
  subpath: string;
  private readonly component = new Component();
  private rendering = 0;

  constructor(
    private readonly app: App,
    options: { file: TFile; subpath?: string },
  ) {
    this.file = options.file;
    this.subpath = options.subpath ?? "";
    this.containerEl = createEl("div", { cls: ["canvas-node-container", "markdown-embed"] });
    this.component.load();
  }

  setFilePath(path: string, subpath = ""): void {
    this.file = this.app.vault.getFileByPath(path);
    this.subpath = subpath;
  }

  /** Renders the note into `containerEl` (async; a newer render wins). */
  render(): void {
    const file = this.file;
    const ticket = ++this.rendering;
    const host = createEl("div", { cls: "markdown-embed-content" });
    this.containerEl.replaceChildren(host);
    if (!file) return;
    void this.app.vault
      .cachedRead(file)
      .then(async (text) => {
        if (ticket !== this.rendering) return;
        await MarkdownRenderer.render(this.app, text, host, file.path, this.component);
      })
      .catch((e) => console.error("[plugin] embedded note render failed:", e));
  }

  isEditable(): boolean {
    return false;
  }
  startEditing(): void {}
  destroy(): void {
    this.rendering++;
    this.component.unload();
    this.containerEl.remove();
  }
}

export class CanvasStub {
  readonly nodes = new Map<string, CanvasFileNodeStub>();
  constructor(private readonly app: App) {}
  createFileNode(options: { file: TFile; subpath?: string }): CanvasFileNodeStub {
    const node = new CanvasFileNodeStub(this.app, options);
    this.nodes.set(String(this.nodes.size), node);
    return node;
  }
  removeNode(node: CanvasFileNodeStub): void {
    node.destroy();
    for (const [k, v] of this.nodes) if (v === node) this.nodes.delete(k);
  }
}

/** `app.internalPlugins.plugins.canvas`: just enough of a loaded internal plugin. */
export function createCanvasPluginStub(app: () => App) {
  return {
    id: "canvas",
    enabled: true,
    _loaded: true,
    instance: {},
    load: async (): Promise<void> => {},
    views: { canvas: (_leaf: unknown) => ({ canvas: new CanvasStub(app()) }) },
  };
}
