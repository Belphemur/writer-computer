import type { CSSProperties, Ref } from "react";

export type Suggestion = {
  id: string;
  label: string;
  detail?: string;
  /** Tooltip for the row (the complete path of a note). */
  title?: string;
  icon?: string;
  /** Muted tag at the right (a skill's source). */
  tag?: string;
  /** Status after the tag, e.g. `loaded`; shown with a check mark and read out as text. */
  status?: string;
};

/** Listbox popover above the composer for `@` mentions and `/` commands. The textarea keeps
 *  focus and drives `activeIndex` (combobox pattern), so typing never leaves the composer. */
export function SuggestionMenu({
  id,
  label,
  items,
  activeIndex,
  onPick,
  emptyText = "No matches",
  hint,
  menuRef,
  style,
}: {
  id: string;
  label: string;
  items: readonly Suggestion[];
  activeIndex: number;
  onPick: (item: Suggestion) => void;
  /** Shown when `items` is empty. */
  emptyText?: string;
  /** A subtle line under the rows (not an option). */
  hint?: string;
  menuRef?: Ref<HTMLDivElement>;
  /** Placement from `usePopoverPlacement` (left, width, max height). */
  style?: CSSProperties;
}) {
  return (
    <div
      id={id}
      ref={menuRef}
      role="listbox"
      aria-label={label}
      style={style}
      className="absolute bottom-full z-30 mb-1 max-h-56 overflow-y-auto rounded-lg border border-[var(--line-subtle)] bg-[var(--surface-primary)] p-1 shadow-lg"
    >
      {items.length === 0 ? (
        <p className="px-2 py-1.5 text-[12.5px] text-text-muted">{emptyText}</p>
      ) : (
        items.map((item, i) => (
          <div
            key={item.id}
            id={`${id}-${i}`}
            role="option"
            title={item.title}
            aria-selected={i === activeIndex}
            onMouseDown={(e) => {
              e.preventDefault(); // keep focus in the textarea
              onPick(item);
            }}
            className="flex cursor-pointer items-baseline gap-2 rounded-md px-2 py-1.5 text-[12.5px] aria-selected:bg-[var(--item-active-bg)]"
          >
            <span className="shrink-0 text-text-icon-muted">{item.icon}</span>
            <span className="truncate text-text-primary">{item.label}</span>
            {item.detail && (
              <span className="min-w-0 flex-1 truncate text-text-muted">{item.detail}</span>
            )}
            {(item.tag || item.status) && (
              <span
                className="ml-auto shrink-0 text-[11px] text-text-muted"
                data-agent-suggestion-tag
              >
                {item.tag}
                {item.status && (
                  <>
                    {item.tag ? " · " : ""}
                    {item.status === "loaded" ? <span aria-hidden="true">✓ </span> : null}
                    {item.status}
                  </>
                )}
              </span>
            )}
          </div>
        ))
      )}
      {hint && <p className="px-2 pt-1 text-[11px] text-text-muted">{hint}</p>}
    </div>
  );
}
