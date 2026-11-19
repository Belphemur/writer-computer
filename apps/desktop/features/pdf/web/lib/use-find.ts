import { useCallback, useEffect, useRef, useState } from "react";
import {
  matchesInPage,
  pageText,
  queryPattern,
  stepIndex,
  type Match,
  type PageText,
} from "./find";
import type { PdfDocument } from "./pdf-lib";

export interface FindState {
  query: string;
  /** Every match found so far, in reading order. */
  matches: Match[];
  /** Index of the current match, -1 for none. */
  current: number;
  /** Pages are still being read. */
  searching: boolean;
}

const EMPTY: FindState = { query: "", matches: [], current: -1, searching: false };
/** Pages read between two updates of the count. */
const BATCH = 8;

/**
 * Find over a whole document (`./find.ts` is the matching): the text of each page is read once per
 * document and cached, a new query supersedes the one still running, and the count grows as pages
 * are read so a long PDF answers quickly. The reader marks the matches in its text layers.
 */
export function useFind(doc: PdfDocument) {
  const [state, setState] = useState<FindState>(EMPTY);
  const texts = useRef(new Map<number, PageText>());
  const run = useRef(0);

  useEffect(() => {
    texts.current = new Map();
    run.current++;
    setState(EMPTY);
    return () => {
      run.current++;
    };
  }, [doc]);

  const setQuery = useCallback(
    async (query: string) => {
      const mine = ++run.current;
      const pattern = queryPattern(query);
      if (!pattern) {
        setState({ ...EMPTY, query });
        return;
      }
      setState({ query, matches: [], current: -1, searching: true });
      const found: Match[] = [];
      for (let page = 1; page <= doc.numPages; page++) {
        let text = texts.current.get(page);
        if (!text) {
          try {
            text = pageText(await doc.textItems(page));
          } catch {
            text = pageText([]); // an unreadable page has no text to find
          }
          if (run.current !== mine) return;
          texts.current.set(page, text);
        }
        found.push(...matchesInPage(page, text, pattern));
        if (page % BATCH === 0 || page === doc.numPages) {
          const matches = [...found];
          setState((s) => ({
            query,
            matches,
            current: s.current >= 0 ? s.current : matches.length > 0 ? 0 : -1,
            searching: page < doc.numPages,
          }));
        }
      }
    },
    [doc],
  );

  const step = useCallback(
    (direction: 1 | -1) =>
      setState((s) => ({ ...s, current: stepIndex(s.current, s.matches.length, direction) })),
    [],
  );

  const clear = useCallback(() => {
    run.current++;
    setState(EMPTY);
  }, []);

  return { state, setQuery, next: () => step(1), prev: () => step(-1), clear };
}
