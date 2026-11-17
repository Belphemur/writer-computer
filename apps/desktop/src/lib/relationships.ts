// The `relationships` property type: a single `[[link]]` or a list of them (spec:
// `SPECs/properties-types-spec.md`). Pure edits on the frontmatter text through the one write
// path (`frontmatter-properties.ts`: quoted, byte-minimal, CRLF-safe, verified), the duplicate
// check of the "+" picker, and the file-name resolution of plain text for conversions. The shape
// is kept: a single link stays single until a second one is added, then it becomes a list.
import {
  appendListItem,
  isWikilink,
  removeListItem,
  setList,
  setScalar,
  type EditResult,
  type PropertyRow,
} from "./frontmatter-properties";
import { getFileStem } from "./paths";
import { canonicalWikiTarget, parseWikiLink } from "./wiki-links";
import type { SearchResult } from "@/types/fs";

/** The links of a relationships row, in order: the single value, the list items, or none. */
export function relationshipItems(row: PropertyRow): string[] {
  if (row.kind === "link") return [String(row.value ?? "")];
  return row.kind === "list" ? row.items : [];
}

/** Add `link` (`[[Note]]`) after the existing ones: the first link of an empty property is a
 *  single value, a second turns it into a list, a list gains an item. */
export function addRelationship(text: string, row: PropertyRow, link: string): EditResult {
  if (row.kind === "empty") return setScalar(text, row.key, link, true);
  if (row.kind === "link") return setList(text, row.key, [String(row.value ?? ""), link]);
  if (row.kind === "list") return appendListItem(text, row.key, link);
  return { ok: false, error: "This value is not a link." };
}

/** Remove the link at `index`; removing the only link of a single value empties the property
 *  (`key:`), removing from a list leaves the others. */
export function removeRelationship(text: string, row: PropertyRow, index: number): EditResult {
  if (row.kind === "link") return setScalar(text, row.key, null);
  return removeListItem(text, row.key, index);
}

const norm = (s: string) => s.normalize("NFC").toLowerCase();

/** The note a link points to as a lower-case key: its path without extension (`folder/Note`). */
function linkKey(link: string): string {
  return norm(parseWikiLink(link.trim().replace(/^\[\[|\]\]$/g, "")).path);
}

/** Whether `file` is already one of `links`: by file name (`[[Note]]`, alias and heading forms
 *  included) or by its path (`[[folder/Note]]`). */
export function isAlreadyLinked(links: readonly string[], file: SearchResult): boolean {
  const stem = norm(getFileStem(file.filename));
  const rel = norm(file.relative_path.replace(/\.(md|markdown)$/i, ""));
  return links.some((l) => {
    const key = linkKey(l);
    return key === rel || key === stem;
  });
}

/** The `[[link]]` to write for a picked note: its file name (never its title), the path only when
 *  another note shares the name. `search` finds the notes with that name. */
export async function linkForNote(
  file: SearchResult,
  search: (query: string, limit: number) => Promise<SearchResult[]>,
): Promise<string> {
  const stem = getFileStem(file.filename);
  const same = await search(stem, 50).catch(() => [file]);
  return `[[${canonicalWikiTarget(file, same)}]]`;
}

/** Resolve plain items by file name (`resolve` is the vault resolver, `resolve_wiki_link`): the
 *  returned map gives the file name to link (the resolved note's own name, whatever the case
 *  typed); an item that resolves nowhere is left out. */
export async function resolveLinkNames(
  items: readonly string[],
  resolve: (target: string) => Promise<string | null>,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  await Promise.all(
    items.map(async (item) => {
      const name = item.trim();
      if (name === "" || isWikilink(name)) return;
      const path = await resolve(name).catch(() => null);
      if (path !== null) out[item] = getFileStem(path);
    }),
  );
  return out;
}
