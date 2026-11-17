// @vitest-environment jsdom
// The composer's pills: a CodeMirror view over the exact token text. No layout in jsdom, so these
// drive an EditorView with dispatched transactions and key events, and read the model back.
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { undo } from "@codemirror/commands";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  composerExtensions,
  pillAt,
  pillField,
  setPillContext,
} from "../src/components/agent/composer-extensions";
import { reconcileRefs } from "../src/lib/agent/draft-refs";
import type { ContextRef } from "../src/lib/agent/events";
import { createPillElement, pillRanges, type PillContext } from "../src/lib/agent/pill";
import "./helpers/agent-composer";

const PLAN: ContextRef = {
  kind: "note",
  path: "Management/2026-11-16 - Daniel Wierdsma Staff Timing and Growth Plan.md",
  label: "Daniel Wierdsma Staff Timing and Growth Plan",
};
const LONG = `@"${PLAN.label}"`;
const CTX: PillContext = {
  refs: [
    PLAN,
    { kind: "note", path: "Notes/Plan.md", label: "Plan" },
    { kind: "folder", path: "Docs" },
    { kind: "active-note", path: "Notes/Today.md", inline: false },
  ],
  skills: new Set(["summarize"]),
};

const views: EditorView[] = [];
afterEach(() => {
  while (views.length) views.pop()!.destroy();
  document.body.replaceChildren();
});

function make(
  marked: string,
  ctx: PillContext = CTX,
  onKey: (e: KeyboardEvent) => boolean = () => false,
) {
  const caret = marked.includes("|") ? marked.indexOf("|") : marked.replace("|", "").length;
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const open = vi.fn();
  const changes: string[] = [];
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: marked.replace("|", ""),
      selection: EditorSelection.single(caret),
      extensions: composerExtensions({
        onKey,
        open,
        onChange: (t) => changes.push(t),
        onCompositionStart: () => {},
        onCompositionEnd: () => {},
        onImageFiles: () => {},
      }),
    }),
  });
  view.dispatch({ effects: setPillContext.of(ctx) });
  views.push(view);
  return { view, open, changes };
}
const text = (v: EditorView) => v.state.doc.toString();
const head = (v: EditorView) => v.state.selection.main.head;
const key = (v: EditorView, k: string, init: KeyboardEventInit = {}) =>
  v.contentDOM.dispatchEvent(
    new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }),
  );
const pillsIn = (v: EditorView) => [...v.contentDOM.querySelectorAll<HTMLElement>(".agent-pill")];

describe("pill model: one pill per token kind, the document keeps the token text", () => {
  const doc = `see ${LONG} and @Plan, @Docs, @activenote, /summarize, @src/a.md, @Nope, /unknown`;
  const ranges = pillRanges(doc, CTX);

  it("labels, kinds and resolution", () => {
    expect(ranges.map((r) => [r.model.kind, r.model.label, r.model.resolved])).toEqual([
      ["note", PLAN.label, true],
      ["note", "Plan", true],
      ["folder", "Docs", true],
      ["active-note", "Today", true],
      ["skill", "/summarize", true],
      ["note", "a", true], // a typed path resolves at send
      ["note", "Nope", false], // nothing attached: muted
      ["skill", "/unknown", false],
    ]);
    for (const r of ranges) expect(doc.slice(r.from, r.to)).toBe(r.model.raw);
  });

  it("@activenote without an open note is unresolved", () => {
    const m = pillRanges("@activenote", { refs: [] })[0]!.model;
    expect([m.resolved, m.label, m.title]).toEqual([false, "Active note", "No note is open"]);
  });

  it("the shared DOM builder carries kind, tint hook, tooltip and aria-label", () => {
    const el = createPillElement(ranges[0]!.model);
    expect(el.dataset.pillKind).toBe("note");
    expect(el.title).toBe(PLAN.path);
    expect(el.getAttribute("aria-label")).toBe(`Note: ${PLAN.label}`);
    expect(el.querySelector("svg")).not.toBeNull();
    const muted = createPillElement(ranges[6]!.model);
    expect(muted.dataset.resolved).toBe("false");
    expect(muted.getAttribute("aria-label")).toBe("Note: Nope (not attached)");
    expect(createPillElement(ranges[4]!.model).querySelector("svg")).toBeNull();
  });

  it("the editor decorates attached tokens and leaves the text untouched", () => {
    const { view } = make(`${doc} |`);
    expect(text(view)).toBe(`${doc} `);
    const shown = pillsIn(view).map((p) => p.dataset.pillKind);
    expect(shown).toEqual([
      "note",
      "note",
      "folder",
      "active-note",
      "skill",
      "note",
      "note",
      "skill",
    ]);
    expect(pillsIn(view).map((p) => p.dataset.resolved)).toContain("false");
  });

  it("an unbacked token the caret touches stays text while it is typed", () => {
    const { view } = make("see @Pl|");
    expect(pillsIn(view)).toHaveLength(0);
    view.dispatch({ selection: { anchor: 0 } });
    expect(pillsIn(view)).toHaveLength(1);
    expect(pillsIn(view)[0]!.dataset.resolved).toBe("false");
  });
});

