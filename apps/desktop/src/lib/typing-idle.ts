/**
 * How long a note must go without a keystroke before something may change it under the user's
 * hands: lint's safe fixes, and (spec `SPECs/git-sync-spec.md` "Cadence") a fetched change applied
 * to an open note. One constant, so the features agree on what "the user stopped typing" means.
 */
export const TYPING_IDLE_MS = 5000;

/** When each note was last edited by the user (a store write from the editor or the properties). */
const lastEdit = new Map<string, number>();

/** The editor store calls this on every edit the user makes to `path`. */
export function noteTyping(path: string, now: number = Date.now()): void {
  lastEdit.set(path, now);
}

/** Has `path` gone without an edit for [`TYPING_IDLE_MS`]? A note never edited in this session is
 *  idle. */
export function isTypingIdle(path: string, now: number = Date.now()): boolean {
  const at = lastEdit.get(path);
  return at === undefined || now - at >= TYPING_IDLE_MS;
}

export function forgetTyping(path: string): void {
  lastEdit.delete(path);
}
