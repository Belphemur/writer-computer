// Search over the generated emoji list (`emoji.json`, built by `scripts/build-emoji-json.mjs` from
// the Unicode `emoji-test.txt`), loaded lazily like the icon shards. Every query word must be a
// prefix of a word of the name or of a keyword, so "smile" finds "grinning face with smiling
// eyes". Pure: the picker builds the index once per loaded list.

export interface EmojiEntry {
  emoji: string;
  name: string;
  keywords: string[];
  group: number;
}

export interface EmojiData {
  groups: string[];
  emoji: EmojiEntry[];
}

export interface EmojiIndexEntry extends EmojiEntry {
  words: string[];
}

/** The emoji list, its own chunk: only the picker's Emoji tab loads it. */
export async function loadEmoji(): Promise<EmojiData> {
  return (await import("./emoji.json")).default as EmojiData;
}

const wordsOf = (text: string) =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

export function buildEmojiIndex(data: EmojiData): EmojiIndexEntry[] {
  return data.emoji.map((e) => ({ ...e, words: [...wordsOf(e.name), ...e.keywords] }));
}

/** Entries matching every query word by prefix: whole-word and shorter-name matches first, then
 *  the list's own (Unicode) order. Everything for an empty query. */
export function searchEmojiIndex(
  index: readonly EmojiIndexEntry[],
  query: string,
): EmojiIndexEntry[] {
  const q = wordsOf(query);
  if (q.length === 0) return [...index];
  const scored: { e: EmojiIndexEntry; score: number }[] = [];
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
  return scored.sort((a, b) => a.score - b.score).map((s) => s.e);
}
