import { useMemo } from "react";
import { enabledModelChoices, type ModelChoice } from "@features/agent/web/lib/model-catalog";
import { useSetting } from "@/hooks/use-settings";
import { useSettingsStore } from "@/stores/settings-store";
import { stringList, type BackendModel } from "@/lib/features/agent-backends";
import { useBackendModels } from "@/hooks/use-backend-models";
import { backendOrDefault } from "@features/agent/web/lib/backends";
import { liveModelChoices } from "@features/agent/web/lib/live-models";

/** The models the composer's model chip lists for Claude: those switched on in Settings > Agent
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

const EMPTY: BackendModel[] = [];

/** The models the chip lists for a chat of backend `backendId`: Claude's catalog, or the live list
 *  of a backend that has one (minus the models its settings switched off). */
export function useChatModelChoices(
  backendId: string,
  opts: { currentModel?: string | null; sessionModel?: string | null } = {},
): ModelChoice[] {
  const backend = backendOrDefault(backendId);
  const catalog = useEnabledAgentModels(opts);
  const live = backend.modelsSource === "live";
  const { state } = useBackendModels(live ? backend : null);
  const models = state.status === "ready" ? state.models : EMPTY;
  const disabledKey = backend.keys.disabledModels;
  const stored = useSettingsStore((s) => (disabledKey ? s.settings[disabledKey] : undefined));
  const disabled = useMemo(() => stringList(stored), [stored]);
  const { currentModel, sessionModel } = opts;
  const choices = useMemo(
    () => (live ? liveModelChoices(models, disabled, { currentModel, sessionModel }) : []),
    [live, models, disabled, currentModel, sessionModel],
  );
  return live ? choices : catalog;
}
