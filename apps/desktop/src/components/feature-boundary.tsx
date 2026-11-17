import { Component, type ErrorInfo, type ReactNode } from "react";
import { useSetSetting } from "@/hooks/use-settings";
import { enabledKey } from "@/lib/features/manifests";
import { recordFailure } from "@/lib/features/health";
import { describeError, logger } from "@/lib/logger";

/** What a contained feature pane shows: the rest of the window keeps working. */
function FailedPlaceholder({ id }: { id: string }) {
  const setSetting = useSetSetting();
  return (
    <div
      role="alert"
      data-feature-failed={id}
      className="flex h-full min-w-0 flex-col items-start gap-2 p-4 text-[13px] text-[var(--text-muted)]"
    >
      <div className="text-[var(--text-primary)]">This feature failed</div>
      <div>The {id} feature hit an error. The rest of Writer is not affected.</div>
      <button
        type="button"
        onClick={() => void setSetting(enabledKey(id), false)}
        className="rounded-md border border-[var(--line-subtle)] px-2.5 py-1 text-[var(--text-primary)] hover:bg-[var(--item-hover-bg)]"
      >
        Turn off
      </button>
    </div>
  );
}

interface Props {
  /** The feature that owns what renders inside. */
  feature: string;
  children: ReactNode;
}

/** The one error boundary for UI a built-in feature contributes (docks today; every new host for
 *  page kinds or settings blocks wraps its contribution in it). A render error is logged, counted
 *  toward the feature's three strikes (`stores/feature-health-store.ts`) and replaced by a
 *  placeholder with a "Turn off" action. */
export class FeatureBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    logger.error("react", describeError(error).message, {
      stack: `${error.stack ?? ""}\ncomponent stack:${info.componentStack ?? ""}`,
      plugin: this.props.feature,
      phase: "render",
    });
    recordFailure(this.props.feature, "render");
  }

  render() {
    return this.state.failed ? <FailedPlaceholder id={this.props.feature} /> : this.props.children;
  }
}
