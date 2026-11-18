// Carries a heading slug across the gap between `navigateToFile` (which
// triggers an async load + an editor swap) and the editor's first render
// of the new document. Keyed by absolute file path. Consumed exactly once.

const pending = new Map<string, string>();

export function setPendingAnchor(path: string, anchor: string): void {
  pending.set(path, anchor);
}

export function consumePendingAnchor(path: string): string | undefined {
  const anchor = pending.get(path);
  if (anchor !== undefined) pending.delete(path);
  return anchor;
}

/** Scrolls the live editor showing `path` to the heading `anchor` (a slug) and says whether one
 *  did. The editor area registers it; core callers (`openPathAtAnchor`) reach it without
 *  importing a component. */
type AnchorReveal = (path: string, anchor: string) => boolean;

let reveal: AnchorReveal | null = null;

export function registerAnchorReveal(fn: AnchorReveal): void {
  reveal = fn;
}

export function revealAnchorInPlace(path: string, anchor: string): boolean {
  return reveal?.(path, anchor) ?? false;
}

// A 1-based line to reveal after a file opens (content search). Same lifecycle as the heading
// anchors above: set before navigation, consumed exactly once by the editor that shows the file.
const pendingLines = new Map<string, number>();

export function setPendingLine(path: string, line: number): void {
  pendingLines.set(path, line);
}

export function consumePendingLine(path: string): number | undefined {
  const line = pendingLines.get(path);
  if (line !== undefined) pendingLines.delete(path);
  return line;
}
