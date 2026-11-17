import { useCallback, type KeyboardEvent } from "react";
import type { StoreEntry } from "../host/store-client";
import { PluginDetail } from "./plugin-detail";
import { nextSelectionId } from "./list-nav";
import { formatDate } from "./format";
import {
  useCatalogActions,
  useEnabledIds,
  useFilter,
  useInstalledVersions,
  useListError,
  useListStatus,
  useLoadCatalogOnMount,
  useSearch,
  useSelectedId,
  useSort,
  useTrusted,
  useVisibleEntries,
  type CatalogFilter,
  type SortKey,
} from "./use-plugin-catalog";

export interface PluginBrowserProps {
  /** Called when the user asks to trust the vault; the host shows its confirmation dialog. */
  onRequestTrust: () => void;
  /** Called after an install, update, uninstall or enable/disable succeeded. */
  onPluginsChanged?: () => void;
  className?: string;
}

const FIELD =
  "rounded-lg border border-[var(--line-subtler)] bg-[var(--surface-card)] px-2 py-1.5 text-[13px] text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-offset-2";

const SORTS: { value: SortKey; label: string }[] = [
  { value: "downloads", label: "Most downloads" },
  { value: "updated", label: "Recently updated" },
  { value: "name", label: "Name" },
];
const FILTERS: { value: CatalogFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "installed", label: "Installed" },
  { value: "updatable", label: "Updates available" },
];

function RestrictedBanner({ onRequestTrust }: { onRequestTrust: () => void }) {
  return (
    <div
      role="status"
      className="flex items-center justify-between gap-3 rounded-xl border border-[var(--line-subtler)] bg-[var(--surface-card)] px-4 py-3 text-[13px]"
    >
      <span className="text-[var(--text-primary)]">
        <strong>Restricted mode.</strong> Plugins stay off until you trust this vault. You can still
        browse and install, but nothing runs.
      </span>
      <button className={`${FIELD} shrink-0`} onClick={onRequestTrust}>
        Trust vault…
      </button>
    </div>
  );
}

function Toolbar() {
  const actions = useCatalogActions();
  const search = useSearch();
  const sort = useSort();
  const filter = useFilter();
  return (
    <div className="flex flex-wrap gap-2">
      <input
        type="search"
        aria-label="Search plugins"
        placeholder="Search plugins"
        className={`${FIELD} min-w-0 flex-1`}
        value={search}
        onChange={(e) => actions.setSearch(e.target.value)}
      />
      <select
        aria-label="Sort plugins"
        className={FIELD}
        value={sort}
        onChange={(e) => actions.setSort(e.target.value as SortKey)}
      >
        {SORTS.map((s) => (
          <option key={s.value} value={s.value}>
            {s.label}
          </option>
        ))}
      </select>
      <select
        aria-label="Filter plugins"
        className={FIELD}
        value={filter}
        onChange={(e) => actions.setFilter(e.target.value as CatalogFilter)}
      >
        {FILTERS.map((f) => (
          <option key={f.value} value={f.value}>
            {f.label}
          </option>
        ))}
      </select>
      <button className={FIELD} onClick={() => void actions.load(true)}>
        Refresh
      </button>
    </div>
  );
}

const ROW_ID_PREFIX = "plugin-row-";

function ListSkeleton() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading community plugins"
      className="flex flex-col"
    >
      <span className="px-3 pt-3 text-[12px] text-[var(--text-muted)]">
        Loading community plugins…
      </span>
      {Array.from({ length: 6 }, (_, i) => (
        <div
          key={i}
          aria-hidden="true"
          className="flex animate-pulse flex-col gap-1.5 border-t border-[var(--line-subtler)] px-3 py-3 first:border-t-0"
        >
          <span className="h-3 w-2/5 rounded bg-[var(--surface-subtle-strong)]" />
          <span className="h-2.5 w-1/4 rounded bg-[var(--surface-subtle)]" />
          <span className="h-2.5 w-4/5 rounded bg-[var(--surface-subtle)]" />
        </div>
      ))}
    </div>
  );
}

