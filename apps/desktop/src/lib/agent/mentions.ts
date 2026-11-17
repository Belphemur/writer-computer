/**
 * `@` mention candidates: notes from the vault's fuzzy search plus the folders those results
 * live in. Lane 3's project pickers extend this adapter (tags, properties, project sources).
 */
import { noteLabel } from "../note-title";
import type { ContextRef } from "./events";

export type MentionCandidate =
  /** `@activenote`: the note open in the editor, as the same chip the pane attaches by default. */
  | { kind: "active-note"; path: string; label: string; detail: string }
  | { kind: "note"; path: string; label: string; detail: string }
  | { kind: "folder"; path: string; label: string; detail: string };

/** A search hit; `title` is the note's display-title override (`fuzzy_search` matches it like the
 *  file name). */
export type MentionHit = { relative_path: string; title?: string | null };

export type MentionSearch = (query: string, limit: number) => Promise<MentionHit[]>;

const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const nameOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);

export function toContextRef(c: MentionCandidate): ContextRef {
  if (c.kind === "active-note") return { kind: "active-note", path: c.path, inline: false };
  return c.kind === "note" ? { kind: "note", path: c.path } : { kind: "folder", path: c.path };
}

export const ACTIVE_NOTE_TOKEN = "activenote";

/** Shortcuts shown above folders and notes, filtered by what was typed after `@`. Only offered
 *  while a note is open. (`@selection` waits for an editor selection hook.) */
export function specialMentions(query: string, activeNotePath: string | null): MentionCandidate[] {
  if (!activeNotePath) return [];
  const q = query.trim().toLowerCase();
  if (q !== "" && !ACTIVE_NOTE_TOKEN.startsWith(q) && !ACTIVE_NOTE_TOKEN.includes(q)) return [];
  return [
    {
      kind: "active-note",
      path: activeNotePath,
      label: ACTIVE_NOTE_TOKEN,
      detail: `The open note: ${activeNotePath.slice(activeNotePath.lastIndexOf("/") + 1)}`,
    },
  ];
}

/** Did the user type `@activenote` as a word? Then that message carries the active note. */
export function mentionsActiveNote(text: string): boolean {
  return /(^|\s)@activenote(?![\w-])/i.test(text);
}

/** Pure ranking of search hits into a short mixed list (folders whose name matches first). */
export function candidatesFromResults(
  query: string,
  hits: readonly MentionHit[],
  max = 8,
): MentionCandidate[] {
  const q = query.trim().toLowerCase();
  const folders = new Map<string, MentionCandidate>();
  const notes: MentionCandidate[] = [];
  for (const hit of hits) {
    const path = hit.relative_path;
    // The override leads when set (with the path, which carries the file name, as detail).
    const shown = noteLabel(path, hit.title);
    notes.push({
      kind: "note",
      path,
      label: shown.text,
      detail: shown.isOverride ? path : dirOf(path),
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
