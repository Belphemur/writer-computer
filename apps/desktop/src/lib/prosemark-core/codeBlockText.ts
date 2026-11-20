import type { SyntaxNodeRef } from "@lezer/common";

/** The code of a fenced or indented code block as written in the document: the lines between the
 *  fences (no fence lines, no info string; an indented block without its indent), without the
 *  newline that precedes the closing fence. `CodeText` nodes are joined as they sit: a block
 *  inside a quote or list has one per line, with the container's marks between them. */
export function codeBlockText(
  state: { doc: { sliceString(from: number, to: number): string } },
  node: SyntaxNodeRef,
): string {
  let text = "";
  for (let child = node.node.firstChild; child; child = child.nextSibling) {
    if (child.name === "CodeText") text += state.doc.sliceString(child.from, child.to);
  }
  return text;
}
