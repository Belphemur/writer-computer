// Which `index://changed` batches make a base view requery.
import { isBasePath } from "./paths";
import type { IndexChangedEvent } from "./types";

export type IndexChangeEffect = "none" | "requery" | "reload-document";

/**
 * A full batch and a batch naming the `.base` file itself re-read the document (views,
 * formulas and filters may have changed) and requery. Any other changed file can enter or
 * leave the result, so it requeries too, except another `.base` file that is not one of the
 * current rows: a base's rows come from the files it filters, and a different base only matters
 * when it is itself a row.
 */
export function indexChangeEffect(
  event: Pick<IndexChangedEvent, "paths" | "full">,
  baseRelativePath: string | null,
  rowPaths: ReadonlySet<string>,
): IndexChangeEffect {
  if (event.full) return "reload-document";
  if (baseRelativePath !== null && event.paths.includes(baseRelativePath)) return "reload-document";
  for (const path of event.paths) {
    if (rowPaths.has(path)) return "requery";
    if (!isBasePath(path)) return "requery";
  }
  return "none";
}
