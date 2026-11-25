import { useRef, useState } from "react";
import { FilterChip } from "@/components/filter-chip";
import { useRovingTablist } from "@/hooks/use-roving-tablist";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { Brain01Icon, Image01Icon, Pdf01Icon, ToolsIcon } from "@hugeicons/core-free-icons";
import type { BackendModel } from "@/lib/features/agent-backends";
import { switchedAfter } from "@/lib/switches";
import { BooleanControl } from "@/components/settings-panel/setting-control";
import { SearchField } from "@/components/settings-panel/search-field";
import {
  filterModels,
  formatContext,
  formatCost,
  isModelOn,
  offProviderNames,
  providerTabs,
  resolveProvider,
  type ProviderEntry,
} from "./lib/models";

/** Rows drawn before "Show more": the list is long (hundreds), one page scroll holds it. */
const PAGE = 50;

const MARKS: {
  key: "reasoning" | "image" | "pdf" | "tools";
  label: string;
  icon: IconSvgElement;
}[] = [
  { key: "reasoning", label: "Reasoning", icon: Brain01Icon },
  { key: "image", label: "Image input", icon: Image01Icon },
  { key: "pdf", label: "PDF input", icon: Pdf01Icon },
  { key: "tools", label: "Tools", icon: ToolsIcon },
];

function Row({
  model,
  disabled,
  offProviders,
  onChange,
}: {
  model: BackendModel;
  disabled: readonly string[];
  offProviders: readonly string[];
  onChange: (next: string[]) => void;
}) {
  const on = isModelOn(model, disabled, offProviders);
  const providerOff = offProviders.includes(model.provider ?? "");
  return (
    <li
      data-opencode-model={model.id}
      data-unavailable={!model.available || undefined}
      className="flex items-center gap-3 py-2 data-[unavailable]:opacity-50"
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] text-[var(--text-primary)]">{model.label}</div>
        <div className="truncate text-[12px] text-[var(--text-muted)]">{model.provider}</div>
      </div>
      <div className="flex w-[68px] shrink-0 gap-1 text-[var(--text-muted)]">
        {MARKS.filter((m) => model[m.key]).map((m) => (
          <span key={m.key} role="img" aria-label={m.label} title={m.label}>
            <HugeiconsIcon icon={m.icon} size={13} strokeWidth={1.75} aria-hidden="true" />
          </span>
        ))}
      </div>
      <div
        className="w-[44px] shrink-0 text-right text-[12px] text-[var(--text-muted)]"
        title="Context window"
      >
        {formatContext(model.context ?? null)}
      </div>
      <div
        className="w-[96px] shrink-0 text-right text-[12px] text-[var(--text-muted)]"
        title="Cost per 1M tokens, in and out"
      >
        {model.free
          ? "Free"
          : `${formatCost(model.inputCost ?? null, false)} / ${formatCost(model.outputCost ?? null, false)}`}
      </div>
      <BooleanControl
        label={`Enable ${model.label} (${model.provider})`}
        value={on}
        disabled={!model.available || providerOff}
        onChange={(next) => onChange(switchedAfter(disabled, model.id, next, true))}
      />
    </li>
  );
}

/** The model list of OpenCode's server: an All tab and one per provider (the tabs wrap, never scroll), Enabled and Free chips and
 *  a search over provider and name (all combine), an Enabled switch per model that writes
 *  `agent.opencode.disabled-models`, and, on a provider's tab, one switch for the provider
 *  (`onProvider`; an off provider keeps its tab and its models show off). */
