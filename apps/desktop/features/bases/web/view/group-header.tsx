import type { HeaderItem } from "../lib/collections";

/** Collapsible group header of the cards and list views (the table renders its own). */
export function GroupHeader({
  item,
  onToggle,
}: {
  item: HeaderItem;
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
        <span>{item.label}</span>
        <span data-group-count className="text-[11px] font-normal text-text-muted">
          {item.count}
        </span>
      </button>
    </div>
  );
}
