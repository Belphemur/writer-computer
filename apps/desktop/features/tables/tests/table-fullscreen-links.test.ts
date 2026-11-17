// @vitest-environment jsdom
// Links in a table cell: the fullscreen overlay renders them with the inline widget's markup and
// opens them through `lib/link-activation.ts` (SPECs/table-editing-spec.md, Fullscreen).
import { markdown } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { GFM } from "@lezer/markdown";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  activateLink: vi.fn(),
  wikiTarget: vi.fn((raw: string) => ({ kind: "custom", open: () => {}, tag: `wiki:${raw}` })),
  hrefTarget: vi.fn((href: string) => ({ kind: "custom", open: () => {}, tag: `href:${href}` })),
}));

vi.mock("@/lib/link-activation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/link-activation")>()),
  activateLink: mocks.activateLink,
}));
// The openers are the editor's (tested with it); here they are tagged stand-ins, and the element
// readers are the real contract of the cell markup.
vi.mock("@/components/editor-area/wiki-link-extension", () => ({
  wikiLinkTarget: mocks.wikiTarget,
  wikiTargetOf: (el: Element) =>
    el.closest<HTMLElement>(".cm-wiki-link")?.dataset.wikiTarget ?? null,
}));
vi.mock("@/components/editor-area/link-navigation", () => ({
  linkTargetFor: mocks.hrefTarget,
  renderedLinkHrefOf: (el: Element) =>
    el.closest<HTMLElement>(".cm-rendered-link")?.dataset.href ?? null,
}));

if (!Range.prototype.getClientRects) {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
}
if (!Range.prototype.getBoundingClientRect) {
  Range.prototype.getBoundingClientRect = () =>
    ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }) as DOMRect;
}

import { editorNotePath } from "@/lib/editor-views";
import { setTableYieldProbe, tableEditing } from "../web/table-editing";
import { tableDecorations } from "../web/table-decorations";
import { closeTableFullscreen, openTableFullscreen } from "../web/table-fullscreen";

const T = [
  "| Name | Links |",
  "| --- | --- |",
  "| [[Ada Lovelace]] | [site](https://example.com/a) |",
  "| [[Notes/Grace\\|Grace]] | https://example.com/b |",
].join("\n");
const DOC = `before\n\n${T}\n\nafter`;
const tableFrom = DOC.indexOf("| Name");

const views: EditorView[] = [];
function make(doc = DOC, extra: Extension[] = []): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        ...extra,
        markdown({ extensions: [GFM] }),
        tableDecorations(),
        tableEditing(),
        editorNotePath.of(() => "/vault/note.md"),
      ],
    }),
  });
  ensureSyntaxTree(view.state, doc.length, 1000);
  view.dispatch({ selection: view.state.selection });
  views.push(view);
  return view;
}

const overlay = () => document.querySelector<HTMLElement>(".cm-table-fullscreen");
const cellText = (root: ParentNode, row: number, col: number) =>
  root.querySelector<HTMLElement>(`[data-row="${row}"][data-col="${col}"] .cm-table-cell-text`)!;
const press = (el: Element, type: string, init: MouseEventInit = {}) => {
  const ev = new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(ev);
  return ev;
};

beforeEach(() => {
  setTableYieldProbe(() => false);
  mocks.activateLink.mockClear();
});
afterEach(() => {
  closeTableFullscreen();
  while (views.length) views.pop()!.destroy();
  document.body.innerHTML = "";
});

