// The note icon: a large inline widget before the text of the first H1 only (a hanging-indent line
// decoration keeps wrapped lines clear of it), never in the document, following the icon store; a
// click, Enter or Space opens the picker, where picking changes it and Remove takes it away.
// Spec: SPECs/icons-spec.md.
// @vitest-environment jsdom
import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke, convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// The picker's virtualized grid needs a size jsdom does not have.
for (const name of ["offsetHeight", "clientHeight"])
  Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get: () => 216 });
for (const name of ["offsetWidth", "clientWidth"])
  Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get: () => 316 });

import { editorNotePath } from "@/lib/editor-views";
import { clearFileIcons, setFileIcons } from "@/lib/file-icons";
import { prosemarkMarkdownSyntaxExtensions } from "@/lib/prosemark-core/markdown";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { firstH1Start, noteIconExtension } from "../web/note-icon";
import IconPickerOverlay from "../web/picker";
import { useIconPickerStore } from "../web/picker-store";

const views: EditorView[] = [];
beforeEach(() => {
  useWorkspaceStore.setState({ root: "/vault" });
  clearFileIcons();
  useIconPickerStore.getState().close();
});
afterEach(() => {
  for (const v of views.splice(0)) v.destroy();
});

function editor(doc: string, path = "/vault/a.md") {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        markdown({ extensions: prosemarkMarkdownSyntaxExtensions }),
        editorNotePath.of(() => path),
        noteIconExtension(),
      ],
    }),
  });
  views.push(view);
  return view;
}
const icons = (v: EditorView) => [...v.dom.querySelectorAll<HTMLElement>(".cm-note-icon")];
/** The document offset of each icon: the text it precedes. */
const before = (v: EditorView) =>
  icons(v).map((el) => v.state.doc.sliceString(v.posAtDOM(el), v.posAtDOM(el) + 5));
const values = (v: EditorView) =>
  [...v.dom.querySelectorAll<HTMLElement>(".cm-note-icon-glyph")].map((g) => g.dataset.iconValue);

describe("firstH1Start", () => {
  it("is where the text of the first top-level H1 starts", () => {
    const state = (doc: string) =>
      EditorState.create({
        doc,
        extensions: [markdown({ extensions: prosemarkMarkdownSyntaxExtensions })],
      });
    expect(firstH1Start(state("intro\n\n# Title\n\n# Two"))).toBe(9);
    expect(firstH1Start(state("#   Wide"))).toBe(2);
    expect(firstH1Start(state("Title\n=====\n"))).toBe(0);
    expect(firstH1Start(state("## Only h2\n\ntext"))).toBeNull();
    expect(firstH1Start(state(""))).toBeNull();
  });
});

