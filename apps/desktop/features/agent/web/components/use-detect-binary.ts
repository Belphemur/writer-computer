import { useEffect } from "react";
import { detectAgentBinary } from "@features/agent/web/hooks/agent-api";

/** Looks for the `claude` binary once when the pane mounts (no process is spawned). */
export function useDetectBinaryOnMount(known: boolean) {
  useEffect(() => {
    if (!known) void detectAgentBinary();
  }, [known]);
}
