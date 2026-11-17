// @vitest-environment jsdom
// The composer's live Markdown: pure state tests (decoration classes from the syntax tree, list
// continuation, wrap commands) plus a view with pills to prove Markdown never changes the text or
// which tokens are pills.
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  composerExtensions,
  pillField,
  setPillContext,
} from "@features/agent/web/components/composer-extensions";
import {
  composerMarkdown,
  composerNewline,
  lineClasses,
  styledSpans,
} from "@features/agent/web/components/composer-markdown";
import { toggleBold, toggleItalic } from "@/components/editor-area/markdown-formatting";
import type { PillContext } from "@features/agent/web/lib/pill";
import "@features/agent/tests/helpers/agent-composer";

function mdState(doc: string, anchor = doc.length, head = anchor) {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.single(anchor, head),
    extensions: [composerMarkdown()],
  });
  ensureSyntaxTree(state, doc.length, 5000);
  return state;
}
const spans = (doc: string) =>
  styledSpans(mdState(doc)).map((s) => [doc.slice(s.from, s.to), s.class] as const);
/** Every character of the first `text` in `doc` carries `cls` (the highlighter splits spans at marks). */
function hasSpan(doc: string, text: string, cls: string) {
  const at = doc.indexOf(text);
  const all = styledSpans(mdState(doc));
  for (let i = at; i < at + text.length; i++)
    if (!all.some((s) => s.from <= i && i < s.to && s.class.split(" ").includes(cls))) return false;
  return true;
}

describe("composer markdown classes", () => {
  it("styles headings, emphasis, strikethrough and inline code, markers dimmed", () => {
    expect(hasSpan("# Title", "# Title", "cm-md-h1")).toBe(true);
    expect(hasSpan("## Sub", "## Sub", "cm-md-h2")).toBe(true);
    expect(hasSpan("# Title", "#", "cm-md-mark")).toBe(true);
    expect(hasSpan("a **bold** b", "**bold**", "cm-md-strong")).toBe(true);
    expect(hasSpan("a **bold** b", "**", "cm-md-mark")).toBe(true);
    expect(hasSpan("a *it* b", "*it*", "cm-md-em")).toBe(true);
    expect(hasSpan("a ~~gone~~ b", "~~gone~~", "cm-md-strike")).toBe(true);
    expect(hasSpan("run `npm i` now", "npm i", "cm-md-code")).toBe(true);
  });

  it("styles links, task markers, list marks, quotes and rules", () => {
    expect(hasSpan("[docs](https://x.dev)", "https://x.dev", "cm-md-url")).toBe(true);
    expect(hasSpan("[docs](https://x.dev)", "[docs](https://x.dev)", "cm-md-link")).toBe(true);
    expect(hasSpan("- [x] done", "[x]", "cm-md-task")).toBe(true);
    expect(hasSpan("- item", "-", "cm-md-mark")).toBe(true);
    expect(hasSpan("1. item", "1.", "cm-md-mark")).toBe(true);
    expect(hasSpan("> said", "> said", "cm-md-quote")).toBe(true);
    expect(hasSpan("a\n\n---\n\nb", "---", "cm-md-hr")).toBe(true);
  });

  it("gives fenced code and quote lines their line classes", () => {
    const state = mdState("intro\n```ts\nlet a = 1\n```\n> q1\n> q2\nend");
    expect(lineClasses(state)).toEqual([
      { line: 2, class: "cm-md-fence-line cm-md-fence-first" },
      { line: 3, class: "cm-md-fence-line" },
      { line: 4, class: "cm-md-fence-line cm-md-fence-last" },
      { line: 5, class: "cm-md-quote-line" },
      { line: 6, class: "cm-md-quote-line" },
    ]);
  });

  it("treats an unclosed fence as code to the end, and leaves plain text alone", () => {
    expect(lineClasses(mdState("```\nopen\nstill")).map((l) => l.line)).toEqual([1, 2, 3]);
    expect(lineClasses(mdState("just words\nand more"))).toEqual([]);
    expect(spans("just words")).toEqual([]);
  });

  it("does not parse tables, setext headings, indented code or html", () => {
    expect(spans("| a | b |\n| - | - |\n| 1 | 2 |").some(([, c]) => c.includes("cm-md-h"))).toBe(
      false,
    );
    expect(spans("title\n---").some(([, c]) => c.includes("cm-md-h2"))).toBe(false);
    expect(lineClasses(mdState("    indented\n    more"))).toEqual([]);
    expect(spans("<b>x</b>")).toEqual([]);
  });
});

