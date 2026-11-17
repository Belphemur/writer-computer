// The editor-extension and menu contribution registries: lazy `load`, live reconfiguration,
// `when`, owner teardown.
// @vitest-environment jsdom
import { EditorState, StateField, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));

import {
  editorExtensionContributions,
  featureEditorExtensions,
} from "../src/lib/features/editor-extensions";
import { contributedMenuItems, menuContributions } from "../src/lib/features/menus";
import { createFeatureHost, defineFeature } from "../src/lib/features/registry";

const flush = () => new Promise((r) => setTimeout(r, 0));
const marker = (name: string): Extension =>
  StateField.define({ create: () => name, update: (v) => v });
const field = marker("x");
const has = (view: EditorView, f: StateField<string>) => view.state.field(f, false) !== undefined;

const views: EditorView[] = [];
function editor(): EditorView {
  const view = new EditorView({
    state: EditorState.create({ doc: "a", extensions: [featureEditorExtensions()] }),
    parent: document.body,
  });
  views.push(view);
  return view;
}

const host = createFeatureHost({ onError: () => {} });
afterEach(async () => {
  for (const id of host.list()) await host.unregister(id);
  for (const v of views.splice(0)) v.destroy();
});

describe("editor extension contributions", () => {
  it("calls load only after an editor asks, applies it to open editors, drops it on unregister", async () => {
    const load = vi.fn(async () => field);
    host.register(
      defineFeature({ id: "ext-a", contributes: { editorExtensions: [{ id: "ext-a.x", load }] } }),
    );
    expect(load).not.toHaveBeenCalled();

    const view = editor();
    expect(load).toHaveBeenCalledTimes(1);
    await flush();
    expect(has(view, field as StateField<string>)).toBe(true);

    // a new editor gets it synchronously, without loading again
    expect(has(editor(), field as StateField<string>)).toBe(true);
    expect(load).toHaveBeenCalledTimes(1);

    await host.unregister("ext-a");
    expect(has(view, field as StateField<string>)).toBe(false);
    expect(editorExtensionContributions.size).toBe(0);
  });

  it("does not apply a contribution whose `when` is false", async () => {
    const on = { value: false };
    const f = marker("w");
    host.register(
      defineFeature({
        id: "ext-b",
        contributes: {
          editorExtensions: [{ id: "ext-b.x", when: () => on.value, load: async () => f }],
        },
      }),
    );
    const view = editor();
    await flush();
    expect(has(view, f as StateField<string>)).toBe(false);
  });
});

describe("editor-body menu contributions", () => {
  it("collects items from every contribution and skips a failing one", async () => {
    host.register(
      defineFeature({
        id: "menu-a",
        contributes: {
          menus: {
            "editor-body": [
              { id: "menu-a.ok", items: async () => [{ kind: "separator" }] },
              {
                id: "menu-a.bad",
                items: () => {
                  throw new Error("boom");
                },
              },
            ],
          },
        },
      }),
    );
    const view = editor();
    const items = await contributedMenuItems("editor-body", view, new MouseEvent("contextmenu"));
    expect(items).toEqual([{ kind: "separator" }]);
    await host.unregister("menu-a");
    expect(menuContributions.size).toBe(0);
  });

  it("rejects a contribution id outside the feature's prefix", () => {
    expect(() =>
      defineFeature({
        id: "menu-b",
        contributes: { menus: { "editor-body": [{ id: "other.x", items: () => [] }] } },
      }),
    ).toThrow(/must start with "menu-b\."/);
  });
});
