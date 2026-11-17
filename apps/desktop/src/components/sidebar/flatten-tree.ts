import type { DirEntry } from "@/types/fs";
import { sortTreeEntries } from "./sidebar-sort";

export { sortTreeEntries } from "./sidebar-sort";

export interface FlatTreeItem {
  entry: DirEntry;
  depth: number;
}

export function flattenTree(
  items: DirEntry[],
  depth: number,
  directoryCache: Map<string, DirEntry[]>,
  expandedDirs: Set<string>,
  sortMode?: string,
  foldersFirst = true,
  result: FlatTreeItem[] = [],
): FlatTreeItem[] {
  for (const entry of sortTreeEntries(items, sortMode, foldersFirst)) {
    result.push({ entry, depth });
    if (entry.is_dir && expandedDirs.has(entry.path)) {
      flattenTree(
        directoryCache.get(entry.path) ?? [],
        depth + 1,
        directoryCache,
        expandedDirs,
        sortMode,
        foldersFirst,
        result,
      );
    }
  }
  return result;
}