describe("whole-pill editing", () => {
  it("Backspace right after a pill removes the whole token in one keystroke", () => {
    const { view } = make(`a ${LONG}| b`);
    expect(head(view)).toBe(2 + LONG.length);
    key(view, "Backspace");
    expect(text(view)).toBe("a  b");
    expect(head(view)).toBe(2);
  });

  it("Delete right before a pill removes the whole token", () => {
    const { view } = make("a |@Plan b");
    key(view, "Delete");
    expect(text(view)).toBe("a  b");
  });

  it("Backspace with a selection deletes it, a pill it only half covers goes whole", () => {
    const { view } = make(`x @Plan y|`);
    view.dispatch({ selection: { anchor: 0, head: 3 } }); // ends inside the pill at 2..7
    key(view, "Backspace");
    expect(text(view)).toBe(" y");
  });

  it("Backspace with a plain selection keeps the pills", () => {
    const { view } = make("hello @Plan");
    view.dispatch({ selection: { anchor: 1, head: 4 } });
    key(view, "Backspace");
    expect(text(view)).toBe("ho @Plan");
  });

  it("a character next to a pill is deleted normally", () => {
    const { view } = make("@Plan |");
    key(view, "Backspace");
    expect(text(view)).toBe("@Plan");
  });

  it("the caret moves over a pill as one unit with Left and Right", () => {
    const { view } = make(`|${LONG} z`);
    key(view, "ArrowRight");
    expect(head(view)).toBe(LONG.length);
    key(view, "ArrowLeft");
    expect(head(view)).toBe(0);
  });

  it("Shift+arrows, Home and End extend the selection over whole pills", () => {
    const { view } = make(`|@Plan @Docs`);
    key(view, "ArrowRight", { shiftKey: true });
    expect([view.state.selection.main.from, view.state.selection.main.to]).toEqual([0, 5]);
    key(view, "End", { shiftKey: true });
    expect(view.state.selection.main.to).toBe(11);
    key(view, "Home");
    expect(head(view)).toBe(0);
    key(view, "End");
    expect(head(view)).toBe(11);
  });

  it("a click inside a pill cannot leave the caret in it", () => {
    const { view } = make(`@Plan z`);
    view.dispatch({ selection: { anchor: 2 } });
    key(view, "ArrowRight");
    expect(head(view)).toBe(5);
  });

  it("cut and copy use the plain token text", () => {
    const { view } = make("x @Plan y");
    view.dispatch({ selection: { anchor: 0, head: 9 } });
    expect(text(view).slice(view.state.selection.main.from, view.state.selection.main.to)).toBe(
      "x @Plan y",
    );
    // CodeMirror copies `state.sliceDoc(selection)`: the document, never the widget DOM
    expect(view.state.sliceDoc(0, 9)).toBe("x @Plan y");
  });

  it("double click selects the whole pill; Cmd+click opens the note", () => {
    const { view, open } = make(`go ${LONG} now`);
    const pill = pillsIn(view)[0]!;
    pill.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    const sel = view.state.selection.main;
    expect(text(view).slice(sel.from, sel.to)).toBe(LONG);
    expect(pillAt(view.state, 5)).toEqual({ from: 3, to: 3 + LONG.length });
    pill.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true, metaKey: true }),
    );
    expect(open).toHaveBeenCalledWith(PLAN.path);
    const plain = vi.fn();
    pill.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    expect(plain).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledTimes(1);
  });
});

