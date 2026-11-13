import { createStore, type StoreApi } from "zustand/vanilla";
import {
  defaultStoreClient,
  errorMessage,
  type PluginStoreClient,
  type StoreDetail,
  type StoreEntry,
  type StorePluginsState,
} from "@/lib/obsidian-host/store-client";

export type SortKey = "downloads" | "updated" | "name";
export type CatalogFilter = "all" | "installed" | "updatable";
export type LoadStatus = "idle" | "loading" | "ready" | "error";
export type PluginAction = "installing" | "updating" | "uninstalling" | "enabling" | "disabling";

export interface CatalogState {
  entries: StoreEntry[];
  listStatus: LoadStatus;
  listError: string | null;
  search: string;
  sort: SortKey;
  filter: CatalogFilter;
  selectedId: string | null;
  detail: StoreDetail | null;
  detailStatus: LoadStatus;
  detailError: string | null;
  trusted: boolean;
  installedVersions: Record<string, string>;
  enabledIds: string[];
  /** Update flags learned from detail fetches (the list alone cannot tell). */
  updatable: Record<string, boolean>;
  /** In-flight action per plugin; at most one at a time. */
  busy: Record<string, PluginAction>;
  actionError: Record<string, string>;
}

export interface CatalogActions {
  load: (refresh?: boolean) => Promise<void>;
  setSearch: (text: string) => void;
  setSort: (sort: SortKey) => void;
  setFilter: (filter: CatalogFilter) => void;
  select: (id: string | null) => Promise<void>;
  install: (id: string) => Promise<boolean>;
  uninstall: (id: string) => Promise<boolean>;
  setEnabled: (id: string, enabled: boolean) => Promise<boolean>;
  /** Re-read trust/installed/enabled from the backend (e.g. after the trust dialog). */
  refreshState: () => Promise<void>;
  clearActionError: (id: string) => void;
}

export type PluginCatalogState = CatalogState & CatalogActions;
export type PluginCatalogStore = StoreApi<PluginCatalogState>;

const INITIAL: CatalogState = {
  entries: [],
  listStatus: "idle",
  listError: null,
  search: "",
  sort: "downloads",
  filter: "all",
  selectedId: null,
  detail: null,
  detailStatus: "idle",
  detailError: null,
  trusted: false,
  installedVersions: {},
  enabledIds: [],
  updatable: {},
  busy: {},
  actionError: {},
};

function versionsOf(s: StorePluginsState): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of s.installed) out[p.id] = String(p.manifest?.version ?? "");
  return out;
}

