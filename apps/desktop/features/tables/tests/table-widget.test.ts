// @vitest-environment jsdom
// The rendered table in a live editor: no unfold on caret entry, a horizontally scrolling
// container, cells edited in place, hover handles, the Edit source toggle, undo as one step and the
// fullscreen overlay.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { history, undo } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { GFM } from "@lezer/markdown";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";

import { setTableYieldProbe, tableEditing, runTableCommand } from "../web/table-editing";
import { tableDecorations } from "../web/table-decorations";
import { closeTableFullscreen, openTableFullscreen } from "../web/table-fullscreen";
import { enterAdjacentTable } from "../web/table-editing";

const T = ["| a   | b   |", "| --- | --- |", "| 1   | 2   |", "| 3   | 4   |"].join("\n");
const DOC = `before\n\n${T}\n\nafter`;
const tableFrom = DOC.indexOf("| a");

const views: EditorView[] = [];
function make(doc = DOC, cursor = 0): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: EditorSelection.cursor(cursor),
      extensions: [markdown({ extensions: [GFM] }), history(), tableDecorations(), tableEditing()],
    }),
  });
  ensureSyntaxTree(view.state, doc.length, 1000);
  view.dispatch({ selection: view.state.selection });
  views.push(view);
  return view;
}

const text = (v: EditorView) => v.state.doc.toString();
const widget = (v: EditorView) => v.contentDOM.querySelector<HTMLElement>(".cm-table-widget");
const cell = (root: ParentNode, row: number, col: number) =>
  root.querySelector<HTMLElement>(`[data-row="${row}"][data-col="${col}"]`)!;
const textOf = (c: HTMLElement) => c.querySelector<HTMLElement>(".cm-table-cell-text")!;

/** Starts editing a cell like a click would (focus in) and replaces its text. */
function edit(c: HTMLElement, value?: string): HTMLElement {
  const t = textOf(c);
  t.focus();
  t.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  if (value !== undefined) t.textContent = value;
  return t;
}
function key(target: HTMLElement, k: string, mods: Partial<KeyboardEventInit> = {}) {
  const ev = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...mods });
  target.dispatchEvent(ev);
  return ev.defaultPrevented;
}
const click = (e: Element) =>
  e.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
const action = (root: ParentNode, name: string, row?: number) =>
  root.querySelector<HTMLElement>(
    row === undefined
      ? `[data-action="${name}"]`
      : `[data-row="${row}"] [data-action="${name}"], [data-row="${row}"][data-action="${name}"]`,
  )!;

beforeEach(() => setTableYieldProbe(() => false));
afterEach(() => {
  closeTableFullscreen();
  for (const v of views.splice(0)) v.destroy();
  document.body.innerHTML = "";
  setTableYieldProbe(null);
});

describe("rendered table", () => {
  test("stays rendered when the caret is placed in it", () => {
    const v = make(DOC, tableFrom + 3);
    expect(widget(v)).not.toBeNull();
    expect(v.contentDOM.querySelector(".cm-table-source-line")).toBeNull();
    v.dispatch({ selection: EditorSelection.single(tableFrom, tableFrom + T.length) });
    expect(widget(v)).not.toBeNull();
    expect(v.contentDOM.querySelector(".cm-table-source-line")).toBeNull();
  });

  test("has a scroll container and its stylesheet makes it scroll horizontally", () => {
    const v = make();
    expect(widget(v)!.querySelector(".cm-table-scroll > table")).not.toBeNull();
    const css = readFileSync(resolve(import.meta.dirname, "../web/table-ui.css"), "utf8");
    expect(css).toMatch(/\.cm-table-scroll\s*\{[^}]*overflow-x:\s*auto/);
    expect(css).toMatch(/\.cm-table-scroll\s*\{[^}]*max-width:\s*100%/);
    expect(css).toMatch(/max-width:\s*28rem/);
  });

  test("an arrow key at the edge lands in the first or last cell instead of unfolding", () => {
    const blankBefore = DOC.indexOf("\n\n| a") + 1;
    const v = make(DOC, blankBefore);
    expect(enterAdjacentTable(v, "down")).toBe(true);
    expect(document.activeElement).toBe(textOf(cell(widget(v)!, -1, 0)));
    expect(v.contentDOM.querySelector(".cm-table-source-line")).toBeNull();

    const blankAfter = DOC.indexOf("4   |\n\n") + "4   |\n".length;
    const w = make(DOC, blankAfter);
    expect(enterAdjacentTable(w, "up")).toBe(true);
    expect(document.activeElement).toBe(textOf(cell(widget(w)!, 1, 1)));
  });
});

