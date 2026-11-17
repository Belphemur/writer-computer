// The panels of the left sidebar: Files (core, always first) then the panels features contribute,
// ordered by `order`. No React, so the order and the fallback rule are testable on their own.
import { Folder01Icon } from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { byOrder } from "@/lib/features/order";
import type { OwnedSidebarPanel } from "@/lib/features/sidebar";
import { FILES_PANEL_ID } from "@/stores/ui-store";

export interface SidebarPanelTab {
  id: string;
  label: string;
  icon: IconSvgElement;
  /** The contribution behind a feature's panel; null for the core Files panel. */
  contribution: OwnedSidebarPanel | null;
}

const FILES_TAB: SidebarPanelTab = {
  id: FILES_PANEL_ID,
  label: "Files",
  icon: Folder01Icon,
  contribution: null,
};

export function buildSidebarPanels(contributed: readonly OwnedSidebarPanel[]): SidebarPanelTab[] {
  return [
    FILES_TAB,
    ...byOrder(contributed).map((c) => ({
      id: c.id,
      label: c.label,
      icon: c.icon,
      contribution: c,
    })),
  ];
}

/** The selected panel, or Files when the selection no longer exists (its feature was turned off). */
export function resolveSidebarPanel(
  panels: readonly SidebarPanelTab[],
  selectedId: string,
): SidebarPanelTab {
  return panels.find((p) => p.id === selectedId) ?? FILES_TAB;
}
