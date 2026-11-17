/**
 * `@` mention candidates: notes from the vault's fuzzy search plus the folders those results
 * live in. Lane 3's project pickers extend this adapter (tags, properties, project sources).
 */
import { noteLabel } from "../note-title";
import type { ContextRef } from "./events";
import { tokenizeMessage } from "./trigger";

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

export function toContextRef(c: MentionCandidate, label?: string): ContextRef {
  if (c.kind === "active-note") return { kind: "active-note", path: c.path, inline: false };
  const l = label === undefined ? {} : { label };
  return c.kind === "note"
    ? { kind: "note", path: c.path, ...l }
    : { kind: "folder", path: c.path, ...l };
}

/**
 * The one rule for the readable name a pick puts in the text: the candidate's label (display
 * title or file name). When another attached path already uses that label, parent folders are
 * added until it is unique (`11/Plan`, then `2026/11/Plan`); with none left the whole path (no
 * extension). A label that cannot sit inside `@"..."` also becomes the path.
 */
export function pickLabel(c: MentionCandidate, attached: readonly ContextRef[]): string {
  const bare = c.path.replace(/\.md$/i, "");
  if (/["\n]/.test(c.label)) return bare;
  const taken = new Set(
    attached.flatMap((r) =>
      "path" in r && "label" in r && r.label && r.path !== c.path ? [r.label] : [],
    ),
  );
  const parents = dirOf(c.path).split("/").filter(Boolean);
  let label = c.label;
  for (let k = 1; taken.has(label) && k <= parents.length; k++)
    label = `${parents.slice(-k).join("/")}/${c.label}`;
  return taken.has(label) ? bare : label;
}

/** `a/b/…/y/z` shortened in the middle to at most `max` characters (the ends are what tell
 *  paths apart); the full text belongs in a tooltip. */
export function middleTruncate(path: string, max = 48): string {
  if (path.length <= max) return path;
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  return `${path.slice(0, head)}\u2026${path.slice(path.length - (keep - head))}`;
}

/** `@` tokens in the text that nothing attached owns: no chip carries that label or path, they
 *  are not `@activenote`, and they do not look like a typed path (those resolve, or stay
 *  literal, at send). Claude gets no path for them, which the composer says. */
export function unattachedMentions(text: string, attached: readonly ContextRef[]): string[] {
  const out: string[] = [];
  for (const seg of tokenizeMessage(text)) {
    if (seg.kind !== "mention" || isActiveNoteToken(seg) || refForToken(seg.path, attached))
      continue;
    if (isTypedPath(seg.path)) continue;
    if (!out.includes(seg.raw)) out.push(seg.raw);
  }
  return out;
}

/** The note or folder ref a token's text names: its readable label (what a pick put in the text)
 *  or its full path. The one ownership rule: a token with an owner is attached, and a ref
 *  without a token is detached from the draft (`draft-refs.ts`). */
export function refForToken(
  tokenPath: string,
  refs: readonly ContextRef[],
): Extract<ContextRef, { kind: "note" | "folder" }> | undefined {
  return refs.find(
    (r): r is Extract<ContextRef, { kind: "note" | "folder" }> =>
      (r.kind === "note" || r.kind === "folder") &&
      (r.path === tokenPath || (r.label ?? r.path) === tokenPath),
  );
}

/** A token that looks like a typed vault path (a folder separator or an extension): it resolves,
 *  or stays literal, at send, so it is not "unattached". A bare name is. */
export const isTypedPath = (p: string) => p.includes("/") || /\.[^/.]+$/.test(p);

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
  return tokenizeMessage(text).some((s) => isActiveNoteToken(s));
}

/** The composer text for a picked name or path: `@name`, or `@"name with spaces"`, the quoted form
 *  Claude Code's own `@` mentions understand (verified with 2.1.325). */
export function mentionToken(path: string): string {
  return /[\s@]|[.,;:!?)\]}'"`>]$/.test(path) ? `@"${path}"` : `@${path}`;
}

export function isActiveNoteToken(seg: { kind: string; path?: string }): boolean {
  return seg.kind === "mention" && seg.path?.toLowerCase() === ACTIVE_NOTE_TOKEN;
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
