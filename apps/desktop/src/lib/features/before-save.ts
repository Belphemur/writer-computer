// Work a feature does to a note just before the save engine (`lib/save.ts`) reads it: the lint
// feature's "fix on save" is the first. The engine awaits `runBeforeSave(path)` once per save;
// each contribution may dispatch edits to the editor showing the note (they reach the store through
// the editor's own sync, so the write that follows carries them) and must never throw or hang the
// save: a failure is reported to the feature's health and the save goes on, and a contribution
// that takes longer than `BEFORE_SAVE_TIMEOUT_MS` is not waited for.
//
// It is called only from a save the editor's own dirty state asked for: an edit by the agent or on
// disk reloads the note clean, so it never reaches here, and a feature that must not fix those has
// nothing to filter.
import { OwnedRegistry } from "@/lib/owned-registry";
import { reportOwnerFailure } from "./health";
import type { BeforeSaveContribution } from "./types";

export type OwnedBeforeSave = BeforeSaveContribution & { owner: string };

export const beforeSaveContributions = new OwnedRegistry<OwnedBeforeSave>();

/** How long a save waits for the contributions before it writes without them. */
export const BEFORE_SAVE_TIMEOUT_MS = 1500;

/** Runs every contribution for the note at `path`, or returns `null` when there is none (the save
 *  then does not even yield a microtask). */
export function runBeforeSave(path: string): Promise<void> | null {
  const all = beforeSaveContributions.list();
  if (all.length === 0) return null;
  const runs = all.map(async (c) => {
    try {
      await c.run(path);
    } catch (e) {
      reportOwnerFailure(c.owner, "before-save", e);
    }
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, BEFORE_SAVE_TIMEOUT_MS);
  });
  return Promise.race([Promise.all(runs).then(() => undefined), timeout]).finally(() =>
    clearTimeout(timer),
  );
}
