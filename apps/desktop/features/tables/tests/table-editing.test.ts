// @vitest-environment jsdom
// Table editing in a live CodeMirror view: Tab/Shift-Tab/Enter/Escape, line breaks, commands, undo
// granularity, paste, format on leave, the toolbar, yielding to the Advanced Tables plugin.
import { EditorSelection, EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { history, undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { ensureSyntaxTree } from "@codemirror/language";
import { GFM } from "@lezer/markdown";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import {
  getTableEditorView,
  insertTableCommand,
  runTableCommand,
  setTableYieldProbe,
  tableContextAt,
  tableEditing,
  tableCommands,
  convertSelectionToTable,
  type TableCommandId,
} from "../web/table-editing";

const views: EditorView[] = [];

function make(doc: string, cursorAt: string | number = 0): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const pos = typeof cursorAt === "number" ? cursorAt : doc.indexOf(cursorAt) + cursorAt.length;
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: EditorSelection.cursor(pos),
      extensions: [markdown({ extensions: [GFM] }), history(), tableEditing()],
    }),
  });
  ensureSyntaxTree(view.state, doc.length, 1000);
  view.dispatch({ selection: view.state.selection });
  views.push(view);
  return view;
}

function key(view: EditorView, k: string, mods: Partial<KeyboardEventInit> = {}): boolean {
  const ev = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...mods });
  view.contentDOM.dispatchEvent(ev);
  return ev.defaultPrevented;
}

const text = (v: EditorView) => v.state.doc.toString();
/** Caret as `text|text` for readable assertions. */
function marked(v: EditorView): string {
  const h = v.state.selection.main.head;
  return `${text(v).slice(0, h)}|${text(v).slice(h)}`;
}

const T = ["| a   | b   |", "| --- | --- |", "| 1   | 2   |"].join("\n");

beforeEach(() => setTableYieldProbe(() => false));
afterEach(() => {
  for (const v of views.splice(0)) v.destroy();
  document.body.innerHTML = "";
  setTableYieldProbe(null);
});

describe("Tab / Shift-Tab", () => {
  test("moves between cells with the caret at the end of the content", () => {
    const v = make(T, "| a");
    expect(key(v, "Tab")).toBe(true);
    expect(marked(v)).toContain("| b|");
    key(v, "Tab"); // header -> first body cell
    expect(marked(v)).toContain("| 1|");
    key(v, "Tab");
    expect(marked(v)).toContain("| 2|");
    key(v, "Tab", { shiftKey: true });
    expect(marked(v)).toContain("| 1|");
  });
  test("Tab in the last cell appends a row, caret in its first cell", () => {
    const v = make(T, "| 2");
    key(v, "Tab");
    expect(text(v)).toBe([T, "|     |     |"].join("\n"));
    expect(v.state.selection.main.head).toBe(text(v).lastIndexOf("|     |     |") + 2);
  });
  test("Tab realigns the table when a cell grew", () => {
    const v = make("| a | b |\n| - | - |\n| 1 | 2 |", "| 1");
    v.dispatch({ changes: { from: v.state.selection.main.head, insert: "long text" } });
    key(v, "Tab");
    expect(text(v)).toBe(
      ["| a          | b   |", "| ---------- | --- |", "| 1long text | 2   |"].join("\n"),
    );
  });
  test("Shift-Tab in the first header cell stays put and swallows the key", () => {
    const v = make(T, "| a");
    expect(key(v, "Tab", { shiftKey: true })).toBe(true);
    expect(text(v)).toBe(T);
  });
  test("Tab from the delimiter row goes to the first body cell", () => {
    const v = make(T, "| ---");
    key(v, "Tab");
    expect(marked(v)).toContain("| 1|");
  });
  test("is not handled outside a table or inside a code block", () => {
    const v = make("plain | text\n\nmore", 3);
    expect(key(v, "Tab")).toBe(false);
    const code = ["```", "| a | b |", "| - | - |", "| 1 | 2 |", "```"].join("\n");
    const c = make(code, "| 1");
    expect(key(c, "Tab")).toBe(false);
    expect(text(c)).toBe(code);
  });
});

describe("Enter", () => {
  test("moves down in the same column, new row at the end", () => {
    const v = make(T, "| a");
    key(v, "Enter");
    expect(marked(v)).toContain("| 1|");
    key(v, "Enter");
    expect(text(v).split("\n")).toHaveLength(4);
    expect(tableContextAt(v.state)?.cursor).toEqual({ row: 1, col: 0 });
  });
  test("Enter on a completely empty last row removes it and leaves the table", () => {
    const v = make(`${T}\n|     |     |\n`, "|     |");
    key(v, "Enter");
    expect(text(v)).toBe(`${T}\n\n`);
    expect(v.state.selection.main.head).toBe(text(v).length);
    expect(tableContextAt(v.state)).toBeNull();
  });
});

