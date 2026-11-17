import { useEffect, useState } from "react";
import type { OwnedRegistry } from "@/lib/owned-registry";

/** The entries of an owned registry, re-read whenever one is added or removed (a feature turned
 *  on or off). One subscription mechanism for every contribution point a component renders. */
export function useRegistryItems<T extends { owner: string }>(registry: OwnedRegistry<T>): T[] {
  const [items, setItems] = useState(() => registry.list());
  useEffect(() => {
    const sync = () => setItems(registry.list());
    sync();
    return registry.subscribe(sync);
  }, [registry]);
  return items;
}