describe("editing cells in place", () => {
  test("shows rendered markdown, raw text while editing, and writes back on Tab", () => {
    const v = make(DOC.replace("| 1   |", "| **x** |"));
    const c = cell(widget(v)!, 0, 0);
    expect(textOf(c).querySelector("strong")).not.toBeNull();
    const t = edit(c);
    expect(t.textContent).toBe("**x**");
    t.textContent = "one";
    expect(key(t, "Tab")).toBe(true);
    expect(text(v)).toContain("| one |");
    expect(document.activeElement).toBe(textOf(cell(widget(v)!, 0, 1)));
  });

  test("Tab in the last cell appends a row; Enter goes down and adds a row at the end", () => {
    const v = make();
    key(edit(cell(widget(v)!, 1, 1)), "Tab");
    expect(
      text(v)
        .split("\n")
        .filter((l) => l.startsWith("|")),
    ).toHaveLength(5);
    expect(document.activeElement).toBe(textOf(cell(widget(v)!, 2, 0)));

    const w = make();
    key(edit(cell(widget(w)!, 0, 0)), "Enter");
    expect(document.activeElement).toBe(textOf(cell(widget(w)!, 1, 0)));
    key(edit(cell(widget(w)!, 1, 0), "x"), "Enter");
    expect(text(w)).toContain("| x");
    expect(document.activeElement).toBe(textOf(cell(widget(w)!, 2, 0)));
  });

  test("Shift+Tab goes back, Escape commits and leaves below", () => {
    const v = make();
    const t = edit(cell(widget(v)!, 0, 1), "two");
    expect(key(t, "Tab", { shiftKey: true })).toBe(true);
    expect(text(v)).toContain("| two");
    expect(document.activeElement).toBe(textOf(cell(widget(v)!, 0, 0)));
    key(edit(cell(widget(v)!, 0, 0)), "Escape");
    expect(v.state.selection.main.head).toBeGreaterThan(tableFrom + T.length);
    expect(widget(v)).not.toBeNull();
  });

  test("arrow keys move between cells at the cell edges", () => {
    const v = make();
    const t = edit(cell(widget(v)!, 0, 0));
    expect(key(t, "ArrowRight")).toBe(true); // caret is at the end
    expect(document.activeElement).toBe(textOf(cell(widget(v)!, 0, 1)));
    key(edit(cell(widget(v)!, 0, 1)), "ArrowDown");
    expect(document.activeElement).toBe(textOf(cell(widget(v)!, 1, 1)));
  });

  test("pasting tab-separated text fills cells from the edited one", () => {
    const v = make();
    const t = edit(cell(widget(v)!, 0, 0));
    const ev = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(ev, "clipboardData", {
      value: { getData: (k: string) => (k === "text/plain" ? "p\tq\nr\ts" : "") },
    });
    t.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    const lines = text(v).split("\n");
    expect(lines.some((l) => /\|\s*p\s*\|\s*q\s*\|/.test(l))).toBe(true);
    expect(lines.some((l) => /\|\s*r\s*\|\s*s\s*\|/.test(l))).toBe(true);
  });
});

