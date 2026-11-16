// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vite-plus/test";
import { EditorSelection, EditorState, type Transaction } from "@codemirror/state";
import { insertNewlineContinueMarkup, markdown } from "@codemirror/lang-markdown";
import { EditorView } from "@codemirror/view";
import { GFM } from "@lezer/markdown";
import {
  defaultHideExtensions,
  prosemarkBasicSetup,
  prosemarkMarkdownSyntaxExtensions,
} from "../src/lib/prosemark-core/main";
import { blockQuoteEnter } from "../src/lib/prosemark-core/blockQuote";
import {
  calloutDecorations,
  calloutField,
  setFoldedEffect,
} from "../src/components/editor-area/callout-decorations";
import {
  clearCalloutFolds,
  getCalloutFolds,
  setCalloutFolded,
} from "../src/lib/callouts/fold-state";
import { withFullParse } from "./helpers/parsed-state";

afterEach(() => clearCalloutFolds());

// `doc` with `|` marking the caret (none: caret at 0).
function make(marked: string, path = "a.md", getPath: () => string = () => path) {
  const caret = Math.max(0, marked.indexOf("|"));
  const field = calloutField(getPath);
  const state = withFullParse(
    EditorState.create({
      doc: marked.replace("|", ""),
      selection: EditorSelection.single(caret),
      extensions: [
        markdown({ extensions: [GFM, prosemarkMarkdownSyntaxExtensions] }),
        defaultHideExtensions,
        field,
      ],
    }),
  );
  return { state, field };
}

type Found = { from: number; to: number; spec: Record<string, unknown> };
function decos(state: EditorState, field: ReturnType<typeof make>["field"]): Found[] {
  const out: Found[] = [];
  state.field(field).decorations.between(0, state.doc.length, (from, to, d) => {
    out.push({ from, to, spec: d.spec as Record<string, unknown> });
  });
  return out;
}
const lineClasses = (state: EditorState, field: ReturnType<typeof make>["field"]) =>
  decos(state, field)
    .filter((d) => d.spec.attributes)
    .map(
      (d) =>
        ({
          line: state.doc.lineAt(d.from).number,
          ...(d.spec.attributes as Record<string, string>),
        }) as Record<string, string> & { line: number },
    );
const replaces = (found: Found[]) =>
  found.filter((d) => d.to > d.from && (d.spec.widget || (!d.spec.class && !d.spec.attributes)));
const select = (state: EditorState, pos: number) =>
  state.update({ selection: { anchor: pos } }).state;

const DOC = "intro\n\n> [!info] Heads **up**\n> line one\n> line two\n\nafter";
const at = (needle: string, off = 0) => DOC.indexOf(needle) + off;