describe("Shift+Enter in lists", () => {
  const run = (doc: string, caret = doc.length) => {
    let state = mdState(doc, caret);
    composerNewline({ state, dispatch: (tr) => (state = tr.state) });
    return [state.doc.toString(), state.selection.main.head] as const;
  };

  it("continues bullets, numbers (incrementing), tasks and quotes", () => {
    expect(run("- one")[0]).toBe("- one\n- ");
    expect(run("1. one")[0]).toBe("1. one\n2. ");
    expect(run("- [ ] todo")[0]).toBe("- [ ] todo\n- [ ] ");
    expect(run("> said")[0]).toBe("> said\n> ");
  });

  it("exits the list on an empty item", () => {
    const [doc, head] = run("- one\n- ");
    expect(doc).toBe("- one\n");
    expect(head).toBe(doc.length);
    expect(run("1. one\n2. ")[0]).toBe("1. one\n");
  });

  it("is a plain newline outside markup", () => {
    expect(run("hello")[0]).toBe("hello\n");
    expect(run("hello world", 5)[0]).toBe("hello\n world");
  });
});

describe("Cmd+B / Cmd+I", () => {
  const apply = (cmd: typeof toggleBold, doc: string, from: number, to: number) => {
    let state = mdState(doc, from, to);
    cmd({ state, dispatch: (tr) => (state = tr.state) });
    return state.doc.toString();
  };
  it("wraps the selection in ** and *", () => {
    expect(apply(toggleBold, "make this loud", 5, 9)).toBe("make **this** loud");
    expect(apply(toggleItalic, "make this soft", 5, 9)).toBe("make *this* soft");
  });
  it("unwraps when the selection is already wrapped", () => {
    expect(apply(toggleBold, "make **this** loud", 7, 11)).toBe("make this loud");
  });
});

describe("markdown in the composer view", () => {
  const views: EditorView[] = [];
  afterEach(() => {
    while (views.length) views.pop()!.destroy();
    document.body.replaceChildren();
  });
  const CTX: PillContext = {
    refs: [{ kind: "note", path: "Notes/Plan.md", label: "Plan" }],
    skills: new Set(["summarize"]),
  };
  const make = (doc: string) => {
    const parent = document.body.appendChild(document.createElement("div"));
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc,
        extensions: composerExtensions({
          onKey: () => false,
          onChange: () => {},
          onCompositionStart: () => {},
          onCompositionEnd: () => {},
          onImageFiles: () => {},
        }),
      }),
    });
    views.push(view);
    view.dispatch({ effects: setPillContext.of(CTX) });
    return view;
  };
  const pills = (v: EditorView) => {
    const out: [number, number][] = [];
    v.state
      .field(pillField)
      .between(0, v.state.doc.length, (from, to) => void out.push([from, to]));
    return out;
  };

  it("keeps a pill a pill inside bold and inside an inline code span (documented rule)", () => {
    const doc =
      "**see @Notes/Plan.md** and `@Notes/Plan.md` and ~~gone @Notes/Plan.md~~\n- /summarize";
    const view = make(doc);
    expect(pills(view).map(([f, t]) => doc.slice(f, t))).toEqual([
      "@Notes/Plan.md",
      "@Notes/Plan.md",
      "@Notes/Plan.md",
      "/summarize",
    ]);
    // styling spans never change the text
    expect(view.state.doc.toString()).toBe(doc);
    expect(view.dom.querySelectorAll(".agent-pill").length).toBe(4);
  });

  it("Shift+Enter keydown continues a list through the real keymap; Enter is left to the composer", () => {
    const view = make("- one @Notes/Plan.md");
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    const press = (init: KeyboardEventInit) =>
      view.contentDOM.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }),
      );
    press({ key: "Enter", shiftKey: true });
    expect(view.state.doc.toString()).toBe("- one @Notes/Plan.md\n- ");
    press({ key: "Enter", shiftKey: true });
    expect(view.state.doc.toString()).toBe("- one @Notes/Plan.md\n");
    press({ key: "Enter" }); // onKey above returns false and the editing keymap has no Enter
    expect(view.state.doc.toString()).toBe("- one @Notes/Plan.md\n");
  });

  it("Mod-b and Mod-i wrap the selection through the keymap", () => {
    const view = make("alpha beta");
    view.dispatch({ selection: { anchor: 0, head: 5 } });
    view.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", { key: "b", ctrlKey: true, bubbles: true, cancelable: true }),
    );
    expect(view.state.doc.toString()).toBe("**alpha** beta");
  });

  it("a 5k-char draft with lots of markup stays cheap", () => {
    const block = "# h\n- item **bold** `code` ~~x~~ [l](http://a.b)\n```\ncode\n```\n> q\n";
    const doc = block.repeat(Math.ceil(5000 / block.length));
    const view = make(doc);
    const t0 = performance.now();
    for (let i = 0; i < 30; i++)
      view.dispatch({
        changes: { from: view.state.doc.length, insert: "x" },
        userEvent: "input.type",
      });
    const per = (performance.now() - t0) / 30;
    expect(view.state.doc.length).toBeGreaterThanOrEqual(5000);
    expect(per).toBeLessThan(50);
  });
});
