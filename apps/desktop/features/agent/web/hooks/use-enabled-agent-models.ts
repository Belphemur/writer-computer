import { useMemo } from "react";
import { enabledModelChoices, type ModelChoice } from "@features/agent/web/lib/model-catalog";
import { useSetting } from "@/hooks/use-settings";

/** The models the composer's model chip lists: those switched on in Settings > Agent
 *  (`agent.enabled-models`), plus the chat's current model. `sessionModel` is the `model` of the
 *  session's init event when there is one. */
export function useEnabledAgentModels(
  opts: {
    currentModel?: string | null;
    sessionModel?: string | null;
  } = {},
): ModelChoice[] {
  const enabled = useSetting("agent.enabled-models");
  const { currentModel, sessionModel } = opts;
  return useMemo(
    () => enabledModelChoices(enabled, { currentModel, sessionModel }),
    [enabled, currentModel, sessionModel],
  );
}
