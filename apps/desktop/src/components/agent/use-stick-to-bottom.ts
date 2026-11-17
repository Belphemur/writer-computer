import { useCallback, useLayoutEffect, useRef } from "react";

/** Keeps a scroller pinned to its bottom while the user has not scrolled up. `version` changes
 *  whenever the content grows. */
export function useStickToBottom(version: unknown) {
  const ref = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  const onScroll = useCallback(() => {
    const el = ref.current;
    if (el) stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  }, []);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stuck.current) el.scrollTop = el.scrollHeight;
  }, [version]);
  return { ref, onScroll };
}
