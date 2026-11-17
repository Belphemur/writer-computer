// Badges features draw on sidebar tree rows (the agent's project badge). The tree
// (`components/sidebar/file-tree-decorations.tsx`) reads this registry, so it names no feature
// (docs/consolidation.md: registry over per-case branches). Entries exist while a feature is on.
import { OwnedRegistry } from "@/lib/owned-registry";
import type { FileTreeDecorationContribution } from "./types";

export type OwnedFileTreeDecoration = FileTreeDecorationContribution & { owner: string };

export const fileTreeDecorationContributions = new OwnedRegistry<OwnedFileTreeDecoration>();
