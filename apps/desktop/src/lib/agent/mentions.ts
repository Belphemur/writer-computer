/**
 * `@` mention candidates: notes from the vault's fuzzy search plus the folders those results
 * live in. Lane 3's project pickers extend this adapter (tags, properties, project sources).
 */
import type { ContextRef } from "./events";

export type MentionCandidate =
  | { kind: "note"; path: string; label: string; detail: string }
  | { kind: "folder"; path: string; label: string; detail: string };

export type MentionSearch = (query: string, limit: number) => Promise<{ relative_path: string }[]>;

const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const nameOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);

export function toContextRef(c: MentionCandidate): ContextRef {
  return c.kind === "note" ? { kind: "note", path: c.path } : { kind: "folder", path: c.path };
}

/** Pure ranking of search hits into a short mixed list (folders whose name matches first). */
export function candidatesFromResults(
  query: string,
  hits: readonly { relative_path: string }[],
  max = 8,
): MentionCandidate[] {
  const q = query.trim().toLowerCase();
  const folders = new Map<string, MentionCandidate>();
  const notes: MentionCandidate[] = [];
  for (const hit of hits) {
    const path = hit.relative_path;
    notes.push({
      kind: "note",
      path,
      label: nameOf(path).replace(/\.md$/i, ""),
      detail: dirOf(path),
    });
    // every ancestor folder whose own name matches
    let dir = dirOf(path);
    while (dir) {
      if (!folders.has(dir) && (q === "" || nameOf(dir).toLowerCase().includes(q)))
        folders.set(dir, { kind: "folder", path: dir, label: nameOf(dir), detail: dirOf(dir) });
      dir = dirOf(dir);
    }
  }
  return [...[...folders.values()].slice(0, 3), ...notes].slice(0, max);
}

export async function searchMentions(
  query: string,
  search: MentionSearch,
  max = 8,
): Promise<MentionCandidate[]> {
  const hits = await search(query, 40);
  return candidatesFromResults(query, hits, max);
}
