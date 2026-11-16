import { useCallback } from "react";
import { usePropertiesPanelStore } from "@/stores/properties-panel-store";
import { useSetting } from "@/hooks/use-settings";
import {
  normalizeDefault,
  resolveCollapsed,
  type PropertyStats,
} from "@/lib/frontmatter-properties";

/** Collapsed and source-view state of one note's properties panel (session only). Subscribes
 *  to this note's entry and the one setting, nothing else. */
export function usePropertiesPanel(filePath: string, stats: PropertyStats) {
  const entry = usePropertiesPanelStore((s) => s.notes.get(filePath));
  const setting = normalizeDefault(useSetting("editor.properties-default-collapsed"));
  const setCollapsedFor = usePropertiesPanelStore((s) => s.setCollapsed);
  const setSourceFor = usePropertiesPanelStore((s) => s.setSource);

  const collapsed = resolveCollapsed(entry?.collapsed, setting, stats);
  const toggleCollapsed = useCallback(
    () => setCollapsedFor(filePath, !collapsed),
    [setCollapsedFor, filePath, collapsed],
  );
  const source = entry?.source === true;
  const toggleSource = useCallback(
    () => setSourceFor(filePath, !source),
    [setSourceFor, filePath, source],
  );
  return { collapsed, toggleCollapsed, source, toggleSource };
}
