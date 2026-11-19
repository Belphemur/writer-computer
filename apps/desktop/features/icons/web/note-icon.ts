// The note's own icon, a large glyph before the text of its first H1 and nowhere else (spec
// `SPECs/icons-spec.md`), like a Confluence page title: an inline widget at the start of the
// heading's text, 1.3em of the heading, plus a line decoration that hangs the heading's wrapped
// lines under the text (padding-left and a negative text-indent of the icon's width), so they
// never run under the icon. A note without an H1 shows no icon in its body. The widget is never
// text and never changes the document; a click, Enter or Space opens the picker for the note.
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

const GLYPH_SIZE = "1.3em";
const NOTE_ICON_CLASS = "cm-note-icon";
const NOTE_ICON_LINE_CLASS = "cm-note-icon-line";

/** The first top-level H1: where it starts and where its text starts, or null without one. Front
 *  matter is its own node, so a `# comment` in it never matches. The text starts after the marker
 *  and a space for `# Title`, at the heading for a setext `Title\n===`. */
export function firstH1(state: EditorState): { from: number; textFrom: number } | null {
  for (let node = syntaxTree(state).topNode.firstChild; node; node = node.nextSibling) {
    if (node.name === "ATXHeading1") {
      const mark = node.firstChild;
      return { from: node.from, textFrom: mark ? Math.min(mark.to + 1, node.to) : node.from };
    }
    if (node.name === "SetextHeading1") return { from: node.from, textFrom: node.from };
  }
  return null;
}

/** The document position where the first H1's text starts, or null without an H1. */
export const firstH1Start = (state: EditorState): number | null => firstH1(state)?.textFrom ?? null;

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
    const button = document.createElement("span");
    button.className = NOTE_ICON_CLASS;
    button.setAttribute("role", "button");
    button.setAttribute("tabindex", "0");
    button.setAttribute("aria-label", "Change icon");
    button.title = "Change icon";
    const glyph = document.createElement("span");
    glyph.className = "cm-note-icon-glyph";
    fillIconElement(glyph, this.entry.icon, { size: GLYPH_SIZE, color: this.entry.color });
    button.append(glyph);
    const open = () => {
      const path = this.getPath();
      if (path) openIconPicker([path]);
    };
    // Keep the editor focused and out of the click (docs/editor.md "Buttons inside widgets").
    for (const type of ["mousedown", "pointerdown"]) {
      button.addEventListener(type, (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
    }
    button.addEventListener("click", (e) => {
      e.preventDefault();
      open();
    });
    button.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      e.stopPropagation();
      open();
    });
    return button;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

/** Asks the plugin to rebuild after the icon store changed. */
const refreshNoteIcon = StateEffect.define<null>();

const lineDeco = Decoration.line({ class: NOTE_ICON_LINE_CLASS });

function build(state: EditorState): DecorationSet {
  const getPath = state.facet(editorNotePath);
  const entry = fileIconOf(getPath() || null);
  const h1 = entry ? firstH1(state) : null;
  if (!entry || !h1) return Decoration.none;
  const widget = Decoration.widget({ widget: new NoteIconWidget(entry, getPath), side: -1 });
  const lineFrom = state.doc.lineAt(h1.from).from;
  return Decoration.set([lineDeco.range(lineFrom), widget.range(h1.textFrom)], true);
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

// The heading's own size: the heading line decoration sets `--ws-heading-scale`, the body size is
// `--writer-editor-font-size`. Absolute, so the widget is right whether or not CodeMirror put it
// inside the heading's highlight span. The icon box is 1.3em plus a 0.35em gap.
const HEADING_SIZE = "calc(var(--ws-heading-scale, 1.6) * var(--writer-editor-font-size, 16px))";
const HANG = `calc(${HEADING_SIZE} * 1.65)`;

const theme = EditorView.baseTheme({
  [`.cm-line.${NOTE_ICON_LINE_CLASS}`]: { paddingLeft: HANG, textIndent: `calc(${HANG} * -1)` },
  [`.${NOTE_ICON_CLASS}`]: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    boxSizing: "border-box",
    width: "1.3em",
    height: "1.3em",
    marginRight: "0.35em",
    verticalAlign: "middle",
    fontSize: HEADING_SIZE,
    lineHeight: "1",
    textIndent: "0",
    borderRadius: "0.25em",
    cursor: "pointer",
  },
  [`.${NOTE_ICON_CLASS}:hover, .${NOTE_ICON_CLASS}:focus-visible`]: {
    backgroundColor: "color-mix(in srgb, var(--fg-base) 12%, transparent)",
    outline: "none",
  },
});

/** The extension: the icon of the note the editor shows, before its first H1's text. */
export function noteIconExtension(): Extension {
  return [plugin, theme];
}