describe("callout decorations (state level)", () => {
  test("caret outside: card lines, icon widget over the prefix, title mark, no source change", () => {
    const { state, field } = make(DOC);
    expect(state.doc.toString()).toBe(DOC);
    const lines = lineClasses(state, field);
    expect(lines.map((l) => l.line)).toEqual([3, 4, 5]);
    for (const l of lines) {
      expect(l["data-callout"]).toBe("info");
      expect(l.class).toContain("callout");
      expect(l.class).toContain("cm-callout-line");
      expect(l.class).not.toContain("cm-callout-revealed");
    }
    expect(lines[0]!.class).toContain("callout-title");
    expect(lines[0]!.class).toContain("cm-callout-first");
    expect(lines[2]!.class).toContain("cm-callout-last");
    expect(lines[1]!.class).not.toContain("callout-title");

    const all = decos(state, field);
    const prefix = replaces(all).find((d) => d.spec.widget);
    expect(prefix).toMatchObject({ from: at("> [!info]"), to: at("Heads") });
    const title = all.find((d) => d.spec.class === "callout-title-inner");
    expect(title).toMatchObject({
      from: at("Heads"),
      to: at("Heads **up**") + "Heads **up**".length,
    });
    // Not foldable: no chevron.
    expect(
      all.some((d) => (d.spec.widget as { index?: number } | undefined)?.index !== undefined),
    ).toBe(false);
  });

  test("caret in the header or body reveals the raw source (no prefix widget)", () => {
    for (const pos of [at("Heads"), at("> [!info]"), at("line one", 3), at("line two") + 8]) {
      const { state, field } = make(DOC);
      const s = select(state, pos);
      expect(replaces(decos(s, field)).filter((d) => d.spec.widget)).toEqual([]);
      for (const l of lineClasses(s, field)) expect(l.class).toContain("cm-callout-revealed");
    }
  });

  test("a range selection that touches the callout reveals it", () => {
    const { state, field } = make(DOC);
    const s = state.update({ selection: { anchor: 0, head: at("line one") } }).state;
    expect(replaces(decos(s, field)).filter((d) => d.spec.widget)).toEqual([]);
  });

  test("title-only callout shows the default title in the widget", () => {
    const { state, field } = make("para\n\n> [!warning]\n\nafter");
    const w = decos(state, field).find((d) => d.spec.widget)!;
    const widget = w.spec.widget as { kind: string; fallbackTitle: string | null };
    expect(widget.kind).toBe("warning");
    expect(widget.fallbackTitle).toBe("Warning");
    expect(lineClasses(state, field)).toHaveLength(1);
  });

  test("an alias keeps its typed name as data-callout and the canonical kind for the icon", () => {
    const { state, field } = make("x\n\n> [!tldr] Short\n> body");
    expect(lineClasses(state, field)[0]!["data-callout"]).toBe("tldr");
    const widget = decos(state, field).find((d) => d.spec.widget)!.spec.widget as { kind: string };
    expect(widget.kind).toBe("abstract");
  });

  test("foldable `-`: body folded away, chevron shown, `+` open", () => {
    const doc = "x\n\n> [!faq]- Closed\n> hidden body\n\n> [!tip]+ Open\n> shown body";
    const { state, field } = make(doc);
    const found = decos(state, field);
    const lines = lineClasses(state, field);
    // Closed: header only. Open: header + body.
    expect(lines.map((l) => l.line)).toEqual([3, 6, 7]);
    expect(lines[0]!.class).toContain("is-collapsed");
    expect(lines[0]!.class).toContain("is-collapsible");
    expect(lines[0]!.class).toContain("cm-callout-last");
    expect(lines[1]!.class).not.toContain("is-collapsed");
    const folds = found.filter(
      (d) => (d.spec.widget as { folded?: boolean })?.folded !== undefined,
    );
    expect(folds.map((d) => (d.spec.widget as { folded: boolean }).folded)).toEqual([true, false]);
    const hidden = found.find(
      (d) => !d.spec.widget && !d.spec.class && !d.spec.attributes && d.to > d.from,
    );
    expect(doc.slice(hidden!.from, hidden!.to)).toBe("\n> hidden body");
    expect(state.field(field).atomic.size).toBe(1);
  });

  test("caret on the folded header keeps it folded; caret in the body opens it", () => {
    const doc = "x\n\n> [!faq]- Closed\n> hidden body\n\nz";
    const { state, field } = make(doc);
    const onHeader = select(state, doc.indexOf("Closed"));
    expect(lineClasses(onHeader, field)).toHaveLength(1);
    expect(onHeader.field(field).atomic.size).toBe(1);
    const inBody = select(state, doc.indexOf("hidden") + 2);
    expect(lineClasses(inBody, field)).toHaveLength(2);
    expect(inBody.field(field).atomic.size).toBe(0);
  });

  test("the fold effect overrides the marker, either way", () => {
    const doc = "x\n\n> [!faq]- Closed\n> a\n\n> [!tip]+ Open\n> b";
    const { state, field } = make(doc);
    const s1 = state.update({ effects: setFoldedEffect.of({ index: 0, folded: false }) }).state;
    const s2 = s1.update({ effects: setFoldedEffect.of({ index: 1, folded: true }) }).state;
    expect(lineClasses(s1, field).map((l) => l.line)).toEqual([3, 4, 6, 7]);
    expect(lineClasses(s2, field).map((l) => l.line)).toEqual([3, 4, 6]);
  });

  test("a non-foldable callout never folds", () => {
    const { state, field } = make("x\n\n> [!note] T\n> body");
    const s = state.update({ effects: setFoldedEffect.of({ index: 0, folded: true }) }).state;
    expect(lineClasses(s, field)).toHaveLength(2);
    expect(s.field(field).atomic.size).toBe(0);
  });

  test("fold choices come from the session store per path, and follow a path change", () => {
    const doc = "x\n\n> [!tip]+ Open\n> b";
    setCalloutFolded("b.md", 0, true);
    let path = "a.md";
    const { state, field } = make(doc, "a.md", () => path);
    expect(lineClasses(state, field)).toHaveLength(2);
    // A tab swap to another document reloads that document's choices.
    path = "b.md";
    const swapped = state.update({ selection: { anchor: 1 } }).state;
    expect(lineClasses(swapped, field)).toHaveLength(1);
    // A fresh state for a path with a stored choice starts that way.
    const b = make(doc, "b.md");
    expect(lineClasses(b.state, b.field)).toHaveLength(1);
    const c = make(doc, "c.md");
    expect(lineClasses(c.state, c.field)).toHaveLength(2);
  });

  test("nested callouts: both decorated; the inner type wins on its lines", () => {
    const doc = "x\n\n> [!question] Outer\n> > [!todo] Inner\n> > body\n>\n> tail";
    const { state, field } = make(doc);
    const lines = lineClasses(state, field);
    const byLine = (n: number) => lines.filter((l) => l.line === n).map((l) => l["data-callout"]);
    expect(byLine(3)).toEqual(["question"]);
    expect(byLine(4)).toEqual(["question", "todo"]);
    expect(byLine(5)).toEqual(["question", "todo"]);
    expect(byLine(7)).toEqual(["question"]);
  });

  test("a callout in a list item is left as a plain quote", () => {
    const { state, field } = make("- item\n  > [!note] In a list\n  > body");
    expect(decos(state, field)).toEqual([]);
  });

  test("typing in the body keeps the decorations in step", () => {
    const { state, field } = make(DOC);
    const pos = at("line one") + 4;
    const s = state.update({
      changes: { from: pos, insert: "X" },
      selection: { anchor: pos + 1 },
    }).state;
    expect(s.doc.toString()).toBe(DOC.slice(0, pos) + "X" + DOC.slice(pos));
    expect(lineClasses(s, field).map((l) => l.line)).toEqual([3, 4, 5]);
  });

  test("deleting the header marker turns it back into a plain quote", () => {
    const { state, field } = make(DOC);
    const from = at("[!info]");
    const s = state.update({ changes: { from, to: from + "[!info] ".length } }).state;
    expect(decos(withFullParse(s), field)).toEqual([]);
  });
});

