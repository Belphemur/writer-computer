import { useState } from "react";
import { useAllSettings, useSetSetting } from "@/hooks/use-settings";
import { AGENT_TIERS, claudeTierSettingKey } from "@features/agent/web/lib/agent-roles";
import {
  CLAUDE_MODEL_CATALOG,
  DEFAULT_MODEL_ID,
  catalogModel,
  isValidModelId,
} from "@features/agent/web/lib/model-catalog";
import { SETTINGS_SCHEMA } from "@/lib/settings-schema";
import { INPUT, SELECT, SelectRow } from "@/components/settings-panel/select-row";

const CUSTOM = "__custom__";

/** One tier's model: a dropdown of the model catalog plus "Custom…" (an alias or a full name,
 *  validated like `agent.model`). Never a bare text field. Blank or an unusable stored value is
 *  the tier's default (the schema default); Rust resolves it, this only shows it. */
function TierModelRow({ tier }: { tier: string }) {
  const key = claudeTierSettingKey(tier);
  const def = SETTINGS_SCHEMA.find((d) => d.key === key);
  const stored = useAllSettings()[key];
  const setSetting = useSetSetting();
  const fallback = typeof def?.default === "string" ? def.default : DEFAULT_MODEL_ID;
  const value = (typeof stored === "string" ? stored.trim() : "") || fallback;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const custom = editing || !catalogModel(value);

  function commit() {
    const id = draft.trim();
    if (!id) {
      setEditing(false);
      return;
    }
    if (!isValidModelId(id)) {
      setError("Use letters, digits and . _ : [ ] / - only, not starting with a dash.");
      return;
    }
    setError(null);
    setEditing(false);
    void setSetting(key, id);
  }

  return (
    <SelectRow title={def?.label ?? tier} description={def?.description ?? ""}>
      <div data-agent-tier-model={tier} className="flex shrink-0 flex-col items-end gap-1.5">
        <select
          aria-label={def?.label ?? tier}
          value={custom ? CUSTOM : value}
          className={SELECT}
          onChange={(e) => {
            if (e.target.value === CUSTOM) {
              setDraft(catalogModel(value) ? "" : value);
              setEditing(true);
              return;
            }
            setEditing(false);
            setError(null);
            void setSetting(key, e.target.value);
          }}
        >
          {CLAUDE_MODEL_CATALOG.map((m) => (
            <option key={m.id} value={m.id}>
              {m.id === DEFAULT_MODEL_ID ? "Chat's own model" : m.label}
            </option>
          ))}
          <option value={CUSTOM}>{custom && !editing ? `Custom: ${value}` : "Custom…"}</option>
        </select>
        {custom && (
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              commit();
            }}
          >
            <input
              type="text"
              aria-label={`Custom model for the ${tier} tier`}
              placeholder="An alias or full model name"
              value={editing ? draft : value}
              onFocus={() => {
                if (!editing) {
                  setDraft(value);
                  setEditing(true);
                }
              }}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              className={`${INPUT} w-[220px]`}
            />
          </form>
        )}
        {error && (
          <div role="alert" className="max-w-[260px] text-right text-[12px] text-[var(--danger)]">
            {error}
          </div>
        )}
      </div>
    </SelectRow>
  );
}

/** The sub-agent model settings of the Claude backend, one row per tier of the roles registry. */
export function TierModels() {
  return (
    <div
      data-agent-tier-models
      className="overflow-hidden rounded-2xl border border-[var(--line-subtler)] bg-[var(--surface-card)] [&>*:first-child]:border-t-0"
    >
      {AGENT_TIERS.map((tier) => (
        <TierModelRow key={tier} tier={tier} />
      ))}
    </div>
  );
}
