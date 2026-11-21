// The CodeMirror side of the merge view: the Result column (editable, with a block of choices
// above every overlap) and the read-only Mine and Theirs columns that mark the same overlaps.
// One state field holds the overlaps of the Result and maps them through every edit, so a choice
// or a keystroke never needs positions from outside. The editor stack is the app's own CodeMirror
// 6 (`@codemirror/state`, `view`, `commands`); nothing here is a new dependency.
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import {
  type EditorState,
  EditorState as State,
  type Extension,
  RangeSetBuilder,
  StateEffect,
  StateField,
} from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap, WidgetType } from "@codemirror/view";
import { type Choice, type HunkLayout, type Span, textFor } from "./merge-model";

/** One overlap of the Result as the field tracks it. `choice: null` is "not decided yet". */
export interface HunkState {
  index: number;
  from: number;
  to: number;
  choice: Choice | null;
}

/** Sets a hunk's range and choice after a button replaced its text (mapping is not enough: the
 *  replaced range's ends map to the same side). */
const settle = StateEffect.define<HunkState>();
/** The user event of a choice button, so a test or an extension can tell it from typing. */
export const CHOICE_EVENT = "git.merge-choice";

export const hunkField = StateField.define<HunkState[]>({
  create: () => [],
  update(hunks, tr) {
    let next = hunks;
    if (tr.docChanged) {
      const typed = !tr.isUserEvent(CHOICE_EVENT);
      next = hunks.map((h) => {
        const from = tr.changes.mapPos(h.from, 1);
        const to = Math.max(from, tr.changes.mapPos(h.to, -1));
        let touched = false;
        if (typed) tr.changes.iterChangedRanges((a, b) => (touched ||= a <= h.to && b >= h.from));
        return { ...h, from, to, choice: touched ? "edited" : h.choice };
      });
    }
    for (const e of tr.effects) {
      if (e.is(settle)) next = next.map((h) => (h.index === e.value.index ? e.value : h));
    }
    return next;
  },
});

/** The starting overlaps of a layout (every one undecided, holding mine's lines). */
export const initialHunks = (hunks: readonly HunkLayout[]): HunkState[] =>
  hunks.map((h) => ({ index: h.index, ...h.inResult, choice: null }));

export const CHOICES: { choice: Exclude<Choice, "edited">; label: string }[] = [
  { choice: "mine", label: "Take mine" },
  { choice: "theirs", label: "Take theirs" },
  { choice: "both", label: "Take both" },
];

/** Replaces overlap `index` of the Result with the text a choice stands for. */
export function takeChoice(
  view: EditorView,
  layout: readonly HunkLayout[],
  index: number,
  choice: Exclude<Choice, "edited">,
) {
  const h = view.state.field(hunkField).find((x) => x.index === index);
  const source = layout[index];
  if (!h || !source) return;
  const insert = textFor(source, choice);
  view.dispatch({
    changes: { from: h.from, to: h.to, insert },
    effects: settle.of({ index, from: h.from, to: h.from + insert.length, choice }),
    userEvent: CHOICE_EVENT,
  });
}

class ChoiceBar extends WidgetType {
  constructor(
    private readonly index: number,
    private readonly choice: Choice | null,
    private readonly layout: readonly HunkLayout[],
  ) {
    super();
  }

  eq(other: ChoiceBar) {
    return other.index === this.index && other.choice === this.choice;
  }

  toDOM(view: EditorView) {
    const bar = document.createElement("div");
    bar.className = "git-merge-choices";
    bar.dataset.gitMergeHunk = String(this.index);
    bar.dataset.gitMergeState = this.choice ?? "open";
    for (const { choice, label } of CHOICES) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.dataset.gitMergeTake = choice;
      b.setAttribute("aria-pressed", String(this.choice === choice));
      // the button must not take the editor's focus or selection before the click lands
      b.addEventListener("mousedown", (e) => e.preventDefault());
      b.addEventListener("click", () => takeChoice(view, this.layout, this.index, choice));
      bar.append(b);
    }
    if (this.choice === "edited") {
      const note = document.createElement("span");
      note.textContent = "Edited";
      bar.append(note);
    }
    return bar;
  }

  ignoreEvent() {
    return false;
  }
}

function decorations(state: EditorState, layout: readonly HunkLayout[]): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  for (const h of state.field(hunkField)) {
    b.add(
      state.doc.lineAt(h.from).from,
      state.doc.lineAt(h.from).from,
      Decoration.widget({
        widget: new ChoiceBar(h.index, h.choice, layout),
        block: true,
        side: -1,
      }),
    );
    // the lines of the overlap
    const first = state.doc.lineAt(h.from).number;
    const last = h.to > h.from ? state.doc.lineAt(h.to - 1).number : first - 1;
    for (let n = first; n <= last; n++) {
      const at = state.doc.line(n).from;
      b.add(
        at,
        at,
        Decoration.line({ class: h.choice === null ? "git-merge-open" : "git-merge-settled" }),
      );
    }
  }
  return b.finish();
}

const theme = EditorView.theme({
  "&": { backgroundColor: "transparent", color: "var(--text-primary)", fontSize: "13px" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { overflow: "visible !important", fontFamily: "var(--pm-code-font, monospace)" },
  ".cm-content": { padding: "4px 0", caretColor: "var(--text-primary)" },
  ".cm-line": { padding: "0 8px" },
  ".git-merge-open": { backgroundColor: "color-mix(in srgb, var(--accent) 16%, transparent)" },
  ".git-merge-settled": {
    backgroundColor: "color-mix(in srgb, var(--success, #2e7d32) 14%, transparent)",
  },
  ".git-merge-choices": {
    display: "flex",
    gap: "6px",
    alignItems: "center",
    padding: "2px 8px",
    fontFamily: "var(--font-sans, inherit)",
    fontSize: "11.5px",
    color: "var(--text-muted)",
  },
  ".git-merge-choices button": {
    border: "1px solid var(--border-color)",
    borderRadius: "6px",
    padding: "1px 8px",
    background: "transparent",
    color: "var(--text-primary)",
    cursor: "pointer",
  },
  ".git-merge-choices button:hover, .git-merge-choices button[aria-pressed=true]": {
    background: "var(--surface-subtle)",
  },
});

/** The Result column: editable, wrapped lines, undo, the overlaps and their choices. */
export function resultExtensions(
  layout: readonly HunkLayout[],
  onChange: (state: EditorState) => void,
): Extension {
  return [
    hunkField.init(() => initialHunks(layout)),
    history(),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    EditorView.lineWrapping,
    EditorView.decorations.compute([hunkField], (s) => decorations(s, layout)),
    EditorView.updateListener.of((u) => {
      if (u.docChanged || u.transactions.some((t) => t.effects.length > 0)) onChange(u.state);
    }),
    theme,
  ];
}

function marksFor(state: EditorState, spans: readonly Span[]): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  for (const s of spans) {
    const first = state.doc.lineAt(s.from).number;
    const last = s.to > s.from ? state.doc.lineAt(s.to - 1).number : first - 1;
    for (let n = first; n <= last; n++) {
      const at = state.doc.line(n).from;
      b.add(at, at, Decoration.line({ class: "git-merge-open" }));
    }
  }
  return b.finish();
}

/** Mine and Theirs: read-only, the overlaps marked. */
export function sideExtensions(spans: readonly Span[]): Extension {
  return [
    State.readOnly.of(true),
    EditorView.editable.of(false),
    EditorView.lineWrapping,
    EditorView.decorations.compute([], (state) => marksFor(state, spans)),
    theme,
  ];
}
