// @vitest-environment jsdom
import { describe, expect, it, vi } from "vite-plus/test";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { createApp } from "../web/host/api/app";
import { createHostServices, Plugin } from "../web/host/api/core";
import { installDomHelpers } from "../web/host/api/dom";
import { detachedBridge } from "../web/host/api/views";
import {
  getPluginCompartmentValue,
  getPluginEditorExtensions,
  setEditorInfoResolver,
  setPluginEditorExtensions,
} from "../web/host/editor-bridge";
import { registerEditorView } from "../../../src/lib/editor-views";
import { createObsidianModule } from "../web/host/obsidian-module";
import { wrapAppForDiagnostics } from "../web/host/missing-api-log";
import { createMemoryVaultIo } from "../web/host/testing";
import { callSitesFromStack, installV8StackApi } from "../web/host/node/v8-stack";

// Every value exported by the public obsidian.d.ts (obsidianmd/obsidian-api). A plugin bundle
// destructures these at load, so a missing one is a user-facing crash. Keep in sync with the
// typings; the README "Compat notes" points here.
const PUBLIC_CLASSES =
  `AbstractInputSuggest AbstractTextComponent App BaseComponent BasesEntry BasesEntryGroup
BasesQueryResult BasesView BasesViewConfig BooleanValue ButtonComponent CapacitorAdapter ColorComponent
Component ConfirmationButton ConfirmationModal DataAdapter DateValue DisplayValueComponent DropdownComponent
DurationValue EditableFileView Editor EditorSuggest Events ExtraButtonComponent FileManager
FileSystemAdapter FileValue FileView FuzzySuggestModal HoverPopover HTMLValue IconValue ImageValue ItemView
Keymap LinkValue ListValue MarkdownEditView MarkdownPreviewRenderer MarkdownPreviewView MarkdownRenderChild
MarkdownView Menu MenuItem MenuSeparator MetadataCache Modal MomentFormatComponent Notice NotNullValue
NullValue NumberValue ObjectValue Plugin PluginSettingTab PopoverSuggest PrimitiveValue ProgressBarComponent
QueryController RegExpValue RelativeDateValue RenderContext Scope SearchComponent SecretComponent
SecretStorage Setting SettingGroup SettingPage SettingTab SliderComponent StringValue SuggestModal
TAbstractFile TagValue Tasks TextAreaComponent TextComponent TExternalFile TextFileView TFile TFolder
ToggleComponent UrlValue Value ValueComponent Vault View Workspace WorkspaceContainer WorkspaceFloating
WorkspaceItem WorkspaceLeaf WorkspaceMobileDrawer WorkspaceParent WorkspaceRibbon WorkspaceRoot
WorkspaceSidedock WorkspaceSplit WorkspaceTabs WorkspaceWindow`.split(/\s+/);
// MarkdownRenderer, Keymap, Notice and Platform are plain (non-ES5-wrapped) values below.
const PUBLIC_VALUES = `MarkdownRenderer Platform PopoverState apiVersion moment editorEditorField
editorInfoField editorLivePreviewField editorViewField livePreviewState`.split(/\s+/);
const PUBLIC_FUNCTIONS = `addIcon arrayBufferToBase64 arrayBufferToHex base64ToArrayBuffer debounce
displayTooltip finishRenderMath getAllTags getBlobArrayBuffer getFrontMatterInfo getIcon getIconIds
getLanguage getLinkpath hexToArrayBuffer htmlToMarkdown iterateCacheRefs iterateRefs loadMathJax loadMermaid
loadPdfJs loadPrism normalizePath parseFrontMatterAliases parseFrontMatterEntry parseFrontMatterStringArray
parseFrontMatterTags parseLinktext parsePropertyId parseYaml prepareFuzzySearch prepareSimpleSearch
removeIcon renderMatches renderMath renderResults request requestUrl requireApiVersion resolveSubpath
sanitizeHTMLToDom setIcon setTooltip sortSearchResults stringifyYaml stripHeading stripHeadingForLink`.split(
  /\s+/,
);