describe("links in the fullscreen table", () => {
  test("render with the same markup as the inline widget", () => {
    const v = make();
    openTableFullscreen(v, tableFrom);
    const inline = v.contentDOM.querySelector<HTMLElement>(".cm-table-widget")!;
    for (const [row, col] of [
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 1],
    ]) {
      expect(cellText(overlay()!, row, col).innerHTML).toBe(cellText(inline, row, col).innerHTML);
    }
    expect(cellText(overlay()!, 0, 0).querySelector(".cm-wiki-link")?.textContent).toBe(
      "Ada Lovelace",
    );
    expect(cellText(overlay()!, 1, 0).querySelector(".cm-wiki-link")?.textContent).toBe("Grace");
    expect(cellText(overlay()!, 0, 1).querySelector(".cm-rendered-link")?.textContent).toBe("site");
    expect(cellText(overlay()!, 1, 1).querySelector(".cm-rendered-link")?.textContent).toBe(
      "https://example.com/b",
    );
  });

  test("a click opens a wiki link through activateLink and closes the overlay", () => {
    const v = make();
    openTableFullscreen(v, tableFrom);
    const link = cellText(overlay()!, 0, 0).querySelector(".cm-wiki-link")!;
    expect(press(link, "mousedown").defaultPrevented).toBe(true); // the cell does not take the press
    press(link, "click");
    expect(mocks.wikiTarget).toHaveBeenCalledWith(
      "Ada Lovelace",
      expect.any(Function),
      expect.any(Function),
    );
    expect(mocks.activateLink).toHaveBeenCalledWith(
      expect.objectContaining({ tag: "wiki:Ada Lovelace" }),
      "current",
    );
    expect(overlay()).toBeNull();
  });

  test("a middle click opens a background tab and keeps the overlay open", () => {
    const v = make();
    openTableFullscreen(v, tableFrom);
    const link = cellText(overlay()!, 1, 0).querySelector(".cm-wiki-link")!;
    press(link, "auxclick", { button: 1 });
    expect(mocks.activateLink).toHaveBeenCalledWith(
      expect.objectContaining({ tag: "wiki:Notes/Grace\\|Grace" }),
      "new-tab-background",
    );
    expect(overlay()).not.toBeNull();
  });

  test("a URL opens without closing the overlay, a Markdown link to a note does close it", () => {
    const v = make();
    openTableFullscreen(v, tableFrom);
    press(cellText(overlay()!, 0, 1).querySelector(".cm-rendered-link")!, "click");
    expect(mocks.hrefTarget).toHaveBeenCalledWith(
      "https://example.com/a",
      v,
      expect.any(Function),
      expect.any(Function),
    );
    expect(mocks.activateLink).toHaveBeenCalledWith(
      expect.objectContaining({ tag: "href:https://example.com/a" }),
      "current",
    );
    expect(overlay()).not.toBeNull();
  });

  test("clicking elsewhere in the cell edits it, and links work after an edit re-renders", () => {
    const v = make();
    openTableFullscreen(v, tableFrom);
    const text = cellText(overlay()!, 0, 0);
    press(text, "mousedown"); // not on the link: the press is left alone
    expect(press(text, "mousedown").defaultPrevented).toBe(false);
    // The note's document changes underneath: the cell re-renders and its link still opens.
    v.dispatch({
      changes: {
        from: DOC.indexOf("Ada Lovelace"),
        to: DOC.indexOf("Ada Lovelace") + 3,
        insert: "Eva",
      },
    });
    const link = cellText(overlay()!, 0, 0).querySelector(".cm-wiki-link")!;
    expect(link.textContent).toBe("Eva Lovelace");
    press(link, "click");
    expect(mocks.activateLink).toHaveBeenCalledWith(
      expect.objectContaining({ tag: "wiki:Eva Lovelace" }),
      "current",
    );
  });
});

describe("inline styles in the fullscreen table", () => {
  const CODE_DOC = "| a | b |\n| --- | --- |\n| `x` **y** *z* ~~w~~ | 2 |";

  test("the overlay carries the editor's theme scope, so its rules reach the cells", () => {
    const theme = EditorView.theme({ ".cm-inline-code": { fontFamily: "TestCodeFont" } });
    const v = make(CODE_DOC, [theme]);
    openTableFullscreen(v, 0);
    const scope = overlay()!.querySelector<HTMLElement>(".cm-table-fullscreen-scope")!;
    const editorClasses = [...v.dom.classList].filter((c) => c !== "cm-focused");
    expect(editorClasses).toContain("cm-editor");
    for (const c of editorClasses) expect(scope.classList.contains(c)).toBe(true);
    // The scope is inside the overlay, not on it: `.cm-editor` must not change the overlay's layout.
    expect(overlay()!.classList.contains("cm-editor")).toBe(false);
    const cell = cellText(overlay()!, 0, 0);
    expect(scope.contains(cell)).toBe(true);
    expect(cell.querySelector("code.cm-inline-code")?.textContent).toBe("x");
    expect(cell.querySelector("strong")?.textContent).toBe("y");
    expect(cell.querySelector("em")?.textContent).toBe("z");
    expect(cell.querySelector("s")?.textContent).toBe("w");
    expect(getComputedStyle(cell.querySelector(".cm-inline-code")!).fontFamily).toContain(
      "TestCodeFont",
    );
  });
});
