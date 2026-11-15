import { useMemo } from "react";
import type { BaseDocument, BaseQueryResult } from "@/lib/bases/types";
import { extraPropertiesOf, getBaseView, type BaseViewProps } from "@/lib/bases/view-registry";
import "./builtin-views";
import { BaseEditsContext, type BaseEdits } from "./edits-context";
import { DomViewHost } from "./plugin-view-host";
import { UnsupportedView } from "./unsupported-view";
import { viewIndexOf, type BaseQueryState } from "./use-base-query";

/** Property ids the selected view's type needs beyond its `order` (image property, plugin options). */
export function extrasFor(document: BaseDocument | null, viewName: string | undefined): string[] {
  const index = viewIndexOf(document, viewName);
  const view = index === null ? undefined : document?.views[index];
  const entry = view ? getBaseView(view.type) : undefined;
  return view && entry ? extraPropertiesOf(entry, view) : [];
}

const DANGER = "text-[var(--danger,#e5484d)]";

export function ErrorBanner({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div
      role="alert"
      data-base-error
      className={`border-b border-[var(--line-subtler)] bg-[color-mix(in_srgb,var(--danger,#e5484d)_10%,transparent)] px-3 py-2 text-[13px] ${DANGER}`}
    >
      <div className="font-medium">{title}</div>
      {children ? <div className="mt-0.5 text-text-secondary">{children}</div> : null}
    </div>
  );
}

function ViewErrorBanner({ error }: { error: NonNullable<BaseQueryResult["error"]> }) {
  const titles = {
    viewNotFound: "View not found",
    filterSyntax: "Filter error",
    filterEval: "Filter error",
    source: "The vault could not be queried",
    document: "The .base file could not be parsed",
  } as const;
  return (
    <ErrorBanner title={`${titles[error.kind]}: ${error.message}`}>
      {error.expression ? (
        <div>
          Expression: <code className="font-mono">{error.expression}</code>
        </div>
      ) : null}
      {error.path ? <div>On file: {error.path}</div> : null}
      <div>No rows are shown for this view.</div>
    </ErrorBanner>
  );
}

function Warnings({ warnings }: { warnings: readonly string[] }) {
  if (warnings.length === 0) return null;
  return (
    <details
      data-base-warnings
      className="border-b border-[var(--line-subtler)] px-3 py-1.5 text-[12px] text-text-secondary"
    >
      <summary className="cursor-pointer">
        {warnings.length} {warnings.length === 1 ? "warning" : "warnings"}
      </summary>
      <ul className="mt-1 list-disc pl-5">
        {warnings.map((w, i) => (
          <li key={i}>{w}</li>
        ))}
      </ul>
    </details>
  );
}

function Skeleton() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading results"
      data-base-skeleton
      className="px-3 py-2"
    >
      {Array.from({ length: 8 }, (_, i) => (
        <div
          key={i}
          className="mb-2 h-5 animate-pulse rounded-sm bg-[var(--surface-subtle)]"
          style={{ width: `${88 - (i % 4) * 12}%` }}
        />
      ))}
    </div>
  );
}

interface Props {
  state: BaseQueryState;
  /** Name of the base in the "could not be read" banner. */
  title: string;
  /** `null` until the first result lands. */
  viewProps: BaseViewProps | null;
  viewType: string;
  edits: BaseEdits;
  onEditYaml: () => void;
  /** Show the raw text of a `.base` that does not parse (not for an inline block: it is on screen). */
  showRawText?: boolean;
}

/**
 * Everything below the toolbar, shared by the tab and the note embed (one rendering path): the
 * error and warning banners, the view dispatched through the registry (or the placeholder for an
 * unregistered type), and the notice bar.
 */
export function BaseViewBody({
  state,
  title,
  viewProps,
  viewType,
  edits,
  onEditYaml,
  showRawText = true,
}: Props) {
  const { document, result } = state;
  const entry = getBaseView(viewType);
  const warnings = useMemo(
    () => [...(document?.warnings ?? []), ...(result?.warnings ?? [])],
    [document, result],
  );
  return (
    <>
      {state.documentError && result?.error?.kind !== "document" ? (
        <ErrorBanner title={`${title} could not be read`}>{state.documentError}</ErrorBanner>
      ) : null}
      {showRawText && state.rawText !== null ? (
        <pre
          data-base-raw-text
          className="max-h-60 overflow-auto border-b border-[var(--line-subtler)] px-3 py-2 font-mono text-[12px] text-text-secondary"
        >
          {state.rawText}
        </pre>
      ) : null}
      {state.error ? (
        <ErrorBanner title={`The query failed${result ? " (showing the previous result)" : ""}`}>
          {state.error}
        </ErrorBanner>
      ) : null}
      {state.liveError ? (
        <ErrorBanner title="Live updates are unavailable">{state.liveError}</ErrorBanner>
      ) : null}
      {result?.error ? <ViewErrorBanner error={result.error} /> : null}
      <Warnings warnings={warnings} />
      {viewProps ? (
        <BaseEditsContext.Provider value={edits}>
          {!entry ? (
            <UnsupportedView type={viewType} onEditYaml={onEditYaml} />
          ) : entry.Component ? (
            <entry.Component {...viewProps} />
          ) : (
            <DomViewHost entry={entry} props={viewProps} />
          )}
        </BaseEditsContext.Provider>
      ) : state.error || state.documentError ? null : (
        <Skeleton />
      )}
      {edits.notice ? (
        <div
          role={edits.notice.kind === "error" ? "alert" : "status"}
          data-base-notice={edits.notice.kind}
          className={`flex items-start gap-3 border-t border-border bg-surface-primary px-3 py-2 text-[13px] ${
            edits.notice.kind === "error" ? DANGER : "text-text-secondary"
          }`}
        >
          <span className="min-w-0 flex-1">{edits.notice.message}</span>
          <button
            type="button"
            onClick={edits.dismissNotice}
            aria-label="Dismiss"
            className="shrink-0 cursor-pointer bg-transparent px-1 text-text-muted hover:text-text-primary"
          >
            ×
          </button>
        </div>
      ) : null}
    </>
  );
}
