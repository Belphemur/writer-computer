import { overlayContributions } from "@/lib/features/overlays";
import { useRegistryItems } from "@/hooks/use-registry-items";
import { FeaturePane } from "./feature-pane";

/** The overlays of the features that are on (a dialog that shows itself when opened). */
export function FeatureOverlays() {
  const overlays = useRegistryItems(overlayContributions);
  return (
    <>
      {overlays.map((o) => (
        <FeaturePane key={o.id} contribution={o} />
      ))}
    </>
  );
}
