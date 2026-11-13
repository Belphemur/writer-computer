/** Id of the row a navigation key moves to, or null when the key is not a navigation key or the
 *  list is empty. With no (or a filtered-out) selection, Down/Up land on the first/last row. */
export function nextSelectionId(
  ids: readonly string[],
  current: string | null,
  key: string,
): string | null {
  if (ids.length === 0) return null;
  const at = current === null ? -1 : ids.indexOf(current);
  switch (key) {
    case "ArrowDown":
      return ids[at < 0 ? 0 : Math.min(at + 1, ids.length - 1)];
    case "ArrowUp":
      return ids[at < 0 ? ids.length - 1 : Math.max(at - 1, 0)];
    case "Home":
      return ids[0];
    case "End":
      return ids[ids.length - 1];
    default:
      return null;
  }
}
