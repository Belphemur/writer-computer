/**
 * Refs follow the text. A note, folder or `@activenote` ref attached to a draft lives only while
 * some token in the text names it (`refForToken`, `isActiveNoteToken`); deleting the last token
 * detaches the ref. The detached ref is parked, not forgotten, so undo, redo or pasting the token
 * back re-attaches it instead of leaving a dead pill. Refs that have no token form (selection,
 * tag, property) are never touched. Pure; the store applies it on every text change.
 */
import type { ContextRef } from "./events";
import { isActiveNoteToken } from "./mentions";
import { tokenizeMessage } from "./trigger";

const MAX_PARKED = 50;

export type DraftRefs = { mentions: ContextRef[]; parked: ContextRef[] };

export function reconcileRefs(
  text: string,
  mentions: readonly ContextRef[],
  parked: readonly ContextRef[],
): DraftRefs {
  const names = new Set<string>();
  let active = false;
  for (const seg of tokenizeMessage(text)) {
    if (seg.kind !== "mention") continue;
    if (isActiveNoteToken(seg)) active = true;
    else names.add(seg.path);
  }
  const used = (r: ContextRef) => {
    switch (r.kind) {
      case "active-note":
        return active;
      case "note":
      case "folder":
        return names.has(r.path) || names.has(r.label ?? r.path);
      default:
        return true;
    }
  };
  const keptMentions = mentions.filter(used);
  const revived = parked.filter((p) => used(p) && !keptMentions.some((m) => sameRef(m, p)));
  const nextParked = [...parked.filter((p) => !used(p)), ...mentions.filter((m) => !used(m))].slice(
    -MAX_PARKED,
  );
  const nextMentions = [...keptMentions, ...revived];
  const same = (a: readonly ContextRef[], b: readonly ContextRef[]) =>
    a.length === b.length && a.every((r, i) => r === b[i]);
  return {
    mentions: same(nextMentions, mentions) ? (mentions as ContextRef[]) : nextMentions,
    parked: same(nextParked, parked) ? (parked as ContextRef[]) : nextParked,
  };
}

const sameRef = (a: ContextRef, b: ContextRef) =>
  a.kind === b.kind && JSON.stringify(a) === JSON.stringify(b);