describe("Enter in a callout", () => {
  function enter(marked: string): string | null {
    const caret = marked.indexOf("|");
    const state = withFullParse(
      EditorState.create({
        doc: marked.replace("|", ""),
        selection: EditorSelection.single(caret),
        extensions: [markdown({ extensions: [GFM] })],
      }),
    );
    let next: EditorState | null = null;
    const dispatch = (tr: Transaction) => {
      next = tr.state;
    };
    if (
      !blockQuoteEnter({ state, dispatch }) &&
      !insertNewlineContinueMarkup({ state, dispatch })
    ) {
      return null;
    }
    const s = next as EditorState | null;
    if (!s) return null;
    const head = s.selection.main.head;
    return `${s.doc.toString().slice(0, head)}|${s.doc.toString().slice(head)}`;
  }

  test("at the end of the header or a body line continues with `> `", () => {
    expect(enter("> [!note] Title|")).toBe("> [!note] Title\n> |");
    expect(enter("> [!note] Title\n> body|")).toBe("> [!note] Title\n> body\n> |");
    expect(enter("> [!tip]-|")).toBe("> [!tip]-\n> |");
  });

  test("an empty quote line still ends the quote", () => {
    expect(enter("> [!note] Title\n> body\n> |")).toBe("> [!note] Title\n> body\n|");
  });
});

