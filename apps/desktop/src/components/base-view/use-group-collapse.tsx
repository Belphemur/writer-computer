import { createContext, useCallback, useContext, useMemo, useState } from "react";

type Collapsed = ReadonlySet<string>;
interface Store {
  /** Collapsed group keys per view name. */
  byView: ReadonlyMap<string, Collapsed>;
  toggle: (view: string, key: string) => void;
}

const EMPTY: Collapsed = new Set();
const GroupCollapseContext = createContext<Store | null>(null);

function toggled(set: Collapsed | undefined, key: string): Collapsed {
  const next = new Set(set ?? EMPTY);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

/**
 * Keeps which groups are collapsed per view for as long as the tab (or embed) is mounted: the
 * `base` tab is kept alive, so the state survives switching tabs and view tabs, but not an app
 * restart (it is never written to the `.base`, which is shared with other apps).
 */
export function GroupCollapseProvider({ children }: { children: React.ReactNode }) {
  const [byView, setByView] = useState<ReadonlyMap<string, Collapsed>>(new Map());
  const toggle = useCallback(
    (view: string, key: string) =>
      setByView((m) => new Map(m).set(view, toggled(m.get(view), key))),
    [],
  );
  const value = useMemo(() => ({ byView, toggle }), [byView, toggle]);
  return <GroupCollapseContext.Provider value={value}>{children}</GroupCollapseContext.Provider>;
}

/**
 * Collapsed group keys of `viewName` and the toggle. Inside a `GroupCollapseProvider` the state
 * is shared; a view rendered on its own keeps it locally.
 */
export function useGroupCollapse(viewName: string) {
  const store = useContext(GroupCollapseContext);
  const [local, setLocal] = useState<Collapsed>(EMPTY);
  const localToggle = useCallback((key: string) => setLocal((s) => toggled(s, key)), []);
  const providerToggle = store?.toggle;
  const toggle = useCallback(
    (key: string) => (providerToggle ? providerToggle(viewName, key) : localToggle(key)),
    [providerToggle, viewName, localToggle],
  );
  const collapsed = store ? (store.byView.get(viewName) ?? EMPTY) : local;
  return { collapsed, toggle };
}
