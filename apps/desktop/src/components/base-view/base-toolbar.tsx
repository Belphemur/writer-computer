import { useRef } from "react";

interface Props {
  /** View names of the base; none for a base without views. */
  viewNames: readonly string[];
  /** The selected view (may name a view that no longer exists: no tab is then selected). */
  selected: string | undefined;
  onSelect: (name: string) => void;
  /** Rows shown and rows that matched before `limit`; `null` while there is no result. */
  counts: { shown: number; matched: number } | null;
  querying: boolean;
  /** The config menus (view, results, sort, ...), shown before the count. */
  menus?: React.ReactNode;
  /** Open the `.base` in the plain text editor. */
  onEditYaml: () => void;
}

export function resultsLabel(counts: { shown: number; matched: number }): string {
  const noun = (n: number) => `${n} ${n === 1 ? "result" : "results"}`;
  return counts.matched > counts.shown
    ? `${noun(counts.shown)} of ${counts.matched}`
    : noun(counts.shown);
}

/** View tabs on the left, the result count and a refresh indicator on the right. */
export function BaseToolbar({
  viewNames,
  selected,
  onSelect,
  counts,
  querying,
  menus,
  onEditYaml,
}: Props) {
  const tabsRef = useRef<HTMLDivElement>(null);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft" && e.key !== "Home" && e.key !== "End")
      return;
    const index = selected === undefined ? 0 : Math.max(0, viewNames.indexOf(selected));
    let next = index;
    if (e.key === "ArrowRight") next = (index + 1) % viewNames.length;
    else if (e.key === "ArrowLeft") next = (index - 1 + viewNames.length) % viewNames.length;
    else if (e.key === "Home") next = 0;
    else next = viewNames.length - 1;
    e.preventDefault();
    onSelect(viewNames[next]!);
    tabsRef.current?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
  };

  return (
    <div
      data-base-toolbar
      className="flex min-w-0 items-center gap-3 border-b border-[var(--line-subtler)] px-3"
      style={{ height: 36 }}
    >
      <div
        ref={tabsRef}
        role="tablist"
        aria-label="Views"
        onKeyDown={onKeyDown}
        className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto"
      >
        {viewNames.map((name) => {
          const isSelected = name === selected;
          return (
            <button
              key={name}
              type="button"
              role="tab"
              aria-selected={isSelected}
              tabIndex={isSelected || (selected === undefined && name === viewNames[0]) ? 0 : -1}
              onClick={() => onSelect(name)}
              className={`shrink-0 cursor-pointer rounded-md px-2.5 py-1 text-[12px] ${
                isSelected
                  ? "bg-[var(--tab-active-bg)] text-text-primary"
                  : "bg-transparent text-text-muted hover:text-text-primary"
              }`}
            >
              {name}
            </button>
          );
        })}
      </div>
      {menus}
      <button
        type="button"
        data-edit-yaml
        title="Open the .base file as text"
        onClick={onEditYaml}
        className="shrink-0 cursor-pointer rounded-md bg-transparent px-2 py-1 text-[12px] text-text-muted hover:bg-[var(--item-hover-bg)] hover:text-text-primary"
      >
        Edit YAML
      </button>
      <div className="flex shrink-0 items-center gap-2 text-[12px] text-text-muted">
        {querying ? (
          <span data-base-refreshing role="status" aria-label="Refreshing">
            Refreshing
          </span>
        ) : null}
        {counts ? <span data-base-count>{resultsLabel(counts)}</span> : null}
      </div>
    </div>
  );
}
