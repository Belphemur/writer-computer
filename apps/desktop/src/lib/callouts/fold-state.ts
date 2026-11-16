// Which callouts the reader folded or unfolded, per document, for this app session. In memory
// only: never written to the note. A callout is identified by its index among the document's
// callouts in reading order.

const store = new Map<string, Map<number, boolean>>();

export function getCalloutFolds(path: string): ReadonlyMap<number, boolean> {
  return store.get(path) ?? new Map();
}

export function setCalloutFolded(path: string, index: number, folded: boolean): void {
  let folds = store.get(path);
  if (!folds) store.set(path, (folds = new Map()));
  folds.set(index, folded);
}

/** Forget one document's folds, or all of them. */
export function clearCalloutFolds(path?: string): void {
  if (path === undefined) store.clear();
  else store.delete(path);
}
