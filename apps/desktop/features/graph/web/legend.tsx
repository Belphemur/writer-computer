// The legend (spec 2.1): edge kinds, property labels with their colors and the groups. Collapsible.
import { useState } from "react";
import type { GroupsResult } from "./groups";
import { labelColor } from "./theme";

function Swatch({ color, dashed }: { color: string; dashed?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-0 w-4 align-middle"
      style={{ borderTop: `2px ${dashed ? "dashed" : "solid"} ${color}` }}
    />
  );
}

export function Legend({
  propertyLabels,
  groups,
  edgeColor,
}: {
  propertyLabels: readonly string[];
  groups: GroupsResult["groups"];
  edgeColor: string;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div
      className="absolute bottom-2 left-2 max-w-[220px] rounded-lg border border-[var(--line-subtle)] bg-[var(--surface-card)] px-2 py-1 text-[11px] text-[var(--text-secondary)]"
      data-testid="graph-legend"
    >
      <button
        type="button"
        className="font-medium text-[var(--text-muted)]"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        Legend
      </button>
      {open && (
        <ul className="m-0 mt-1 list-none space-y-0.5 p-0">
          <li>
            <Swatch color={edgeColor} /> links
          </li>
          <li>
            <Swatch color={edgeColor} dashed /> embeds
          </li>
          {propertyLabels.map((l) => (
            <li key={l}>
              <Swatch color={labelColor(l, propertyLabels)} /> {l}
            </li>
          ))}
          {groups.slice(0, 12).map((g) => (
            <li key={g.key}>
              <span
                aria-hidden="true"
                className="mr-1 inline-block h-2 w-2 rounded-full align-middle"
                style={{ background: g.color }}
              />
              {g.key} <span className="text-[var(--text-muted)]">{g.size}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
