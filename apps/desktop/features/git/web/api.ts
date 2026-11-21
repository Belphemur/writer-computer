// The public entry of the git feature that another feature may name: the service `git.history`
// opens the History tab of a file without importing anything of git. Consumers use `getService`
// (`@/lib/features/services`) and take the TYPE from here with `import type`; the service is
// absent while the feature is off.

/** The service id, one of the manifest's `provides`. */
export const GIT_HISTORY = "git.history";

/** The turn of an agent chat to find the commit of; times in milliseconds since the epoch. */
export interface TurnRef {
  chatId: string;
  turnId: string;
  /** When it finished; the commit follows within moments. */
  finishedAt: number | null;
}

/** `rev` is the turn's commit; `settled` means there is nothing more to wait for (found, or git
 *  moved on without one), so the caller stops asking. */
export interface TurnCommit {
  rev: string | null;
  settled: boolean;
}

export interface GitHistoryService {
  /** Opens (or focuses) the History tab of the file at `path` (absolute), on version `rev`. */
  openHistory(path: string, options?: { rev?: string; activate?: boolean }): void;
  /** The commit git made for an agent turn (matched on the `Writer-Chat` and `Writer-Turn`
   *  trailers, no time window). */
  commitForTurn(turn: TurnRef): Promise<TurnCommit>;
  /** Calls `listener` after each commit (and setup); returns the way to stop. A caller that got
   *  `null` from `commitForTurn` asks again then. */
  onCommit(listener: () => void): () => void;
}
