// @vitest-environment jsdom
// A plugin-registered CodeMirror extension that is invalid, throws, or misbehaves must never take
// Writer's own live-preview decorations down with it (editor-bridge.ts validates each extension
// in isolation before it reaches the live editors' plugin compartment).
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { markdown } from "@codemirror/lang-markdown";
import * as cmLanguage from "@codemirror/language";
import { EditorState, Facet, Prec, StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin } from "@codemirror/view";
import { GFM } from "@lezer/markdown";
import {
  getPluginCompartmentValue,
  getPluginEditorExtensions,
  pluginConfigGuard,
  pluginExtensionCompartment,
  setPluginEditorExtensions,
  validatePluginExtension,
} from "../web/host/editor-bridge";
import { registerEditorView } from "@/lib/editor-views";
import { makeRequire } from "../web/host/modules";
import {
  hideExtension,
  prosemarkBasicSetup,
  prosemarkMarkdownSyntaxExtensions,
} from "@/lib/prosemark-core/main";
import { logger } from "@/lib/logger";

const DOC = "intro\n\n## Heading\n\ntext with **bold** and a [[link]]\n";

let views: EditorView[] = [];
let unregister: Array<() => void> = [];

function mount(): EditorView {
  const state = EditorState.create({
    doc: DOC,
    selection: { anchor: 1 },
    extensions: [
      markdown({ extensions: [GFM, prosemarkMarkdownSyntaxExtensions] }),
      prosemarkBasicSetup(),
      pluginConfigGuard,
      pluginExtensionCompartment.of(getPluginCompartmentValue()),
    ],
  });
  cmLanguage.ensureSyntaxTree(state, state.doc.length, 5000);
  const view = new EditorView({ state: state.update({}).state, parent: document.body });
  views.push(view);
  unregister.push(registerEditorView(view, () => "a.md"));
  return view;
}

function hiddenCount(view: EditorView): number {
  let n = 0;
  const iter = view.state.field(hideExtension).iter();
  while (iter.value) {
    n++;
    iter.next();
  }
  return n;
}

const goodFacet = Facet.define<number, number>({ combine: (v) => v.length });
const goodExtensions = () => {
  const lang = makeRequire({} as never, {} as never)("@codemirror/language") as {
    syntaxTree: typeof cmLanguage.syntaxTree;
    tokenClassNodeProp: never;
  };
  return [
    ViewPlugin.fromClass(
      class {
        constructor(v: EditorView) {
          lang
            .syntaxTree(v.state)
            .iterate({ enter: (n) => void n.type.prop(lang.tokenClassNodeProp) });
        }
      },
    ),
    StateField.define({ create: () => 0, update: (v) => v }),
    goodFacet.of(1),
  ];
};

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(logger, "warn").mockImplementation(() => {});
});
afterEach(() => {
  setPluginEditorExtensions([]);
  unregister.forEach((u) => u());
  views.forEach((v) => v.destroy());
  views = [];
  unregister = [];
  vi.restoreAllMocks();
});

