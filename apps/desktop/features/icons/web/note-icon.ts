// The note's own icon, next to the text of its first H1 and nowhere else (spec
// `SPECs/icons-spec.md`): an inline widget at the start of the heading's text, so it lines up with
// the title in live preview and in source. A note without an H1 shows no icon in its body. The
// widget is never text and never changes the document; a click opens the picker for the note.
import { syntaxTree } from "@codemirror/language";
import { type EditorState, type Extension, StateEffect } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { editorNotePath } from "@/lib/editor-views";
import { fileIconOf, type FileIconEntry, watchFileIcon } from "@/lib/file-icons";
import { fillIconElement } from "@/lib/icon-picker/icon-dom";
import { treeChanged } from "@/lib/prosemark-core/utils";
import { openIconPicker } from "./picker-store";

const GLYPH_SIZE = 16;
const NOTE_ICON_CLASS = "cm-note-icon";

/** The document position where the first H1's text starts, or null without an H1. Only top-level
 *  headings count (front matter is its own node, so a `# comment` in it never matches): `# Title`
 *  after its marker and spaces, or a setext `Title\n===`. */
export function firstH1Start(state: EditorState): number | null {
  for (let node = syntaxTree(state).topNode.firstChild; node; node = node.nextSibling) {
    if (node.name === "ATXHeading1") {
      const mark = node.firstChild;
      return mark ? Math.min(mark.to + 1, node.to) : node.from;
    }
    if (node.name === "SetextHeading1") return node.from;
  }
  return null;
}

class NoteIconWidget extends WidgetType {
  constructor(
    readonly entry: FileIconEntry,
    readonly getPath: () => string,
  ) {
    super();
  }

  // Visual identity only: the icon and its colour (the path getter is stable per editor).
  eq(other: NoteIconWidget): boolean {
    return this.entry.icon === other.entry.icon && this.entry.color === other.entry.color;
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = NOTE_ICON_CLASS;
    span.setAttribute("role", "button");
    span.setAttribute("aria-label", "Change icon");
    span.title = "Change icon";
    fillIconElement(span, this.entry.icon, { size: GLYPH_SIZE, color: this.entry.color });
    // Keep the editor focused and out of the click (docs/editor.md "Buttons inside widgets").
    for (const type of ["mousedown", "pointerdown"]) {
      span.addEventListener(type, (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
    }
    span.addEventListener("click", (e) => {
      e.preventDefault();
      const path = this.getPath();
      if (path) openIconPicker([path]);
    });
    return span;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

/** Asks the plugin to rebuild after the icon store changed. */
const refreshNoteIcon = StateEffect.define<null>();

function build(state: EditorState): DecorationSet {
  const getPath = state.facet(editorNotePath);
  const entry = fileIconOf(getPath() || null);
  const pos = entry ? firstH1Start(state) : null;
  if (!entry || pos === null) return Decoration.none;
  const widget = Decoration.widget({ widget: new NoteIconWidget(entry, getPath), side: -1 });
  return Decoration.set([widget.range(pos)]);
}

const plugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    private readonly stop: () => void;

    constructor(view: EditorView) {
      this.decorations = build(view.state);
      // The icon store changes outside CodeMirror (the feature loads, a picker writes): rebuild
      // when this note's icon is set, changed or removed.
      this.stop = watchFileIcon(view.state.facet(editorNotePath), () =>
        view.dispatch({ effects: refreshNoteIcon.of(null) }),
      );
    }

    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        treeChanged(update) ||
        update.transactions.some((tr) => tr.effects.some((e) => e.is(refreshNoteIcon)))
      ) {
        this.decorations = build(update.state);
      }
    }

    destroy() {
      this.stop();
    }
  },
  { decorations: (v) => v.decorations },
);

const theme = EditorView.baseTheme({
  [`.${NOTE_ICON_CLASS}`]: {
    alignItems: "center",
    justifyContent: "center",
    verticalAlign: "-0.1em",
    marginRight: "0.35em",
    // the heading's own size, whatever fillIconElement sets for an emoji
    fontSize: "0.9em !important",
    cursor: "pointer",
  },
  [`.${NOTE_ICON_CLASS} svg`]: { width: "1em", height: "1em" },
});

/** The extension: the icon of the note the editor shows, before its first H1's text. */
export function noteIconExtension(): Extension {
  return [plugin, theme];
}