describe("handles", () => {
  test("insert row below, insert column after, and the end handles", () => {
    let v = make();
    click(action(widget(v)!, "row-add", 0));
    expect(text(v)).toContain(
      ["| a   | b   |", "| --- | --- |", "| 1   | 2   |", "|     |     |", "| 3   | 4   |"].join(
        "\n",
      ),
    );

    v = make();
    click(action(widget(v)!, "col-add", -1)); // header cell 0 → after column a
    expect(text(v)).toContain(["| a   |     | b   |", "| --- | --- | --- |"].join("\n"));

    v = make();
    click(action(widget(v)!, "end-row"));
    expect(
      text(v)
        .split("\n")
        .filter((l) => l.startsWith("|")),
    ).toHaveLength(5);
    v = make();
    click(action(widget(v)!, "end-col"));
    expect(text(v)).toContain("| a   | b   |     |");
  });

  test("the column menu offers the commands and runs one", () => {
    const v = make();
    click(action(widget(v)!, "col-menu"));
    const menu = document.querySelector(".cm-table-menu")!;
    const labels = [...menu.querySelectorAll("button")].map((b) => b.textContent);
    expect(labels).toEqual(
      expect.arrayContaining([
        "Insert column left",
        "Sort A \u2192 Z",
        "Align right",
        "Delete column",
      ]),
    );
    click(menu.querySelector<HTMLElement>('[data-command="table.alignRight"]')!);
    expect(text(v)).toContain("| --: |");
    expect(document.querySelector(".cm-table-menu")).toBeNull();
  });

  test("a row action is one undo step", () => {
    const v = make();
    click(action(widget(v)!, "row-add", 0));
    expect(text(v)).not.toBe(DOC);
    undo(v);
    expect(text(v)).toBe(
      DOC.replace(
        T,
        ["| a   | b   |", "| --- | --- |", "| 1   | 2   |", "| 3   | 4   |"].join("\n"),
      ),
    );
  });

  test("an edited cell is one undo step", () => {
    const v = make();
    key(edit(cell(widget(v)!, 0, 0), "changed"), "Tab");
    expect(text(v)).toContain("changed");
    undo(v);
    expect(text(v)).toBe(DOC);
  });
});

describe("Edit source", () => {
  test("the button shows the markdown and the Done toolbar button renders it again", () => {
    const v = make();
    click(action(widget(v)!, "source"));
    expect(widget(v)).toBeNull();
    expect(v.contentDOM.querySelectorAll(".cm-table-source-line")).toHaveLength(4);
    // The palette command toggles back.
    expect(runTableCommand(v, "table.toggleSource")).toBe(true);
    expect(widget(v)).not.toBeNull();
    expect(v.contentDOM.querySelector(".cm-table-source-line")).toBeNull();
  });

  test("the palette command turns the table at the caret into source", () => {
    const v = make(DOC, tableFrom + 3);
    runTableCommand(v, "table.toggleSource");
    expect(widget(v)).toBeNull();
    expect(v.contentDOM.querySelectorAll(".cm-table-source-line").length).toBeGreaterThan(0);
  });
});

describe("fullscreen", () => {
  const overlay = () => document.querySelector<HTMLElement>(".cm-table-fullscreen");

  test("opens from the expand button and closes with Escape", () => {
    const v = make();
    click(action(widget(v)!, "expand"));
    expect(overlay()).not.toBeNull();
    expect(overlay()!.querySelectorAll("[data-row][data-col]").length).toBe(6);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(overlay()).toBeNull();
  });

  test("closes on the close button and on a backdrop click", () => {
    const v = make();
    click(action(widget(v)!, "expand"));
    click(overlay()!.querySelector(".writer-fullscreen-close")!);
    expect(overlay()).toBeNull();
    click(action(widget(v)!, "expand"));
    overlay()!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(overlay()).toBeNull();
  });

  test("an edit inside it is a document edit, one undo step, and shows in the note", () => {
    const v = make();
    openTableFullscreen(v, tableFrom);
    const o = overlay()!;
    key(edit(cell(o, 0, 1), "fresh"), "Tab");
    expect(text(v)).toContain("| fresh");
    expect(textOf(cell(widget(v)!, 0, 1)).textContent).toBe("fresh");
    // Tab from the last cell added a row in the overlay as well.
    click(action(o, "row-add", 0));
    expect(o.querySelectorAll("tbody tr")).toHaveLength(3);
    undo(v);
    expect(o.querySelectorAll("tbody tr")).toHaveLength(2);
    undo(v);
    expect(text(v)).toBe(DOC);
  });

  test("only one at a time, and destroying the editor closes it", () => {
    const v = make();
    openTableFullscreen(v, tableFrom);
    openTableFullscreen(v, tableFrom);
    expect(document.querySelectorAll(".cm-table-fullscreen")).toHaveLength(1);
    v.destroy();
    expect(overlay()).toBeNull();
  });
});