export function ModelsTable({
  models,
  disabled,
  providers,
  disabledProviders,
  providerError,
  onChange,
  onProvider,
}: {
  models: readonly BackendModel[];
  disabled: readonly string[];
  providers: readonly ProviderEntry[];
  disabledProviders: readonly string[];
  /** Why the last provider switch failed (shown under the switch), or null. */
  providerError: string | null;
  onChange: (next: string[]) => void;
  onProvider: (id: string, on: boolean) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [enabledOnly, setEnabledOnly] = useState(false);
  const [freeOnly, setFreeOnly] = useState(false);
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(PAGE);
  const names = providerTabs(models, providers);
  const offProviders = offProviderNames(providers, disabledProviders);
  const provider = resolveProvider(selected, names);
  const entry = providers.find((p) => p.name === provider);
  const rows = filterModels(models, {
    provider,
    enabled: enabledOnly,
    free: freeOnly,
    query,
    disabled,
    offProviders,
  });
  const narrow = (apply: () => void) => {
    apply();
    setShown(PAGE);
  };
  const tabs: { id: string; provider: string | null; label: string }[] = [
    { id: "all", provider: null, label: "All" },
    ...names.map((p) => ({ id: `provider:${p}`, provider: p, label: p })),
  ];
  const tabsRef = useRef<HTMLDivElement>(null);
  const onTabKeys = useRovingTablist(tabsRef, {
    ids: tabs.map((t) => t.id),
    selectedId: tabs.find((t) => t.provider === provider)!.id,
    onSelect: (id) => narrow(() => setSelected(tabs.find((t) => t.id === id)!.provider)),
  });
  const chips = [
    { id: "enabled", label: "Enabled", on: enabledOnly, set: setEnabledOnly },
    { id: "free", label: "Free", on: freeOnly, set: setFreeOnly },
  ];
  return (
    <div data-opencode-models className="border-t border-[var(--line-subtler)] px-4 py-3.5">
      <div
        ref={tabsRef}
        role="tablist"
        aria-label="Providers"
        onKeyDown={onTabKeys}
        className="mb-2 flex flex-wrap gap-1"
      >
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={provider === t.provider}
            tabIndex={provider === t.provider ? 0 : -1}
            data-opencode-tab={t.id}
            data-off={(t.provider !== null && offProviders.includes(t.provider)) || undefined}
            onClick={() => narrow(() => setSelected(t.provider))}
            className="shrink-0 rounded-full px-3 py-1 text-[12.5px] text-[var(--text-secondary)] aria-selected:bg-[var(--accent)] aria-selected:text-white data-[off]:opacity-50"
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Filters" className="flex gap-1">
          {chips.map((c) => (
            <FilterChip
              key={c.id}
              pressed={c.on}
              data-opencode-chip={c.id}
              onClick={() => narrow(() => c.set(!c.on))}
            >
              {c.label}
            </FilterChip>
          ))}
        </div>
        <SearchField
          label="Search models"
          value={query}
          onChange={(q) => narrow(() => setQuery(q))}
        />
      </div>
      {entry && (
        <div data-opencode-provider={entry.id} className="mb-1 flex items-center gap-3 py-2">
          <div className="min-w-0 flex-1 truncate text-[13px] text-[var(--text-primary)]">
            {entry.name}
          </div>
          <BooleanControl
            label={`Enable provider ${entry.name}`}
            value={!disabledProviders.includes(entry.id)}
            onChange={(next) => onProvider(entry.id, next)}
          />
        </div>
      )}
      {entry && providerError && (
        <p role="alert" data-opencode-provider-error className="text-[12px] text-[var(--danger)]">
          {providerError}
        </p>
      )}
      <ul>
        {rows.slice(0, shown).map((m) => (
          <Row
            key={m.id}
            model={m}
            disabled={disabled}
            offProviders={offProviders}
            onChange={onChange}
          />
        ))}
        {rows.length === 0 && (
          <li className="py-2 text-[13px] text-[var(--text-muted)]">
            {entry && disabledProviders.includes(entry.id) ? "Provider off" : "No models match."}
          </li>
        )}
      </ul>
      {rows.length > shown && (
        <button
          type="button"
          data-opencode-more
          onClick={() => setShown((n) => n + PAGE)}
          className="mt-1 rounded-md px-1.5 text-[12px] text-[var(--text-muted)] hover:bg-[var(--item-hover-bg)]"
        >
          Show more ({rows.length - shown})
        </button>
      )}
    </div>
  );
}
