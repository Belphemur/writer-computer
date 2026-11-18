// Fetches the slice a surface shows and keeps it current: a refetch (one code path, spec 8.5 "prefer
// refetch first") when an `index://changed` batch touches a note of the slice, is a full batch, or
// names a note the slice may now gain; debounced, and only for the workspace that is open.
import { useCallback, useEffect, useRef, useState } from "react";
import { getWorkspaceEventIdentity } from "@/hooks/workspace-api";
import { graphSlice, onIndexChanged, type GraphSlice, type GraphSliceArgs } from "./ipc";

export const REFETCH_DEBOUNCE_MS = 300;

export interface GraphData {
  slice: GraphSlice | null;
  error: string | null;
  loading: boolean;
  refetch: () => void;
}

/** Does a change batch concern this slice? Any changed path might add a node or an edge, so
 *  anything but a batch of paths wholly outside a small slice is a refetch; a whole-vault slice
 *  refetches on every batch (one note's new link changes its edges). */
export function batchAffects(
  batch: { full: boolean; paths: readonly string[] },
  nodePaths: ReadonlySet<string>,
  scoped: boolean,
): boolean {
  if (batch.full || !scoped) return true;
  return batch.paths.some((p) => nodePaths.has(p) || p.endsWith(".md"));
}

export function useGraphData(args: GraphSliceArgs | null): GraphData {
  const [state, setState] = useState<{
    slice: GraphSlice | null;
    error: string | null;
    loading: boolean;
  }>({ slice: null, error: null, loading: false });
  const argsKey = JSON.stringify(args);
  const seq = useRef(0);
  const nodePaths = useRef<ReadonlySet<string>>(new Set());
  const argsRef = useRef(args);
  argsRef.current = args;

  /** `visible`: a request the user asked for (a new slice, Retry) shows as loading; the quiet
   *  refetch after an index change does not. */
  const fetchNow = useCallback((visible: boolean) => {
    const a = argsRef.current;
    if (!a) return;
    const mine = ++seq.current;
    setState((s) => ({ ...s, loading: visible, error: null }));
    graphSlice(a).then(
      (slice) => {
        if (mine !== seq.current) return;
        nodePaths.current = new Set(slice.nodes.map((n) => n.path));
        setState({ slice, error: null, loading: false });
      },
      (e: unknown) => {
        if (mine !== seq.current) return;
        setState((s) => ({
          ...s,
          error: e instanceof Error ? e.message : String(e),
          loading: false,
        }));
      },
    );
  }, []);

  // Refetch when the request changes.
  useEffect(() => {
    fetchNow(true);
    return () => {
      seq.current++;
    };
  }, [argsKey, fetchNow]);

  // Live updates.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let dead = false;
    let unlisten: (() => void) | null = null;
    const identity = getWorkspaceEventIdentity();
    void onIndexChanged((batch) => {
      if (!identity || getWorkspaceEventIdentity()?.root !== identity.root) return;
      if (!batchAffects(batch, nodePaths.current, argsRef.current?.center !== undefined)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => fetchNow(false), REFETCH_DEBOUNCE_MS);
    }).then((u) => {
      if (dead) u();
      else unlisten = u;
    });
    return () => {
      dead = true;
      if (timer) clearTimeout(timer);
      unlisten?.();
    };
  }, [fetchNow]);

  const refetch = useCallback(() => fetchNow(true), [fetchNow]);
  return { ...state, refetch };
}
