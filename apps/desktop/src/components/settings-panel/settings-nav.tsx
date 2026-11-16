import { useRef, type KeyboardEvent } from "react";
import type { NavGroup } from "./settings-sections";

export const settingsTabId = (id: string) => `settings-tab-${id}`;
export const SETTINGS_PANEL_ID = "settings-tabpanel";

const NEXT_KEYS = ["ArrowDown", "ArrowRight"];
const PREV_KEYS = ["ArrowUp", "ArrowLeft"];

/**
 * The sidebar: a single vertical tablist (roving tabindex). Arrow keys move and select,
 * Home/End jump. Group titles are presentational. Below `md` it becomes a horizontal strip.
 * `footer` (e.g. "Browse plugins") renders after the last group as a plain button.
 */
export function SettingsNav({
  groups,
  selectedId,
  onSelect,
  footer,
}: {
  groups: readonly NavGroup[];
  selectedId: string;
  onSelect: (id: string) => void;
  footer?: { label: string; onClick: () => void };
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const ids = groups.flatMap((g) => g.items.map((i) => i.id));

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const at = ids.indexOf(selectedId);
    let next = -1;
    if (NEXT_KEYS.includes(e.key)) next = (at + 1) % ids.length;
    else if (PREV_KEYS.includes(e.key)) next = (at - 1 + ids.length) % ids.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = ids.length - 1;
    if (next < 0 || ids.length === 0) return;
    e.preventDefault();
    onSelect(ids[next]);
    listRef.current?.querySelector<HTMLElement>(`[id="${settingsTabId(ids[next])}"]`)?.focus();
  }

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
            className="flex gap-1 md:mt-5 md:flex-col md:first:mt-0"
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
