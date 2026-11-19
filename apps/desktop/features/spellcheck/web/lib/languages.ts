// Language names and the block under the cursor, for the status item and its menu.
import type { BlockLanguage } from "../ipc";

const names = new Intl.DisplayNames(["en"], { type: "language", languageDisplay: "standard" });

/** "English", "French (Canada)"; the tag itself when the runtime does not know it. */
export function languageName(tag: string): string {
  try {
    return names.of(tag) ?? tag;
  } catch {
    return tag;
  }
}

/** The block the cursor is in, or the closest one before it (a cursor in a code block or in the
 *  blank line between paragraphs still reads a language), or the first block. */
export function blockAt(
  blocks: readonly BlockLanguage[] | undefined,
  offset: number,
): BlockLanguage | null {
  if (!blocks?.length) return null;
  let found: BlockLanguage | null = null;
  for (const b of blocks) {
    if (b.start > offset) break;
    found = b;
  }
  return found ?? blocks[0];
}

const SOURCES: Record<BlockLanguage["source"], string> = {
  override: "chosen for this note",
  property: "from the note's lang property",
  folder: "from a folder rule",
  detected: "detected",
  default: "the default language",
};

export function sourceLabel(source: BlockLanguage["source"]): string {
  return SOURCES[source];
}
