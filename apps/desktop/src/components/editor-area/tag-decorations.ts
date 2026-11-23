import {
  Decoration,
  type DecorationSet,
  EditorView,
  type ViewUpdate,
  ViewPlugin,
} from "@codemirror/view";
import { type Extension, Prec, RangeSetBuilder } from "@codemirror/state";
import { linkActivationExtension, tagLinkTarget } from "@/lib/link-activation";
import { TAG_EDITING_CLASS, TAG_PILL_CLASS } from "@/lib/link-dom";
import { scanLineTags } from "@/lib/tags";
import {
  renderedRanges,
  renderedRangesChanged,
  selectionTouchesRange,
  treeChanged,
} from "@/lib/prosemark-core/utils";
import { getEffectiveSelectionRanges } from "./drag-selection-gate";
import { isInsideCode } from "./wiki-link-extension";

// A body `#tag` is a pill (property chip look) until the caret or selection touches it, then raw
// text, like links and headings. It is a mark over the text, not a widget: the text, the caret
// and copy/paste stay exactly as written. What is a tag is `lib/tags.ts` (the index's rule);
// fenced and indented code come from the syntax tree, inline code and URLs from the line scan.
// SPECs/tags-spec.md, "Inline tags in the UI".

const editingMark = Decoration.mark({ class: TAG_EDITING_CLASS });
const pillMark = (tag: string) =>
  Decoration.mark({ class: TAG_PILL_CLASS, attributes: { "data-tag": tag } });

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const { state } = view;
  // The drag snapshot while a pointer drag is in progress, so a tag does not flip mid-drag.
  const selection = getEffectiveSelectionRanges(state);
  let doneTo = -1;
  for (const range of renderedRanges(view)) {
    let pos = range.from;
    while (pos <= range.to) {
      const line = state.doc.lineAt(pos);
      pos = line.to + 1;
      if (line.from <= doneTo) continue; // rendered ranges may share a line
      doneTo = line.to;
      if (!line.text.includes("#")) continue;
      for (const t of scanLineTags(line.text)) {
        const from = line.from + t.from;
        const to = line.from + t.to;
        if (isInsideCode(state, from)) continue;
        builder.add(
          from,
          to,
          selectionTouchesRange(selection, { from, to }) ? editingMark : pillMark(t.tag),
        );
      }
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
      if (
        update.docChanged ||
        update.selectionSet ||
        renderedRangesChanged(update) ||
        treeChanged(update)
      ) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

/** Left, middle and Cmd/Ctrl clicks on a pill (`lib/link-activation.ts`): the press is claimed on
 *  mousedown so the caret does not move into the tag (which would turn the pill into raw text);
 *  the search opens on click. To edit a tag, move the caret in with the keyboard or click just
 *  after its end. */
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
  [`.${TAG_EDITING_CLASS}`]: { color: "var(--text-muted, #888)" },
});

export function tagDecorations(): Extension[] {
  return [tagDecorationPlugin, tagClickHandler, tagTheme];
}
