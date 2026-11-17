import { useRegistryItems } from "@/hooks/use-registry-items";
import { featureOfOwner } from "@/lib/features/id";
import {
  fileTreeDecorationContributions,
  type OwnedFileTreeDecoration,
} from "@/lib/features/file-tree";
import type { DirEntry } from "@/types/fs";
import { FeatureBoundary } from "@/components/feature-boundary";
import { FileTreeBadgeIcon } from "./file-tree-icons";

// One component per contribution, so each calls its feature's hook exactly once and the number of
// hooks of a row never changes when a feature is turned on or off.
function Decoration({
  contribution,
  entry,
}: {
  contribution: OwnedFileTreeDecoration;
  entry: DirEntry;
}) {
  const { useBadge } = contribution;
  const badge = useBadge(entry);
  return badge ? <FileTreeBadgeIcon badge={badge} /> : null;
}

/** The badges the features that are on draw on this row. A contribution that throws costs its
 *  feature a strike and draws nothing, so the tree keeps working. */
export function FileTreeDecorations({ entry }: { entry: DirEntry }) {
  const items = useRegistryItems(fileTreeDecorationContributions);
  return (
    <>
      {items.map((c) => {
        const row = <Decoration contribution={c} entry={entry} />;
        const feature = featureOfOwner(c.owner);
        return feature ? (
          <FeatureBoundary key={c.id} feature={feature} fallback={null}>
            {row}
          </FeatureBoundary>
        ) : (
          row
        );
      })}
    </>
  );
}
