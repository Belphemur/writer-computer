// @vitest-environment jsdom
// Markdown processors community plugins register: the registry (stored per plugin, ordered by
// sort order, dropped with the plugin) and the live editor path (a SYNTHETIC fixture plugin's
// code block and post processors in a real CodeMirror view). All data is invented.
import { EditorSelection, EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { EditorView } from "@codemirror/view";
import { GFM } from "@lezer/markdown";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

if (!Range.prototype.getClientRects) {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
}
if (!Range.prototype.getBoundingClientRect) {
  Range.prototype.getBoundingClientRect = () =>
    ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }) as DOMRect;
}

import {
  PLUGIN_BLOCK_DEBOUNCE_MS,
  pluginMarkdownDecorations,
} from "../web/plugin-markdown-decorations";
import { editorNotePath } from "@/lib/editor-views";
import { PluginHost, type ScriptLoader } from "../web/host/loader";
import {
  findCodeBlockProcessor,
  fenceLanguage,
  listPostProcessors,
  pool,
  resetMarkdownProcessorCaches,
} from "../web/host/markdown-processors";
import { createMemoryVaultIo, FakeHostIpc } from "../web/host/testing";
import { prosemarkMarkdownSyntaxExtensions } from "@/lib/prosemark-core/main";
import { withFullParse } from "@tests/helpers/parsed-state";

type Req = (name: string) => any;
const g = globalThis as unknown as {
  __writerPluginDefine: (id: string, factory: unknown) => void;
  __fx: any;
};

const NOTE = "/vault/n.md";
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The fixture plugin: records every call into `globalThis.__fx`. */
function fixtureFactory(module: { exports: any }, _e: any, require: Req) {
  const { Plugin, MarkdownRenderChild } = require("obsidian");
  module.exports = class extends Plugin {
    async onload() {
      const fx = g.__fx;
      this.registerMarkdownCodeBlockProcessor(
        "fx-block",
        async (source: string, el: HTMLElement, ctx: any) => {
          fx.calls.push({ source, sourcePath: ctx.sourcePath, ctx, el });
          await new Promise((r) => setTimeout(r, fx.delay));
          el.textContent = `FX:${source.trim()}`;
          const child = new MarkdownRenderChild(el);
          child.onunload = () => fx.unloaded.push(source.trim());
          ctx.addChild(child);
        },
      );
      this.registerMarkdownCodeBlockProcessor("fx-fail", async () => {
        throw new Error("boom from fixture");
      });
      this.registerMarkdownCodeBlockProcessor("fx-sync-throw", () => {
        throw new Error("sync boom");
      });
      // Dataview registers first and sets the order on the returned function afterwards.
      const late = this.registerMarkdownPostProcessor((el: HTMLElement) => {
        fx.order.push("late");
        for (const code of Array.from(el.querySelectorAll("code"))) {
          const text = code.textContent ?? "";
          if (!text.startsWith("=")) continue;
          const span = document.createElement("span");
          span.className = "fx-inline";
          span.textContent = `RESULT:${text.slice(1)}`;
          code.replaceWith(span);
        }
      });
      (late as any).sortOrder = 5;
      const early = this.registerMarkdownPostProcessor(() => void fx.order.push("early"));
      (early as any).sortOrder = -100;
    }
  };
}

async function bootFixture(): Promise<PluginHost> {
  g.__fx = { calls: [], unloaded: [], order: [], delay: 0 };
  const ipc = new FakeHostIpc({ trusted: true, enabled: ["fx"], plugins: [{ id: "fx" }] });
  const loadScript: ScriptLoader = async (url) => {
    const id = decodeURIComponent(url.split("/")[3]);
    g.__writerPluginDefine(id, (module: any, exports: any, require: Req) =>
      fixtureFactory(module, exports, require),
    );
  };
  const host = new PluginHost({
    ipc,
    io: createMemoryVaultIo({ "n.md": "# n" }),
    loadScript,
    styles: { add: () => () => {} },
  });
  await host.boot();
  return host;
}