describe("mounted view: fold toggle", () => {
  let cleanup = () => {};
  afterEach(() => cleanup());

  function mount(doc: string, path = "note.md") {
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({
      parent,
      state: withFullParse(
        EditorState.create({
          doc,
          selection: EditorSelection.single(0),
          extensions: [
            markdown({ extensions: [GFM, prosemarkMarkdownSyntaxExtensions] }),
            defaultHideExtensions,
            calloutDecorations(() => path),
          ],
        }),
      ),
    });
    cleanup = () => (view.destroy(), parent.remove());
    return view;
  }

  function click(el: Element) {
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
  }

  test("renders the documented DOM on the real lines", () => {
    const view = mount("x\n\n> [!tip]- Fold me\n> body\n\nz");
    const header = view.dom.querySelector<HTMLElement>(".callout.callout-title[data-callout]")!;
    expect(header.dataset.callout).toBe("tip");
    expect(header.getAttribute("data-callout-fold")).toBe("-");
    expect(header.querySelector(".callout-icon svg")).not.toBeNull();
    expect(header.querySelector(".callout-title-inner")?.textContent).toBe("Fold me");
    expect(header.querySelector(".callout-fold")).not.toBeNull();
    // Folded: the body line is not in the DOM.
    expect(view.dom.textContent).not.toContain("body");
  });

  test("coexists with the full prosemark setup (quote bars, hide, lists) and folds", () => {
    const doc = "x\n\n> [!bug]- Nested\n> - item\n> > [!tip] inner\n> > body\n\nz";
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({
      parent,
      state: withFullParse(
        EditorState.create({
          doc,
          selection: EditorSelection.single(0),
          extensions: [
            markdown({ extensions: [GFM, prosemarkMarkdownSyntaxExtensions] }),
            prosemarkBasicSetup(),
            calloutDecorations(() => "full.md"),
          ],
        }),
      ),
    });
    cleanup = () => (view.destroy(), parent.remove());
    expect(view.dom.querySelectorAll(".cm-callout-line")).toHaveLength(1);
    click(view.dom.querySelector(".callout-fold")!);
    expect(view.dom.querySelectorAll(".cm-callout-line")).toHaveLength(4);
    expect(view.dom.querySelectorAll(".cm-blockquote-line").length).toBeGreaterThan(0);
    expect(view.dom.querySelectorAll(".callout-icon").length).toBe(2);
  });

  test("a non-foldable callout has no chevron", () => {
    const view = mount("x\n\n> [!note] Plain\n> body");
    expect(view.dom.querySelector(".callout-fold")).toBeNull();
  });

  test("clicking the chevron unfolds, again folds, and remembers per document", () => {
    const view = mount("x\n\n> [!tip]- Fold me\n> body\n\nz");
    click(view.dom.querySelector(".callout-fold")!);
    expect(view.dom.textContent).toContain("body");
    expect(view.dom.querySelector(".callout-fold")?.classList.contains("is-collapsed")).toBe(false);
    expect(getCalloutFolds("note.md").get(0)).toBe(false);
    // The caret did not move.
    expect(view.state.selection.main.head).toBe(0);

    click(view.dom.querySelector(".callout-fold")!);
    expect(view.dom.textContent).not.toContain("body");
    expect(getCalloutFolds("note.md").get(0)).toBe(true);
    // The file text never changes.
    expect(view.state.doc.toString()).toBe("x\n\n> [!tip]- Fold me\n> body\n\nz");
  });

  test("a view opened later for the same document starts with the remembered state", () => {
    const doc = "x\n\n> [!tip]- Fold me\n> body\n\nz";
    const first = mount(doc);
    click(first.dom.querySelector(".callout-fold")!);
    cleanup();
    const second = mount(doc);
    expect(second.dom.textContent).toContain("body");
    cleanup();
    const other = mount(doc, "other.md");
    expect(other.dom.textContent).not.toContain("body");
  });

  test("folding with the caret in the body moves the caret to the header", () => {
    const doc = "x\n\n> [!tip]+ Open\n> body\n\nz";
    const view = mount(doc);
    view.dispatch({ selection: { anchor: doc.indexOf("body") + 1 } });
    click(view.dom.querySelector(".callout-fold")!);
    expect(view.state.selection.main.head).toBe(doc.indexOf("Open") + "Open".length);
    expect(view.dom.textContent).not.toContain("body");
  });
});
