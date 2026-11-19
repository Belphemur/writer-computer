import { useEffect, useRef, useState } from "react";
import * as tauri from "@/lib/tauri";
import type { SearchResult } from "@/types/fs";

interface FuzzySearchState {
  /** The query these results answer; empty-ness is compared so recents never show under a typed query. */
  query: string;
  results: SearchResult[];
  error: string | null;
}

/**
 * File-name search backed by the vault index: fuzzy, typo tolerant, boosted by recently opened
 * and modified files. An empty query lists recent files (opened first). When `enabled` is false
 * (standalone windows without an index) nothing is requested. `error` is set when the index
 * failed (not when the list is merely short); callers show it instead of
 * "No results". `kind` narrows the list to one file kind (the palette's chip).
 */
export function useFuzzySearch(
  query: string,
  limit = 20,
  enabled = true,
  kind: string | null = null,
) {
  const [state, setState] = useState<FuzzySearchState>({ query: "", results: [], error: null });
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const hasQuery = enabled;

  useEffect(() => {
    if (!enabled) {
      return;
    }

    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    let stale = false;
    debounceRef.current = setTimeout(() => {
      (kind ? tauri.fuzzySearch(query, limit, [kind]) : tauri.fuzzySearch(query, limit))
        .then((results) => {
          if (!stale) setState({ query, results, error: null });
        })
        .catch((e: unknown) => {
          console.error("[palette] file search failed:", e);
          if (!stale) {
            setState({ query, results: [], error: e instanceof Error ? e.message : String(e) });
          }
        });
    }, 50);

    return () => {
      stale = true;
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [query, limit, enabled, kind]);

  // Disabled hooks have no results — derive this during render instead of
  // clearing state in the effect, so callers never see a stale frame.
  const sameKind = (state.query.trim() === "") === (query.trim() === "");
  return hasQuery && sameKind
    ? { results: state.results, error: state.error }
    : { results: [], error: null };
}
