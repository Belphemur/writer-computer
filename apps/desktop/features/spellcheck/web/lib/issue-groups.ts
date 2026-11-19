// Findings grouped into unique issues for the footer popover: one row per misspelled word
// (spelling, case-insensitive) or per rule and flagged text (grammar, style), so the user fixes
// every occurrence at once. Pure: no editor, no store. The key is also stamped on each diagnostic
// (`source`), which is how the popover finds a group's live ranges after edits.
import type { Finding } from "../ipc";

export type IssueKind = Finding["kind"];

/** Suggestions shown per row. */
export const GROUP_REPLACEMENTS = 3;
const KIND_ORDER: Record<IssueKind, number> = { spelling: 0, grammar: 1, style: 2 };

export interface IssueGroup {
  key: string;
  kind: IssueKind;
  ruleId: string;
  /** The first occurrence as written: shown, and what "Add to dictionary" stores. */
  text: string;
  count: number;
  replacements: string[];
}

/** Case folded, curly apostrophes straight: "Don’t" and "don't" are one word. */
export function normalizeFlagged(text: string): string {
  return text.replace(/[‘’ʼ]/g, "'").toLowerCase().trim();
}

/** The identity of an issue. Spelling ignores the rule (two providers name it differently). */
export function issueKey(kind: IssueKind, ruleId: string, flagged: string): string {
  const word = normalizeFlagged(flagged);
  return kind === "spelling" ? `spelling\u0000${word}` : `${kind}\u0000${ruleId}\u0000${word}`;
}

/** What a diagnostic carries in `source`, so its group can be recomputed from live text. */
export function encodeSource(kind: IssueKind, ruleId: string): string {
  return `${kind}\u0000${ruleId}`;
}

export function keyFromSource(source: string | undefined, flagged: string): string | null {
  const [kind, ruleId] = (source ?? "").split("\u0000");
  if (!ruleId || !(kind! in KIND_ORDER)) return null;
  return issueKey(kind as IssueKind, ruleId, flagged);
}

/** Unique issues of a note: spelling first, then grammar, then style, most frequent first. `text`
 *  is the text the offsets (UTF-16) were found in. */
export function groupFindings(findings: readonly Finding[], text: string): IssueGroup[] {
  const groups = new Map<string, IssueGroup>();
  for (const f of findings) {
    const flagged = text.slice(f.start, f.end);
    if (!flagged) continue;
    const key = issueKey(f.kind, f.ruleId, flagged);
    const group = groups.get(key);
    if (group) {
      group.count += 1;
      continue;
    }
    groups.set(key, {
      key,
      kind: f.kind,
      ruleId: f.ruleId,
      text: flagged,
      count: 1,
      replacements: f.replacements.slice(0, GROUP_REPLACEMENTS),
    });
  }
  return [...groups.values()].sort(
    (a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || b.count - a.count,
  );
}

/** A replacement in the case of the word it replaces: `teh` gets `the`, `Teh` gets `The`, `TEH`
 *  gets `THE`; any other shape (lowercase, mixed) takes the suggestion as given. Used by fix-all,
 *  where one suggestion serves occurrences in different cases. */
export function matchCase(original: string, replacement: string): string {
  if (!replacement) return replacement;
  const [first = "", ...rest] = original;
  const tail = rest.join("");
  const isUpper = (t: string) => t !== t.toLowerCase() && t === t.toUpperCase();
  if (original.length > 1 && isUpper(original)) return replacement.toUpperCase();
  if (isUpper(first) && tail === tail.toLowerCase()) {
    return replacement[0]!.toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

/** Findings per kind, from the groups. */
export function countByKind(groups: readonly IssueGroup[]): Record<IssueKind, number> {
  const out: Record<IssueKind, number> = { spelling: 0, grammar: 0, style: 0 };
  for (const g of groups) out[g.kind] += g.count;
  return out;
}

/** "3 spelling, 1 grammar" (kinds with none left out). */
export function summarize(groups: readonly IssueGroup[]): string {
  const n = countByKind(groups);
  return (["spelling", "grammar", "style"] as const)
    .filter((k) => n[k] > 0)
    .map((k) => `${n[k]} ${k}`)
    .join(", ");
}
