import { useEffect, useRef } from "react";
import { usePluginRibbon, usePluginStatusItems } from "../use-plugins";

/** Appends a plugin-created element (ribbon icon, status text) and removes it on unmount. */
function PluginElement({ element, className }: { element: HTMLElement; className: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.replaceChildren(element);
    return () => {
      if (element.parentElement === host) element.remove();
    };
  }, [element]);
  return <div ref={hostRef} className={className} />;
}

/** Small icon buttons for the plugins' ribbon actions. Renders nothing without any. */
export function PluginRibbon() {
  const items = usePluginRibbon();
  if (items.length === 0) return null;
  return (
    <div data-plugin-ribbon className="mb-2 flex flex-wrap items-center gap-1">
      {items.map((item) => (
        <PluginElement
          key={`${item.owner}:${item.icon}:${item.title}`}
          element={item.el}
          className="flex size-6 cursor-pointer items-center justify-center rounded-md text-text-muted hover:bg-[var(--surface-card)] hover:text-text-primary [&_svg]:size-4"
        />
      ))}
    </div>
  );
}

/** Minimal status strip, pinned to the bottom-right of the editor column. */
export function PluginStatusBar() {
  const items = usePluginStatusItems();
  if (items.length === 0) return null;
  return (
    <div
      data-plugin-status-bar
      className="pointer-events-none absolute right-3 bottom-1 z-20 flex items-center gap-3 text-xs text-text-muted"
    >
      {items.map((item, i) => (
        <PluginElement
          key={`${item.owner}:${i}`}
          element={item.el}
          className="pointer-events-auto"
        />
      ))}
    </div>
  );
}
