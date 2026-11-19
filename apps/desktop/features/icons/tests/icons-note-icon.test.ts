// The note icon: an inline widget before the text of the first H1 only, never in the document,
// following the icon store, a click opens the picker for the note. Spec: SPECs/icons-spec.md.
// @vitest-environment jsdom
import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));

import { editorNotePath } from "@/lib/editor-views";
import { clearFileIcons, setFileIcons } from "@/lib/file-icons";
import { prosemarkMarkdownSyntaxExtensions } from "@/lib/prosemark-core/markdown";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { firstH1Start, noteIconExtension } from "../web/note-icon";
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
    expect(icons(view).map((i) => i.dataset.iconValue)).toEqual(["emoji:🚀"]);
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
    expect(icons(view).map((i) => i.dataset.iconValue)).toEqual(["emoji:🚀"]);
    setFileIcons([{ path: "a.md", icon: "emoji:🎉" }]);
    expect(icons(view).map((i) => i.dataset.iconValue)).toEqual(["emoji:🎉"]);
    view.dispatch({ changes: { from: 0, insert: "intro\n\n" } });
    expect(before(view)).toEqual(["Title"]);
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "no heading" } });
    expect(icons(view)).toEqual([]);
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "# Back" } });
    expect(before(view)).toEqual(["Back"]);
    clearFileIcons();
    expect(icons(view)).toEqual([]);
  });

  it("a click opens the picker for that note and leaves the document alone", () => {
    setFileIcons([{ path: "a.md", icon: "emoji:🚀" }]);
    const view = editor("# Title");
    icons(view)[0]!.click();
    expect(useIconPickerStore.getState().paths).toEqual(["/vault/a.md"]);
    expect(view.state.doc.toString()).toBe("# Title");
  });
});
