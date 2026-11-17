import type { ViewChoice } from "../lib/grid";
import { ViewSwitcher } from "./view-switcher";

interface Props {
  /** Views of the base (name and type); none for a base without views. */
  views: readonly ViewChoice[];
  /** The selected view (may name a view that no longer exists: it is then shown but unchecked). */
  selected: string | undefined;
  onSelect: (name: string) => void;
  /** Rows shown and rows that matched before `limit`; `null` while there is no result. */
  counts: { shown: number; matched: number } | null;
  querying: boolean;
  /** The config menus (view, results, sort, ...), shown before the count. */
  menus?: React.ReactNode;
  /** Open the `.base` in the plain text editor; no button when omitted (embeds). */
  onEditYaml?: () => void;
  /** Extra controls after the menus (the embed's open and edit buttons). */
  trailing?: React.ReactNode;
  /** Smaller bar for note embeds. */
  compact?: boolean;
}

export function resultsLabel(counts: { shown: number; matched: number }): string {
  const noun = (n: number) => `${n} ${n === 1 ? "result" : "results"}`;
  return counts.matched > counts.shown
    ? `${noun(counts.shown)} of ${counts.matched}`
    : noun(counts.shown);
}

/** The view dropdown on the left, the result count and a refresh indicator on the right. */
export function BaseToolbar({
  views,
  selected,
  onSelect,
  counts,
  querying,
  menus,
  onEditYaml,
  trailing,
  compact = false,
}: Props) {
  return (
    <div
      data-base-toolbar
      className="flex min-w-0 items-center gap-3 border-b border-[var(--line-subtler)] px-3"
      style={{ height: compact ? 30 : 36 }}
    >
      <div className="flex min-w-0 flex-1 items-center">
        <ViewSwitcher views={views} selected={selected} onSelect={onSelect} />
      </div>
      {menus}
      {onEditYaml ? (
        <button
          type="button"
          data-edit-yaml
          title="Open the .base file as text"
          onClick={onEditYaml}
          className="shrink-0 cursor-pointer rounded-md bg-transparent px-2 py-1 text-[12px] text-text-muted hover:bg-[var(--item-hover-bg)] hover:text-text-primary"
        >
          Edit YAML
        </button>
      ) : null}
      {trailing}
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
