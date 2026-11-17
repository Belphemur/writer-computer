/** Rank of `name` for `query`: 0 prefix, 1 word start, 2 substring, 3 subsequence, `null` no match. */
function rank(name: string, query: string): number | null {
  const n = name.toLowerCase();
  if (n.startsWith(query)) return 0;
  const at = n.indexOf(query);
  if (at >= 0) return /[^\p{L}\p{N}]/u.test(n[at - 1] ?? " ") ? 1 : 2;
  let i = 0;
  for (const ch of n) if (ch === query[i]) i += 1;
  return i === query.length ? 3 : null;
}

/**
 * The views matching `query` (case-insensitive substring, then in-order subsequence), best match
 * first and in file order within a rank. A blank query keeps every view in file order.
 */
export function filterViews<T extends { name: string }>(views: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...views];
  const ranked: { view: T; rank: number; index: number }[] = [];
  views.forEach((view, index) => {
    const r = rank(view.name, q);
    if (r !== null) ranked.push({ view, rank: r, index });
  });
  ranked.sort((a, b) => a.rank - b.rank || a.index - b.index);
  return ranked.map((r) => r.view);
}

/** Index of the first name starting with `prefix` at or after `from` (wrapping), or -1. */
export function typeaheadIndex(names: readonly string[], prefix: string, from: number): number {
  const p = prefix.toLowerCase();
  for (let step = 0; step < names.length; step += 1) {
    const i = (from + step) % names.length;
    if (names[i]!.toLowerCase().startsWith(p)) return i;
  }
  return -1;
}
