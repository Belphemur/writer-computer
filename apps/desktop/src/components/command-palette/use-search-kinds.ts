import { useEffect, useState } from "react";
import { searchKinds, type SearchKind } from "@/lib/content-search";

/**
 * The file kinds the vault lists (the registry, over IPC), fetched each time the palette opens so
 * a setting or a feature switch shows at once. Empty until the answer comes, and when there is no
 * backend (tests, the browser): the chips and icons then simply do not show.
 */
export function useSearchKinds(enabled: boolean): SearchKind[] {
  const [kinds, setKinds] = useState<SearchKind[]>([]);
  // External sync: one IPC read per open, dropped when the palette closes first.
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    searchKinds().then(
      (list) => {
        if (current && Array.isArray(list)) setKinds(list);
      },
      () => {
        if (current) setKinds([]);
      },
    );
    return () => {
      current = false;
    };
  }, [enabled]);
  return kinds;
}