describe("paste and undo", () => {
  it("a pasted token that matches an attached ref becomes a pill; otherwise it stays text", () => {
    const { view } = make("|");
    view.dispatch({ changes: { from: 0, insert: "@Plan x" }, userEvent: "input.paste" });
    expect(text(view)).toBe("@Plan x");
    expect(pillsIn(view).map((p) => p.dataset.pillKind)).toEqual(["note"]);
    view.dispatch({
      changes: { from: 7, insert: " @Unknown" },
      selection: { anchor: 16 },
      userEvent: "input.paste",
    });
    expect(text(view)).toBe("@Plan x @Unknown"); // never lose text
    expect(pillsIn(view)).toHaveLength(1); // the caret still touches the unbacked token
  });

  it("undo restores a deleted pill whole", () => {
    const { view } = make("a @Plan| b");
    key(view, "Backspace");
    expect(text(view)).toBe("a  b");
    undo(view);
    expect(text(view)).toBe("a @Plan b");
    expect(pillsIn(view)).toHaveLength(1);
  });

  it("Shift+Enter inserts a newline; Enter is left to the composer", () => {
    const onKey = vi.fn((e: KeyboardEvent) => e.key === "Enter" && !e.shiftKey);
    const { view } = make("ab|", CTX, onKey);
    key(view, "Enter", { shiftKey: true });
    expect(text(view)).toBe("ab\n");
    key(view, "Enter");
    expect(text(view)).toBe("ab\n"); // consumed by the composer (send)
    expect(onKey).toHaveBeenCalledTimes(2);
  });

  it("the pill decorations are what the editor treats as atomic ranges", () => {
    const { view } = make("@Plan @Docs");
    const deco = view.state.field(pillField);
    const found: number[] = [];
    deco.between(0, 11, (from, to) => void found.push(from, to));
    expect(found).toEqual([0, 5, 6, 11]);
  });
});

describe("refs follow the text", () => {
  const A: ContextRef = { kind: "note", path: "Notes/Plan.md", label: "Plan" };
  const B: ContextRef = { kind: "folder", path: "Docs" };
  const sel: ContextRef = { kind: "tag", tag: "x" } as ContextRef;

  it("removing the last token detaches the ref (parked); another token keeps it", () => {
    let r = reconcileRefs("a @Plan b @Plan", [A, B, sel], []);
    expect(r.mentions).toEqual([A, sel]); // Docs has no token
    expect(r.parked).toEqual([B]);
    r = reconcileRefs("a @Plan b", r.mentions, r.parked);
    expect(r.mentions).toEqual([A, sel]);
    r = reconcileRefs("a b", r.mentions, r.parked);
    expect(r.mentions).toEqual([sel]); // refs with no token form stay
    expect(r.parked).toContain(A);
  });

  it("undo, redo or a paste of the token brings a parked ref back (dedupe by path kept)", () => {
    const gone = reconcileRefs("", [A], []);
    expect(gone.mentions).toEqual([]);
    const back = reconcileRefs("@Plan", gone.mentions, gone.parked);
    expect(back.mentions).toEqual([A]);
    expect(back.parked).toEqual([]);
    expect(reconcileRefs("@Plan @Notes/Plan.md", back.mentions, back.parked).mentions).toEqual([A]);
  });

  it("an explicit @activenote ref follows its token", () => {
    const act: ContextRef = { kind: "active-note", path: "N.md", inline: false };
    expect(reconcileRefs("see @activenote", [act], []).mentions).toEqual([act]);
    expect(reconcileRefs("see", [act], []).mentions).toEqual([]);
  });

  it("returns the same arrays when nothing changes", () => {
    const mentions = [A];
    const r = reconcileRefs("@Plan", mentions, []);
    expect(r.mentions).toBe(mentions);
  });
});
