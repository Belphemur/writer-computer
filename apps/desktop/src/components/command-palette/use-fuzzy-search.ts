import { useEffect, useRef, useState } from "react";
import * as tauri from "@/lib/tauri";
import type { SearchResult } from "@/types/fs";

interface FuzzySearchState {
  results: SearchResult[];
  error: string | null;
}

/**
 * File-name search backed by the vault index. `error` is set when the index
 * failed (not when the list is merely short); callers show it instead of
 * "No results".
 */
export function useFuzzySearch(query: string, limit = 20) {
  const [state, setState] = useState<FuzzySearchState>({ results: [], error: null });
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const hasQuery = query.trim() !== "";

  useEffect(() => {
    if (!hasQuery) {
      return;
    }

    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    let stale = false;
    debounceRef.current = setTimeout(() => {
      tauri
        .fuzzySearch(query, limit)
        .then((results) => {
          if (!stale) setState({ results, error: null });
        })
        .catch((e: unknown) => {
          console.error("[palette] file search failed:", e);
          if (!stale) {
            setState({ results: [], error: e instanceof Error ? e.message : String(e) });
          }
        });
    }, 50);

    return () => {
      stale = true;
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [query, limit, hasQuery]);

  // Empty queries have no results — derive this during render instead of
  // clearing state in the effect, so callers never see a stale frame.
  return hasQuery ? { results: state.results, error: state.error } : { results: [], error: null };
}
