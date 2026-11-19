// Finding the ```tasks query block around a position of a note. Plain text scanning of the
// fence lines (a block is a handful of lines), so it needs no syntax tree.

export interface TasksBlock {
  /** Offset of the opening fence line's start. */
  from: number;
  /** Offset of the end of the closing fence line (or of the document when unclosed). */
  to: number;
  /** The instructions between the fences. */
  source: string;
}

const OPEN = /^( {0,3})(`{3,}|~{3,})\s*tasks\s*$/i;

/** The ```tasks block `pos` is inside (fences included), or `null`. */
export function tasksBlockAt(doc: string, pos: number): TasksBlock | null {
  let offset = 0;
  const lines = doc.split("\n");
  let open: { from: number; fence: string; bodyFrom: number } | null = null;
  for (const text of lines) {
    const lineFrom = offset;
    const lineTo = offset + text.length;
    offset = lineTo + 1;
    if (!open) {
      const m = OPEN.exec(text);
      if (m) open = { from: lineFrom, fence: m[2]!, bodyFrom: lineTo + 1 };
      else if (lineFrom > pos) return null;
      continue;
    }
    const closes = text.trim().startsWith(open.fence) && /^[`~]+$/.test(text.trim());
    if (closes) {
      if (pos >= open.from && pos <= lineTo) {
        return {
          from: open.from,
          to: lineTo,
          source: doc.slice(open.bodyFrom, Math.max(open.bodyFrom, lineFrom - 1)),
        };
      }
      open = null;
    }
  }
  if (open && pos >= open.from) {
    return { from: open.from, to: doc.length, source: doc.slice(open.bodyFrom) };
  }
  return null;
}
