import { useEffect, type RefObject } from "react";

/** Focuses `ref` on mount and whenever `tick` changes ("focus the composer" requests). */
export function useFocusOnTick(ref: RefObject<HTMLElement | null>, tick: number) {
  useEffect(() => {
    ref.current?.focus();
  }, [ref, tick]);
}
