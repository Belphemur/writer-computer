import { useCallback, useEffect, useRef, useState } from "react";
import { getWorkspaceEventIdentity, getWorkspaceRoot } from "@/hooks/workspace-api";
import { indexChangeEffect, type IndexChangeEffect } from "@/lib/bases/events";
import { extraColumnsToAdd, withExtraColumns } from "@/lib/bases/base-yaml";
import { baseParseText, baseQuery, baseQueryText, baseRead, onIndexChanged } from "@/lib/bases/ipc";
import { toRelativePath } from "@/lib/bases/paths";
import type {
  BaseDocument,
  BaseQueryResult,
  BaseReadResult,
  IndexChangedEvent,
} from "@/lib/bases/types";
import { isWorkspaceEventCurrent } from "@/lib/workspace-events";

/** Quiet period after the last relevant index change before the view requeries. */
export const REQUERY_DEBOUNCE_MS = 200;

/**
 * Where the base comes from: a `.base` file (the tab and `![[x.base]]` embeds) or YAML text that
 * is not a file (a fenced `base` block, evaluated with `base_query_text`).
 */
export type BaseSource = { kind: "file"; path: string } | { kind: "text"; text: string };

/** Quiet period after the last edit of inline YAML before it is parsed and queried again. */
export const TEXT_DEBOUNCE_MS = 250;

const sourceKeyOf = (source: BaseSource): string =>
  source.kind === "file" ? `file:${source.path}` : "text";

/** The document read of a source (`base_read` for a file, `base_parse_text` for inline YAML). */
async function readSource(source: BaseSource): Promise<BaseReadResult> {
  if (source.kind === "file") return baseRead(source.path);
  const parsed = await baseParseText(source.text);
  return { text: source.text, document: parsed.document, error: parsed.error };
}

export interface BaseQueryState {
  /** The parsed `.base` (views, display names, column sizes); `null` until read. */
  document: BaseDocument | null;
  /** Why the `.base` could not be read (the file is gone, its YAML does not parse). */
  documentError: string | null;
  /** The raw text of a `.base` that does not parse, shown with the error. */
  rawText: string | null;
  /** The raw text of the `.base` as last read (parsed or not); `null` until read. */
  text: string | null;
  /** Leading columns of `result` that are the view's own (the rest were added for its needs). */
  shown: number;
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
  text: null,
  shown: 0,
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
  source: BaseSource;
  /**
   * The `this` file (absolute path). Defaults to the `.base` itself for a file source; an
   * embed passes the embedding note (spec 2.2), and a text source has no default.
   */
  thisPath?: string;
  /** Selected view name; the first view when `undefined`. */
  view: string | undefined;
  isActive: boolean;
  /**
   * Property ids the selected view needs values for beyond its `order` (an image property, a
   * plugin's property options). Pure; called with the latest document at query time.
   */
  extras: (document: BaseDocument | null, view: string | undefined) => string[];
}

/** Index of the selected view in the document (`null` for a base without views). */
export function viewIndexOf(
  document: BaseDocument | null,
  view: string | undefined,
): number | null {
  if (!document || document.views.length === 0) return null;
  if (view === undefined) return 0;
  const i = document.views.findIndex((v) => v.name === view);
  return i < 0 ? null : i;
}

/**
 * Loads a base document and its query result and keeps them current. Every request carries a
 * counter and only the latest one may land (a slow stale response never overwrites a newer one).
 * `index://changed` batches that matter requery after a short debounce; an inactive (kept-alive)
 * tab only marks itself stale and refreshes when it becomes active again.
 */
