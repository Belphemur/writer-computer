import { PluginDetail } from "./plugin-detail";
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
  if (status !== "ready" && entries.length === 0) {
    return (
      <p role="status" className="p-3 text-[13px] text-[var(--text-muted)]">
        Loading plugins…
      </p>
    );
  }
  if (entries.length === 0) {
    return <p className="p-3 text-[13px] text-[var(--text-muted)]">No plugins match.</p>;
  }
  return (
    <ul aria-label="Community plugins" className="flex flex-col">
      {entries.map((e) => (
        <li key={e.id} className="border-t border-[var(--line-subtler)] first:border-t-0">
          <button
            aria-current={selectedId === e.id}
            className={`flex w-full flex-col gap-0.5 px-3 py-2 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 ${
              selectedId === e.id ? "bg-[var(--surface-hover,transparent)]" : ""
            }`}
            onClick={() => void actions.select(e.id)}
          >
            <span className="flex items-baseline justify-between gap-2 text-[13px] text-[var(--text-primary)]">
              <span className="font-medium">
                {e.name}
                {e.id in installed && (
                  <span className="ml-2 text-[11px] text-[var(--text-muted)]">
                    {enabled.includes(e.id) ? "Enabled" : "Installed"}
                  </span>
                )}
              </span>
              <span className="shrink-0 text-[11px] text-[var(--text-muted)]">
                {e.downloads.toLocaleString()} downloads
                {e.updated ? ` · ${formatDate(e.updated)}` : ""}
              </span>
            </span>
            <span className="text-[11px] text-[var(--text-muted)]">{e.author}</span>
            <span className="line-clamp-2 text-[12px] text-[var(--text-muted)]">
              {e.description}
            </span>
          </button>
        </li>
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