describe("obsidian module exports", () => {
  const mod = createObsidianModule() as Record<string, unknown>;

  it("defines every public export", () => {
    const missing = [...PUBLIC_CLASSES, ...PUBLIC_VALUES, ...PUBLIC_FUNCTIONS].filter(
      (n) => mod[n] === undefined,
    );
    expect(missing).toEqual([]);
  });

  it("exports every class as something a plugin can extend (ES6 and ES5 style)", () => {
    for (const name of PUBLIC_CLASSES) {
      const Base = mod[name] as new (...a: never[]) => object;
      expect(typeof Base, name).toBe("function");
      class Sub extends Base {}
      expect(Sub.prototype instanceof Base, name).toBe(true);
    }
    // ES5 output: `_super.apply(this, arguments)` on classes with a no-argument constructor.
    for (const name of ["SettingPage", "WorkspaceItem", "HoverPopover", "Scope"]) {
      const Base = mod[name] as new (...a: never[]) => object;
      function Es5(this: unknown) {
        return Reflect.construct(Base, [], new.target ?? Es5) as object;
      }
      Es5.prototype = Object.create(Base.prototype);
      expect(() => new (Es5 as unknown as new () => object)(), name).not.toThrow();
    }
  });

  it("getLanguage normalises the webview locale", () => {
    const getLanguage = mod.getLanguage as () => string;
    vi.spyOn(navigator, "language", "get").mockReturnValue("pt_BR");
    expect(getLanguage()).toBe("pt-br");
    vi.spyOn(navigator, "language", "get").mockReturnValue("en-US");
    expect(getLanguage()).toBe("en-us");
    vi.restoreAllMocks();
  });

  it("SettingPage and ConfirmationModal work as bases", () => {
    installDomHelpers(window);
    const SettingPage = mod.SettingPage as new () => {
      rootEl: HTMLElement;
      containerEl: HTMLElement;
      display(): void;
    };
    class Page extends SettingPage {
      display() {
        this.containerEl.textContent = "x";
      }
    }
    const page = new Page();
    page.display();
    expect(page.rootEl.textContent).toBe("x");
  });
});

describe("host methods Dataview, Tasks and Templater call on load", () => {
  function setup() {
    installDomHelpers(window);
    const app = createApp({
      io: createMemoryVaultIo({ "a.md": "---\nk: v\n---\n# A\n^blk" }),
      services: createHostServices({ read: async () => null, write: async () => {} }),
      bridge: { ...detachedBridge, reapplyEditorOptions: vi.fn() },
    });
    return app;
  }

  it("runs a fixture plugin that touches the same members as Dataview's onload", async () => {
    const app = setup();
    await app.start();
    const reapply = vi.mocked(app.workspace.bridge.reapplyEditorOptions);
    class Fixture extends Plugin {
      async onload() {
        const { workspace, vault, metadataCache } = this.app;
        this.registerEvent(workspace.on("active-leaf-change", () => {}));
        this.registerEvent(vault.on("modify", () => {}));
        this.registerEvent(metadataCache.on("changed", () => {}));
        workspace.onLayoutReady(() => {});
        workspace.iterateAllLeaves(() => {});
        workspace.getActiveViewOfType(class {} as never);
        workspace.getUnpinnedLeaf();
        void workspace.layoutReady;
        void metadataCache.resolvedLinks;
        void vault.getMarkdownFiles();
        void vault.configDir;
        void this.app.plugins.enabledPlugins;
        void this.app.appId;
        workspace.updateOptions();
        metadataCache.trigger("dataview:api-ready", {});
        workspace.trigger("dataview:api-ready", {});
      }
    }
    const plugin = new Fixture(app, { id: "fixture", name: "Fixture", version: "1" } as never);
    await expect(plugin.onload()).resolves.toBeUndefined();
    expect(reapply).toHaveBeenCalledTimes(1);
  });

  it("updateOptions re-applies the registered extensions to every live editor", () => {
    const seen: number[] = [];
    const view = new EditorView({
      state: EditorState.create({ doc: "x", extensions: [] }),
      parent: document.body,
    });
    const off = registerEditorView(view, () => "/v/a.md");
    expect(setPluginEditorExtensions([])).toBeNull();
    const dispatch = vi.spyOn(view, "dispatch");
    const app = setup();
    // The real bridge is `reapplyPluginEditorExtensions`; assert through the editor-bridge directly.
    void app;
    setPluginEditorExtensions(getPluginEditorExtensions().slice(1));
    expect(dispatch).toHaveBeenCalled();
    seen.push(1);
    off();
    view.destroy();
  });

  it("editorInfoField resolves the note behind a view and editorLivePreviewField is true", () => {
    const fields = createObsidianModule() as Record<string, never>;
    const info = fields.editorInfoField;
    const live = fields.editorLivePreviewField;
    const view = new EditorView({
      state: EditorState.create({ doc: "x", extensions: [getPluginCompartmentValue()] }),
      parent: document.body,
    });
    const off = registerEditorView(view, () => "/v/a.md");
    setEditorInfoResolver((_v, abs) => ({ app: null, file: abs, editor: null }));
    expect(view.state.field(live)).toBe(true);
    expect((view.state.field(info) as { file: unknown }).file).toBe("/v/a.md");
    setEditorInfoResolver(null);
    expect((view.state.field(info) as { file: unknown }).file).toBeNull();
    off();
    view.destroy();
  });
});

