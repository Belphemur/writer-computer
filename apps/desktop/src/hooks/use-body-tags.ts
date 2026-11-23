import { useMemo } from "react";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { scanTags, tagsNotIn } from "@/lib/tags";
import { useEditorStore } from "@/stores/editor-store";

/** How long the body must rest before its tags are read again. */
export const BODY_TAGS_DEBOUNCE_MS = 250;

/** The `#tags` written in the open note's body that `written` (the front matter's tags) does not
 *  have: from the buffer, so they follow the typing and do not wait for the index. The scan runs
 *  only where this hook is used, which is the expanded panel's tags row, on the debounced text and
 *  memoised on it, so typing never waits on a pass over the note. */
export function useBodyTags(filePath: string | null, written: readonly string[]): string[] {
  const content = useEditorStore((s) =>
    filePath ? s.openFiles.get(filePath)?.content : undefined,
  );
  const settled = useDebouncedValue(content ?? "", BODY_TAGS_DEBOUNCE_MS);
  const scanned = useMemo(() => scanTags(settled), [settled]);
  return tagsNotIn(scanned, written);
}
