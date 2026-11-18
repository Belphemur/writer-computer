// The one side panel of the graph tab (nothing floats over the canvas): Filters, Display and Clusters
// (the legend: colour, name and count of each cluster, largest first). Every change goes through
// the config store's one write path.
import type { ReactNode } from "react";
import { MAX_DEPTH, type Depth, type GraphFilters, type SurfaceConfig } from "./config";
import { FiltersPanel } from "./filters-panel";
import type { GroupsResult } from "./groups";
import { GroupsPanel } from "./groups-panel";
import { LABEL_MODES, type LabelMode } from "./lod";
import { useGraphConfig } from "./store";
import { Check } from "./panel-controls";
import { FIELD } from "./panel-style";

const LABEL_NAMES: Record<LabelMode, string> = {
  hover: "On hover",
  zoom: "By zoom",
  always: "Always",
};

function Section({
  title,
  open,
  children,
}: {
  title: string;
  open?: boolean;
  children: ReactNode;
}) {
  return (
    <details open={open} className="border-b border-[var(--line-subtle)] py-1" data-section={title}>
      <summary className="cursor-pointer select-none px-3 py-1 text-[12px] font-medium text-[var(--text-primary)]">
        {title}
      </summary>
      {children}
    </details>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex items-center justify-between gap-2 py-0.5 text-[12px] text-[var(--text-secondary)]">
      {label}
      {children}
    </label>
  );
}

export interface DepthControl {
  value: Depth;
  onChange: (depth: Depth) => void;
}

/** The clusters of the current groups as the legend lists them: largest first, then by name. */
export const legendClusters = (groups: GroupsResult["groups"]) =>
  [...groups].sort((a, b) => b.size - a.size || a.key.localeCompare(b.key));

function DisplaySection({
  config,
  labels,
  depth,
}: {
  config: SurfaceConfig;
  labels: readonly string[];
  depth: DepthControl | null;
}) {
  const update = useGraphConfig((s) => s.update);
  const d = config.display;
  const f = config.filters;
  const setDisplay = (patch: Partial<SurfaceConfig["display"]>) =>
    update((s) => ({ ...s, display: { ...s.display, ...patch } }));
  const setFilters = (patch: Partial<GraphFilters>) =>
    update((s) => ({ ...s, filters: { ...s.filters, ...patch } }));
  return (
    <div className="flex flex-col px-3 pb-2" data-testid="graph-display">
      <Row label="Labels">
        <select
          className={`${FIELD} w-28 flex-none`}
          value={d.labels}
          onChange={(e) => setDisplay({ labels: e.target.value as LabelMode })}
        >
          {LABEL_MODES.map((m) => (
            <option key={m} value={m}>
              {LABEL_NAMES[m]}
            </option>
          ))}
        </select>
      </Row>
      <Row label="Cluster by">
        <select
          className={`${FIELD} w-28 flex-none`}
          value={d.clusterBy}
          onChange={(e) => setDisplay({ clusterBy: e.target.value as "communities" | "folder" })}
        >
          <option value="communities">Communities</option>
          <option value="folder">Folder</option>
        </select>
      </Row>
      {depth && (
        <Row label={`Depth ${depth.value}`}>
          <input
            type="range"
            aria-label="Depth"
            min={1}
            max={MAX_DEPTH}
            step={1}
            value={depth.value}
            onChange={(e) => depth.onChange(Number(e.target.value) as Depth)}
          />
        </Row>
      )}
      <Check label="Links" checked={f.links} onChange={(v) => setFilters({ links: v })} />
      <Check label="Embeds" checked={f.embeds} onChange={(v) => setFilters({ embeds: v })} />
      <Check
        label="Properties"
        checked={f.properties}
        onChange={(v) => setFilters({ properties: v })}
      />
      {f.properties && labels.length > 0 && (
        <div className="ml-5 flex max-h-32 flex-col overflow-auto">
          {labels.map((label) => (
            <Check
              key={label}
              label={label}
              checked={!f.hiddenLabels.includes(label)}
              onChange={(on) =>
                setFilters({
                  hiddenLabels: on
                    ? f.hiddenLabels.filter((l) => l !== label)
                    : [...f.hiddenLabels, label],
                })
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ClustersSection({
  config,
  groups,
}: {
  config: SurfaceConfig;
  groups: GroupsResult["groups"];
}) {
  return (
    <div className="px-3 pb-2" data-testid="graph-clusters">
      {groups.length === 0 ? (
        <p className="py-1 text-[12px] text-[var(--text-muted)]">No clusters</p>
      ) : (
        <ul className="m-0 max-h-48 list-none space-y-0.5 overflow-y-auto p-0">
          {legendClusters(groups).map((g) => (
            <li key={g.key} className="flex items-center gap-2 text-[12px]">
              <span
                aria-hidden="true"
                className="inline-block h-2 w-2 shrink-0 rounded-full"
                style={{ background: g.color }}
              />
              <span
                className="min-w-0 flex-1 truncate text-[var(--text-secondary)]"
                title={g.subtitle}
              >
                {g.key}
              </span>
              <span className="text-[var(--text-muted)]">{g.size}</span>
            </li>
          ))}
        </ul>
      )}
      <details className="mt-1">
        <summary className="cursor-pointer select-none py-1 text-[12px] text-[var(--text-muted)]">
          Group by and colors
        </summary>
        <GroupsPanel rules={config.rules} groupBy={config.groupBy} />
      </details>
    </div>
  );
}

export function SidePanel({
  config,
  labels,
  groups,
  depth,
}: {
  config: SurfaceConfig;
  /** Property labels of the slice (for the colour of their edges and the Properties list). */
  labels: readonly string[];
  groups: GroupsResult["groups"];
  /** The depth slider of a local graph; null for the whole vault. */
  depth: DepthControl | null;
}) {
  return (
    <div className="h-full overflow-y-auto" data-testid="graph-side-panel">
      <Section title="Display" open>
        <DisplaySection config={config} labels={labels} depth={depth} />
      </Section>
      <Section title="Clusters" open>
        <ClustersSection config={config} groups={groups} />
      </Section>
      <Section title="Filters">
        <FiltersPanel filters={config.filters} />
      </Section>
    </div>
  );
}