const compare: Record<SortKey, (a: StoreEntry, b: StoreEntry) => number> = {
  downloads: (a, b) => b.downloads - a.downloads,
  updated: (a, b) => b.updated - a.updated,
  name: (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
};

/** Search + filter + sort. Pure so the view layer and tests share one definition. */
export function selectVisibleEntries(
  s: Pick<
    CatalogState,
    "entries" | "search" | "sort" | "filter" | "installedVersions" | "updatable"
  >,
): StoreEntry[] {
  const q = s.search.trim().toLowerCase();
  const rows = s.entries.filter((e) => {
    if (s.filter === "installed" && !(e.id in s.installedVersions)) return false;
    if (s.filter === "updatable" && !(e.id in s.installedVersions && s.updatable[e.id])) {
      return false;
    }
    if (!q) return true;
    return [e.name, e.author, e.description, e.id].some((f) => f.toLowerCase().includes(q));
  });
  // Stable tie-break on name so equal downloads do not shuffle.
  return rows.sort((a, b) => compare[s.sort](a, b) || compare.name(a, b));
}

export function createPluginCatalogStore(
  client: PluginStoreClient = defaultStoreClient,
): PluginCatalogStore {
  // Request sequencing: only the newest response of each kind may write.
  let listSeq = 0;
  let detailSeq = 0;
  let stateSeq = 0;

  return createStore<PluginCatalogState>()((set, get) => {
    const patchBusy = (id: string, action: PluginAction | null, error?: string | null) =>
      set((s) => {
        const busy = { ...s.busy };
        if (action) busy[id] = action;
        else delete busy[id];
        const actionError = { ...s.actionError };
        if (error) actionError[id] = error;
        else if (error === null) delete actionError[id];
        return { busy, actionError };
      });

    const refreshState = async () => {
      const seq = ++stateSeq;
      try {
        const st = await client.state();
        if (seq !== stateSeq) return;
        set({
          trusted: st.trusted,
          enabledIds: st.enabled,
          installedVersions: versionsOf(st),
        });
      } catch (e) {
        if (seq !== stateSeq) return;
        set({ listError: errorMessage(e) });
      }
    };

    // Detail fetch for `id`. Selected plugins fill the detail pane; the rest only feed the
    // update flag used by the "updatable" filter.
    const fetchDetail = async (id: string): Promise<void> => {
      const selected = get().selectedId === id;
      const seq = selected ? ++detailSeq : detailSeq;
      if (selected) set({ detailStatus: "loading", detailError: null });
      try {
        const d = await client.detail(id);
        set((s) => ({ updatable: { ...s.updatable, [id]: d.update } }));
        if (selected && seq === detailSeq && get().selectedId === id) {
          set({ detail: d, detailStatus: "ready" });
        }
      } catch (e) {
        if (selected && seq === detailSeq && get().selectedId === id) {
          set({ detail: null, detailStatus: "error", detailError: errorMessage(e) });
        }
      }
    };

    const runAction = async (
      id: string,
      action: PluginAction,
      work: () => Promise<void>,
    ): Promise<boolean> => {
      if (get().busy[id]) return false;
      patchBusy(id, action, null);
      try {
        await work();
      } catch (e) {
        patchBusy(id, null, errorMessage(e));
        // The backend may have partially changed; resync without hiding the error.
        await refreshState();
        return false;
      }
      await refreshState();
      await fetchDetail(id);
      patchBusy(id, null);
      return true;
    };

    return {
      ...INITIAL,

      load: async (refresh = false) => {
        const seq = ++listSeq;
        set({ listStatus: "loading", listError: null });
        try {
          const [entries, st] = await Promise.all([client.list(refresh), client.state()]);
          if (seq !== listSeq) return;
          set({
            entries,
            listStatus: "ready",
            trusted: st.trusted,
            enabledIds: st.enabled,
            installedVersions: versionsOf(st),
          });
          // Learn update flags for installed plugins that are in the catalog.
          const known = new Set(entries.map((e) => e.id));
          for (const p of st.installed) {
            if (known.has(p.id) && p.id !== get().selectedId) void fetchDetail(p.id);
          }
        } catch (e) {
          if (seq !== listSeq) return;
          set({ listStatus: "error", listError: errorMessage(e) });
        }
      },

      setSearch: (search) => {
        if (get().search !== search) set({ search });
      },
      setSort: (sort) => {
        if (get().sort !== sort) set({ sort });
      },
      setFilter: (filter) => {
        if (get().filter !== filter) set({ filter });
      },

      select: async (id) => {
        if (id === get().selectedId) return;
        detailSeq++;
        set({ selectedId: id, detail: null, detailStatus: "idle", detailError: null });
        if (id) await fetchDetail(id);
      },

      install: (id) =>
        runAction(id, get().installedVersions[id] !== undefined ? "updating" : "installing", () =>
          client.install(id).then(() => undefined),
        ),
      uninstall: (id) => runAction(id, "uninstalling", () => client.uninstall(id)),
      setEnabled: (id, enabled) =>
        runAction(id, enabled ? "enabling" : "disabling", () => client.setEnabled(id, enabled)),

      refreshState,
      clearActionError: (id) => {
        if (id in get().actionError) patchBusy(id, get().busy[id] ?? null, null);
      },
    };
  });
}

/** App-wide instance backed by the real client. */
export const pluginCatalogStore: PluginCatalogStore = createPluginCatalogStore();
