import { Component, useEffect, useState, type ComponentType, type ReactNode } from "react";
import { describeError, logger } from "@/lib/logger";
import { cachedSection, loadSection, type SectionLoader } from "@/lib/features/section-loader";
import type { FeatureNavSection } from "./settings-sections";

/** A page a feature contributes failing to load or render shows one line, never the app-wide
 *  error screen: the rest of Settings keeps working. */
class SectionBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error) {
    logger.error("react", `feature settings page failed: ${describeError(error).message}`);
  }
  render() {
    return this.state.failed ? (
      <p role="alert" className="text-[13px] text-[var(--text-muted)]">
        This page could not be loaded.
      </p>
    ) : (
      this.props.children
    );
  }
}

/** Reserved height of the loading page, so the page arriving below the title does not move it. */
const SKELETON_MIN_HEIGHT = "min-h-[32rem]";

/** Neutral placeholder while a page's chunk loads (the title is the panel's own heading). */
export function SectionSkeleton() {
  return (
    <div
      data-section-skeleton
      role="status"
      aria-busy="true"
      aria-label="Loading"
      className={`${SKELETON_MIN_HEIGHT} space-y-3`}
    >
      <div className="h-24 rounded-2xl bg-[var(--surface-subtle)]" />
      <div className="h-48 rounded-2xl bg-[var(--surface-subtle)]" />
    </div>
  );
}

/** The page of a section: synchronous when its chunk is cached, else the skeleton until it loads.
 *  A load failure is thrown into `SectionBoundary`. */
function SectionPage({ load }: { load: SectionLoader }) {
  const [Page, setPage] = useState<ComponentType | undefined>(() => cachedSection(load));
  useEffect(() => {
    let live = true;
    loadSection(load).then(
      (c) => live && setPage(() => c),
      (e: unknown) =>
        live &&
        setPage(() => {
          throw e;
        }),
    );
    return () => {
      live = false;
    };
  }, [load]);
  return Page ? <Page /> : <SectionSkeleton />;
}

/** Mounts a feature's settings page: its chunk loads when Settings opens (`usePreloadSections`)
 *  or at the latest when the page is selected. */
export function FeatureSectionContent({ section }: { section: FeatureNavSection }) {
  return (
    <SectionBoundary key={section.id}>
      <SectionPage key={section.id} load={section.load} />
    </SectionBoundary>
  );
}
