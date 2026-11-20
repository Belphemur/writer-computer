/**
 * "Reload session": the words of its outcomes, in one place. The notice of a reload that went
 * ahead ("Session reloaded", with the cause for an automatic one) comes from the
 * `session-reloaded` event (`reduce.ts`, `reloadedNotice`), so a manual and an automatic reload
 * read the same; only what stops a reload from starting is worded here.
 */
import type { ReloadOutcome } from "./events";

export const RELOAD_BUSY_TEXT =
  "Can't reload while the agent or its sub-agents are working, or while it waits for your answer. Try again when they're done.";
export const RELOAD_NOT_STARTED_TEXT =
  "Nothing to reload yet: the session starts with your first message.";

/** The notice to show now, or `null` when the reload started (its event brings the notice). */
export function reloadNoticeFor(outcome: ReloadOutcome): string | null {
  return outcome === "busy" ? RELOAD_BUSY_TEXT : null;
}
