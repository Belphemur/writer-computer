// @vitest-environment jsdom
// The editor's tag pills: a pill until the caret or selection touches the tag, never in code, a
// URL, a link or a heading marker; a click opens the search with `tag:`. What is a tag is pinned
// by `tags.test.ts` and the shared vectors.
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(), openPath: vi.fn() }));

import { tagDecorations } from "../src/components/editor-area/tag-decorations";
import { useUIStore } from "../src/stores/ui-store";
import { withFullParse } from "./helpers/parsed-state";

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});
beforeEach(() => useUIStore.getState().closeCommandPalette());

/** `doc` with `|` marking the caret (none: caret at 0). */
function mount(marked: string, selection?: EditorSelection) {
  const caret = Math.max(0, marked.indexOf("|"));
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({
    parent,
    state: withFullParse(
      EditorState.create({
        doc: marked.replace("|", ""),
        selection: selection ?? EditorSelection.single(caret),
        extensions: [markdown({ extensions: [GFM] }), tagDecorations()],
      }),
    ),
  });
  cleanups.push(() => (view.destroy(), parent.remove()));
  return view;
}

const pills = (view: EditorView) =>
  [...view.dom.querySelectorAll<HTMLElement>(".cm-tag-pill")].map((e) => e.textContent);
const raw = (view: EditorView) =>
  [...view.dom.querySelectorAll<HTMLElement>(".cm-tag-editing")].map((e) => e.textContent);

describe("tag pills", () => {
  test("a tag away from the caret is a pill, # kept, the text untouched", () => {
    const view = mount("|first line\nsee #Draft and #research/hlo");
    expect(pills(view)).toEqual(["#Draft", "#research/hlo"]);
    expect(view.dom.querySelector<HTMLElement>(".cm-tag-pill")!.dataset.tag).toBe("draft");
    expect(view.state.doc.toString()).toContain("see #Draft and #research/hlo");
  });

  test("the caret inside, at either end, or a selection over it shows raw text", () => {
    for (const marked of ["see #Dr|aft", "see |#Draft", "see #Draft| x"]) {
      const view = mount(`${marked}\n#other`);
      expect(raw(view), marked).toEqual(["#Draft"]);
      expect(pills(view), marked).toEqual(["#other"]);
    }
    const view = mount("see #Draft x", EditorSelection.single(0, 8));
    expect(raw(view)).toEqual(["#Draft"]);
  });

  test("moving the caret away turns it back into a pill, and typing a tag keeps it raw", () => {
    const view = mount("a #t|");
    expect(raw(view)).toEqual(["#t"]);
    view.dispatch({ changes: { from: 4, insert: "ag" } });
    expect(raw(view)).toEqual(["#tag"]);
    view.dispatch({ selection: { anchor: 0 } });
    expect(pills(view)).toEqual(["#tag"]);
    expect(raw(view)).toEqual([]);
  });

  test("no pill in a fence, indented code, inline code, a URL, a link or a heading marker", () => {
    const view = mount(
      [
        "|start",
        "```",
        "#fenced",
        "```",
        "",
        "    #indented",
        "",
        "`#inline` https://example.com/p#frag [[Note#Heading]] [a](b.md#h)",
        "# Heading",
        "#yes",
      ].join("\n"),
    );
    expect(pills(view)).toEqual(["#yes"]);
  });

  test("a tag in a heading line after its marker is a pill", () => {
    expect(pills(mount("|x\n## Title #topic"))).toEqual(["#topic"]);
  });
});

describe("tag click", () => {
  function press(view: EditorView, type: string, init: MouseEventInit) {
    const el = view.dom.querySelector(".cm-tag-pill")!;
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
    el.dispatchEvent(event);
    return event;
  }

  test("a plain click opens the content search for the tag and leaves the caret alone", () => {
    const view = mount("|x\n#Research/HLO");
    press(view, "mousedown", { button: 0 });
    press(view, "click", { button: 0 });
    const ui = useUIStore.getState();
    expect(ui.isCommandPaletteOpen).toBe(true);
    expect(ui.commandPaletteIntent).toBe("search-notes");
    expect(ui.commandPaletteSearch).toBe("tag:research/hlo ");
    expect(view.state.selection.main.head).toBe(0);
  });

  test("a middle click opens the same search", () => {
    const view = mount("|x\n#a");
    press(view, "mousedown", { button: 1 });
    press(view, "auxclick", { button: 1 });
    expect(useUIStore.getState().commandPaletteSearch).toBe("tag:a ");
  });

  test("Cmd/Ctrl+click opens the same search", () => {
    const view = mount("|x\n#a");
    press(view, "click", { button: 0, metaKey: true, ctrlKey: true });
    expect(useUIStore.getState().commandPaletteSearch).toBe("tag:a ");
  });

  test("a click on text that is not a pill does nothing", () => {
    const view = mount("|x\n#a");
    view.dom
      .querySelector(".cm-line")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    expect(useUIStore.getState().isCommandPaletteOpen).toBe(false);
  });

  test("a tag with the caret in it is raw text and is not a link", () => {
    const view = mount("x #a|");
    expect(view.dom.querySelector(".cm-tag-pill")).toBeNull();
  });
});
