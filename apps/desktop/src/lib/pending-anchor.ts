// Carries a heading slug across the gap between `navigateToFile` (which
// triggers an async load + an editor swap) and the editor's first render
// of the new document. Keyed by absolute file path. Consumed exactly once.

/** How a missing heading is reported: wiki links (`[[Note#Heading]]`, like Obsidian) open the
 *  note at the top silently; a Markdown `#slug` link shows the "Heading not found" notice. */
export interface AnchorOptions {
  quiet?: boolean;
}

export interface PendingAnchor {
  anchor: string;
  quiet: boolean;
}

const pending = new Map<string, PendingAnchor>();

export function setPendingAnchor(path: string, anchor: string, opts: AnchorOptions = {}): void {
  pending.set(path, { anchor, quiet: opts.quiet ?? false });
}

/** The parked anchor with its options, taken exactly once. */
export function takePendingAnchor(path: string): PendingAnchor | undefined {
  const entry = pending.get(path);
  if (entry !== undefined) pending.delete(path);
  return entry;
}

export function consumePendingAnchor(path: string): string | undefined {
  return takePendingAnchor(path)?.anchor;
}

/** Scrolls the live view showing `path` to `anchor` (a heading slug in an editor, `page=N` in the
 *  PDF reader) and says whether one did. The editor area registers one for the editors; a viewer
 *  of another kind registers its own while mounted. Core callers (`openPathAtAnchor`) reach them
 *  without importing a component. */
type AnchorReveal = (path: string, anchor: string, opts: AnchorOptions) => boolean;

const reveals = new Set<AnchorReveal>();

/** Add a reveal; the returned function removes it. */
export function registerAnchorReveal(fn: AnchorReveal): () => void {
  reveals.add(fn);
  return () => void reveals.delete(fn);
}

/** The first registered reveal that shows `path` takes the anchor. */
export function revealAnchorInPlace(
  path: string,
  anchor: string,
  opts: AnchorOptions = {},
): boolean {
  for (const reveal of reveals) if (reveal(path, anchor, opts)) return true;
  return false;
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