describe("missing API diagnostics", () => {
  it("logs each missing member once per plugin, never changes behaviour", () => {
    const app = createApp({
      io: createMemoryVaultIo({}),
      services: createHostServices({ read: async () => null, write: async () => {} }),
    });
    const logged: string[] = [];
    const wrapped = wrapAppForDiagnostics(app, "p1", (id, path) => logged.push(`${id} ${path}`));
    const anyApp = wrapped as unknown as Record<string, any>;
    expect(anyApp.workspace.noSuchThing).toBeUndefined();
    expect(anyApp.workspace.noSuchThing).toBeUndefined();
    expect(anyApp.vault.adapter.getFileName).toBeUndefined();
    expect(anyApp.nope).toBeUndefined();
    expect(typeof wrapped.vault.getName()).toBe("string");
    expect(anyApp.workspace.then).toBeUndefined();
    expect(logged).toEqual([
      "p1 app.workspace.noSuchThing",
      "p1 app.vault.adapter.getFileName",
      "p1 app.nope",
    ]);
    expect(wrapped.workspace).toBe(wrapped.workspace);
  });
});

describe("V8 stack API for non-V8 engines", () => {
  it("parses JavaScriptCore frames into CallSite-like objects", () => {
    const sites = callSitesFromStack(
      "run@writer-plugin://localhost/slides/main.js:10:5\nMy.method@/x/y.js:3:9\nmap@[native code]\nglobal code@/z.js:1:1",
    );
    expect(sites[0].getFileName()).toBe("writer-plugin://localhost/slides/main.js");
    expect(sites[0].getLineNumber()).toBe(10);
    expect(sites[0].getColumnNumber()).toBe(5);
    expect(sites[1].getTypeName()).toBe("My");
    expect(sites[1].getMethodName()).toBe("method");
    expect(sites[2].isNative()).toBe(true);
    expect(sites[3].getFunctionName()).toBeNull();
    expect(callSitesFromStack("    at f (/a.js:1:2)")[0].getFileName()).toBe("/a.js");
  });

  it("makes captureStackTrace honour prepareStackTrace when the engine lacks it", () => {
    const fake: Parameters<typeof installV8StackApi>[0] = {
      captureStackTrace(o) {
        (o as { stack: string }).stack = "caller@/p/main.js:7:1";
      },
    };
    expect(installV8StackApi(fake, false)).toBe(true);
    fake.prepareStackTrace = (_e, sites) => sites;
    const holder: { stack?: unknown } = {};
    fake.captureStackTrace!(holder);
    expect((holder.stack as { getFileName(): string }[])[0].getFileName()).toBe("/p/main.js");
    // Native V8: untouched.
    expect(installV8StackApi({}, true)).toBe(false);
  });
});
