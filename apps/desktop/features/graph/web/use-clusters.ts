// The detected communities of the surface's spec, computed in a worker when the clusters are
// `communities` and no explicit Group by applies (`clusters.ts` names them). The last answer is
// kept while the next one is computed (a refetch does not flash the clusters away); `surfaceGroups`
// ignores an answer whose size no longer matches.
import { useEffect, useState } from "react";
import { logger } from "@/lib/logger";
import { clusterEdges } from "./clusters";
import { detectInWorker } from "./layout-worker-client";
import type { GraphSpec } from "./model";

export function useCommunities(spec: GraphSpec, enabled: boolean): Int32Array | null {
  const [communities, setCommunities] = useState<Int32Array | null>(null);
  useEffect(() => {
    if (!enabled || spec.nodes.length === 0) return;
    const { order, edges } = clusterEdges(spec);
    const job = detectInWorker(order, edges);
    let live = true;
    job.result.then(
      (c) => live && setCommunities(c),
      (e: unknown) => {
        if (live)
          logger.warn("app", `graph clusters failed: ${e instanceof Error ? e.message : e}`);
      },
    );
    return () => {
      live = false;
      job.cancel();
    };
  }, [spec, enabled]);
  return enabled ? communities : null;
}
