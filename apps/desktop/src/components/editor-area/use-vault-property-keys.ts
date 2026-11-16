import { useEffect, useState } from "react";
import { indexProperties } from "@/lib/bases/ipc";
import type { VaultProperty } from "@/lib/bases/types";

// The vault's property names for the add-property field. One fetch per session, refreshed at
// most every 30 seconds; a failure (no index yet, no backend) just means no suggestions.
const TTL_MS = 30_000;
let cache: { at: number; promise: Promise<VaultProperty[]> } | null = null;

function fetchKeys(): Promise<VaultProperty[]> {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.promise;
  const promise = indexProperties().catch(() => [] as VaultProperty[]);
  cache = { at: now, promise };
  return promise;
}

/** Suggestions for the add-property field; fetched when the field first mounts. */
export function useVaultPropertyKeys(): VaultProperty[] {
  const [keys, setKeys] = useState<VaultProperty[]>([]);
  useEffect(() => {
    let live = true;
    void fetchKeys().then((found) => live && setKeys(found));
    return () => {
      live = false;
    };
  }, []);
  return keys;
}
