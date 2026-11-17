import { useMemo, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown01Icon, ArrowRight01Icon, Search01Icon } from "@hugeicons/core-free-icons";
import {
  buildModelRows,
  DEFAULT_MODEL_ID,
  isValidModelId,
  toggleModel,
  type ModelRow,
} from "@/lib/agent/model-catalog";
import { BooleanControl } from "@/components/settings-panel/setting-control";
import { INPUT } from "./agent-rows";

function matches(row: ModelRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || `${row.label} ${row.id} ${row.description}`.toLowerCase().includes(q);
}

/** The model catalog of Settings > Agent: search, one collapsible group with the number of
 *  enabled models, a switch per model (which models the composer offers) and "Add custom model…". */
export function AgentModels({
  backendLabel,
  enabled,
  currentModel,
  sessionModel,
  onChange,
}: {
  backendLabel: string;
  enabled: unknown;
  currentModel: string | null;
  sessionModel?: string | null;
  onChange: (next: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(true);
  const [custom, setCustom] = useState("");
  const [error, setError] = useState<string | null>(null);
  const rows = useMemo(
    () => buildModelRows(enabled, { currentModel, sessionModel }),
    [enabled, currentModel, sessionModel],
  );
  const shown = rows.filter((r) => matches(r, query));
  const count = rows.filter((r) => r.enabled).length;

  function addCustom() {
    const id = custom.trim();
    if (!id) return;
    if (!isValidModelId(id)) {
      setError("Use letters, digits and . _ : [ ] / - only, not starting with a dash.");
      return;
    }
    setError(null);
    onChange(toggleModel(enabled, id, true));
    setCustom("");
  }

  return (
    <div data-agent-models className="border-t border-[var(--line-subtler)] px-4 py-3.5">
      <label className="relative block">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-icon-muted)]">
          <HugeiconsIcon icon={Search01Icon} size={14} strokeWidth={1.75} aria-hidden="true" />
        </span>
        <input
          type="search"
          aria-label={`Search ${backendLabel} models`}
          placeholder={`Search ${backendLabel} models…`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className={`${INPUT} pl-8`}
        />
      </label>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="mt-3 flex w-full items-center gap-2 text-left text-[13px] font-medium text-[var(--text-primary)]"
      >
        <HugeiconsIcon
          icon={open ? ArrowDown01Icon : ArrowRight01Icon}
          size={14}
          strokeWidth={1.75}
          aria-hidden="true"
        />
        {backendLabel}
        <span
          data-agent-models-count
          className="rounded-full bg-[var(--accent)] px-1.5 text-[11px] leading-5 font-medium text-white"
        >
          {count}
        </span>
      </button>
      {open && (
        <ul className="mt-1">
          {shown.map((row) => (
            <li
              key={row.id}
              data-agent-model={row.id}
              className="flex items-center justify-between gap-4 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="text-[13px] text-[var(--text-primary)]">
                  {row.label}
                  {row.legacy && (
                    <span className="ml-2 text-[11px] text-[var(--text-muted)]">older</span>
                  )}
                </div>
                <div className="text-[12px] text-[var(--text-muted)]">{row.description}</div>
              </div>
              {row.custom && row.enabled && (
                <button
                  type="button"
                  aria-label={`Remove ${row.id}`}
                  onClick={() => onChange(toggleModel(enabled, row.id, false))}
                  className="shrink-0 rounded-md px-1.5 text-[12px] text-[var(--text-muted)] hover:bg-[var(--item-hover-bg)]"
                >
                  Remove
                </button>
              )}
              <BooleanControl
                label={`Show ${row.label} in the model picker`}
                value={row.enabled}
                onChange={(on) =>
                  row.id !== DEFAULT_MODEL_ID && onChange(toggleModel(enabled, row.id, on))
                }
              />
            </li>
          ))}
          {shown.length === 0 && (
            <li className="py-2 text-[13px] text-[var(--text-muted)]">No models match.</li>
          )}
        </ul>
      )}
      <form
        className="mt-2 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          addCustom();
        }}
      >
        <input
          type="text"
          aria-label="Add custom model"
          placeholder="Add custom model…  (an alias or full model name)"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          className={INPUT}
        />
        <button
          type="submit"
          className="shrink-0 rounded-lg border border-[var(--line-subtle)] px-3 text-[13px] text-[var(--text-primary)] hover:bg-[var(--surface-subtle-strong)]"
        >
          Add
        </button>
      </form>
      {error && (
        <div role="alert" className="mt-1 text-[12px] text-[var(--danger)]">
          {error}
        </div>
      )}
    </div>
  );
}
