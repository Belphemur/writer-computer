import { useRef } from "react";
import { useRovingTablist } from "@/hooks/use-roving-tablist";
import type { NavGroup } from "./settings-sections";

export const settingsTabId = (id: string) => `settings-tab-${id}`;
export const SETTINGS_PANEL_ID = "settings-tabpanel";

/**
 * The sidebar: a single vertical tablist (roving tabindex). Arrow keys move and select,
 * Home/End jump. Group titles are presentational. Below `md` it becomes a horizontal strip.
 * `footer` (e.g. "Browse plugins") renders after the last group as a plain button.
 */
export function SettingsNav({
  groups,
  selectedId,
  onSelect,
  onIntent,
  footer,
}: {
  groups: readonly NavGroup[];
  selectedId: string;
  onSelect: (id: string) => void;
  /** Hover or focus on an item: the panel preloads that page. */
  onIntent?: (id: string) => void;
  footer?: { label: string; onClick: () => void };
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const ids = groups.flatMap((g) => g.items.map((i) => i.id));

  const onKeyDown = useRovingTablist(listRef, { ids, selectedId, onSelect });

  return (
    <nav
      aria-label="Settings"
      data-settings-nav
      className="shrink-0 overflow-x-auto border-b border-[var(--line-subtler)] px-3 pt-24 pb-2 md:w-56 md:overflow-y-auto md:border-r md:border-b-0 md:px-4 md:pt-[9rem] md:pb-8"
    >
      <div
        ref={listRef}
        role="tablist"
        aria-orientation="vertical"
        aria-label="Settings sections"
        onKeyDown={onKeyDown}
        className="flex gap-1 md:flex-col"
      >
        {groups.map((g) => (
          <div
            key={g.group}
            role="presentation"
            data-nav-group={g.isFeatureGroup ? "features" : undefined}
            className={`flex gap-1 md:mt-5 md:flex-col md:first:mt-0 ${g.isFeatureGroup ? "md:border-t md:border-[var(--line-subtler)] md:pt-4" : ""}`}
          >
            <div
              role="presentation"
              className="hidden px-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)] md:block"
            >
              {g.group}
            </div>
            {g.items.map((item) => {
              const selected = item.id === selectedId;
              return (
                <button
                  key={item.id}
                  id={settingsTabId(item.id)}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  aria-controls={SETTINGS_PANEL_ID}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => onSelect(item.id)}
                  onPointerEnter={() => onIntent?.(item.id)}
                  onFocus={() => onIntent?.(item.id)}
                  className="shrink-0 truncate rounded-lg px-2.5 py-1.5 text-left text-[13px] text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-subtle-strong)] hover:text-[var(--text-primary)] aria-selected:bg-[var(--surface-card)] aria-selected:text-[var(--text-primary)]"
                >
                  {item.label}
                  {item.badge ? (
                    <span
                      data-nav-badge
                      aria-label={`${item.badge} update${item.badge === 1 ? "" : "s"} available`}
                      className="ml-2 rounded-full bg-[var(--accent)] px-1.5 text-[11px] text-white"
                    >
                      {item.badge}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        ))}
      </div>
      {footer && (
        <button
          type="button"
          onClick={footer.onClick}
          className="mt-1 shrink-0 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-subtle-strong)] hover:text-[var(--text-primary)] md:mt-2"
        >
          {footer.label}
        </button>
      )}
    </nav>
  );
}
