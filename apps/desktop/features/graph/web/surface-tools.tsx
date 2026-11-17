// The Filters and Groups buttons of a surface with the panel each opens, shared by the tab and the
// local panel (one component, so the two stay in step).
import { useState } from "react";
import { FiltersPanel } from "./filters-panel";
import { GroupsPanel } from "./groups-panel";
import type { SurfaceConfig, SurfaceId } from "./config";

const BTN =
  "rounded-md px-2 py-1 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--item-hover-bg)] aria-pressed:bg-[var(--item-active-bg)]";

type Open = "filters" | "groups" | null;

export function SurfaceTools({
  surface,
  config,
  labels,
}: {
  surface: SurfaceId;
  config: SurfaceConfig;
  labels: readonly string[];
}) {
  const [open, setOpen] = useState<Open>(null);
  const toggle = (what: Exclude<Open, null>) => setOpen(open === what ? null : what);
  return (
    <>
      <button
        type="button"
        className={BTN}
        aria-pressed={open === "filters"}
        onClick={() => toggle("filters")}
      >
        Filters
      </button>
      <button
        type="button"
        className={BTN}
        aria-pressed={open === "groups"}
        onClick={() => toggle("groups")}
      >
        Groups
      </button>
      {open && (
        <div className="absolute inset-x-2 top-full z-20 mt-1 max-h-[70vh] overflow-auto rounded-lg border border-[var(--line-subtle)] bg-[var(--surface-card)] shadow-lg sm:left-auto sm:w-[300px]">
          {open === "filters" ? (
            <FiltersPanel surface={surface} filters={config.filters} propertyLabels={labels} />
          ) : (
            <GroupsPanel surface={surface} rules={config.rules} groupBy={config.groupBy} />
          )}
        </div>
      )}
    </>
  );
}

export { BTN as TOOL_BUTTON };
