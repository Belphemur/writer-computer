import { slotContributions, type SlotName } from "@/lib/features/slots";
import { useRegistryItems } from "@/hooks/use-registry-items";
import { FeaturePane, type LazyContribution } from "./feature-pane";

/** The components the features that are on mount in `slot`, each in its own error boundary. The
 *  props are those of `SlotMap[slot]`; contributions are typed by it, this renderer only forwards. */
export function FeatureSlot({ slot, ...props }: { slot: SlotName } & Record<string, unknown>) {
  const items = useRegistryItems(slotContributions)
    .filter((c) => c.slot === slot)
    .sort((a, b) => a.id.localeCompare(b.id));
  return (
    <>
      {items.map((c) => (
        <FeaturePane key={c.id} contribution={c as LazyContribution<object>} {...props} />
      ))}
    </>
  );
}
