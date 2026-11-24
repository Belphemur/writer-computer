import { useEffect } from "react";
import { detectAgentBinary } from "@features/agent/web/hooks/agent-api";

/** Looks for the chat's backend program once when the pane mounts (no process is spawned). */
export function useDetectBinaryOnMount(known: boolean, backendId: string) {
  useEffect(() => {
    if (!known) void detectAgentBinary(backendId);
  }, [known, backendId]);
}