describe("plugin editor extension isolation", () => {
  it("baseline: Prosemark hide decorations exist", () => {
    expect(hiddenCount(mount())).toBeGreaterThan(0);
  });

  it("valid plugin extensions (view plugin, field, facet) apply and keep decorations", () => {
    const view = mount();
    expect(setPluginEditorExtensions(goodExtensions(), ["good"])).toBeNull();
    expect(getPluginEditorExtensions()).toHaveLength(3);
    expect(hiddenCount(view)).toBeGreaterThan(0);
    expect(view.state.facet(goodFacet)).toBe(1);
  });

  const bad: Array<[string, () => unknown]> = [
    [
      "a state field whose create throws",
      () =>
        StateField.define({
          create: () => {
            throw new Error("field boom");
          },
          update: (v) => v,
        }),
    ],
    [
      "a decorations provider that throws",
      () =>
        EditorView.decorations.of(() => {
          throw new Error("deco boom");
        }),
    ],
    [
      "a decorations provider returning a non-RangeSet",
      () => EditorView.decorations.of((() => ({})) as never),
    ],
    ["a non-extension value", () => ({ nope: 1 })],
  ];

  for (const [name, make] of bad) {
    it(`rejects ${name} without touching Prosemark decorations`, () => {
      const view = mount();
      const before = hiddenCount(view);
      const err = setPluginEditorExtensions([make() as never], ["evil"]);
      expect(err).toBeInstanceOf(Error);
      expect(getPluginEditorExtensions()).toHaveLength(0);
      expect(hiddenCount(view)).toBe(before);
      // The editor stays usable.
      view.dispatch({ changes: { from: 0, insert: "z" }, selection: { anchor: 3 } });
      expect(view.state.doc.sliceString(0, 1)).toBe("z");
      expect(logger.warn).toHaveBeenCalledWith(
        "plugin",
        expect.stringContaining("rejected"),
        expect.objectContaining({ plugin: "evil" }),
      );
    });
  }

  it("a bad extension is dropped while the good ones from other plugins still apply", () => {
    const view = mount();
    const bad = StateField.define({
      create: () => {
        throw new Error("boom");
      },
      update: (v) => v,
    });
    const good = goodExtensions();
    const err = setPluginEditorExtensions([good, bad, goodFacet.of(5)], ["a", "b", "c"]);
    expect(err?.message).toBe("boom");
    expect(getPluginEditorExtensions()).toHaveLength(2);
    expect(view.state.facet(goodFacet)).toBe(2);
    expect(hiddenCount(view)).toBeGreaterThan(0);
    expect(logger.warn).toHaveBeenCalledWith(
      "plugin",
      expect.any(String),
      expect.objectContaining({ plugin: "b" }),
    );
  });

  it("an editor created after a rejection starts clean", () => {
    setPluginEditorExtensions([
      StateField.define({
        create: () => {
          throw new Error("x");
        },
        update: (v) => v,
      }),
    ]);
    expect(hiddenCount(mount())).toBeGreaterThan(0);
  });

  it("a view plugin that throws on update only loses itself (CodeMirror isolates it)", () => {
    const view = mount();
    const vp = ViewPlugin.fromClass(
      class {
        update() {
          throw new Error("update boom");
        }
      },
    );
    expect(validatePluginExtension(vp)).toBeNull();
    setPluginEditorExtensions([vp], ["thrower"]);
    view.dispatch({ changes: { from: 0, insert: "q" } });
    expect(hiddenCount(view)).toBeGreaterThan(0);
  });

  const plainLanguage = () =>
    cmLanguage.StreamLanguage.define({
      token(stream) {
        stream.skipToEnd();
        return null;
      },
    });

  it("rejects an extension that supplies a higher-precedence language (tree goes empty, raw markdown)", () => {
    const view = mount();
    const before = hiddenCount(view);
    const err = setPluginEditorExtensions([Prec.highest(plainLanguage())], ["lang-plugin"]);
    expect(err?.message).toMatch(/language/);
    expect(hiddenCount(view)).toBe(before);
    expect(hiddenCount(view)).toBeGreaterThan(0);
  });

  it("drops a plugin's top-level reconfigure but lets the rest of the transaction through", () => {
    const view = mount();
    view.dispatch({
      changes: { from: 0, insert: "Q" },
      effects: StateEffect.reconfigure.of([]),
    });
    expect(view.state.doc.sliceString(0, 1)).toBe("Q");
    expect(hiddenCount(view)).toBeGreaterThan(0);
    expect(cmLanguage.language).toBeDefined();
    expect(view.state.field(hideExtension, false)).toBeDefined();
  });

  it("drops a plugin's appendConfig carrying a language, keeps a harmless one", () => {
    const view = mount();
    const langBefore = view.state.facet(cmLanguage.language);
    view.dispatch({ effects: StateEffect.appendConfig.of(Prec.highest(plainLanguage())) });
    expect(view.state.facet(cmLanguage.language)).toBe(langBefore);
    expect(view.state.facet(goodFacet)).toBe(0);
    view.dispatch({ effects: StateEffect.appendConfig.of(goodFacet.of(7)) });
    expect(view.state.facet(goodFacet)).toBe(1);
  });
});
