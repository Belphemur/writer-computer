import { useAllSettings, useSetSetting } from "@/hooks/use-settings";
import { SELECT, SelectRow } from "@/components/settings-panel/select-row";
import {
  agentBackendContributions,
  EFFORT_LABEL,
  isModelEnabled,
  resolveModel,
  selectableEfforts,
  stringList,
  type BackendModel,
} from "@/lib/features/agent-backends";
import { SETTINGS_SCHEMA } from "@/lib/settings-schema";
import { useBackendModels } from "@/hooks/use-backend-models";
import { useRegistryItems } from "@/hooks/use-registry-items";
import { OPENCODE_BACKEND_ID, OPENCODE_KEYS } from "./keys";
import { ModelsTable } from "./models-table";
import { SavedRules } from "./saved-rules";

const BUTTON =
  "shrink-0 rounded-lg border border-[var(--line-subtle)] px-3 py-1.5 text-[13px] text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-subtle-strong)] disabled:opacity-50";

const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const labelOf = (key: string, fallback: string) =>
  SETTINGS_SCHEMA.find((d) => d.key === key)?.label ?? fallback;

/** A select of the enabled models; `blank` is the entry for the empty value. A stored model the
 *  list does not offer (switched off, retired) stays visible so the row never lies. */
function ModelSelect({
  label,
  blank,
  value,
  models,
  disabled,
  onChange,
}: {
  label: string;
  blank: string;
  value: string;
  models: readonly BackendModel[];
  disabled: readonly string[];
  onChange: (value: string) => void;
}) {
  const offered = models.filter((m) => isModelEnabled(m, disabled));
  const stray = value && !offered.some((m) => m.id === value);
  return (
    <select
      aria-label={label}
      value={value}
      className={SELECT}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{blank}</option>
      {stray && <option value={value}>{value}</option>}
      {offered.map((m) => (
        <option key={m.id} value={m.id}>
          {m.label} ({m.provider})
        </option>
      ))}
    </select>
  );
}

/** The body of Settings > Agent > OpenCode: the default model and effort, the tier models, the
 *  models table and the saved permission rules. The status card above it is the pane's own. */
export function OpencodeSettingsPanel() {
  const settings = useAllSettings();
  const setSetting = useSetSetting();
  // the same loader the chip and the start read: one cached answer, Retry forgets it for all
  const backend = useRegistryItems(agentBackendContributions).find(
    (b) => b.backendId === OPENCODE_BACKEND_ID,
  );
  const { state, reload } = useBackendModels(backend ?? null);
  const disabled = stringList(settings[OPENCODE_KEYS.disabledModels]);
  const model = text(settings[OPENCODE_KEYS.model]);
  const effort = text(settings[OPENCODE_KEYS.effort]) || "default";
  const models = state.status === "ready" ? state.models : [];
  // blank means the first enabled model of the list
  const effective = resolveModel(models, disabled, model || null);
  const levels = selectableEfforts(effective?.variants ?? []);

  return (
    <div data-opencode-panel>
      <p className="border-t border-[var(--line-subtler)] px-4 py-3 text-[13px] text-[var(--text-muted)]">
        Your own OpenCode config does not apply.
      </p>
      {state.status === "loading" && (
        <p
          role="status"
          data-opencode-loading
          className="px-4 pb-3 text-[13px] text-[var(--text-muted)]"
        >
          Loading models…
        </p>
      )}
      {state.status === "error" && (
        <div role="alert" data-opencode-error className="flex items-center gap-3 px-4 pb-3">
          <span className="min-w-0 flex-1 break-words text-[13px] text-[var(--danger)]">
            Could not load models: {state.message}
          </span>
          <button type="button" className={BUTTON} onClick={reload}>
            Retry
          </button>
        </div>
      )}
      <SelectRow title={labelOf(OPENCODE_KEYS.model, "Model")} description="">
        <ModelSelect
          label="Default model"
          blank="First enabled"
          value={model}
          models={models}
          disabled={disabled}
          onChange={(v) => void setSetting(OPENCODE_KEYS.model, v)}
        />
      </SelectRow>
      <SelectRow title={labelOf(OPENCODE_KEYS.effort, "Effort")} description="">
        <select
          aria-label="Default effort"
          disabled={levels.length === 0}
          value={levels.includes(effort) ? effort : "default"}
          className={SELECT}
          onChange={(e) => void setSetting(OPENCODE_KEYS.effort, e.target.value)}
        >
          <option value="default">Agent default</option>
          {levels.map((l) => (
            <option key={l} value={l}>
              {EFFORT_LABEL[l as keyof typeof EFFORT_LABEL]}
            </option>
          ))}
        </select>
      </SelectRow>
      {Object.entries(OPENCODE_KEYS.tiers).map(([tier, key]) => (
        <SelectRow key={tier} title={labelOf(key, tier)} description="">
          <div data-opencode-tier={tier}>
            <ModelSelect
              label={labelOf(key, tier)}
              blank="Chat's own"
              value={text(settings[key])}
              models={models}
              disabled={disabled}
              onChange={(v) => void setSetting(key, v)}
            />
          </div>
        </SelectRow>
      ))}
      {state.status === "ready" && (
        <ModelsTable
          models={state.models}
          disabled={disabled}
          onChange={(next) => void setSetting(OPENCODE_KEYS.disabledModels, next)}
        />
      )}
      <SavedRules />
    </div>
  );
}
