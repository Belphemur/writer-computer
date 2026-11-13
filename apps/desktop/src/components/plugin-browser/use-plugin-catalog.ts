import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
} from "react";
import { useStore } from "zustand";
import {
  pluginCatalogStore,
  selectVisibleEntries,
  type PluginCatalogState,
  type PluginCatalogStore,
} from "@/stores/plugin-store-catalog";

export type {
  CatalogFilter,
  PluginAction,
  PluginCatalogStore,
  SortKey,
} from "@/stores/plugin-store-catalog";

const StoreContext = createContext<PluginCatalogStore>(pluginCatalogStore);

/** Optional: scope a different store (e.g. one built on a fake client) to a subtree. */
export function PluginCatalogProvider({
  store,
  children,
}: {
  store: PluginCatalogStore;
  children: ReactNode;
}) {
  return createElement(StoreContext.Provider, { value: store }, children);
}

function useCatalog<T>(selector: (s: PluginCatalogState) => T): T {
  return useStore(useContext(StoreContext), selector);
}

export const useCatalogActions = () => {
  const store = useContext(StoreContext);
  return store.getState();
};

/** Loads the catalog once when the browser mounts. */
export function useLoadCatalogOnMount() {
  const store = useContext(StoreContext);
  useEffect(() => {
    void store.getState().load();
  }, [store]);
}

export const useListStatus = () => useCatalog((s) => s.listStatus);
export const useListError = () => useCatalog((s) => s.listError);
export const useSearch = () => useCatalog((s) => s.search);
export const useSort = () => useCatalog((s) => s.sort);
export const useFilter = () => useCatalog((s) => s.filter);
export const useSelectedId = () => useCatalog((s) => s.selectedId);
export const useTrusted = () => useCatalog((s) => s.trusted);
export const useDetail = () => useCatalog((s) => s.detail);
export const useDetailStatus = () => useCatalog((s) => s.detailStatus);
export const useDetailError = () => useCatalog((s) => s.detailError);
export const useBusy = () => useCatalog((s) => s.busy);
export const useActionError = () => useCatalog((s) => s.actionError);
export const useEnabledIds = () => useCatalog((s) => s.enabledIds);
export const useInstalledVersions = () => useCatalog((s) => s.installedVersions);

export function useVisibleEntries() {
  const entries = useCatalog((s) => s.entries);
  const search = useSearch();
  const sort = useSort();
  const filter = useFilter();
  const installedVersions = useInstalledVersions();
  const updatable = useCatalog((s) => s.updatable);
  return useMemo(
    () => selectVisibleEntries({ entries, search, sort, filter, installedVersions, updatable }),
    [entries, search, sort, filter, installedVersions, updatable],
  );
}
