import { useCallback, useMemo, useState } from "react";
import * as editorApi from "@/hooks/editor-api";
import { embedKey, type BaseEmbed } from "../lib/embeds";
import { viewChoices, viewNames, viewOfResult } from "../lib/grid";
import { setPendingAnchor } from "@/lib/pending-anchor";
import type { BaseViewProps, ViewConfig } from "../lib/view-registry";
import { BaseToolbar } from "./base-toolbar";
import { useBaseConfig } from "./use-base-config";
import { useBaseEdits } from "./use-base-edits";
import { errorMessage, useBaseQuery, type BaseSource } from "./use-base-query";
import { useCellActions } from "./use-cell-actions";
import { useEmbeddedFile } from "./use-embedded-file";
import { BaseViewBody, ErrorBanner, extrasFor } from "./view-content";

/**
 * Height cap of an embedded base (px), toolbar included. Past it the view scrolls inside the
 * frame (table rows, cards and list items are windowed there), so a 10k-row base never grows the
 * note. Spec U16 is open: Obsidian's own limit is unknown.
 */
export const EMBED_MAX_HEIGHT = 420;

export const EMBED_READ_ONLY = "Embedded bases are read-only. Open the base to edit it.";

export interface EmbeddedBaseProps {
  embed: BaseEmbed;
  /** Absolute path of the embedding note: `this` inside the base (spec 2.2). */
  notePath: string;
  /** Put the caret in the embed's source so it can be edited (the widget owns the dispatch). */
  onEdit: () => void;
}

/** docs/editor.md: a button that dispatches into the editor must not take focus on mousedown. */
const holdEditorFocus = {
  onMouseDown: (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
  },
};

const buttonClass =
  "shrink-0 cursor-pointer rounded-md bg-transparent px-2 py-1 text-[12px] text-text-muted hover:bg-[var(--item-hover-bg)] hover:text-text-primary";

function Frame({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <div
      data-base-embed
      role="group"
      aria-label={label}
      style={{ maxHeight: EMBED_MAX_HEIGHT }}
      className="flex min-w-0 flex-col overflow-hidden rounded-md border border-[var(--line-subtler)] bg-surface-primary"
    >
      {children}
    </div>
  );
}

/** A note embed of a base: a `.base` file by link, or a fenced `base` block. Read-only except column widths (spec 7.13). */
export function EmbeddedBase(props: EmbeddedBaseProps) {
  const { embed } = props;
  // A different embed (another file or view) starts with fresh state; typing in a block does not.
  const identity = embed.kind === "block" ? "block" : embedKey(embed);
  return embed.kind === "file" ? (
    <FileEmbed key={identity} {...props} embed={embed} />
  ) : (
    <Body
      key={identity}
      source={{ kind: "text", text: embed.text }}
      notePath={props.notePath}
      label="Embedded base block"
      onEdit={props.onEdit}
    />
  );
}

function FileEmbed({
  embed,
  notePath,
  onEdit,
}: EmbeddedBaseProps & { embed: Extract<BaseEmbed, { kind: "file" }> }) {
  const file = useEmbeddedFile(embed.target, notePath);
  if (file.status === "ready") {
    return (
      <Body
        source={{ kind: "file", path: file.path }}
        notePath={notePath}
        label={`Embedded base ${embed.target}`}
        initialView={embed.view}
        onEdit={onEdit}
      />
    );
  }
  return (
    <Frame label={`Embedded base ${embed.target}`}>
      <BaseToolbar
        compact
        views={[]}
        selected={undefined}
        onSelect={() => {}}
        counts={null}
        querying={false}
        trailing={
          <button
            type="button"
            data-embed-edit
            onClick={onEdit}
            className={buttonClass}
            {...holdEditorFocus}
          >
            Edit
          </button>
        }
      />
      {file.status === "loading" ? (
        <div
          role="status"
          aria-busy="true"
          data-base-embed-loading
          className="px-3 py-2 text-[12px] text-text-muted"
        >
          Loading {embed.target}
        </div>
      ) : file.status === "missing" ? (
        <ErrorBanner title={`Base not found: ${embed.target}`}>
          No .base file with that name or path exists in the vault.
        </ErrorBanner>
      ) : (
        <ErrorBanner title={`Could not resolve ${embed.target}`}>{file.message}</ErrorBanner>
      )}
    </Frame>
  );
}

