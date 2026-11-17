// The Filters panel (spec 3.3): search query, optional node kinds, edge kinds with one checkbox per
// property label, orphans, and folder include/exclude lists. Every change goes through the config
// store's one write path.
import type { GraphFilters, SurfaceId } from "./config";
import { useGraphConfig } from "./store";

const INPUT =
  "h-7 w-full rounded-md border border-transparent bg-[var(--surface-input)] px-2 text-[12px] text-[var(--text-secondary)] outline-none focus:border-[var(--focus-border)]";

function Check({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 py-0.5 text-[12px] text-[var(--text-secondary)]">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

const lines = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim().replace(/\/+$/, ""))
    .filter(Boolean);

export function FiltersPanel({
  surface,
  filters,
  propertyLabels,
}: {
  surface: SurfaceId;
  filters: GraphFilters;
  propertyLabels: readonly string[];
}) {
  const update = useGraphConfig((s) => s.update);
  const set = (patch: Partial<GraphFilters>) =>
    update(surface, (s) => ({ ...s, filters: { ...s.filters, ...patch } }));
  const toggleLabel = (label: string, on: boolean) =>
    set({
      hiddenLabels: on
        ? filters.hiddenLabels.filter((l) => l !== label)
        : [...filters.hiddenLabels, label],
    });
  return (
    <div className="flex flex-col gap-2 p-3" data-testid="graph-filters">
      <label
        className="text-[11px] font-medium text-[var(--text-muted)]"
        htmlFor={`gf-q-${surface}`}
      >
        Show only matches and their links
      </label>
      <input
        id={`gf-q-${surface}`}
        className={INPUT}
        value={filters.query}
        placeholder="path:  tag:  [property:value]  words"
        onChange={(e) => set({ query: e.target.value })}
      />
      <div className="mt-1 text-[11px] font-medium text-[var(--text-muted)]">Nodes</div>
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
      <div className="mt-1 text-[11px] font-medium text-[var(--text-muted)]">Edges</div>
      <Check label="Links" checked={filters.links} onChange={(v) => set({ links: v })} />
      <Check label="Embeds" checked={filters.embeds} onChange={(v) => set({ embeds: v })} />
      <Check
        label="Properties"
        checked={filters.properties}
        onChange={(v) => set({ properties: v })}
      />
      {filters.properties && propertyLabels.length > 0 && (
        <div className="ml-5 flex flex-col">
          {propertyLabels.map((label) => (
            <Check
              key={label}
              label={label}
              checked={!filters.hiddenLabels.includes(label)}
              onChange={(v) => toggleLabel(label, v)}
            />
          ))}
        </div>
      )}
      <div className="mt-1 text-[11px] font-medium text-[var(--text-muted)]">
        Folders (one per line)
      </div>
      <textarea
        aria-label="Include folders"
        className={`${INPUT} h-14 py-1`}
        placeholder="Include"
        defaultValue={filters.includeFolders.join("\n")}
        onBlur={(e) => set({ includeFolders: lines(e.target.value) })}
      />
      <textarea
        aria-label="Exclude folders"
        className={`${INPUT} h-14 py-1`}
        placeholder="Exclude"
        defaultValue={filters.excludeFolders.join("\n")}
        onBlur={(e) => set({ excludeFolders: lines(e.target.value) })}
      />
    </div>
  );
}
