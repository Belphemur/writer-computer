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

/** Scrolls the live editor showing `path` to the heading `anchor` (a slug) and says whether one
 *  did. The editor area registers it; core callers (`openPathAtAnchor`) reach it without
 *  importing a component. */
type AnchorReveal = (path: string, anchor: string, opts: AnchorOptions) => boolean;

let reveal: AnchorReveal | null = null;

export function registerAnchorReveal(fn: AnchorReveal): void {
  reveal = fn;
}

export function revealAnchorInPlace(
  path: string,
  anchor: string,
  opts: AnchorOptions = {},
): boolean {
  return reveal?.(path, anchor, opts) ?? false;
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