describe("Shift-Enter / Alt-Enter", () => {
  test("inserts <br> in the cell and re-aligns, caret after the break", () => {
    const v = make(T, "| 1");
    v.dispatch({ selection: { anchor: text(v).indexOf("| 1") + 2 } });
    key(v, "Enter", { shiftKey: true });
    expect(text(v)).toContain("| <br>1");
    expect(v.state.selection.main.head).toBe(text(v).indexOf("<br>") + 4);
    key(v, "Enter", { altKey: true });
    expect(text(v).match(/<br>/g)).toHaveLength(2);
  });
});

describe("Escape / Mod-Enter", () => {
  test("exits below with a blank line separating, at end of document", () => {
    const v = make(T, "| 1");
    key(v, "Escape");
    expect(text(v)).toBe(`${T}\n\n`);
    expect(v.state.selection.main.head).toBe(text(v).length);
  });
  test("moves onto the blank line after the table when text follows", () => {
    const v = make(`${T}\n\nafter`, "| 1");
    key(v, "Enter", { ctrlKey: true });
    expect(text(v)).toBe(`${T}\n\n\nafter`);
    expect(marked(v)).toBe(`${T}\n\n|\nafter`);
  });
  test("formats on the way out", () => {
    const v = make("| a | b |\n| - | - |\n| 1 | 2 |", "| 1");
    key(v, "Escape");
    expect(text(v).startsWith(T)).toBe(true);
  });
});

describe("commands are single undo steps", () => {
  const ids: TableCommandId[] = [
    "table.addRowAbove",
    "table.addRowBelow",
    "table.addColumnLeft",
    "table.addColumnRight",
    "table.deleteColumn",
    "table.moveRowDown",
    "table.moveColumnRight",
    "table.duplicateRow",
    "table.sortDescending",
    "table.alignRight",
    "table.transpose",
    "table.format",
  ];
  test.each(ids)("%s", (id) => {
    const src = "| a | b |\n| - | - |\n| 1 | x |\n| 2 | y |";
    const v = make(src, "| 1");
    expect(runTableCommand(v, id)).toBe(true);
    expect(text(v)).not.toBe(src.replace(/ {2,}/g, " ")); // changed (formatted or edited)
    undo(v);
    expect(text(v)).toBe(src);
  });
  test("results", () => {
    const v = make(T, "| 1");
    runTableCommand(v, "table.addColumnRight");
    expect(text(v).split("\n")[0]).toBe("| a   |     | b   |");
    runTableCommand(v, "table.alignCenter");
    expect(text(v).split("\n")[1]).toBe("| --- | :-: | --- |");
    runTableCommand(v, "table.clearCell");
    runTableCommand(v, "table.deleteRow");
    expect(text(v)).toBe(["| a   |     | b   |", "| --- | :-: | --- |"].join("\n"));
    expect(tableContextAt(v.state)?.cursor.row).toBe(-1);
  });
  test("commands report false outside a table", () => {
    const v = make("hello", 2);
    expect(runTableCommand(v, "table.format")).toBe(false);
    expect(Object.keys(tableCommands).length).toBeGreaterThan(15);
  });
  test("Alt-ArrowDown moves the row, Mod-Alt-F formats", () => {
    const v = make("| a | b |\n| - | - |\n| 1 | x |\n| 2 | y |", "| 1");
    key(v, "ArrowDown", { altKey: true });
    expect(text(v).split("\n")[3]).toContain("| 1");
    key(v, "f", { altKey: true, ctrlKey: true, metaKey: true });
    expect(text(v).split("\n")[0]).toBe("| a   | b   |");
  });
});

describe("insert and convert", () => {
  test("insert separates from surrounding text and selects the first header cell", () => {
    const v = make("intro\nnext", 5);
    insertTableCommand(2, 1)({ state: v.state, dispatch: (tr) => v.dispatch(tr) });
    expect(text(v)).toBe(
      [
        "intro",
        "",
        "| Column 1 | Column 2 |",
        "| -------- | -------- |",
        "|          |          |",
        "",
        "next",
      ].join("\n"),
    );
    expect(tableContextAt(v.state)?.cursor).toEqual({ row: -1, col: 0 });
  });
  test("convert selected CSV", () => {
    const v = make("a,b\n1,2", 0);
    v.dispatch({ selection: { anchor: 0, head: text(v).length } });
    expect(convertSelectionToTable({ state: v.state, dispatch: (tr) => v.dispatch(tr) })).toBe(
      true,
    );
    expect(text(v)).toBe(T.replace("| 2   |", "| 2   |"));
    const w = make("not tabular", 0);
    w.dispatch({ selection: { anchor: 0, head: 3 } });
    expect(convertSelectionToTable({ state: w.state, dispatch: (tr) => w.dispatch(tr) })).toBe(
      false,
    );
  });
});

