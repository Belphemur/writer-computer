// Manual group order (`groupOrder`) for the Group menu. The engine (`order_groups` in
// `src-tauri/src/bases/query.rs`) puts the listed entries first, in the listed order, matching a
// group key by equality with no coercion, then the other groups by key in the view's direction.
// So an entry can only be one of the scalar kinds that compare equal to a group key: text,
// number, boolean or null. Pure: no React, no IPC.
import type { Cell, Group } from "./types";

export type ScalarEntry = string | number | boolean | null;

/** The entry that matches `cell`, or why none can. */
export function entryOfCell(cell: Cell): { entry: ScalarEntry } | { reason: string } {
  switch (cell.type) {
    case "null":
      return { entry: null };
    case "string":
      return { entry: cell.value };
    case "boolean":
      return { entry: cell.value };
    case "number":
      return cell.value === null
        ? { reason: "NaN and infinity cannot be listed" }
        : { entry: cell.value };
    default:
      return { reason: `${cell.type} values cannot be ordered by hand` };
  }
}

/** Equality the way the engine compares an entry with a group key. */
export function sameEntry(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/** Text shown for an entry. */
export function entryLabel(entry: unknown): string {
  if (entry === null) return "No value";
  if (entry === "") return "(empty text)";
  if (typeof entry === "string") return entry;
  if (typeof entry === "number" || typeof entry === "boolean") return String(entry);
  return JSON.stringify(entry);
}

export interface Candidate {
  entry: ScalarEntry;
  label: string;
}

export interface Candidates {
  /** Group values present in the result that are not listed yet, in current display order. */
  addable: Candidate[];
  /** Values present that cannot be listed, with the reason (shown, never hidden). */
  blocked: { label: string; reason: string }[];
}

/** What "Add value" can offer: the groups currently in the result minus the listed entries. */
export function groupCandidates(
  groups: readonly Group[] | null,
  listed: readonly unknown[],
): Candidates {
  const addable: Candidate[] = [];
  const blocked: Candidates["blocked"] = [];
  for (const g of groups ?? []) {
    const r = entryOfCell(g.key);
    if ("reason" in r) {
      blocked.push({ label: g.key.display || "No value", reason: r.reason });
      continue;
    }
    if (listed.some((e) => sameEntry(e, r.entry))) continue;
    if (addable.some((c) => sameEntry(c.entry, r.entry))) continue;
    addable.push({ entry: r.entry, label: entryLabel(r.entry) });
  }
  return { addable, blocked };
}

/** Whether a listed entry matches a group of the current result (stale entries are dimmed). */
export function entryIsPresent(groups: readonly Group[] | null, entry: unknown): boolean {
  return (groups ?? []).some((g) => {
    const r = entryOfCell(g.key);
    return "entry" in r && sameEntry(r.entry, entry);
  });
}

/** Stable React key and focus identity of an entry. */
export function entryId(entry: unknown): string {
  return `${entry === null ? "null" : typeof entry}:${JSON.stringify(entry)}`;
}
