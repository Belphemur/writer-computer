/**
 * The model chip's list, and the start's model, for a backend whose models come live
 * (`modelsSource: "live"`). One rule everywhere (`resolveModel`, `isModelEnabled` in
 * `@/lib/features/agent-backends`): the backend's list minus the models the user switched off, a
 * blank model being the first of those. The chat's current model is always kept in the chip (it
 * never shows a value it cannot list). Effort levels are the model's variants that Writer can
 * select (`EFFORT_LEVELS`); `none` and `minimal` are not offered.
 */
import {
  isModelEnabled,
  loadBackendModels,
  resolveModel,
  selectableEfforts,
  stringList,
  type BackendModel,
} from "@/lib/features/agent-backends";
import { useSettingsStore } from "@/stores/settings-store";
import type { AgentBackendDescriptor } from "./backends";
import { DEFAULT_MODEL_ID, type ModelChoice } from "./model-catalog";

export function liveModelChoices(
  models: readonly BackendModel[],
  disabled: readonly string[],
  opts: { currentModel?: string | null; sessionModel?: string | null } = {},
): ModelChoice[] {
  const rows = models
    .filter((m) => isModelEnabled(m, disabled) || (m.available && m.id === opts.currentModel))
    .map<ModelChoice>((m) => {
      const efforts = selectableEfforts(m.variants);
      return {
        id: m.id,
        label: m.provider ? `${m.label} (${m.provider})` : m.label,
        value: m.id,
        provider: m.provider,
        name: m.label,
        supportsEffort: efforts.length > 0,
        efforts,
      };
    });
  // a model the list does not (or not yet) know: shown by its id, with no effort levels
  for (const id of [opts.currentModel, opts.sessionModel]) {
    if (id && !rows.some((r) => r.id === id) && !models.some((m) => m.id === id)) {
      rows.push({ id, label: id, value: id, supportsEffort: false, efforts: [] });
    }
  }
  // blank means the backend's own first pick: its levels are that model's
  const first = resolveModel(models, disabled, null);
  const efforts = first ? selectableEfforts(first.variants) : [];
  return [
    {
      id: DEFAULT_MODEL_ID,
      label: "Default",
      value: null,
      supportsEffort: efforts.length > 0,
      efforts,
    },
    ...rows,
  ];
}

/** What a start sends as the model and effort. A blank model of a live backend is resolved here
 *  (the first enabled model of its list) and always passed; the effort is kept only when that
 *  model takes it. Throws when nothing is available, or when the model asked for is switched off
 *  (no start is made). Other backends: as is. */
export async function resolveStartModel(
  backend: AgentBackendDescriptor,
  choice: { model: string | null; effort: string | null },
): Promise<{ model: string | null; effort: string | null }> {
  if (backend.modelsSource !== "live") return choice;
  const disabledKey = backend.keys.disabledModels;
  const disabled = disabledKey ? stringList(useSettingsStore.getState().settings[disabledKey]) : [];
  if (choice.model) {
    // the user chose it (the chip, the chat note or Settings): a model they switched off is
    // refused and said so, never swapped for another one (Rust refuses the same way)
    const slug = choice.model.split("#")[0]!;
    if (disabled.includes(slug)) {
      throw new Error(`The model ${slug} is switched off in Settings > Agent > ${backend.label}`);
    }
    return choice;
  }
  const models = await loadBackendModels({ backendId: backend.id, models: backend.models });
  const model = resolveModel(models, disabled, null);
  if (!model) {
    throw new Error(`No ${backend.label} model is available. Turn one on in Settings > Agent.`);
  }
  const levels = selectableEfforts(model.variants);
  return {
    model: model.id,
    effort: choice.effort && levels.includes(choice.effort) ? choice.effort : null,
  };
}