describe("processor registry", () => {
  let host: PluginHost;
  beforeEach(async () => {
    host = await bootFixture();
  });
  afterEach(async () => {
    await host.shutdown();
    resetMarkdownProcessorCaches();
  });

  it("stores code block processors per language and finds them by the first info word", () => {
    expect(host.getStatus("fx").state).toBe("enabled");
    expect(findCodeBlockProcessor("fx-block")?.owner).toBe("fx");
    expect(findCodeBlockProcessor("FX-BLOCK")?.language).toBe("fx-block");
    expect(findCodeBlockProcessor("nothing")).toBeNull();
    expect(fenceLanguage('fx-block title="x"')).toBe("fx-block");
  });

  it("orders post processors by the sortOrder property read at lookup time", async () => {
    const [first, second] = listPostProcessors();
    expect(listPostProcessors()).toHaveLength(2);
    first.fn(document.createElement("div"), {});
    second.fn(document.createElement("div"), {});
    expect(g.__fx.order).toEqual(["early", "late"]);
  });

  it("removes everything with the plugin", async () => {
    await host.disable("fx");
    expect(findCodeBlockProcessor("fx-block")).toBeNull();
    expect(listPostProcessors()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------

function stateOf(doc: string, anchor = 0) {
  return withFullParse(
    EditorState.create({
      doc,
      selection: EditorSelection.single(anchor),
      extensions: [
        markdown({ extensions: [GFM, prosemarkMarkdownSyntaxExtensions] }),
        editorNotePath.of(() => NOTE),
        pluginMarkdownDecorations(),
      ],
    }),
  );
}

function mount(doc: string, anchor = 0) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ parent, state: stateOf(doc, anchor) });
  return {
    view,
    cleanup: () => {
      view.destroy();
      parent.remove();
    },
  };
}

const blockEl = (view: EditorView) => view.dom.querySelector<HTMLElement>(".cm-plugin-block");
const DOC = "intro\n\n```fx-block\nhello\n```\n\noutro";

describe("code blocks in the live editor", () => {
  let host: PluginHost;
  let view: EditorView;
  let cleanup: () => void;
  beforeEach(async () => {
    host = await bootFixture();
  });
  afterEach(async () => {
    cleanup?.();
    await host.shutdown();
    resetMarkdownProcessorCaches();
  });

  const open = (doc: string, anchor = 0) => {
    ({ view, cleanup } = mount(doc, anchor));
  };

  it("renders a widget for the fenced block and hands the processor a real context", async () => {
    open(DOC);
    await wait(20);
    const el = blockEl(view)!;
    expect(el.textContent).toContain("FX:hello");
    expect(view.dom.textContent).not.toContain("```fx-block");
    const call = g.__fx.calls[0];
    expect(call.source).toBe("hello");
    expect(call.sourcePath).toBe("n.md");
    expect(call.ctx.getSectionInfo(call.el)).toEqual({ text: DOC, lineStart: 2, lineEnd: 4 });
    expect(call.ctx.docId).toBe("n.md");
  });

  it("supports async handlers: the widget exists immediately, content arrives later", async () => {
    g.__fx.delay = 60;
    open(DOC);
    expect(blockEl(view)).not.toBeNull();
    expect(blockEl(view)!.textContent).not.toContain("FX:hello");
    await wait(120);
    expect(blockEl(view)!.textContent).toContain("FX:hello");
  });

  it("shows a readable error box for a rejecting and a throwing handler, never crashing", async () => {
    open("```fx-fail\nx\n```\n\n```fx-sync-throw\ny\n```");
    await wait(20);
    const boxes = view.dom.querySelectorAll(".writer-plugin-block-error");
    expect(boxes).toHaveLength(2);
    expect(boxes[0].textContent).toContain("boom from fixture");
    expect(boxes[1].textContent).toContain("sync boom");
    expect(view.dom.isConnected).toBe(true);
  });

  it("does not render an unclosed or empty fence", async () => {
    open("```fx-block\nhello\n");
    await wait(20);
    expect(blockEl(view)).toBeNull();
    cleanup();
    open("```fx-block\n```\n");
    await wait(20);
    expect(blockEl(view)).toBeNull();
  });

  it("shows the raw source (widget stays below) while the caret is inside, and re-runs after a pause", async () => {
    open(DOC);
    await wait(20);
    const before = g.__fx.calls.length;
    view.dispatch({ selection: EditorSelection.single(DOC.indexOf("hello") + 2) });
    expect(view.dom.textContent).toContain("```fx-block");
    expect(blockEl(view)).not.toBeNull();
    // The block was parked and reused: entering edit mode did not re-run the processor.
    expect(g.__fx.calls.length).toBe(before);

    view.dispatch({ changes: { from: DOC.indexOf("hello") + 5, insert: "!" } });
    expect(g.__fx.calls.length).toBe(before); // debounced
    await wait(PLUGIN_BLOCK_DEBOUNCE_MS + 80);
    expect(g.__fx.calls.length).toBe(before + 1);
    expect(blockEl(view)!.textContent).toContain("FX:hello!");
  });

  it("does not re-run on unrelated edits, and unloads the added child when the widget goes", async () => {
    open(DOC);
    await wait(20);
    view.dispatch({ changes: { from: 0, insert: "typed " } });
    await wait(20);
    expect(g.__fx.calls).toHaveLength(1);
    // Remove the fence: widget destroyed, mount parked then disposed by clearing the pool.
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "plain" } });
    pool.clear();
    expect(g.__fx.unloaded).toEqual(["hello"]);
  });

  it("reuses a parked render when the same block scrolls back", async () => {
    open(DOC);
    await wait(20);
    view.dispatch({ selection: EditorSelection.single(DOC.indexOf("hello") + 1) });
    view.dispatch({ selection: EditorSelection.single(0) });
    await wait(20);
    expect(g.__fx.calls).toHaveLength(1);
    expect(blockEl(view)!.textContent).toContain("FX:hello");
  });

  it("drops the widget and unloads its children when the plugin is disabled", async () => {
    open(DOC);
    await wait(20);
    expect(blockEl(view)).not.toBeNull();
    await host.disable("fx");
    await wait(20);
    expect(blockEl(view)).toBeNull();
    expect(view.dom.textContent).toContain("```fx-block");
    expect(g.__fx.unloaded).toEqual(["hello"]);
  });

  it("the Edit button range-selects the block", async () => {
    open(DOC);
    await wait(20);
    blockEl(view)!.querySelector<HTMLButtonElement>(".cm-plugin-block-edit")!.click();
    const sel = view.state.selection.main;
    expect(view.state.doc.sliceString(sel.from, sel.to)).toBe("```fx-block\nhello\n```");
  });
});

describe("inline code in the live editor", () => {
  let host: PluginHost;
  let view: EditorView;
  let cleanup: () => void;
  beforeEach(async () => {
    host = await bootFixture();
  });
  afterEach(async () => {
    cleanup?.();
    await host.shutdown();
    resetMarkdownProcessorCaches();
  });

  const doc = "start `=this.file.name` mid `plain code` end";

  it("renders a post-processed inline code span, leaves ordinary code alone, shows raw under the caret", async () => {
    ({ view, cleanup } = mount(doc, doc.length));
    await wait(450);
    const inlines = view.dom.querySelectorAll(".cm-plugin-inline");
    expect(inlines).toHaveLength(1);
    expect(inlines[0].textContent).toBe("RESULT:this.file.name");
    expect(view.dom.textContent).toContain("plain code");
    expect(view.dom.textContent).not.toContain("`=this.file.name`");

    view.dispatch({ selection: EditorSelection.single(doc.indexOf("this.file") + 2) });
    expect(view.dom.querySelector(".cm-plugin-inline")).toBeNull();
    expect(view.dom.textContent).toContain("=this.file.name");
  });
});

// Keep the linter honest about unused helpers.
void vi;
