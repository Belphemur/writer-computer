// The Filters section (spec 3.3): search query, node kinds, orphans and folder include/exclude
// lists (the edge kinds are in Display). Every change goes through the config store's one write path.
import type { GraphFilters, SurfaceId } from "./config";
import { Check } from "./panel-controls";
import { FIELD } from "./panel-style";
import { useGraphConfig } from "./store";

const INPUT = `${FIELD} w-full`;

const lines = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim().replace(/\/+$/, ""))
    .filter(Boolean);

export function FiltersPanel({ surface, filters }: { surface: SurfaceId; filters: GraphFilters }) {
  const update = useGraphConfig((s) => s.update);
  const set = (patch: Partial<GraphFilters>) =>
    update(surface, (s) => ({ ...s, filters: { ...s.filters, ...patch } }));
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
      <div className="mt-1 text-[11px] font-medium text-[var(--text-muted)]">Folders</div>
      <textarea
        aria-label="Include folders"
        className={`${INPUT} h-14 py-1`}
        placeholder="Include, one per line"
        defaultValue={filters.includeFolders.join("\n")}
        onBlur={(e) => set({ includeFolders: lines(e.target.value) })}
      />
      <textarea
        aria-label="Exclude folders"
        className={`${INPUT} h-14 py-1`}
        placeholder="Exclude, one per line"
        defaultValue={filters.excludeFolders.join("\n")}
        onBlur={(e) => set({ excludeFolders: lines(e.target.value) })}
      />
    </div>
  );
}
