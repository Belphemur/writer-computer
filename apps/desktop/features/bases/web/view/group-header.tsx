import { EnumValueIcon } from "@/components/icon-picker/enum-value-icon";
import type { HeaderItem } from "../lib/collections";
import { canonicalPropertyKey } from "../lib/cells";

/** Collapsible group header of the cards and list views (the table renders its own). */
export function GroupHeader({
  item,
  groupProperty,
  onToggle,
}: {
  item: HeaderItem;
  /** The property the view groups by (`groupBy.property`): an enum's value icon shows before the label. */
  groupProperty?: string;
  onToggle: (key: string) => void;
}) {
  return (
    <div data-group-header className="flex h-full items-center bg-[var(--surface-subtle)] px-3">
      <button
        type="button"
        aria-label={`${item.collapsed ? "Expand" : "Collapse"} group ${item.label}`}
        aria-expanded={!item.collapsed}
        onClick={() => onToggle(item.key)}
        className="flex cursor-pointer items-center gap-2 bg-transparent text-[13px] font-medium text-text-primary"
      >
        <span aria-hidden="true" className="w-3 text-text-muted">
          {item.collapsed ? "▸" : "▾"}
        </span>
        {groupProperty ? (
          <EnumValueIcon property={canonicalPropertyKey(groupProperty)} value={item.label} />
        ) : null}
        <span>{item.label}</span>
        <span data-group-count className="text-[11px] font-normal text-text-muted">
          {item.count}
        </span>
      </button>
    </div>
  );
}
