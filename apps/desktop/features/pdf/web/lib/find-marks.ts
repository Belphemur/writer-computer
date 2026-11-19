// Marks find matches in a rendered text layer: the matched characters of a text item are wrapped in
// `<mark>` (the current match in `data-current`), and a page's text is put back as pdf.js drew it
// before the next marking. DOM only, no pdf.js: the layer is `TextLayerHandle`'s `items` (the
// strings) and `divs` (their elements).
import type { Match } from "./find";
import type { TextLayerHandle } from "./pdf-lib";

type Span = Match["spans"][number];

/** Put every item back to its plain text. */
export function clearMarks(layer: TextLayerHandle): void {
  layer.divs.forEach((div, i) => {
    if (div.querySelector("mark")) div.textContent = layer.items[i] ?? "";
  });
}

/** Mark the matches of one page; `current` (an index into `matches`) is marked as the current one.
 *  Returns the first mark of the current match, for scrolling. */
export function applyMarks(
  layer: TextLayerHandle,
  matches: readonly Match[],
  current: number,
): HTMLElement | null {
  clearMarks(layer);
  const byItem = new Map<number, { span: Span; current: boolean }[]>();
  matches.forEach((m, index) => {
    for (const span of m.spans) {
      const list = byItem.get(span.item) ?? [];
      list.push({ span, current: index === current });
      byItem.set(span.item, list);
    }
  });
  let first: HTMLElement | null = null;
  for (const [item, ranges] of byItem) {
    const div = layer.divs[item];
    const text = layer.items[item];
    if (!div || text === undefined) continue;
    ranges.sort((a, b) => a.span.from - b.span.from);
    const nodes: Node[] = [];
    let at = 0;
    for (const { span, current: isCurrent } of ranges) {
      if (span.from < at) continue; // overlapping ranges cannot happen; be safe
      if (span.from > at) nodes.push(document.createTextNode(text.slice(at, span.from)));
      const mark = document.createElement("mark");
      mark.className = "pdf-hit";
      if (isCurrent) mark.dataset.current = "";
      mark.textContent = text.slice(span.from, span.to);
      nodes.push(mark);
      if (isCurrent && !first) first = mark;
      at = span.to;
    }
    if (at < text.length) nodes.push(document.createTextNode(text.slice(at)));
    div.replaceChildren(...nodes);
  }
  return first;
}
