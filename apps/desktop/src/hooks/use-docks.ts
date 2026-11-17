import { useEffect, useRef, useSyncExternalStore } from "react";
import {
  closeDocksOpenedBefore,
  openDock,
  openDockIds,
  subscribeDocks,
} from "@/lib/features/docks";

/** Id of the open dock, or null. A primitive, so the snapshot is stable between changes. */
export function useOpenDockId(): string | null {
  return useSyncExternalStore(subscribeDocks, () => openDock()?.id ?? null);
}

/** Width the open dock reserves; 0 when none is open. */
export function useDockWidth(): number {
  return useSyncExternalStore(subscribeDocks, () => openDock()?.width() ?? 0);
}

/** One right-hand column: whichever dock opened last wins (mount once, in the layout). */
export function useExclusiveDocks(): void {
  const open = useRef<Set<string>>(openDockIds());
  useEffect(
    () =>
      subscribeDocks(() => {
        const now = openDockIds();
        closeDocksOpenedBefore(open.current, now);
        open.current = openDockIds();
      }),
    [],
  );
}
