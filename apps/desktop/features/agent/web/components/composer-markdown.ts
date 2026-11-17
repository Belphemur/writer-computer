/**
 * Live Markdown styling for the agent composer: a light subset of what the note editor shows
 * (headings, bold, italic, strikethrough, inline code, fenced code, block quotes, bullet / numbered
 * / task lists, links, horizontal rules). It is styling only: markers stay in the text (dimmed),
 * nothing is hidden, folded or replaced, so the document is exactly what the user typed and the
 * prompt, the pills and the golden prompts are unchanged. No tables, images, HTML, math, mermaid or
 * widgets, and no nested code-language parsing.
 *
 * Cost: `@codemirror/lang-markdown` parses incrementally; the styling is the stock highlighter
 * (classes only, see `.agent-composer-editor` in App.css) plus one view plugin that adds line
 * classes to fenced code and quote lines in the visible ranges, rebuilt when the document, the
 * viewport or the parse tree changed.
 *
 * Pills and Markdown: pill recognition is textual (`pillRanges`, the same rule the transcript and
 * the prompt builder use) and ignores the syntax tree, so a token inside bold, italic or an inline
 * code span or a fence is still a pill (what is sent is the token either way). Markdown never
 * changes which text is a pill.
 */
import { insertNewline } from "@codemirror/commands";
import { markdown, insertNewlineContinueMarkupCommand } from "@codemirror/lang-markdown";
import {
  HighlightStyle,
  syntaxHighlighting,
  syntaxTree,
  type Language,
} from "@codemirror/language";
import { EditorState, Prec, type Extension, type StateCommand } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  keymap,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { highlightTree, tags } from "@lezer/highlight";
import { Strikethrough, TaskList } from "@lezer/markdown";
import { toggleBold, toggleItalic } from "@/components/editor-area/markdown-formatting";

/** Tag to class: all the look lives in App.css so it follows the theme tokens. */
export const composerHighlightStyle = HighlightStyle.define([
  { tag: tags.heading1, class: "cm-md-h1" },
  { tag: tags.heading2, class: "cm-md-h2" },
  { tag: tags.heading3, class: "cm-md-h3" },
  { tag: [tags.heading4, tags.heading5, tags.heading6], class: "cm-md-h4" },
  { tag: tags.strong, class: "cm-md-strong" },
  { tag: tags.emphasis, class: "cm-md-em" },
  { tag: tags.strikethrough, class: "cm-md-strike" },
  { tag: tags.monospace, class: "cm-md-code" },
  { tag: tags.quote, class: "cm-md-quote" },
  { tag: tags.link, class: "cm-md-link" },
  { tag: tags.url, class: "cm-md-url" },
  { tag: tags.contentSeparator, class: "cm-md-hr" },
  { tag: tags.atom, class: "cm-md-task" },
  { tag: tags.labelName, class: "cm-md-fence-info" },
  // `#`, `**`, backticks, `>`, list bullets, link brackets: dimmed, never hidden
  { tag: tags.processingInstruction, class: "cm-md-mark" },
]);

/** The composer's Markdown: GFM strikethrough and task lists only, no setext headings (`text`
 *  then `---` stays text and a rule), indented code, HTML, link references or images. The
 *  language's own Enter / Backspace keymap is off: Enter sends. */
const markdownSupport = markdown({
  extensions: [
    Strikethrough,
    TaskList,
    {
      remove: [
        "SetextHeading",
        "CodeBlock",
        "HTMLBlock",
        "HTMLTag",
        "LinkReference",
        "Image",
        "Entity",
      ],
    },
  ],
  addKeymap: false,
});
export const composerMarkdownLanguage: Language = markdownSupport.language;

/** Source lines of fenced code and block quotes in `from..to`, with their line class. */
export function lineClasses(
  state: EditorState,
  from = 0,
  to = state.doc.length,
): { line: number; class: string }[] {
  const out = new Map<number, string>();
  const put = (pos: number, cls: string) => {
    const n = state.doc.lineAt(pos).number;
    out.set(n, out.has(n) ? `${out.get(n)} ${cls}` : cls);
  };
  syntaxTree(state).iterate({
    from,
    to,
    enter(node) {
      if (node.name === "FencedCode") {
        const first = state.doc.lineAt(node.from).number;
        // an unclosed fence runs to the end of the document: its last line is the last line
        const last = state.doc.lineAt(node.to).number;
        for (let n = first; n <= last; n++) {
          const pos = state.doc.line(n).from;
          put(pos, "cm-md-fence-line");
          if (n === first) put(pos, "cm-md-fence-first");
          if (n === last) put(pos, "cm-md-fence-last");
        }
        return false;
      }
      if (node.name === "Blockquote") {
        const first = state.doc.lineAt(node.from).number;
        const last = state.doc.lineAt(node.to).number;
        // lazy continuation lines (no `>`) are part of the quote for Markdown but not drawn as one
        for (let n = first; n <= last; n++) {
          const line = state.doc.line(n);
          if (/^\s*>/.test(line.text)) put(line.from, "cm-md-quote-line");
        }
      }
      return undefined;
    },
  });
  return [...out].map(([line, cls]) => ({ line, class: cls }));
}

/** The class of every styled span (`highlightTree` with the composer style), for tests and tools. */
export function styledSpans(state: EditorState): { from: number; to: number; class: string }[] {
  const spans: { from: number; to: number; class: string }[] = [];
  highlightTree(syntaxTree(state), composerHighlightStyle, (from, to, cls) =>
    spans.push({ from, to, class: cls }),
  );
  return spans;
}

function buildLineDecorations(view: EditorView): DecorationSet {
  const ranges = [];
  const seen = new Set<number>();
  for (const { from, to } of view.visibleRanges) {
    for (const { line, class: cls } of lineClasses(view.state, from, to)) {
      if (seen.has(line)) continue;
      seen.add(line);
      ranges.push(Decoration.line({ class: cls }).range(view.state.doc.line(line).from));
    }
  }
  return Decoration.set(ranges, true);
}

const lineDecorations = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    tree: unknown;
    constructor(view: EditorView) {
      this.decorations = buildLineDecorations(view);
      this.tree = syntaxTree(view.state);
    }
    update(u: ViewUpdate) {
      const tree = syntaxTree(u.state);
      if (u.docChanged || u.viewportChanged || tree !== this.tree) {
        this.decorations = buildLineDecorations(u.view);
        this.tree = tree;
      }
    }
  },
  { decorations: (p) => p.decorations },
);

/** Shift+Enter: a newline that continues a list item, task or quote marker; on an empty item it
 *  removes the marker and exits the list. Anywhere else it is a plain newline. */
export const composerNewline: StateCommand = (target) =>
  // `nonTightLists: false`: an empty second item exits the list too (the library would otherwise
  // turn a two-item list loose)
  continueMarkup(target) || insertNewline(target);
const continueMarkup = insertNewlineContinueMarkupCommand({ nonTightLists: false });

export const composerMarkdownKeymap = Prec.high(
  keymap.of([
    { key: "Shift-Enter", run: composerNewline },
    { key: "Mod-b", run: toggleBold },
    { key: "Mod-i", run: toggleItalic },
  ]),
);

export function composerMarkdown(): Extension[] {
  return [
    markdownSupport,
    syntaxHighlighting(composerHighlightStyle),
    lineDecorations,
    composerMarkdownKeymap,
  ];
}
