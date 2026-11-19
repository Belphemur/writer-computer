import { useEffect, useRef, useState } from "react";
import {
  indexSearch,
  isIndexBuildingError,
  onIndexChanged,
  type ContentSearchHit,
} from "@/lib/content-search";

export const CONTENT_SEARCH_DEBOUNCE_MS = 150;
export const CONTENT_SEARCH_MIN_CHARS = 2;
const RESULT_LIMIT = 30;

export type ContentSearchState =
  | { status: "idle" }
  | { status: "loading"; hits: ContentSearchHit[] }
  | { status: "ready"; hits: ContentSearchHit[]; total: number }
  | { status: "building" }
  | { status: "error"; message: string };

const IDLE: ContentSearchState = { status: "idle" };

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Debounced content search with stale-response protection: every request takes a ticket and
 * only the newest ticket may write state, so a slow answer for "ha" never overwrites the
 * answer for "harbour". `kind` narrows the search to one file kind (the palette's chip). A cold
 * index reports `building`; the search re-runs when the backend
 * announces a full `index://changed` (the cold build finished).
 */
export function useContentSearch(
  query: string,
  enabled: boolean,
  kind: string | null = null,
): ContentSearchState {
  const [state, setState] = useState<ContentSearchState>(IDLE);
  const [retry, setRetry] = useState(0);
  const ticket = useRef(0);
  const trimmed = query.trim();
  const active = enabled && trimmed.length >= CONTENT_SEARCH_MIN_CHARS;

  // External sync: a debounced IPC request keyed by the query. Not derivable during render.
  // eslint-disable-next-line react-doctor/no-event-handler
  useEffect(() => {
    if (!active) {
      ticket.current++; // drop any answer still in flight
      return;
    }
    const mine = ++ticket.current;
    const timer = setTimeout(() => {
      setState((s) => ({
        status: "loading",
        hits: s.status === "ready" || s.status === "loading" ? s.hits : [],
      }));
      indexSearch({
        query: trimmed,
        limit: RESULT_LIMIT,
        snippetLen: 140,
        maxSnippets: 3,
        asYouType: true,
        recency: true,
        fuzzy: true,
        ...(kind ? { kinds: [kind] } : {}),
      }).then(
        (page) => {
          if (mine === ticket.current) {
            setState({ status: "ready", hits: page.hits, total: page.total });
          }
        },
        (e: unknown) => {
          if (mine !== ticket.current) return;
          setState(
            isIndexBuildingError(e)
              ? { status: "building" }
              : { status: "error", message: errorText(e) },
          );
        },
      );
    }, CONTENT_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [active, trimmed, retry, kind]);

  // Listener registered once per open palette; reads nothing but bumps the retry counter.
  // eslint-disable-next-line react-doctor/no-event-handler
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    onIndexChanged((event) => {
      if (event.full) setRetry((n) => n + 1);
    }).then(
      (fn) => {
        if (disposed) fn();
        else unlisten = fn;
      },
      () => {
        // No event bridge (tests, browser): the search still works, it just does not auto-retry.
      },
    );
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [enabled]);

  return active ? state : IDLE;
}
