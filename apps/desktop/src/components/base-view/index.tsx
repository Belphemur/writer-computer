import { useMemo, useSyncExternalStore } from "react";
import { viewNames, viewOfResult } from "@/lib/bases/grid";
import type { BaseDocument, BaseQueryResult } from "@/lib/bases/types";
import {
  extraPropertiesOf,
  getBaseView,
  listBaseViews,
  subscribeBaseViews,
  type BaseViewProps,
} from "@/lib/bases/view-registry";
import * as editorApi from "@/hooks/editor-api";
import { getFileName } from "@/lib/paths";
import type { BaseLocation } from "@/components/editor-area/page-kinds/base";
import { BaseToolbar } from "./base-toolbar";
import "./builtin-views";
import { ConfigMenus } from "./config-menus";
import { BaseEditsContext } from "./edits-context";
import type { MenuContext } from "./menu-context";
import { DomViewHost } from "./plugin-view-host";
import { UnsupportedView } from "./unsupported-view";
import { useBaseConfig } from "./use-base-config";
import { useBaseEdits } from "./use-base-edits";
import { useBaseQuery, viewIndexOf } from "./use-base-query";
import { useCellActions } from "./use-cell-actions";
import { usePendingBaseView } from "./use-pending-view";

/** Property ids the selected view's type needs beyond its `order` (image property, plugin options). */
function extrasFor(document: BaseDocument | null, viewName: string | undefined): string[] {
  const index = viewIndexOf(document, viewName);
  const view = index === null ? undefined : document?.views[index];
  const entry = view ? getBaseView(view.type) : undefined;
  return view && entry ? extraPropertiesOf(entry, view) : [];
}

const DANGER = "text-[var(--danger,#e5484d)]";

function ErrorBanner({ title, children }: { title: string; children?: React.ReactNode }) {
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

/** Table view of a `.base` file: the tab body of the `base` page kind. */
export function BaseView({
  location,
  isActive,
  tabId,
}: {
  location: BaseLocation;
  isActive: boolean;
  tabId: string;
}) {
  const { state, refresh, reload } = useBaseQuery({
    path: location.path,
    view: location.view,
    isActive,
    extras: extrasFor,
  });
  const edits = useBaseEdits({ result: state.result, refresh });
  const actions = useCellActions(edits.notify);
  const configApi = useBaseConfig({ path: location.path, reload, notify: edits.notify });
  usePendingBaseView(location.path, tabId);
  // Re-render when a view type is (un)registered, e.g. a plugin is disabled.
  useSyncExternalStore(subscribeBaseViews, listBaseViews, listBaseViews);

  const { document, result } = state;
  const names = useMemo(
    () =>
      result && result.availableViews.length > 0 ? result.availableViews : viewNames(document),
    [result, document],
  );
  const view = viewOfResult(document, result);
  const title = getFileName(location.path);
  const viewIndex = result?.view.index ?? null;
  const viewType = result?.view.type || view?.type || "table";
  const entry = getBaseView(viewType);
  const viewConfig = useMemo(
    () => configApi.viewConfig(viewIndex, view),
    [configApi, viewIndex, view],
  );
  const menuContext: MenuContext | null =
    document && view && viewIndex !== null
      ? {
          path: location.path,
          tabId,
          document,
          view,
          viewIndex,
          result,
          shown: result ? Math.min(state.shown, result.columns.length) : 0,
          apply: configApi.apply,
          notify: edits.notify,
        }
      : null;
  const editYaml = () =>
    editorApi
      .openFileAsTextInNewTab(location.path)
      .catch((e) =>
        edits.notify(
          "error",
          `Could not open ${location.path}: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
  const viewProps: BaseViewProps | null = result
    ? {
        path: location.path,
        result,
        shown: Math.min(state.shown, result.columns.length),
        view,
        viewIndex,
        document,
        label: title,
        actions,
        config: viewConfig,
      }
    : null;
  const selected = location.view ?? result?.view.name ?? names[0];
  const warnings = useMemo(
    () => [...(document?.warnings ?? []), ...(result?.warnings ?? [])],
    [document, result],
  );

  return (
    <div
      data-base-view={location.path}
      className={`${
        isActive ? "relative z-10 h-full" : "absolute inset-0 invisible pointer-events-none h-full"
      } flex min-h-0 flex-col pt-16`}
      aria-hidden={!isActive}
    >
      <BaseToolbar
        viewNames={names}
        selected={selected}
        onSelect={(name) => editorApi.setBaseTabView(tabId, name)}
        counts={result ? { shown: result.rows.length, matched: result.totalMatched } : null}
        querying={state.querying}
        onEditYaml={editYaml}
        menus={menuContext ? <ConfigMenus ctx={menuContext} config={viewConfig} /> : null}
      />
      {state.documentError && result?.error?.kind !== "document" ? (
        <ErrorBanner title={`${title} could not be read`}>{state.documentError}</ErrorBanner>
      ) : null}
      {state.rawText !== null ? (
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
            <UnsupportedView type={viewType} onEditYaml={editYaml} />
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
    </div>
  );
}
