import { useCallback, useEffect, useRef, useState } from "react";
import { getWorkspaceEventIdentity, getWorkspaceRoot } from "@/hooks/workspace-api";
import { indexChangeEffect, type IndexChangeEffect } from "@/lib/bases/events";
import { baseQuery, baseRead, onIndexChanged } from "@/lib/bases/ipc";
import { toRelativePath } from "@/lib/bases/paths";
import type { BaseDocument, BaseQueryResult, IndexChangedEvent } from "@/lib/bases/types";
import { isWorkspaceEventCurrent } from "@/lib/workspace-events";

/** Quiet period after the last relevant index change before the view requeries. */
export const REQUERY_DEBOUNCE_MS = 200;

export interface BaseQueryState {
  /** The parsed `.base` (views, display names, column sizes); `null` until read. */
  document: BaseDocument | null;
  /** Why the `.base` could not be read (the file is gone, its YAML does not parse). */
  documentError: string | null;
  /** The raw text of a `.base` that does not parse, shown with the error. */
  rawText: string | null;
  /** The latest query result; kept while a refresh runs so the table does not flash. */
  result: BaseQueryResult | null;
  /** Why the latest query call failed (not the view's own error state, which is in `result`). */
  error: string | null;
  /** A query is in flight. */
  querying: boolean;
  /** Live updates could not be subscribed; the table only updates on explicit refresh. */
  liveError: string | null;
}

const INITIAL: BaseQueryState = {
  document: null,
  documentError: null,
  rawText: null,
  result: null,
  error: null,
  querying: false,
  liveError: null,
};

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const m = (error as { message?: unknown }).message;
    if (typeof m === "string") return m;
    try {
      return JSON.stringify(error);
    } catch {
      // fall through
    }
  }
  return String(error);
}

const rowPathCache = new WeakMap<BaseQueryResult, Set<string>>();
function rowPathsOf(result: BaseQueryResult | null): ReadonlySet<string> {
  if (!result) return new Set();
  let set = rowPathCache.get(result);
  if (!set) {
    set = new Set(result.rows.map((r) => r.path));
    rowPathCache.set(result, set);
  }
  return set;
}

interface Params {
  /** Absolute path of the `.base`. */
  path: string;
  /** Selected view name; the first view when `undefined`. */
  view: string | undefined;
  isActive: boolean;
}

/**
 * Loads a `.base` document and its query result and keeps them current. Every request carries a
 * counter and only the latest one may land (a slow stale response never overwrites a newer one).
 * `index://changed` batches that matter requery after a short debounce; an inactive (kept-alive)
 * tab only marks itself stale and refreshes when it becomes active again.
 */
export function useBaseQuery({ path, view, isActive }: Params) {
  const [state, setState] = useState<BaseQueryState>(INITIAL);
  const queryCounter = useRef(0);
  const documentCounter = useRef(0);
  const waiters = useRef<(() => void)[]>([]);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stale = useRef<IndexChangeEffect>("none");
  const latest = useRef({ path, view, isActive, result: null as BaseQueryResult | null });

  useEffect(() => {
    latest.current.path = path;
    latest.current.view = view;
    latest.current.isActive = isActive;
  });
  useEffect(() => {
    latest.current.result = state.result;
  }, [state.result]);

  const settle = useCallback(() => {
    const pending = waiters.current;
    waiters.current = [];
    for (const resolve of pending) resolve();
  }, []);

  const runQuery = useCallback(async () => {
    const { path: queryPath, view: queryView } = latest.current;
    const id = ++queryCounter.current;
    setState((s) => (s.querying ? s : { ...s, querying: true }));
    try {
      const result = await baseQuery({
        path: queryPath,
        ...(queryView !== undefined ? { view: queryView } : {}),
        thisPath: queryPath,
        nowOffsetMinutes: -new Date().getTimezoneOffset(),
      });
      if (id !== queryCounter.current) return;
      setState((s) => ({ ...s, result, error: null, querying: false }));
      settle();
    } catch (e) {
      if (id !== queryCounter.current) return;
      setState((s) => ({ ...s, error: errorMessage(e), querying: false }));
      settle();
    }
  }, [settle]);

  const loadDocument = useCallback(async () => {
    const id = ++documentCounter.current;
    try {
      const read = await baseRead(latest.current.path);
      if (id !== documentCounter.current) return;
      if (read.document === null || read.error !== null) {
        setState((s) => ({
          ...s,
          document: null,
          documentError: read.error ?? "The .base file could not be parsed",
          rawText: read.text,
        }));
      } else {
        setState((s) => ({ ...s, document: read.document, documentError: null, rawText: null }));
      }
    } catch (e) {
      if (id !== documentCounter.current) return;
      setState((s) => ({ ...s, documentError: errorMessage(e) }));
    }
  }, []);

  const flush = useCallback(() => {
    const effect = stale.current;
    stale.current = "none";
    if (effect === "none") return;
    if (effect === "reload-document") void loadDocument();
    void runQuery();
  }, [loadDocument, runQuery]);

  // New file: reset and load everything. New view: requery only.
  const loadedPath = useRef<string | null>(null);
  useEffect(() => {
    if (loadedPath.current !== path) {
      loadedPath.current = path;
      queryCounter.current++;
      documentCounter.current++;
      setState((s) => ({ ...INITIAL, liveError: s.liveError }));
      void loadDocument();
    }
    void runQuery();
  }, [path, view, loadDocument, runQuery]);

  // Live updates: register once, read current state at event time.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    const onChanged = (event: IndexChangedEvent) => {
      const root = getWorkspaceRoot();
      if (!root || !isWorkspaceEventCurrent(event, getWorkspaceEventIdentity())) return;
      const effect = indexChangeEffect(
        event,
        toRelativePath(root, latest.current.path),
        rowPathsOf(latest.current.result),
      );
      if (effect === "none") return;
      if (stale.current !== "reload-document") stale.current = effect;
      if (!latest.current.isActive) return;
      if (debounce.current) clearTimeout(debounce.current);
      debounce.current = setTimeout(() => {
        debounce.current = null;
        flush();
      }, REQUERY_DEBOUNCE_MS);
    };
    onIndexChanged(onChanged).then(
      (fn) => {
        if (disposed) fn();
        else unlisten = fn;
      },
      (e) => {
        if (!disposed) setState((s) => ({ ...s, liveError: errorMessage(e) }));
      },
    );
    return () => {
      disposed = true;
      if (debounce.current) clearTimeout(debounce.current);
      debounce.current = null;
      unlisten?.();
    };
  }, [flush]);

  // A kept-alive tab that went stale while hidden refreshes when shown again.
  useEffect(() => {
    if (isActive) flush();
  }, [isActive, flush]);

  /** Requery now. Resolves when the latest query has landed (or failed). */
  const refresh = useCallback((): Promise<void> => {
    const done = new Promise<void>((resolve) => waiters.current.push(resolve));
    void runQuery();
    return done;
  }, [runQuery]);

  return { state, refresh };
}
