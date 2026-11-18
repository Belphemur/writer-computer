import {
  EditorView,
  ViewPlugin,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { Compartment, EditorState, Prec, type Extension } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  HighlightStyle,
  LanguageDescription,
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
} from "@codemirror/language";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { selectNextOccurrence, selectSelectionMatches } from "@codemirror/search";
import { tags } from "@lezer/highlight";
import { generalSyntaxHighlights } from "@/lib/prosemark-core/syntaxHighlighting";
import { editorSearchExtensions } from "@/components/editor-area/editor-search-extensions";
import { useEditorSearchStore } from "@/components/editor-area/editor-search-store";
import * as editorApi from "@/hooks/editor-api";
import { type IndentStyle } from "../lib/code-language";

/** The per-view compartments the pane reconfigures: language, indentation, wrapping, read-only, history. */
export interface CodeEditorCompartments {
  language: Compartment;
  indent: Compartment;
  wrap: Compartment;
  readOnly: Compartment;
  history: Compartment;
}

export function createCodeEditorCompartments(): CodeEditorCompartments {
  return {
    language: new Compartment(),
    indent: new Compartment(),
    wrap: new Compartment(),
    readOnly: new Compartment(),
    history: new Compartment(),
  };
}

/** Code tokens the note palette does not colour (functions, properties, numbers, operators),
 *  mapped onto the same `--pm-syntax-*` variables so they match fenced code blocks. */
const codeExtraHighlights = syntaxHighlighting(
  HighlightStyle.define([
    {
      tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
      color: "var(--pm-syntax-definition-variable)",
    },
    { tag: [tags.propertyName, tags.attributeName], color: "var(--pm-syntax-definition-property)" },
    { tag: [tags.number, tags.integer, tags.float], color: "var(--pm-syntax-literal)" },
    { tag: [tags.tagName, tags.heading], color: "var(--pm-syntax-keyword)" },
    {
      tag: [tags.meta, tags.processingInstruction],
      color: "var(--pm-syntax-special-variable-macro)",
    },
    { tag: tags.variableName, color: "var(--pm-syntax-local-variable)" },
  ]),
);

const codeTheme = EditorView.theme({
  "&": { height: "100%" },
  ".cm-content": {
    fontFamily: "var(--pm-code-font)",
    fontSize: "calc(var(--writer-editor-font-size, 16px) * 0.875)",
    lineHeight: "1.6",
    letterSpacing: "normal",
  },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "var(--text-muted)",
    border: "none",
    fontFamily: "var(--pm-code-font)",
  },
  ".cm-activeLine": { backgroundColor: "var(--item-hover-bg)" },
  ".cm-activeLineGutter": { backgroundColor: "var(--item-hover-bg)", color: "var(--text-primary)" },
  "&.cm-focused .cm-matchingBracket": {
    backgroundColor: "var(--editor-selection-bg)",
    outline: "none",
  },
});

/** Mirror document and caret changes into the editor store; swaps and reloads carry a "writer"
 *  userEvent and are skipped (the store already holds that content). */
function storeSync(getFilePath: () => string): Extension {
  return EditorView.updateListener.of((update) => {
    const isSwap = update.transactions.some((tr) => tr.isUserEvent("writer"));
    if (update.docChanged && !isSwap) {
      editorApi.updateContent(getFilePath(), update.state.doc.toString());
    }
    if (update.selectionSet && !isSwap) {
      editorApi.updateCursorPos(getFilePath(), update.state.selection.main.head);
    }
    if (update.docChanged || update.selectionSet) {
      useEditorSearchStore.getState().bumpDocVersion(update.view);
    }
  });
}

/** Focus the editor when its pane is revealed (tab switch); panes hide with an `invisible` class. */
function focusOnReveal(isDisposed: () => boolean): Extension {
  return ViewPlugin.define((view) => {
    const pane = view.dom.closest<HTMLElement>("[data-pane]");
    if (!pane) return { destroy() {} };
    let wasHidden = pane.classList.contains("invisible");
    const mo = new MutationObserver(() => {
      if (isDisposed()) return;
      const hidden = pane.classList.contains("invisible");
      if (wasHidden && !hidden) view.focus();
      wasHidden = hidden;
    });
    mo.observe(pane, { attributes: true, attributeFilter: ["class"] });
    return { destroy: () => mo.disconnect() };
  });
}

export function indentExtension(indent: IndentStyle): Extension {
  return [indentUnit.of(indent.unit), EditorState.tabSize.of(indent.size)];
}

export function readOnlyExtension(readOnly: boolean): Extension {
  return [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)];
}

export function wrapExtension(wrap: boolean): Extension {
  return wrap ? EditorView.lineWrapping : [];
}

/**
 * The code editor: one CodeMirror stack with the note editor's search overlay, store sync and
 * highlight colours, and none of the markdown live preview (no hiding, widgets, decorations).
 * Language, indentation, wrapping and read-only live in compartments the pane updates.
 */
export function createCodeEditorExtensions(options: {
  getFilePath: () => string;
  isDisposed: () => boolean;
  compartments: CodeEditorCompartments;
  indent: IndentStyle;
  wrap: boolean;
  readOnly: boolean;
}): Extension[] {
  const { compartments: c } = options;
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    foldGutter(),
    highlightActiveLine(),
    drawSelection(),
    dropCursor(),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    c.history.of(history()),
    c.language.of([]),
    c.indent.of(indentExtension(options.indent)),
    c.wrap.of(wrapExtension(options.wrap)),
    c.readOnly.of(readOnlyExtension(options.readOnly)),
    generalSyntaxHighlights,
    codeExtraHighlights,
    codeTheme,
    editorSearchExtensions,
    Prec.low(
      keymap.of([
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...historyKeymap,
        ...foldKeymap,
        { key: "Mod-d", run: selectNextOccurrence, preventDefault: true },
        { key: "Mod-Shift-l", run: selectSelectionMatches },
        indentWithTab,
      ]),
    ),
    storeSync(options.getFilePath),
    focusOnReveal(options.isDisposed),
  ];
}

/** Load a language's support and return it as an extension (`[]` when it fails to load). */
export async function loadLanguageExtension(
  description: LanguageDescription | null,
): Promise<Extension> {
  if (!description) return [];
  try {
    const support = await description.load();
    return support;
  } catch {
    return [];
  }
}
