import { Component, lazy, Suspense, useMemo, type ReactNode } from "react";
import { describeError, logger } from "@/lib/logger";
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

/** Mounts a feature's settings page: lazy, so its chunk loads only when the page is opened. */
export function FeatureSectionContent({ section }: { section: FeatureNavSection }) {
  const Page = useMemo(() => lazy(section.load), [section.load]);
  return (
    <SectionBoundary key={section.id}>
      <Suspense fallback={null}>
        <Page />
      </Suspense>
    </SectionBoundary>
  );
}
