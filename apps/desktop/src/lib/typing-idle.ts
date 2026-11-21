/**
 * How long a note must go without a keystroke before something may change it under the user's
 * hands: lint's safe fixes, and (spec `SPECs/git-sync-spec.md` "Cadence") a fetched change applied
 * to an open note. One constant, so the features agree on what "the user stopped typing" means.
 */
export const TYPING_IDLE_MS = 5000;
