// The detected communities of the surface's spec, computed in a worker when the clusters are
// `communities` and no explicit Group by applies (`clusters.ts` names them). The last answer is
// kept while the next one is computed (a refetch does not flash the clusters away); `surfaceGroups`
// ignores an answer whose size no longer matches. `pending` tells the progress phase that the
// current spec has no answer yet.
import { useEffect, useState } from "react";
import { logger } from "@/lib/logger";
import { clusterEdges } from "./clusters";
import { detectInWorker } from "./layout-worker-client";
import type { GraphSpec } from "./model";

export interface Communities {
  communities: Int32Array | null;
  pending: boolean;
}

export function useCommunities(spec: GraphSpec, enabled: boolean): Communities {
  // `of` is the spec the job ran for (also on failure, so a failed job is not pending forever).
  const [state, setState] = useState<{ of: GraphSpec | null; communities: Int32Array | null }>({
    of: null,
    communities: null,
  });
  useEffect(() => {
    if (!enabled || spec.nodes.length === 0) return;
    const { order, edges } = clusterEdges(spec);
    const job = detectInWorker(order, edges);
    let live = true;
    job.result.then(
      (c) => live && setState({ of: spec, communities: c }),
      (e: unknown) => {
        if (!live) return;
        logger.warn("app", `graph clusters failed: ${e instanceof Error ? e.message : e}`);
        setState((s) => ({ ...s, of: spec }));
      },
    );
    return () => {
      live = false;
      job.cancel();
    };
  }, [spec, enabled]);
  return {
    communities: enabled ? state.communities : null,
    pending: enabled && spec.nodes.length > 0 && state.of !== spec,
  };
}
