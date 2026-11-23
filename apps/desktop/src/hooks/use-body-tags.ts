import { useDeferredValue, useMemo } from "react";
import { scanTags, tagsNotIn } from "@/lib/tags";
import { useEditorStore } from "@/stores/editor-store";

/** The `#tags` written in the open note's body that `written` (the front matter's tags) does not
 *  have: from the buffer, so they follow the typing and do not wait for the index. The scan is
 *  memoised on the text and deferred, so a keystroke never waits on it. */
export function useBodyTags(filePath: string | null, written: readonly string[]): string[] {
  const content = useEditorStore((s) =>
    filePath ? s.openFiles.get(filePath)?.content : undefined,
  );
  const deferred = useDeferredValue(content ?? "");
  const scanned = useMemo(() => scanTags(deferred), [deferred]);
  return tagsNotIn(scanned, written);
}