describe("the editor extension", () => {
  it("draws the note's icon before the first H1's text, document untouched", () => {
    setFileIcons([{ path: "a.md", icon: "emoji:🚀", color: "#ff0000" }]);
    const doc = "# Title\n\nbody";
    const view = editor(doc);
    expect(values(view)).toEqual(["emoji:🚀"]);
    expect(before(view)).toEqual(["Title"]);
    expect(view.state.doc.toString()).toBe(doc);
  });

  it("shows nothing without an H1, or for a note with no icon", () => {
    setFileIcons([{ path: "a.md", icon: "emoji:🚀" }]);
    expect(icons(editor("## Section\n\ntext"))).toEqual([]);
    expect(icons(editor("just text"))).toEqual([]);
    expect(icons(editor("# Title", "/vault/b.md"))).toEqual([]);
  });

  it("puts it on the first H1 only", () => {
    setFileIcons([{ path: "a.md", icon: "emoji:🚀" }]);
    const view = editor("intro\n\n# One\n\n# Two");
    expect(before(view)).toEqual(["One\n\n"]);
  });

  it("skips front matter: a # line in it is no heading", () => {
    setFileIcons([{ path: "a.md", icon: "emoji:🚀" }]);
    const view = editor("---\n# not a heading\ntitle: x\n---\n\n# Real\n");
    expect(before(view)).toEqual(["Real\n"]);
    expect(icons(editor("---\n# not a heading\n---\n\ntext"))).toEqual([]);
  });

  it("follows the store: set, change, remove, and the H1 moving or going", () => {
    const view = editor("# Title\n\nbody");
    expect(icons(view)).toEqual([]);
    setFileIcons([{ path: "a.md", icon: "emoji:🚀" }]);
    expect(values(view)).toEqual(["emoji:🚀"]);
    setFileIcons([{ path: "a.md", icon: "emoji:🎉" }]);
    expect(values(view)).toEqual(["emoji:🎉"]);
    view.dispatch({ changes: { from: 0, insert: "intro\n\n" } });
    expect(before(view)).toEqual(["Title"]);
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "no heading" } });
    expect(icons(view)).toEqual([]);
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "# Back" } });
    expect(before(view)).toEqual(["Back"]);
    clearFileIcons();
    expect(icons(view)).toEqual([]);
  });

  it("is a large unframed glyph hanging off the H1 line: a button, 1.3em, wrapped lines indented", () => {
    setFileIcons([{ path: "a.md", icon: "emoji:🚀" }]);
    const view = editor("# Title\n\nbody");
    const tile = icons(view)[0]!;
    expect(tile.getAttribute("role")).toBe("button");
    expect(tile.getAttribute("aria-label")).toBe("Change icon");
    expect(tile.tabIndex).toBe(0);
    const glyph = tile.querySelector<HTMLElement>(".cm-note-icon-glyph")!;
    expect(glyph.textContent).toBe("🚀");
    // an emoji and an SVG share one size, 1.3em of the heading, with no !important override
    expect(glyph.style.fontSize).toBe("calc(1.17em)");
    expect(glyph.style.getPropertyPriority("font-size")).toBe("");
    // only the H1 line hangs, not the body
    const lines = [...view.dom.querySelectorAll(".cm-line")];
    expect(lines.filter((l) => l.classList.contains("cm-note-icon-line"))).toHaveLength(1);
    expect(lines[0]!.classList.contains("cm-note-icon-line")).toBe(true);
    expect(lines[0]!.contains(tile)).toBe(true);
  });

  it("draws a Hugeicons glyph as an SVG of the same size, in the text colour", async () => {
    setFileIcons([{ path: "a.md", icon: "icon:Home01Icon" }]);
    const view = editor("# Title");
    const svg = await vi.waitFor(() => {
      const el = view.dom.querySelector(".cm-note-icon svg");
      expect(el).not.toBeNull();
      return el!;
    });
    expect(svg.getAttribute("width")).toBe("1.3em");
    expect(svg.getAttribute("height")).toBe("1.3em");
    expect((view.dom.querySelector(".cm-note-icon-glyph") as HTMLElement).style.color).toBe("");
  });

  it("a click opens the picker for that note and leaves the document and caret alone", () => {
    setFileIcons([{ path: "a.md", icon: "emoji:🚀" }]);
    const view = editor("# Title");
    const head = view.state.selection.main.head;
    icons(view)[0]!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    icons(view)[0]!.click();
    expect(useIconPickerStore.getState().paths).toEqual(["/vault/a.md"]);
    expect(view.state.doc.toString()).toBe("# Title");
    expect(view.state.selection.main.head).toBe(head);
  });

  it("Enter and Space on the focused icon open the picker too", () => {
    setFileIcons([{ path: "a.md", icon: "emoji:🚀" }]);
    const view = editor("# Title");
    for (const key of ["Enter", " "]) {
      useIconPickerStore.getState().close();
      icons(view)[0]!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      expect(useIconPickerStore.getState().paths).toEqual(["/vault/a.md"]);
    }
    useIconPickerStore.getState().close();
    icons(view)[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    expect(useIconPickerStore.getState().paths).toBeNull();
  });

  describe("through the picker", () => {
    let container: HTMLElement;
    let root: Root;
    let rows: { path: string; icon: string; color?: string; source: string }[];

    beforeEach(async () => {
      rows = [{ path: "a.md", icon: "emoji:🚀", source: "writer" }];
      invoke.mockReset();
      invoke.mockImplementation(async (cmd: string, args: { icon?: string }) => {
        if (cmd === "plugin:icons|icons_resolved") return { icons: rows, iconizeUnsupported: 0 };
        if (cmd === "plugin:icons|icons_set") {
          rows = [{ path: "a.md", icon: args.icon!, source: "writer" }];
        }
        if (cmd === "plugin:icons|icons_remove") rows = [];
        return null;
      });
      setFileIcons(rows);
      container = document.createElement("div");
      document.body.append(container);
      root = createRoot(container);
      await act(async () => root.render(createElement(IconPickerOverlay)));
    });
    afterEach(async () => {
      await act(async () => root.unmount());
      container.remove();
    });

    it(
      "picking a new icon changes the widget, Remove takes it away",
      { timeout: 30_000 },
      async () => {
        const view = editor("# Title\n\nbody");
        expect(values(view)).toEqual(["emoji:🚀"]);

        await act(async () => icons(view)[0]!.click());
        expect(container.querySelector("[role=dialog]")).not.toBeNull();
        await act(async () =>
          container.querySelector<HTMLButtonElement>("[role=tab]:last-child")!.click(),
        );
        const cell = await vi.waitFor(
          () => {
            const el = container.querySelector<HTMLElement>("[role=option][data-emoji]");
            expect(el).not.toBeNull();
            return el!;
          },
          { timeout: 25_000 },
        );
        const picked = `emoji:${cell.dataset.emoji}`;
        expect(picked).not.toBe("emoji:🚀");
        await act(async () => {
          cell.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        });
        await vi.waitFor(() => expect(values(view)).toEqual([picked]));
        await vi.waitFor(() => expect(container.querySelector("[role=dialog]")).toBeNull());
        expect(view.state.doc.toString()).toBe("# Title\n\nbody");

        await act(async () => icons(view)[0]!.click());
        const remove = [...container.querySelectorAll("button")].find(
          (b) => b.textContent === "Remove icon",
        );
        expect(remove).toBeDefined();
        await act(async () => remove!.click());
        await vi.waitFor(() => expect(icons(view)).toEqual([]));
        expect(view.dom.querySelector(".cm-note-icon-line")).toBeNull();
      },
    );
  });
});