function Body({
  source,
  notePath,
  label,
  initialView,
  onEdit,
}: {
  source: BaseSource;
  notePath: string;
  label: string;
  initialView?: string;
  onEdit: () => void;
}) {
  const [chosen, setChosen] = useState<string | undefined>(initialView);
  const { state, refresh, reload } = useBaseQuery({
    source,
    thisPath: notePath,
    view: chosen,
    isActive: true,
    extras: extrasFor,
  });
  const edits = useBaseEdits({ result: state.result, refresh, readOnly: EMBED_READ_ONLY });
  const actions = useCellActions(edits.notify);
  const { notify } = edits;

  // Header clicks never write the `.base` from an embed. Column resizes (drag or double-click fit)
  // do, for a file embed, through the same write path as the Bases tab (`useBaseConfig`); a fenced
  // block has no file, so its widths only last until the block's result reloads.
  const filePathForConfig = source.kind === "file" ? source.path : null;
  const configApi = useBaseConfig({ path: filePathForConfig ?? notePath, reload, notify });
  const viewIndex = state.result?.view.index ?? null;
  const viewOfState = viewOfResult(state.document, state.result);
  const config = useMemo<ViewConfig>(() => {
    const refuse = () => notify("info", EMBED_READ_ONLY);
    const persisting = filePathForConfig ? configApi.viewConfig(viewIndex, viewOfState) : null;
    return {
      cycleSort: refuse,
      setColumnWidth: (id, px) => persisting?.setColumnWidth(id, px),
      setOption: refuse,
    };
  }, [notify, configApi, filePathForConfig, viewIndex, viewOfState]);

  const { document, result } = state;
  const names = useMemo(
    () =>
      result && result.availableViews.length > 0 ? result.availableViews : viewNames(document),
    [result, document],
  );
  const choices = useMemo(() => viewChoices(names, document), [names, document]);
  const view = viewOfResult(document, result);
  const viewType = result?.view.type || view?.type || "table";
  const title = source.kind === "file" ? "The base" : "The base block";
  const filePath = source.kind === "file" ? source.path : null;

  const openBase = useCallback(() => {
    if (!filePath) return;
    if (chosen) setPendingAnchor(filePath, chosen);
    editorApi
      .openFileInNewTab(filePath)
      .catch((e) => notify("error", `Could not open ${filePath}: ${errorMessage(e)}`));
  }, [filePath, chosen, notify]);

  const editYaml = useCallback(() => {
    if (!filePath) return onEdit();
    editorApi
      .openFileAsTextInNewTab(filePath)
      .catch((e) => notify("error", `Could not open ${filePath}: ${errorMessage(e)}`));
  }, [filePath, onEdit, notify]);

  const viewProps: BaseViewProps | null = result
    ? {
        path: filePath ?? notePath,
        result,
        shown: Math.min(state.shown, result.columns.length),
        view,
        viewIndex: result.view.index,
        document,
        label: filePath ? filePath : "base block",
        actions,
        config,
      }
    : null;

  return (
    <Frame label={label}>
      <BaseToolbar
        compact
        views={choices}
        selected={chosen ?? result?.view.name ?? names[0]}
        onSelect={setChosen}
        counts={result ? { shown: result.rows.length, matched: result.totalMatched } : null}
        querying={state.querying}
        trailing={
          <>
            {filePath ? (
              <button
                type="button"
                data-embed-open
                title="Open the base in a new tab"
                onClick={openBase}
                className={buttonClass}
                {...holdEditorFocus}
              >
                Open base
              </button>
            ) : null}
            <button
              type="button"
              data-embed-edit
              title={filePath ? "Edit the embed link" : "Edit the base block source"}
              onClick={onEdit}
              className={buttonClass}
              {...holdEditorFocus}
            >
              Edit
            </button>
          </>
        }
      />
      <BaseViewBody
        state={state}
        title={title}
        viewProps={viewProps}
        viewType={viewType}
        edits={edits}
        onEditYaml={editYaml}
        showRawText={false}
      />
    </Frame>
  );
}
