// The one cache of the Settings pages features contribute (`settingsSection.load`). The page's
// chunk is preloaded in the background when Settings opens or a nav item is hovered/focused, and
// a resolved page is read synchronously, so a second open renders on the first frame. Keyed by the
// `load` function (its identity is stable per contribution), so no per-feature code lives here.
import type { ComponentType } from "react";

export type SectionLoader = () => Promise<{ default: ComponentType }>;

const pending = new Map<SectionLoader, Promise<ComponentType>>();
const resolved = new Map<SectionLoader, ComponentType>();

/** Starts (once) and returns the load; a failed load is forgotten so the next call retries. */
export function loadSection(load: SectionLoader): Promise<ComponentType> {
  let p = pending.get(load);
  if (!p) {
    p = load().then(
      (m) => {
        resolved.set(load, m.default);
        return m.default;
      },
      (e: unknown) => {
        pending.delete(load);
        throw e;
      },
    );
    pending.set(load, p);
  }
  return p;
}

/** Background preload: errors are left to the render path, which retries and shows its own line. */
export function preloadSections(loads: readonly SectionLoader[]): void {
  for (const load of loads) loadSection(load).catch(() => {});
}

/** The page when its chunk has already loaded. */
export function cachedSection(load: SectionLoader): ComponentType | undefined {
  return resolved.get(load);
}

/** Tests only. */
export function resetSectionCache(): void {
  pending.clear();
  resolved.clear();
}
