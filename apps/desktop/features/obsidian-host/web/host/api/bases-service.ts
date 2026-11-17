// The Bases feature as the host sees it: the `bases.views` service, found through the registry
// (`@/lib/features/services`), never imported. With Bases switched off there is no service and
// `registerBasesView` answers `false`, as Obsidian does without the core Bases plugin. The types
// come from the feature's public entry with `import type` only (erased: no runtime edge).
import { getService } from "@/lib/features/services";
import type { BasesViewsService } from "@features/bases/web/api";

/** The service id (`provides` in the Bases manifest). */
const BASES_VIEWS = "bases.views";

export const basesViews = (): BasesViewsService | undefined =>
  getService<BasesViewsService>(BASES_VIEWS);

/** For code that only runs while a plugin's Bases view is on screen, which needs the feature. */
export function requireBasesViews(): BasesViewsService {
  const service = basesViews();
  if (!service) throw new Error("Bases is turned off");
  return service;
}
