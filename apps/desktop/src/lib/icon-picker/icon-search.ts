/**
 * Search over Hugeicons export names (the one icon picker, `components/icon-picker`; project icons: spec 4.8). `Rocket01Icon` is the words "rocket" and "01";
 * every query word must be a prefix of one name word, so "arrow down" finds `ArrowDown01Icon`.
 * Pure: the picker builds the index once per loaded set.
 */

/** `ArrowDown01Icon` -> `["arrow", "down", "01"]` (the trailing "Icon" is dropped). */
export function iconWords(name: string): string[] {
  const base = name.endsWith("Icon") ? name.slice(0, -4) : name;
  return (base.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+/g) ?? []).map((w) => w.toLowerCase());
}

export interface IconIndexEntry {
  name: string;
  words: string[];
}

export function buildIconIndex(names: readonly string[]): IconIndexEntry[] {
  return [...names].sort().map((name) => ({ name, words: iconWords(name) }));
}

/** Entries whose words match every query word by prefix; whole-word matches and shorter names
 *  first, then alphabetical (the index order). All entries for an empty query. */
export function searchIconIndex(index: readonly IconIndexEntry[], query: string): IconIndexEntry[] {
  const q = query
    .toLowerCase()
    .split(/[\s_-]+/)
    .filter(Boolean);
  if (q.length === 0) return [...index];
  const scored: { e: IconIndexEntry; score: number }[] = [];
  for (const e of index) {
    let score = e.words.length;
    let ok = true;
    for (const w of q) {
      if (e.words.includes(w)) continue;
      if (e.words.some((x) => x.startsWith(w))) score += 10;
      else {
        ok = false;
        break;
      }
    }
    if (ok) scored.push({ e, score });
  }
  // Array.prototype.sort is stable: equal scores stay alphabetical.
  return scored.sort((a, b) => a.score - b.score).map((s) => s.e);
}
