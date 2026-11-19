// What a fenced block is to Dataview: the grammar in one place. ```dataview is a query,
// ```dataviewjs is JavaScript that is shown as a placeholder and never run. Inline JS
// (`$= ...`) and inline `=` queries are not rendered in v1 (spec `SPECs/dataview-spec.md`).
export type DataviewBlock = { kind: "query"; source: string } | { kind: "js"; source: string };

/** The fence info string as a block kind (`dataview`, `dataviewjs`, case-insensitive), else null. */
export function blockKindOfInfo(info: string): DataviewBlock["kind"] | null {
  const word = info.trim().toLowerCase();
  if (word === "dataview") return "query";
  if (word === "dataviewjs") return "js";
  return null;
}

/** Stable identity of a block (widget equality, React keys). */
export function blockKey(block: DataviewBlock): string {
  return `${block.kind}\0${block.source}`;
}

/** The DQL line an error points at, with a caret line under its column. */
export function errorContext(source: string, line: number, col: number): string {
  const text = source.split("\n")[line - 1] ?? "";
  return `${text}\n${" ".repeat(Math.max(0, col - 1))}^`;
}