describe("paste", () => {
  function paste(view: EditorView, data: Record<string, string>): boolean {
    const ev = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(ev, "clipboardData", {
      value: { getData: (t: string) => data[t] ?? "" },
    });
    view.contentDOM.dispatchEvent(ev);
    return ev.defaultPrevented;
  }
  test("TSV outside a table becomes a table", () => {
    const v = make("", 0);
    expect(paste(v, { "text/plain": "a\tb\n1\t2" })).toBe(true);
    expect(text(v)).toBe(T);
  });
  test("TSV inside a table fills cells from the caret and grows it", () => {
    const v = make(T, "| 1");
    paste(v, { "text/plain": "x\ty\tz\nq\tr\ts" });
    expect(text(v).split("\n")).toHaveLength(4);
    expect(text(v).split("\n")[2]).toContain("x");
    expect(text(v).split("\n")[0]).toContain("|     |");
  });
  test("HTML table", () => {
    const v = make("", 0);
    paste(v, {
      "text/html": "<table><tr><th>h1</th><th>h2</th></tr><tr><td>a|b</td><td>c</td></tr></table>",
    });
    expect(text(v).split("\n")[2]).toBe("| a\\|b | c   |");
  });
  test("pipes in single-cell paste are escaped", () => {
    const v = make(T, "| 1");
    paste(v, { "text/plain": "x|y" });
    expect(text(v)).toContain("x\\|y");
  });
  test("plain text and code blocks are left to the default paste", () => {
    const v = make("", 0);
    paste(v, { "text/plain": "hello" });
    expect(text(v)).not.toContain("|");
    const code = "```\n\n```";
    const c = make(code, 4);
    paste(c, { "text/plain": "a\tb\n1\t2" });
    expect(text(c)).not.toContain("| ---");
  });
});

describe("format on leave", () => {
  test("aligns an edited table once the caret leaves, not an untouched one", async () => {
    const messy = "| a | b |\n| - | - |\n| 1 | 2 |\n\nafter";
    const v = make(messy, "| 1");
    v.dispatch({ selection: { anchor: text(v).length } }); // leave without editing
    await Promise.resolve();
    expect(text(v)).toBe(messy);

    const w = make(messy, "| 1");
    w.dispatch({ changes: { from: w.state.selection.main.head, insert: "x" } });
    w.dispatch({ selection: { anchor: text(w).length } });
    await Promise.resolve();
    expect(text(w).startsWith("| a   | b   |\n| --- | --- |\n| 1x  | 2   |")).toBe(true);
    undo(w);
    expect(text(w)).toContain("| 1x |");
  });
});

describe("toolbar and yielding", () => {
  test("toolbar renders while the caret is in a focused table and runs commands", () => {
    const v = make(T, "| 1");
    v.focus();
    v.dispatch({ selection: v.state.selection });
    const bar = v.dom.querySelector<HTMLElement>(".cm-table-toolbar");
    expect(bar).not.toBeNull();
    expect(bar?.hidden).toBe(false);
    bar?.querySelector<HTMLButtonElement>('[data-command="table.addRowBelow"]')?.click();
    expect(text(v).split("\n")).toHaveLength(4);
    v.dispatch({ selection: { anchor: 0 } });
    expect(bar?.hidden).toBe(false); // still inside the table's first line
    expect(getTableEditorView()).toBe(v);
  });
  test("keymap, paste and auto-format yield to Advanced Tables; commands still work", async () => {
    setTableYieldProbe(() => true);
    const v = make(T, "| a");
    expect(key(v, "Tab")).toBe(false);
    expect(key(v, "Enter")).toBe(false);
    expect(runTableCommand(v, "table.addRowBelow")).toBe(true);
    const messy = "| a | b |\n| - | - |\n| 1 | 2 |\n\nafter";
    const w = make(messy, "| 1");
    w.dispatch({ changes: { from: w.state.selection.main.head, insert: "x" } });
    w.dispatch({ selection: { anchor: text(w).length } });
    await Promise.resolve();
    expect(text(w)).toContain("| 1x |");
  });
});

void vi;
