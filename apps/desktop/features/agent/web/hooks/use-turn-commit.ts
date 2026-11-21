// The commit git made for a finished turn, for the Changes card's "View in history". Git is
// optional: through the service `git.history` (`getService`; the TYPE comes from git's public api
// with `import type`), so the link is absent while git is off or the vault is not set up. The card
// shows the link once the commit resolves and asks again after each commit git announces, until git says the turn is settled (found, or committed past it without one).
import { useEffect, useState, useSyncExternalStore } from "react";
import { getService, serviceContributions } from "@/lib/features/services";
import type { GitHistoryService } from "@features/git/web/api";

const GIT_HISTORY = "git.history";

export function useGitHistory(): GitHistoryService | undefined {
  return useSyncExternalStore(
    (l) => serviceContributions.subscribe(l),
    () => getService<GitHistoryService>(GIT_HISTORY),
  );
}

/** The turn's commit id, `null` until git has made it (or when there is none). */
export function useTurnCommit(
  git: GitHistoryService | undefined,
  turn: { chatId: string; turnId: string; finishedAt: number | null } | null,
): string | null {
  const [rev, setRev] = useState<string | null>(null);
  const key = turn ? `${turn.chatId}:${turn.turnId}:${turn.finishedAt}` : "";
  useEffect(() => {
    setRev(null);
    if (!git || !turn) return;
    let current = true;
    let stop = () => {};
    const ask = () =>
      git.commitForTurn(turn).then(
        (r) => {
          if (!current) return;
          if (r.rev) setRev(r.rev);
          // found, or git moved on without one: stop listening, no more questions
          if (r.settled) stop();
        },
        () => {},
      );
    stop = git.onCommit(() => void ask());
    void ask();
    return () => {
      current = false;
      stop();
    };
    // `turn` is described by `key`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [git, key]);
  return rev;
}
