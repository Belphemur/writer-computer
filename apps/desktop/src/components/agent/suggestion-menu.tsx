export type Suggestion = { id: string; label: string; detail?: string; icon?: string };

/** Listbox popover above the composer for `@` mentions and `/` commands. The textarea keeps
 *  focus and drives `activeIndex` (combobox pattern), so typing never leaves the composer. */
export function SuggestionMenu({
  id,
  label,
  items,
  activeIndex,
  onPick,
}: {
  id: string;
  label: string;
  items: readonly Suggestion[];
  activeIndex: number;
  onPick: (item: Suggestion) => void;
}) {
  return (
    <div
      id={id}
      role="listbox"
      aria-label={label}
      className="absolute inset-x-0 bottom-full z-30 mb-1 max-h-56 overflow-y-auto rounded-lg border border-[var(--line-subtle)] bg-[var(--surface-primary)] p-1 shadow-lg"
    >
      {items.length === 0 ? (
        <p className="px-2 py-1.5 text-[12.5px] text-text-muted">No matches</p>
      ) : (
        items.map((item, i) => (
          <div
            key={item.id}
            id={`${id}-${i}`}
            role="option"
            aria-selected={i === activeIndex}
            onMouseDown={(e) => {
              e.preventDefault(); // keep focus in the textarea
              onPick(item);
            }}
            className="flex cursor-pointer items-baseline gap-2 rounded-md px-2 py-1.5 text-[12.5px] aria-selected:bg-[var(--item-active-bg)]"
          >
            <span className="shrink-0 text-text-icon-muted">{item.icon}</span>
            <span className="truncate text-text-primary">{item.label}</span>
            {item.detail && <span className="min-w-0 truncate text-text-muted">{item.detail}</span>}
          </div>
        ))
      )}
    </div>
  );
}
