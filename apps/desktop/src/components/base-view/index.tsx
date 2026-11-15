import { useMemo, useSyncExternalStore } from "react";
import { viewNames, viewOfResult } from "@/lib/bases/grid";
import { listBaseViews, subscribeBaseViews, type BaseViewProps } from "@/lib/bases/view-registry";
import * as editorApi from "@/hooks/editor-api";
import { getFileName } from "@/lib/paths";
import type { BaseLocation } from "@/components/editor-area/page-kinds/base";
import { BaseToolbar } from "./base-toolbar";
import "./builtin-views";
import { ConfigMenus } from "./config-menus";
import type { MenuContext } from "./menu-context";
import { useBaseConfig } from "./use-base-config";
import { useBaseEdits } from "./use-base-edits";
import { useBaseQuery } from "./use-base-query";
import { useCellActions } from "./use-cell-actions";
import { usePendingBaseView } from "./use-pending-view";
import { BaseViewBody, extrasFor } from "./view-content";

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
    source: { kind: "file", path: location.path },
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
      <BaseViewBody
        state={state}
        title={title}
        viewProps={viewProps}
        viewType={viewType}
        edits={edits}
        onEditYaml={editYaml}
      />
    </div>
  );
}
