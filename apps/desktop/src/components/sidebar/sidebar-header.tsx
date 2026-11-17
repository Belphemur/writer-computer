import { HugeiconsIcon } from "@hugeicons/react";
import { FeatureDivider } from "@/components/feature-divider";
import { byOrder } from "@/lib/features/order";
import { withFeatureDivider } from "@/lib/features/origin";
import { sidebarActionContributions } from "@/lib/features/sidebar";
import { useRegistryItems } from "@/hooks/use-registry-items";
import type { SidebarPanelTab } from "./sidebar-panels";

const BUTTON_CLASS =
  "flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[var(--item-hover-bg)] hover:text-[var(--fg-base)]";

interface SidebarHeaderProps {
  panels: readonly SidebarPanelTab[];
  selectedId: string;
  onSelect: (id: string) => void;
}

/** The row under the window chrome: the panel switcher (when a feature added a panel) and the
 *  toolbar buttons features contributed. Nothing renders while there is neither, so the sidebar
 *  is unchanged when no feature adds to it. */
export function SidebarHeader({ panels, selectedId, onSelect }: SidebarHeaderProps) {
  const actions = byOrder(useRegistryItems(sidebarActionContributions));
  const showSwitcher = panels.length > 1;
  const renderTab = (p: SidebarPanelTab) => (
    <button
      key={p.id}
      type="button"
      role="tab"
      aria-selected={p.id === selectedId}
      aria-label={p.label}
      title={p.label}
      data-sidebar-panel-tab={p.id}
      onClick={() => onSelect(p.id)}
      className={`${BUTTON_CLASS} ${p.id === selectedId ? "bg-[var(--item-hover-bg)] text-[var(--fg-base)]" : ""}`}
    >
      <HugeiconsIcon icon={p.icon} size={16} color="currentColor" strokeWidth={2} />
    </button>
  );
  if (!showSwitcher && actions.length === 0) return null;

  return (
    <div data-sidebar-header className="flex shrink-0 items-center justify-between gap-2 px-3 pb-1">
      <div role="tablist" aria-label="Sidebar panels" className="flex items-center gap-0.5">
        {showSwitcher &&
          withFeatureDivider(
            panels.filter((p) => !p.contribution).map(renderTab),
            panels.filter((p) => p.contribution).map(renderTab),
            <FeatureDivider key="feature-divider" />,
          )}
      </div>
      <div className="flex items-center gap-0.5">
        {actions.map((a) => (
          <button
            key={a.id}
            type="button"
            aria-label={a.label}
            title={a.label}
            data-sidebar-action={a.id}
            onClick={a.run}
            className={BUTTON_CLASS}
          >
            <HugeiconsIcon icon={a.icon} size={16} color="currentColor" strokeWidth={2} />
          </button>
        ))}
      </div>
    </div>
  );
}
