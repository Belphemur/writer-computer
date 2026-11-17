// @vitest-environment jsdom
// Read-only integration test: loads the REAL installed Dataview bundle (third-party plugin, never
// modified) through PluginHost against a SYNTHETIC in-memory vault, waits for its index, and
// renders ```dataview / ```dataviewjs blocks and inline queries through the editor widget path.
// Skipped when the bundle is not on disk. Nothing from the user's vault is read except the bundle.
import { existsSync, readFileSync } from "node:fs";
import { EditorSelection, EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { EditorView } from "@codemirror/view";
import { GFM } from "@lezer/markdown";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

if (!Range.prototype.getClientRects) {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
}
if (!Range.prototype.getBoundingClientRect) {
  Range.prototype.getBoundingClientRect = () =>
    ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }) as DOMRect;
}

import { pluginMarkdownDecorations } from "../web/plugin-markdown-decorations";
import { editorNotePath } from "@/lib/editor-views";
import { PluginHost, type ScriptLoader } from "../web/host/loader";
import { resetMarkdownProcessorCaches } from "../web/host/markdown-processors";
import { createMemoryVaultIo, FakeHostIpc } from "../web/host/testing";
import { prosemarkMarkdownSyntaxExtensions } from "@/lib/prosemark-core/main";
import { withFullParse } from "@tests/helpers/parsed-state";

const BUNDLE_DIR = "/Users/antoinea/Documents/Vault/PersonalVault/.obsidian/plugins/dataview";
const hasBundle = existsSync(`${BUNDLE_DIR}/main.js`) && existsSync(`${BUNDLE_DIR}/manifest.json`);

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting for condition");
    await wait(25);
  }
}

const HOME = [
  "---",
  "title: Home",
  "---",
  "# Home",
  "",
  "```dataview",
  'TABLE status, owner FROM "Projects" SORT file.name ASC',
  "```",
  "",
  "```dataview",
  'TASK FROM "Projects" WHERE !completed',
  "```",
  "",
  "```dataviewjs",
  "dv.paragraph('pages=' + dv.pages('\"Projects\"').length + ' current=' + dv.current().file.name);",
  "```",
  "",
  "Inline: `=this.file.name` and `$=dv.pages('\"Projects\"').length` and `plain`.",
].join("\n");

const NOTES: Record<string, string> = {
  "Home.md": HOME,
  "Projects/Alpha.md":
    "---\nstatus: active\nowner: Ada\ntags: [project]\n---\n# Alpha\n\n- [ ] ship alpha\n- [x] draft alpha\n\nrating:: 4\nSee [[Beta]].\n",
  "Projects/Beta.md":
    "---\nstatus: done\nowner: Bob\ntags: [project]\n---\n# Beta\n\n- [ ] review beta #todo\n",
  "Projects/Gamma.md": "---\nstatus: active\nowner: Cy\n---\n# Gamma\n\nLinks to [[Alpha]].\n",
};