export function useBaseQuery({ source, thisPath, view, isActive, extras }: Params) {
  const sourceKey = sourceKeyOf(source);
  const [state, setState] = useState<BaseQueryState>(INITIAL);
  const queryCounter = useRef(0);
  const documentCounter = useRef(0);
  const waiters = useRef<(() => void)[]>([]);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stale = useRef<IndexChangeEffect>("none");
  const latest = useRef({
    source,
    thisPath,
    view,
    isActive,
    extras,
    result: null as BaseQueryResult | null,
    document: null as BaseDocument | null,
    text: null as string | null,
  });

  useEffect(() => {
    latest.current.source = source;
    latest.current.thisPath = thisPath;
    latest.current.view = view;
    latest.current.isActive = isActive;
    latest.current.extras = extras;
  });
  useEffect(() => {
    latest.current.result = state.result;
    latest.current.document = state.document;
    latest.current.text = state.text;
  }, [state.result, state.document, state.text]);

  const settle = useCallback(() => {
    const pending = waiters.current;
    waiters.current = [];
    for (const resolve of pending) resolve();
  }, []);

  const runQuery = useCallback(async () => {
    const { source: querySource, thisPath: queryThis, view: queryView } = latest.current;
    const id = ++queryCounter.current;
    setState((s) => (s.querying ? s : { ...s, querying: true }));
    try {
      const thisFile = queryThis ?? (querySource.kind === "file" ? querySource.path : undefined);
      const common = {
        ...(queryView !== undefined ? { view: queryView } : {}),
        ...(thisFile !== undefined ? { thisPath: thisFile } : {}),
        nowOffsetMinutes: -new Date().getTimezoneOffset(),
      };
      // A view that needs values it does not show queries the file's text with those properties
      // appended to its `order` (in memory only; the file is never touched).
      const { document } = latest.current;
      const text = querySource.kind === "text" ? querySource.text : latest.current.text;
      const wanted = text !== null ? latest.current.extras(document, queryView) : [];
      const index = viewIndexOf(document, queryView);
      const fallback = ["file.name"];
      const current = index !== null ? (document?.views[index]?.order ?? fallback) : fallback;
      const add = wanted.length > 0 && index !== null ? extraColumnsToAdd(current, wanted) : [];
      const result =
        add.length > 0
          ? await baseQueryText({
              ...common,
              text: withExtraColumns(text!, index, add, fallback),
            })
          : querySource.kind === "file"
            ? await baseQuery({ path: querySource.path, ...common })
            : await baseQueryText({ ...common, text: querySource.text });
      if (id !== queryCounter.current) return;
      const shown = result.columns.length - (result.error ? 0 : add.length);
      setState((s) => ({ ...s, result, shown, error: null, querying: false }));
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
      const read = await readSource(latest.current.source);
      if (id !== documentCounter.current) return;
      if (read.document === null || read.error !== null) {
        setState((s) => ({
          ...s,
          document: null,
          documentError: read.error ?? "The .base file could not be parsed",
          rawText: read.text,
          text: read.text,
        }));
      } else {
        // Publish the document and text to the query's latest-ref first: a view that needs extra
        // columns requeries with them as soon as its document is known.
        latest.current.document = read.document;
        latest.current.text = read.text;
        setState((s) => ({
          ...s,
          document: read.document,
          text: read.text,
          documentError: null,
          rawText: null,
        }));
        if (latest.current.extras(read.document, latest.current.view).length > 0) void runQuery();
      }
    } catch (e) {
      if (id !== documentCounter.current) return;
      setState((s) => ({ ...s, documentError: errorMessage(e) }));
    }
  }, [runQuery]);

  const flush = useCallback(() => {
    const effect = stale.current;
    stale.current = "none";
    if (effect === "none") return;
    if (effect === "reload-document") void loadDocument();
    void runQuery();
  }, [loadDocument, runQuery]);

  // New source: reset and load everything. New view: requery only.
  const loadedSource = useRef<string | null>(null);
  const loadedText = useRef<string | null>(null);
  useEffect(() => {
    if (loadedSource.current !== sourceKey) {
      loadedSource.current = sourceKey;
      loadedText.current =
        latest.current.source.kind === "text" ? latest.current.source.text : null;
      queryCounter.current++;
      documentCounter.current++;
      setState((s) => ({ ...INITIAL, liveError: s.liveError }));
      void loadDocument();
    }
    void runQuery();
  }, [sourceKey, view, loadDocument, runQuery]);

  // Inline YAML edited in place: parse and query again after a quiet period (the source block is
  // being typed; one request per keystroke would flood the backend).
  const inlineText = source.kind === "text" ? source.text : null;
  useEffect(() => {
    if (inlineText === null || loadedText.current === inlineText) return;
    const timer = setTimeout(() => {
      loadedText.current = inlineText;
      void loadDocument();
      void runQuery();
    }, TEXT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [inlineText, loadDocument, runQuery]);

  // Live updates: register once, read current state at event time.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    const onChanged = (event: IndexChangedEvent) => {
      const root = getWorkspaceRoot();
      if (!root || !isWorkspaceEventCurrent(event, getWorkspaceEventIdentity())) return;
      const effect = indexChangeEffect(
        event,
        latest.current.source.kind === "file"
          ? toRelativePath(root, latest.current.source.path)
          : null,
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

  /** Re-read the document and requery. Resolves when the new query has landed (or failed). */
  const reload = useCallback(async (): Promise<void> => {
    await loadDocument();
    await refresh();
  }, [loadDocument, refresh]);

  return { state, refresh, reload };
}
