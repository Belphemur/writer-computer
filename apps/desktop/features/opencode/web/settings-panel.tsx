import { useCallback, useEffect, useState } from "react";
import { useAllSettings, useSetSetting } from "@/hooks/use-settings";
import { useSettingsStore } from "@/stores/settings-store";
import { switchedAfter } from "@/lib/switches";
import { SELECT, SelectRow } from "@/components/settings-panel/select-row";
import {
  agentBackendContributions,
  EFFORT_LABEL,
  resolveModel,
  selectableEfforts,
  stringList,
  type BackendModel,
} from "@/lib/features/agent-backends";
import { SETTINGS_SCHEMA } from "@/lib/settings-schema";
import { useBackendModels } from "@/hooks/use-backend-models";
import { useRegistryItems } from "@/hooks/use-registry-items";
import { OPENCODE_BACKEND_ID, OPENCODE_KEYS } from "./keys";
import {
  providers as loadProviders,
  reconfigure,
  status,
  type GlobalConfig,
  type ProviderRow,
} from "./ipc";
import { ModelsTable } from "./models-table";
import { isModelOn, offProviderNames } from "./lib/models";
import { SavedRules } from "./saved-rules";

const BUTTON =
  "shrink-0 rounded-lg border border-[var(--line-subtle)] px-3 py-1.5 text-[13px] text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-subtle-strong)] disabled:opacity-50";

const describe = (e: unknown) => (e instanceof Error ? e.message : String(e));

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
  offProviders,
  onChange,
}: {
  label: string;
  blank: string;
  value: string;
  models: readonly BackendModel[];
  disabled: readonly string[];
  /** Provider names switched off: none of their models is offered. */
  offProviders: readonly string[];
  onChange: (value: string) => void;
}) {
  const offered = models.filter((m) => isModelOn(m, disabled, offProviders));
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

/** The body of Settings > Agent > OpenCode: what applies of the user's own config, the default model
 *  and effort, the tier models, the models table (with a switch per provider) and the saved
 *  permission rules. The status card above it is the pane's own. */
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
  const disabledProviders = stringList(settings[OPENCODE_KEYS.disabledProviders]);
  const binaryPath = text(settings[OPENCODE_KEYS.binaryPath]);
  const [providers, setProviders] = useState<readonly ProviderRow[]>([]);
  const offProviders = offProviderNames(providers, disabledProviders);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [globalConfig, setGlobalConfig] = useState<GlobalConfig | null>(null);
  const ready = state.status === "ready";
  // the tabs come from the server (its providers plus the switched-off ones); the server is up once
  // the models loaded, which is also when its config state is known
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    loadProviders().then(
      (rows) => !cancelled && setProviders(rows),
      (e: unknown) => !cancelled && setProviderError(describe(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [ready, state]);
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    status(binaryPath || null).then(
      (s) => !cancelled && setGlobalConfig(s.globalConfig),
      () => {}, // the status card above already says why a program is unusable
    );
    return () => {
      cancelled = true;
    };
  }, [ready, binaryPath]);
  const switchProvider = useCallback(
    async (id: string, on: boolean) => {
      // read at the click: two quick clicks each start from the list the other left
      const list = stringList(
        useSettingsStore.getState().settings[OPENCODE_KEYS.disabledProviders],
      );
      setProviderError(null);
      try {
        await setSetting(OPENCODE_KEYS.disabledProviders, switchedAfter(list, id, on, true));
        await reconfigure();
        reload(); // the models come or go; the new list is read again, and the providers with it
      } catch (e) {
        setProviderError(describe(e));
        try {
          setProviders(await loadProviders()); // nothing reloaded: show what is in force
        } catch (e2) {
          setProviderError(describe(e2));
        }
      }
    },
    [setSetting, reload],
  );
  // blank means the first enabled model of the list
  const effective = resolveModel(models, disabled, model || null);
  const levels = selectableEfforts(effective?.variants ?? []);

  return (
    <div data-opencode-panel>
      <p className="border-t border-[var(--line-subtler)] px-4 py-3 text-[13px] text-[var(--text-muted)]">
        Your global OpenCode config, plugins and instructions apply. Its MCP servers stay off until
        you switch them on below. Global permission allows do not apply here.
      </p>
      {globalConfig === "skipped-mcp-policy" && (
        <p data-opencode-config-skipped className="px-4 pb-3 text-[13px] text-[var(--text-muted)]">
          Your OpenCode config sets an MCP policy, so Writer uses its own config only.
        </p>
      )}
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
          offProviders={offProviders}
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
              offProviders={offProviders}
              onChange={(v) => void setSetting(key, v)}
            />
          </div>
        </SelectRow>
      ))}
      {state.status === "ready" && (
        <ModelsTable
          models={state.models}
          disabled={disabled}
          providers={providers}
          disabledProviders={disabledProviders}
          providerError={providerError}
          onChange={(next) => void setSetting(OPENCODE_KEYS.disabledModels, next)}
          onProvider={(id, on) => void switchProvider(id, on)}
        />
      )}
      <SavedRules />
    </div>
  );
}
