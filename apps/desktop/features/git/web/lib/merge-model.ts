// The pure model of the merge view (spec `SPECs/git-sync-spec.md` "Merge view"): the three
// documents the columns show and where each overlap sits in them. Rust lays the merge out as a run
// of settled text and overlaps (`git_conflict_open`); this turns it into Mine, Theirs and the
// starting Result (every overlap holds mine's lines until the user chooses). No CodeMirror here.
import type { ConflictPart, PropertyConflict } from "../ipc";

/** What the user took for an overlap: a side, both (mine then theirs) or their own text. */
export type Choice = "mine" | "theirs" | "both" | "edited";

export interface Span {
  from: number;
  to: number;
}

/** One overlap and where it sits in each column. */
export interface HunkLayout {
  index: number;
  mine: string;
  theirs: string;
  base: string;
  /** The overlap in the Mine and Theirs documents. */
  inMine: Span;
  inTheirs: Span;
  /** The overlap in the starting Result (mine's lines). */
  inResult: Span;
}

export interface MergeLayout {
  mineDoc: string;
  theirsDoc: string;
  /** The Result before any choice: settled text, and mine's lines in every overlap. */
  resultDoc: string;
  hunks: HunkLayout[];
}

/** Mine's lines then theirs', a line break between when mine's last line has none. */
export function both(mine: string, theirs: string): string {
  const glue = mine !== "" && theirs !== "" && !mine.endsWith("\n") ? "\n" : "";
  return mine + glue + theirs;
}

/** The text an overlap becomes for a choice (`edited` is the user's own: never computed). */
export function textFor(h: { mine: string; theirs: string }, choice: Exclude<Choice, "edited">) {
  return choice === "mine" ? h.mine : choice === "theirs" ? h.theirs : both(h.mine, h.theirs);
}

export function layoutOf(parts: readonly ConflictPart[]): MergeLayout {
  let mineDoc = "";
  let theirsDoc = "";
  let resultDoc = "";
  const hunks: HunkLayout[] = [];
  for (const p of parts) {
    const c = p.conflict;
    if (!c) {
      mineDoc += p.text;
      theirsDoc += p.text;
      resultDoc += p.text;
      continue;
    }
    hunks.push({
      index: hunks.length,
      mine: c.mine,
      theirs: c.theirs,
      base: c.base,
      inMine: { from: mineDoc.length, to: mineDoc.length + c.mine.length },
      inTheirs: { from: theirsDoc.length, to: theirsDoc.length + c.theirs.length },
      inResult: { from: resultDoc.length, to: resultDoc.length + c.mine.length },
    });
    mineDoc += c.mine;
    theirsDoc += c.theirs;
    resultDoc += c.mine;
  }
  return { mineDoc, theirsDoc, resultDoc, hunks };
}

/** The value a property entry shows: `status: done\n` is `done` (a list or a block keeps its lines). */
export function valueOf(entry: string | null): string {
  if (entry === null) return "";
  const text = entry.replace(/\n$/, "");
  const colon = text.indexOf(":");
  const rest = colon < 0 ? text : text.slice(colon + 1);
  return rest.replace(/^ /, "");
}

/** Which side of each conflicting property the user took (`null`: not yet). */
export type Picks = Record<string, "mine" | "theirs" | undefined>;

export function allPicked(properties: readonly PropertyConflict[], picks: Picks): boolean {
  return properties.every((p) => picks[p.name] !== undefined);
}

export function pickRows(picks: Picks): { name: string; side: string }[] {
  return Object.entries(picks).flatMap(([name, side]) => (side ? [{ name, side }] : []));
}
