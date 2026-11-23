import {
  Decoration,
  type DecorationSet,
  EditorView,
  type ViewUpdate,
  ViewPlugin,
} from "@codemirror/view";
import {
  type EditorState,
  type Extension,
  Prec,
  RangeSetBuilder,
  StateField,
  type Text,
} from "@codemirror/state";
import { linkActivationExtension, tagLinkTarget } from "@/lib/link-activation";
import { TAG_PILL_CLASS } from "@/lib/link-dom";
import { type Fence, scanLineTags, stepFence } from "@/lib/tags";
import {
  renderedRanges,
  renderedRangesChanged,
  selectionTouchesRange,
} from "@/lib/prosemark-core/utils";
import { getEffectiveSelectionRanges } from "./drag-selection-gate";

// A body `#tag` is a pill (property chip look) until the caret or selection touches it; then it
// is plain text, with no decoration at all (so IME composition and typing see the bare text). It
// is a mark over the text, not a widget: the text, the caret and copy/paste stay as written. What
// is a tag, and what is code, is `lib/tags.ts` (the index's rule, line by line: a fence is a
// fence line, nothing else is code); the editor does not ask the syntax tree, so it agrees with
// what the index stores. SPECs/tags-spec.md, "Inline tags in the UI".

/** Lines longer than this are not decorated (the line scan and a pill would cost more than they
 *  are worth on a minified blob). */
const MAX_DECORATED_LINE = 10_000;

// --- The fence state at the start of a line, kept cheaply ----------------------------------------
// A cache of the open fence at the start of every `STRIDE`th line. An edit drops the entries after
// its first changed line (the state at a line depends only on the lines before it) and a query
// fills them in again from the last one, so typing at the viewport re-reads at most `STRIDE`
// lines and a note is never scanned from its top on a keystroke.

const STRIDE = 64;

interface FenceCache {
  /** `starts[i]` is the fence open at the start of line `i * STRIDE + 1`; `starts[0]` is none. */
  starts: Fence[];
}

const fenceCache = StateField.define<FenceCache>({
  create: () => ({ starts: [null] }),
  update(value, tr) {
    if (!tr.docChanged) return value;
    let first = Infinity;
    tr.changes.iterChangedRanges((_fa, _ta, fromB) => {
      first = Math.min(first, tr.newDoc.lineAt(fromB).number);
    });
    // Keep the entries whose line is at or before the first changed one.
    const keep = Math.max(1, Math.floor((first - 1) / STRIDE) + 1);
    return { starts: value.starts.slice(0, keep) };
  },
});

function fenceAtLine(state: EditorState, lineNo: number): Fence {
  const { starts } = state.field(fenceCache);
  const doc = state.doc;
  const k = Math.floor((lineNo - 1) / STRIDE);
  while (starts.length <= k) {
    const from = (starts.length - 1) * STRIDE + 1;
    starts.push(advance(doc, starts[starts.length - 1]!, from, from + STRIDE));
  }
  return advance(doc, starts[k]!, k * STRIDE + 1, lineNo);
}

/** The fence open at the start of line `to`, given the one open at the start of line `from`. */
function advance(doc: Text, fence: Fence, from: number, to: number): Fence {
  const last = Math.min(to, doc.lines + 1);
  if (from >= last) return fence;
  for (const line of doc.iterLines(from, last)) fence = stepFence(fence, line).next;
  return fence;
}

// --- Decorations --------------------------------------------------------------------------------

const pillMark = (tag: string) =>
  Decoration.mark({ class: TAG_PILL_CLASS, attributes: { "data-tag": tag } });

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const { state } = view;
  // The drag snapshot while a pointer drag is in progress, so a tag does not flip mid-drag.
  const selection = getEffectiveSelectionRanges(state);
  let doneTo = -1;
  for (const range of renderedRanges(view)) {
    let line = state.doc.lineAt(range.from);
    let fence = fenceAtLine(state, line.number);
    for (;;) {
      const step = stepFence(fence, line.text);
      fence = step.next;
      if (
        line.from > doneTo && // rendered ranges may share a line
        !step.skip &&
        line.length <= MAX_DECORATED_LINE &&
        line.text.includes("#")
      ) {
        for (const t of scanLineTags(line.text)) {
          const from = line.from + t.from;
          const to = line.from + t.to;
          if (!selectionTouchesRange(selection, { from, to })) {
            builder.add(from, to, pillMark(t.tag));
          }
        }
      }
      if (line.from > doneTo) doneTo = line.to;
      if (line.to >= range.to || line.number >= state.doc.lines) break;
      line = state.doc.line(line.number + 1);
    }
  }
  return builder.finish();
}

const tagDecorationPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || renderedRangesChanged(update)) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

/** Left, middle and Cmd/Ctrl clicks on a pill (`lib/link-activation.ts`): the press is claimed on
 *  mousedown so the caret does not move into the tag (which would turn the pill into raw text);
 *  the search opens on click. Shift+click extends the selection. To edit a tag, move the caret in
 *  with the keyboard or click just after its end. */
const tagClickHandler: Extension = Prec.highest(
  linkActivationExtension((event) => {
    const el = event.target instanceof Element ? event.target.closest(`.${TAG_PILL_CLASS}`) : null;
    const tag = el?.getAttribute("data-tag");
    return tag ? tagLinkTarget(tag) : null;
  }),
);

const tagTheme = EditorView.baseTheme({
  [`.${TAG_PILL_CLASS}`]: {
    backgroundColor: "var(--surface-subtle)",
    color: "var(--text-primary)",
    borderRadius: "9999px",
    padding: "0.05em 0.5em",
    fontSize: "0.9em",
    cursor: "pointer",
    boxDecorationBreak: "clone",
    "&:hover": { backgroundColor: "var(--surface-subtle-strong, var(--surface-subtle))" },
  },
});

export function tagDecorations(): Extension[] {
  return [fenceCache, tagDecorationPlugin, tagClickHandler, tagTheme];
}