describe.skipIf(!hasBundle)(
  "real Dataview bundle in the host (synthetic vault)",
  { timeout: 30000 },
  () => {
    let host: PluginHost;
    let view: EditorView;
    let parent: HTMLElement;
    const errors: string[] = [];

    beforeAll(async () => {
      // jsdom has neither blob URLs nor Worker nor IndexedDB; the host shims Worker, the rest is
      // stubbed here (Dataview's persistent cache degrades to "no cache" when storage fails).
      let blobSeq = 0;
      (URL as any).createObjectURL ??= () => `blob:test/${++blobSeq}`;
      (URL as any).revokeObjectURL ??= () => {};
      // jsdom has no layout, hence no innerText (browsers do; Dataview reads it for inline code).
      if (!("innerText" in HTMLElement.prototype)) {
        Object.defineProperty(HTMLElement.prototype, "innerText", {
          get() {
            return this.textContent;
          },
          set(v: string) {
            this.textContent = v;
          },
          configurable: true,
        });
      }
      const origError = console.error;
      console.error = (...args: unknown[]) => {
        errors.push(args.map(String).join(" ").slice(0, 400));
        origError(...args);
      };

      const manifest = JSON.parse(readFileSync(`${BUNDLE_DIR}/manifest.json`, "utf8"));
      const code = readFileSync(`${BUNDLE_DIR}/main.js`, "utf8");
      const ipc = new FakeHostIpc({
        trusted: true,
        enabled: ["dataview"],
        plugins: [{ id: "dataview", ...manifest }],
        // Dataview ships with JavaScript queries off; the writer turns them on in its settings.
        data: {
          dataview: JSON.stringify({ enableDataviewJs: true, enableInlineDataviewJs: true }),
        },
      });
      const loadScript: ScriptLoader = async (url) => {
        const id = decodeURIComponent(url.split("/")[3]);
        (globalThis as any).__writerPluginDefine(id, (...args: unknown[]) => {
          const run = new Function(
            "module",
            "exports",
            "require",
            "process",
            "global",
            "Buffer",
            "Error",
            "__filename",
            "__dirname",
            "SharedArrayBuffer",
            "fetch",
            code,
          );
          run.apply(args[1], args);
        });
      };
      host = new PluginHost({
        ipc,
        io: createMemoryVaultIo(NOTES),
        loadScript,
        styles: { add: () => () => {} },
      });
      await host.boot();
    });

    afterAll(async () => {
      view?.destroy();
      parent?.remove();
      await host?.shutdown();
      resetMarkdownProcessorCaches();
    });

    it("loads and registers its renderers", () => {
      expect(host.getStatus("dataview")).toEqual({ state: "enabled" });
      const kinds = host.services.registrations.list().map((r) => `${r.kind}:${r.key}`);
      expect(kinds).toContain("codeBlockProcessor:dataview");
      expect(kinds).toContain("codeBlockProcessor:dataviewjs");
    });

    it("indexes the synthetic vault", async () => {
      const dv = (host.app as any).plugins.plugins.dataview;
      // jsdom has no IndexedDB, which Dataview's persistent cache needs: give the index an
      // in-memory stand-in for that cache and run its initializer again (in the app the browser's
      // IndexedDB is there from the start).
      const memory = new Map<string, unknown>();
      dv.index.persister = {
        loadFile: async (path: string) => memory.get(path) ?? null,
        storeFile: async (path: string, data: unknown) => void memory.set(path, data),
        synchronize: async () => new Set<string>(),
        allFiles: async () => [...memory.keys()],
      };
      void dv.index._initialize(host.app.vault.getMarkdownFiles());
      await until(() => dv.index?.initialized === true);
      expect(dv.api.pages('"Projects"').length).toBe(3);
    });

    it("renders dataview, dataviewjs and inline queries through the editor widgets", async () => {
      parent = document.createElement("div");
      document.body.append(parent);
      const state = withFullParse(
        EditorState.create({
          doc: HOME,
          selection: EditorSelection.single(0),
          extensions: [
            markdown({ extensions: [GFM, prosemarkMarkdownSyntaxExtensions] }),
            editorNotePath.of(() => "/vault/Home.md"),
            pluginMarkdownDecorations(),
          ],
        }),
      );
      view = new EditorView({ parent, state });
      await until(() => view.dom.querySelectorAll(".cm-plugin-block").length === 3);
      const blocks = Array.from(view.dom.querySelectorAll<HTMLElement>(".cm-plugin-block"));
      await until(() => (blocks[0].textContent ?? "").includes("Alpha"));
      const table = blocks[0].querySelector("table");
      expect(table).not.toBeNull();
      const text = table!.textContent ?? "";
      expect(text).toContain("Alpha");
      expect(text).toContain("Gamma");
      expect(text).toContain("Ada");
      // Tasks come from the metadata cache's `listItems` and `sections`.
      await until(() => (blocks[1].textContent ?? "").includes("ship alpha"));
      expect(blocks[1].textContent).toContain("review beta");
      expect(blocks[1].textContent).not.toContain("draft alpha");
      await until(() => (blocks[2].textContent ?? "").includes("pages="));
      expect(blocks[2].textContent).toContain("pages=3 current=Home");

      await until(() => view.dom.querySelectorAll(".cm-plugin-inline").length === 2);
      await until(() =>
        (view.dom.querySelector(".cm-plugin-inline")?.textContent ?? "").includes("Home"),
      );
      await until(() =>
        (view.dom.querySelectorAll(".cm-plugin-inline")[1]?.textContent ?? "").includes("3"),
      );
      expect(view.dom.textContent).not.toContain("$=dv.pages");
      expect(view.dom.textContent).toContain("plain");
      expect(errors.filter((e) => e.startsWith("[plugin]"))).toEqual([]);
    });
  },
);