function PluginRow({
  entry,
  selected,
  badge,
  onSelect,
}: {
  entry: StoreEntry;
  selected: boolean;
  badge: string | null;
  onSelect: (id: string) => void;
}) {
  // Runs when the row mounts selected (dialog re-open) or becomes selected (keyboard, click).
  const ref = useCallback(
    (el: HTMLLIElement | null) => {
      if (selected) el?.scrollIntoView?.({ block: "nearest" });
    },
    [selected],
  );
  return (
    <li
      ref={ref}
      id={ROW_ID_PREFIX + entry.id}
      role="option"
      aria-selected={selected}
      data-selected={selected || undefined}
      className={`flex cursor-pointer flex-col gap-0.5 border-l-2 border-t border-t-[var(--line-subtler)] px-3 py-2 first:border-t-0 ${
        selected
          ? "border-l-[var(--accent)] bg-[var(--surface-selected)]"
          : "border-l-transparent hover:bg-[var(--item-hover-bg)]"
      }`}
      onClick={() => onSelect(entry.id)}
    >
      <span className="flex items-baseline justify-between gap-2 text-[13px] text-[var(--text-primary)]">
        <span className="font-medium">
          {entry.name}
          {badge && <span className="ml-2 text-[11px] text-[var(--text-muted)]">{badge}</span>}
        </span>
        <span className="shrink-0 text-[11px] text-[var(--text-muted)]">
          {entry.downloads.toLocaleString()} downloads
          {entry.updated ? ` · ${formatDate(entry.updated)}` : ""}
        </span>
      </span>
      <span className="text-[11px] text-[var(--text-muted)]">{entry.author}</span>
      <span className="line-clamp-2 text-[12px] text-[var(--text-muted)]">{entry.description}</span>
    </li>
  );
}

function PluginList() {
  const actions = useCatalogActions();
  const status = useListStatus();
  const error = useListError();
  const entries = useVisibleEntries();
  const selectedId = useSelectedId();
  const installed = useInstalledVersions();
  const enabled = useEnabledIds();

  if (status === "error") {
    return (
      <div role="alert" className="p-3 text-[13px] text-red-500">
        Could not load the plugin list: {error}{" "}
        <button className="underline" onClick={() => void actions.load(true)}>
          Retry
        </button>
      </div>
    );
  }
  // Loading is the status, never "no rows": an unloaded catalog (idle, or the first load) must not
  // read as "No plugins match". A re-open keeps the previously loaded rows while it refreshes.
  if ((status === "idle" || status === "loading") && entries.length === 0) {
    return <ListSkeleton />;
  }
  if (entries.length === 0) {
    return <p className="p-3 text-[13px] text-[var(--text-muted)]">No plugins match.</p>;
  }
  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const ids = entries.map((e) => e.id);
    const next =
      event.key === "Enter" ? (selectedId ?? ids[0]) : nextSelectionId(ids, selectedId, event.key);
    if (!next) return;
    event.preventDefault();
    void actions.select(next);
  };
  return (
    <ul
      role="listbox"
      tabIndex={0}
      aria-label="Community plugins"
      aria-busy={status === "loading"}
      aria-activedescendant={selectedId ? ROW_ID_PREFIX + selectedId : undefined}
      className="flex flex-col focus-visible:outline-2 focus-visible:-outline-offset-2"
      onKeyDown={onKeyDown}
    >
      {entries.map((e) => (
        <PluginRow
          key={e.id}
          entry={e}
          selected={selectedId === e.id}
          badge={e.id in installed ? (enabled.includes(e.id) ? "Enabled" : "Installed") : null}
          onSelect={(id) => void actions.select(id)}
        />
      ))}
    </ul>
  );
}

export function PluginBrowser({ onRequestTrust, onPluginsChanged, className }: PluginBrowserProps) {
  useLoadCatalogOnMount();
  const trusted = useTrusted();
  const status = useListStatus();
  return (
    <section aria-label="Community plugins" className={`flex flex-col gap-3 ${className ?? ""}`}>
      {status === "ready" && !trusted && <RestrictedBanner onRequestTrust={onRequestTrust} />}
      <Toolbar />
      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
        <div className="max-h-[32rem] overflow-y-auto rounded-2xl border border-[var(--line-subtler)] bg-[var(--surface-card)]">
          <PluginList />
        </div>
        <div className="max-h-[32rem] overflow-y-auto rounded-2xl border border-[var(--line-subtler)] bg-[var(--surface-card)]">
          <PluginDetail onPluginsChanged={onPluginsChanged} />
        </div>
      </div>
    </section>
  );
}

export { PluginCatalogProvider } from "./use-plugin-catalog";
