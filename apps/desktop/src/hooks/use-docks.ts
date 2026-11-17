import { useSyncExternalStore } from "react";
import { closeDocks, openDock, subscribeDocks } from "@/lib/features/docks";

/** Id of the open dock, or null. A primitive, so the snapshot is stable between changes. */
export function useOpenDockId(): string | null {
  return useSyncExternalStore(subscribeDocks, () => openDock()?.id ?? null);
}

/** Width the open dock reserves; 0 when none is open. */
export function useDockWidth(): number {
  return useSyncExternalStore(subscribeDocks, () => openDock()?.width() ?? 0);
}

export { closeDocks };
