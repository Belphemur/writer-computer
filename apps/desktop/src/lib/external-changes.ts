// Who may take a change the file watcher saw in a note that is open in an editor, instead of the
// default reload from disk. A feature that writes files itself and knows how to hand the change to
// the editor politely (git's sync: after the typing idle, as one undo step, caret kept) claims the
// path; the watcher then leaves it alone. One registry, one place the watcher asks.

export type ExternalChangeClaim = (path: string, kind: string) => boolean;

const claims = new Set<ExternalChangeClaim>();

/** Register a claim; returns the function that removes it. */
export function registerExternalChangeClaim(claim: ExternalChangeClaim): () => void {
  claims.add(claim);
  return () => void claims.delete(claim);
}

/** Does a registered claim take this change? The first to say yes wins. */
export function claimsExternalChange(path: string, kind: string): boolean {
  for (const claim of claims) {
    if (claim(path, kind)) return true;
  }
  return false;
}
