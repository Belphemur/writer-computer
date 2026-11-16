// Finds callouts in a CodeMirror syntax tree. A callout is a `Blockquote` whose first child
// paragraph starts, on the quote's first line, with a valid `[!type]` header.
import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import type { SyntaxNode, SyntaxNodeRef } from "@lezer/common";
import { type CalloutHeader, parseCalloutHeader } from "./syntax";

export interface CalloutInfo {
  /** Position among the document's callouts, in reading order (the fold-state key). */
  index: number;
  header: CalloutHeader;
  /** The quote's own `>` (for a nested callout, the inner one). */
  nodeFrom: number;
  headerLineFrom: number;
  headerLineTo: number;
  /** Where the typed title starts and ends; both equal `headerLineTo` when there is none. */
  titleFrom: number;
  titleTo: number;
  /** End of the callout's last line (equals `headerLineTo` for a title-only callout). */
  lastLineTo: number;
  /** Inside a list item: parsed, but the editor leaves it as a plain quote. */
  inList: boolean;
}

// The header of `quote`, or null when it is a plain quote.
function parseHeaderAt(
  state: EditorState,
  quote: SyntaxNode,
): { header: CalloutHeader; paragraph: SyntaxNode } | null {
  let child = quote.firstChild;
  while (child && child.name === "QuoteMark") child = child.nextSibling;
  if (!child || child.name !== "Paragraph") return null;
  const { doc } = state;
  const line = doc.lineAt(child.from);
  if (line.number !== doc.lineAt(quote.from).number) return null;
  const header = parseCalloutHeader(doc.sliceString(child.from, line.to));
  return header ? { header, paragraph: child } : null;
}

/** All callouts in reading order (outer before inner). */
export function scanCallouts(state: EditorState): CalloutInfo[] {
  const { doc } = state;
  const out: CalloutInfo[] = [];
  syntaxTree(state).iterate({
    enter(ref) {
      if (ref.name !== "Blockquote") return;
      const found = parseHeaderAt(state, ref.node);
      if (!found) return;
      const { header, paragraph } = found;
      const headerLine = doc.lineAt(paragraph.from);
      let last = doc.lineAt(ref.to);
      if (last.from === ref.to && last.number > headerLine.number) {
        last = doc.line(last.number - 1);
      }
      const titleFrom = paragraph.from + header.titleOffset;
      let inList = false;
      for (let p = ref.node.parent; p; p = p.parent) {
        if (p.name === "ListItem") inList = true;
      }
      out.push({
        index: out.length,
        header,
        nodeFrom: ref.from,
        headerLineFrom: headerLine.from,
        headerLineTo: headerLine.to,
        titleFrom,
        titleTo: titleFrom + header.title.length,
        lastLineTo: Math.max(last.to, headerLine.to),
        inList,
      });
    },
  });
  return out;
}

/** True for the `Link` node lezer makes of the `[!type]` marker (a shortcut reference link):
 *  the hide extension must leave its brackets alone so the raw header reads as typed. */
export function isCalloutMarkerLink(state: EditorState, node: SyntaxNodeRef): boolean {
  if (node.name !== "Link") return false;
  const paragraph = node.node.parent;
  if (paragraph?.name !== "Paragraph" || paragraph.from !== node.from) return false;
  const quote = paragraph.parent;
  return quote?.name === "Blockquote" && parseHeaderAt(state, quote) !== null;
}
