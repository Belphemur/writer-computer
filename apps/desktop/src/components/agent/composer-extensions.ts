/**
 * CodeMirror extensions of the agent composer: plain-text document, reference tokens drawn as
 * pills (`Decoration.replace` widgets over the exact token text, built by `createPillElement`) and
 * made atomic, so the caret, Backspace/Delete and selections treat a pill as one character while
 * the document, the clipboard and the sent prompt keep the token string. Pure CodeMirror, no
 * React: the model is testable with an `EditorState` (see tests/agent-composer-pills.test.ts).
 */
import { history, historyKeymap, standardKeymap } from "@codemirror/commands";
import {
  EditorSelection,
  EditorState,
  Prec,
  StateEffect,
  StateField,
  type Extension,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  WidgetType,
  keymap,
  placeholder,
  type DecorationSet,
} from "@codemirror/view";
import { imageFilesOfTransfer } from "@/lib/agent/chat-images";
import { linkActivationExtension, linkIntent } from "@/lib/link-activation";
import { vaultTarget } from "./agent-links";
import { composerMarkdown } from "./composer-markdown";
import {
  createPillElement,
  pillRanges,
  samePill,
  type PillContext,
  type PillModel,
} from "@/lib/agent/pill";

export const setPillContext = StateEffect.define<PillContext>();

export const pillContextField = StateField.define<PillContext>({
  create: () => ({ refs: [] }),
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setPillContext)) value = e.value;
    return value;
  },
});

class PillWidget extends WidgetType {
  constructor(readonly model: PillModel) {
    super();
  }
  eq(other: PillWidget) {
    return samePill(this.model, other.model);
  }
  toDOM() {
    return createPillElement(this.model, { as: "span" });
  }
  // CodeMirror handles clicks on a pill itself (caret next to it, drag-select across it).
  ignoreEvent() {
    return false;
  }
}

function buildPills(state: EditorState): DecorationSet {
  const ctx = state.field(pillContextField);
  const sel = state.selection.main;
  const ranges = [];
  for (const { from, to, model } of pillRanges(state.doc.toString(), ctx)) {
    // A token the caret touches that no attached ref or known skill backs is still being typed: it stays text.
    if (!model.attached && sel.empty && sel.from >= from && sel.from <= to) continue;
    ranges.push(Decoration.replace({ widget: new PillWidget(model) }).range(from, to));
  }
  return Decoration.set(ranges);
}

export const pillField = StateField.define<DecorationSet>({
  create: buildPills,
  update: (value, tr) =>
    tr.docChanged || tr.selection || tr.effects.some((e) => e.is(setPillContext))
      ? buildPills(tr.state)
      : value,
  provide: (f) => [
    EditorView.decorations.from(f),
    EditorView.atomicRanges.of((v) => v.state.field(f)),
  ],
});

/** The range of the pill covering `pos` (inclusive of its edges), if any. */
export function pillAt(state: EditorState, pos: number): { from: number; to: number } | null {
  let found: { from: number; to: number } | null = null;
  state.field(pillField).between(pos, pos, (from, to) => {
    found ??= { from, to };
  });
  return found;
}

/** A pill opens its note on a middle or Cmd/Ctrl click (a plain click places the caret, so it is
 *  not a link click here); a double click selects the whole pill. */
export function pillMouse(): Extension {
  return [
    linkActivationExtension((e) => {
      const target = pillElement(e.target)?.dataset.target;
      return target && linkIntent(e) !== "current" ? vaultTarget(target) : null;
    }),
    EditorView.domEventHandlers({
      dblclick(e, view) {
        const el = pillElement(e.target);
        if (!el) return false;
        const pos = view.posAtDOM(el);
        const range = pillAt(view.state, pos);
        if (!range) return false;
        e.preventDefault();
        view.dispatch({ selection: EditorSelection.range(range.from, range.to) });
        return true;
      },
    }),
  ];
}

const pillElement = (t: EventTarget | null) =>
  t instanceof Element ? t.closest<HTMLElement>(".agent-pill") : null;

/** A paste or drop that carries images attaches them instead of inserting anything; text-only
 *  transfers fall through to the editor. */
function imageTransfer(onImageFiles: (files: File[]) => void): Extension {
  const take = (e: ClipboardEvent | DragEvent) => {
    const data = "clipboardData" in e ? e.clipboardData : e.dataTransfer;
    const files = data ? imageFilesOfTransfer(data) : [];
    if (files.length === 0) return false;
    e.preventDefault();
    onImageFiles(files);
    return true;
  };
  return EditorView.domEventHandlers({ paste: (e) => take(e), drop: (e) => take(e) });
}

/** Keys handled by the composer first (`onKey` returns true when it consumed the event); the rest
 *  fall through to the editing keymap below. */
export function composerKeys(onKey: (e: KeyboardEvent) => boolean): Extension {
  return Prec.highest(
    EditorView.domEventHandlers({
      keydown: (e) => !e.isComposing && onKey(e),
    }),
  );
}

/** Everything but Enter from the standard keymap (Enter sends; the composer owns it). */
const editingKeymap = standardKeymap.filter((b) => b.key !== "Enter" && b.key !== "Mod-Enter");

export type ComposerExtras = {
  onKey: (e: KeyboardEvent) => boolean;
  onChange: (text: string, caret: number, composing: boolean) => void;
  onCompositionStart: () => void;
  onCompositionEnd: () => void;
  /** Image files from a paste or an HTML5 drop (a browser drag); the composer attaches them. */
  onImageFiles: (files: File[]) => void;
};

/** The fixed part of the composer editor; placeholder, editability and ARIA attributes live in
 *  compartments the hook reconfigures. */
export function composerExtensions(extras: ComposerExtras): Extension[] {
  return [
    pillContextField,
    pillField,
    history(),
    composerKeys(extras.onKey),
    composerMarkdown(),
    keymap.of([...editingKeymap, ...historyKeymap]),
    pillMouse(),
    EditorView.lineWrapping,
    EditorView.contentAttributes.of({ "data-agent-composer": "" }),
    imageTransfer(extras.onImageFiles),
    EditorView.domEventHandlers({
      compositionstart: () => extras.onCompositionStart(),
      compositionend: () => void setTimeout(extras.onCompositionEnd, 0),
    }),
    EditorView.updateListener.of((u) => {
      if (u.docChanged || u.selectionSet)
        extras.onChange(u.state.doc.toString(), u.state.selection.main.head, u.view.composing);
    }),
  ];
}

export const placeholderExtension = (text: string) => placeholder(text);
