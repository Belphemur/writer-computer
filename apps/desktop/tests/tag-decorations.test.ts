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
const bare = (view: EditorView) => view.dom.querySelectorAll(".cm-tag-editing").length;

describe("tag pills", () => {
  test("a tag away from the caret is a pill, # kept, the text untouched", () => {
    const view = mount("|first line\nsee #Draft and #research/hlo");
    expect(pills(view)).toEqual(["#Draft", "#research/hlo"]);
    expect(view.dom.querySelector<HTMLElement>(".cm-tag-pill")!.dataset.tag).toBe("draft");
    expect(view.state.doc.toString()).toContain("see #Draft and #research/hlo");
  });

  test("the caret inside or at either end, or a selection over it, leaves bare text", () => {
    for (const marked of ["see #Dr|aft", "see |#Draft", "see #Draft| x"]) {
      const view = mount(`${marked}\n#other`);
      expect(pills(view), marked).toEqual(["#other"]);
      expect(bare(view), "no editing decoration (IME sees plain text)").toBe(0);
    }
    const view = mount("see #Draft x", EditorSelection.single(0, 8));
    expect(pills(view)).toEqual([]);
  });

  test("moving the caret away turns it back into a pill, and typing a tag keeps it bare", () => {
    const view = mount("a #t|");
    expect(pills(view)).toEqual([]);
    view.dispatch({ changes: { from: 4, insert: "ag" } });
    expect(pills(view)).toEqual([]);
    view.dispatch({ selection: { anchor: 0 } });
    expect(pills(view)).toEqual(["#tag"]);
  });

  test("no pill in a fence, inline code, a URL, a link or a heading marker", () => {
    const view = mount(
      [
        "|start",
        "```",
        "#fenced",
        "```",
        "",
        "`#inline` https://example.com/p#frag [[Note#Heading]] [a](b.md#h)",
        "# Heading",
        "#yes",
      ].join("\n"),
    );
    expect(pills(view)).toEqual(["#yes"]);
  });

  test("it follows the index on code: indented code, a fence in a list or a quote are text", () => {
    const view = mount(
      ["|x", "    #indented", "- ```", "#inlist", "> ```", "> #inquote"].join("\n"),
    );
    expect(pills(view)).toEqual(["#indented", "#inlist", "#inquote"]);
  });

  test("a tag in a heading line after its marker is a pill", () => {
    expect(pills(mount("|x\n## Title #topic"))).toEqual(["#topic"]);
  });

  test("an edit that opens or closes a fence far above re-decorates the lines below", () => {
    const lines = ["|top", ...Array.from({ length: 300 }, (_, i) => `line ${i} #t${i}`)];
    const view = mount(lines.join("\n"));
    const count = () => view.dom.querySelectorAll(".cm-tag-pill").length;
    const before = count();
    expect(before).toBeGreaterThan(0);
    view.dispatch({ changes: { from: 0, to: 3, insert: "```" } }); // opens a fence to the end
    expect(count()).toBe(0);
    view.dispatch({ changes: { from: 0, to: 3, insert: "top" } });
    expect(count()).toBe(before);
  });

  test("a line over the length cap is left undecorated", () => {
    const view = mount(`|x\n${"a ".repeat(6000)}#big\n#small`);
    expect(pills(view)).toEqual(["#small"]);
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

  test("Shift+click on a pill opens nothing and does not claim the press", () => {
    const view = mount("|x\n#a");
    const pill = view.dom.querySelector(".cm-tag-pill")!; // CodeMirror may extend the selection over it
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true, shiftKey: true });
    pill.dispatchEvent(down);
    pill.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, shiftKey: true }),
    );
    expect(useUIStore.getState().isCommandPaletteOpen).toBe(false);
    expect(down.cancelBubble).toBe(false);
  });
});
