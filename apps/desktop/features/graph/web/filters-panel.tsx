// The Filters section (spec 3.3): search query, node kinds, orphans and folder include/exclude
// lists (the edge kinds are in Display). Every change goes through the config store's one write path.
import { useMemo } from "react";
import type { GraphFilters } from "./config";
import { detectPresets, toggleEntry, type Excludable } from "./exclude";
import { Check } from "./panel-controls";
import { FIELD } from "./panel-style";
import { useGraphConfig } from "./store";

const INPUT = `${FIELD} w-full`;

const lines = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim().replace(/\/+$/, ""))
    .filter(Boolean);

export function FiltersPanel({
  filters,
  notes,
}: {
  filters: GraphFilters;
  /** The notes of the slice, to offer presets for what generates many of them. */
  notes: readonly Excludable[];
}) {
  const presets = useMemo(() => detectPresets(notes), [notes]);
  const update = useGraphConfig((s) => s.update);
  const set = (patch: Partial<GraphFilters>) =>
    update((s) => ({ ...s, filters: { ...s.filters, ...patch } }));
  return (
    <div className="flex flex-col gap-2 p-3" data-testid="graph-filters">
      <input
        aria-label="Only matching notes"
        className={INPUT}
        value={filters.query}
        placeholder="path:  tag:  [property:value]  words"
        onChange={(e) => set({ query: e.target.value })}
      />
      <Check label="Tags" checked={filters.tags} onChange={(v) => set({ tags: v })} />
      <Check
        label="Attachments"
        checked={filters.attachments}
        onChange={(v) => set({ attachments: v })}
      />
      <Check label="Bases" checked={filters.bases} onChange={(v) => set({ bases: v })} />
      <Check
        label="Missing notes"
        checked={filters.missing}
        onChange={(v) => set({ missing: v })}
      />
      <Check label="Orphans" checked={filters.orphans} onChange={(v) => set({ orphans: v })} />
      <div className="mt-1 text-[11px] font-medium text-[var(--text-muted)]">Include</div>
      <textarea
        aria-label="Include folders"
        className={`${INPUT} h-14 py-1`}
        placeholder="Include, one per line"
        defaultValue={filters.includeFolders.join("\n")}
        onBlur={(e) => set({ includeFolders: lines(e.target.value) })}
      />
      <div className="mt-1 text-[11px] font-medium text-[var(--text-muted)]">Exclude</div>
      {presets.length > 0 && (
        <div className="flex flex-wrap gap-1" data-testid="graph-exclude-presets">
          {presets.map((p) => (
            <button
              key={p.entry}
              type="button"
              aria-pressed={filters.exclude.includes(p.entry)}
              title={p.entry}
              className="rounded-md border border-[var(--line-subtle)] px-1.5 py-0.5 text-[11px] text-[var(--text-secondary)] aria-pressed:bg-[var(--item-active-bg)]"
              onClick={() => set({ exclude: toggleEntry(filters.exclude, p.entry) })}
            >
              {p.label} {p.count}
            </button>
          ))}
        </div>
      )}
      <textarea
        key={filters.exclude.join("\n")}
        aria-label="Exclude"
        className={`${INPUT} h-14 py-1`}
        placeholder="Folder or name*, one per line"
        defaultValue={filters.exclude.join("\n")}
        onBlur={(e) => set({ exclude: lines(e.target.value) })}
      />
    </div>
  );
}
