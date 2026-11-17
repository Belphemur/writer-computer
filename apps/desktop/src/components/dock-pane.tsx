import { dockContributions } from "@/lib/features/docks";
import { FeaturePane } from "./feature-pane";

/** The pane of the dock `id` (a contributed dock; the layout falls back to the plugin pane). */
export function DockPane({ id }: { id: string }) {
  const dock = dockContributions.get(id);
  return dock ? <FeaturePane contribution={dock} /> : null;
}
