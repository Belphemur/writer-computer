import { useState } from "react";
import { groupByProvider, matchesQuery } from "@/lib/features/agent-backends";
import { ChipMenuRadio } from "./chip-menu";
import type { ModelChoice } from "@features/agent/web/lib/model-catalog";

/** Over this many models the menu has a search field. */
export const MODEL_SEARCH_THRESHOLD = 8;

/**
 * The model rows of the chip's menu, the same for every backend: a search field above
 * `MODEL_SEARCH_THRESHOLD` models (typing filters, Enter picks the first match), and provider
 * headers only when the models come from more than one provider (the Default row and models with
 * no provider stay above them). Claude's short, single-provider list is a plain list.
 */
export function ModelList({
  models,
  selectedId,
  onPick,
}: {
  models: readonly ModelChoice[];
  selectedId: string;
  onPick: (m: ModelChoice) => void;
}) {
  const [query, setQuery] = useState("");
  const searchable = models.length > MODEL_SEARCH_THRESHOLD;
  const shown = models.filter((m) => matchesQuery(query, m.provider, m.name ?? m.label));
  const groups = groupByProvider(shown);
  const grouped = groupByProvider(models).length > 1;
  const loose = grouped ? shown.filter((m) => !m.provider) : shown;
  // the rows in the order they are drawn: Enter picks the first of them
  const first = loose[0] ?? (grouped ? groups[0]?.items[0] : undefined);
  const row = (m: ModelChoice) => (
    <ChipMenuRadio key={m.id} checked={m.id === selectedId} onSelect={() => onPick(m)}>
      {grouped && m.name ? m.name : m.label}
    </ChipMenuRadio>
  );
  return (
    <>
      {searchable && (
        <input
          type="search"
          data-menu-nav
          data-agent-model-search
          aria-label="Search models"
          placeholder="Search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && first) {
              e.preventDefault();
              onPick(first);
            }
          }}
          className="mb-1 block w-full rounded-md border border-[var(--line-subtle)] bg-transparent px-2 py-1 text-[12.5px] outline-none"
        />
      )}
      {loose.map(row)}
      {grouped &&
        groups.map((g) => (
          <div key={g.provider} role="group" aria-label={g.provider} data-agent-model-group>
            <div aria-hidden="true" className="px-2 pt-1.5 text-[10.5px] text-text-muted">
              {g.provider}
            </div>
            {g.items.map(row)}
          </div>
        ))}
      {shown.length === 0 && (
        <div className="px-2 py-1.5 text-[12px] text-text-muted">No models match.</div>
      )}
    </>
  );
}
