import { useCallback, useEffect, useRef } from "react";
import type { BaseViewEntry, BaseViewProps, MountedView } from "../lib/view-registry";

/**
 * Hosts a DOM view (a plugin's `registerBasesView`): the container is created by React, the view
 * by the entry's `mount`. The view is rebuilt when the entry changes and destroyed on unmount; it
 * is updated when the result, view or document change (not on every render).
 */
export function DomViewHost({ entry, props }: { entry: BaseViewEntry; props: BaseViewProps }) {
  const mounted = useRef<MountedView | null>(null);
  const latest = useRef(props);
  latest.current = props;

  const ref = useCallback(
    (node: HTMLDivElement | null) => {
      mounted.current?.destroy();
      mounted.current = null;
      if (node && entry.mount) mounted.current = entry.mount(node, latest.current);
    },
    [entry],
  );

  const { result, view, document, shown } = props;
  useEffect(() => {
    mounted.current?.update(latest.current);
  }, [result, view, document, shown]);

  return (
    <div
      ref={ref}
      data-base-plugin-view={entry.type}
      className="relative min-h-0 flex-1 overflow-auto"
    />
  );
}
