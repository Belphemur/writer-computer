// Property pickers: the ids a user can sort, group, filter or show. Pure.
import type { BaseDocument, VaultProperty } from "./types";

/** The documented `file.*` fields that make sense as columns. */
export const FILE_PROPERTIES = [
  "file.name",
  "file.path",
  "file.folder",
  "file.ext",
  "file.size",
  "file.ctime",
  "file.mtime",
  "file.tags",
  "file.links",
] as const;

export interface PropertyChoice {
  /** Property id as written in a `.base`: `status`, `file.name`, `formula.age`. */
  id: string;
  label: string;
}

/** File fields, the base's formulas, then every vault property (frontmatter keys, by name). */
export function propertyChoices(
  vault: readonly VaultProperty[],
  document: Pick<BaseDocument, "formulas" | "properties"> | null,
): PropertyChoice[] {
  const label = (id: string, fallback: string) => document?.properties[id]?.displayName ?? fallback;
  const out: PropertyChoice[] = FILE_PROPERTIES.map((id) => ({ id, label: label(id, id) }));
  for (const name of Object.keys(document?.formulas ?? {})) {
    const id = `formula.${name}`;
    out.push({ id, label: label(id, id) });
  }
  const seen = new Set(out.map((c) => c.id));
  for (const p of vault) {
    if (seen.has(p.key)) continue;
    seen.add(p.key);
    out.push({ id: p.key, label: label(p.key, p.key) });
  }
  return out;
}
