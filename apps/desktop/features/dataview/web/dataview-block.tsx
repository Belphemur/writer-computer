import { useEffect, useState, type ComponentType } from "react";
import { getService } from "@/lib/features/services";
import type { BasesViewsService, EmbeddedBaseProps } from "@features/bases/web/api";
import { blockKey, errorContext, type DataviewBlock } from "./blocks";
import { offerDataviewTakeover } from "./takeover";
import { dqlConvert, dqlLower, type DqlLowered } from "./ipc";

const BASES_VIEWS = "bases.views";
const DEBOUNCE_MS = 200;

export interface DataviewBlockProps {
  block: DataviewBlock;
  /** Absolute path of the note holding the block (`this`). */
  notePath: string;
  /** Put the caret in the block's source so it can be edited. */
  onEdit: () => void;
  /** Replace the whole block with `text` (Convert to Base, on confirm). */
  onReplace: (text: string) => void;
}

/** docs/editor.md: a button that dispatches into the editor must not take focus on mousedown. */
const holdEditorFocus = {
  onMouseDown: (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
  },
};

const buttonClass =
  "shrink-0 cursor-pointer rounded-md bg-transparent px-2 py-1 text-[12px] text-text-muted hover:bg-[var(--item-hover-bg)] hover:text-text-primary disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-text-muted";

function Frame({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div
      data-dataview-block
      role="group"
      aria-label={label}
      className="flex min-w-0 flex-col overflow-hidden rounded-md border border-[var(--line-subtler)] bg-surface-primary"
    >
      {children}
    </div>
  );
}

function EditButton({ onEdit }: { onEdit: () => void }) {
  return (
    <button
      type="button"
      data-dataview-edit
      className={buttonClass}
      onClick={onEdit}
      {...holdEditorFocus}
    >
      Edit
    </button>
  );
}

/** ```dataviewjs: a placeholder. The code is shown collapsed and is never run. */
function JsPlaceholder({ source, onEdit }: { source: string; onEdit: () => void }) {
  return (
    <Frame label="Dataview JavaScript block">
      <div className="flex items-center gap-2 px-3 py-2 text-[12px] text-text-muted">
        <span data-dataview-js className="min-w-0 flex-1">
          dataviewjs is not supported
        </span>
        <EditButton onEdit={onEdit} />
      </div>
      <details className="border-t border-[var(--line-subtler)] px-3 py-1 text-[12px] text-text-muted">
        <summary className="cursor-pointer">Code</summary>
        <pre className="overflow-x-auto py-1 font-mono text-[11px]">{source}</pre>
      </details>
    </Frame>
  );
}

type Lowering =
  | { status: "loading" }
  | { status: "failed"; message: string }
  | { status: "ready"; lowered: DqlLowered };

/** The query lowered by Rust; a new source waits for a pause in typing. */
function useLowered(source: string): Lowering {
  const [state, setState] = useState<{ source: string; result: Lowering } | null>(null);
  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      dqlLower(source).then(
        (lowered) => live && setState({ source, result: { status: "ready", lowered } }),
        (e) =>
          live &&
          setState({
            source,
            result: { status: "failed", message: e instanceof Error ? e.message : String(e) },
          }),
      );
    }, DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [source]);
  return state ? state.result : { status: "loading" };
}

type BaseComponent = ComponentType<EmbeddedBaseProps> | "off" | null;

/** The Bases embed component, through the Bases service (a feature never imports another). */
function useEmbeddedBase(): BaseComponent {
  const [component, setComponent] = useState<BaseComponent>(null);
  useEffect(() => {
    const service = getService<BasesViewsService>(BASES_VIEWS);
    if (!service) {
      setComponent("off");
      return;
    }
    let live = true;
    void service.loadEmbeddedBase().then((c) => live && setComponent(() => c));
    return () => {
      live = false;
    };
  }, []);
  return component;
}

function Query({
  source,
  notePath,
  onEdit,
  onReplace,
}: Omit<DataviewBlockProps, "block"> & { source: string }) {
  const lowering = useLowered(source);
  const Embedded = useEmbeddedBase();
  // a block is on screen: ask once whether the Dataview plugin should step aside
  useEffect(() => {
    void offerDataviewTakeover();
  }, []);
  const [converted, setConverted] = useState<{ path: string } | { error: string } | null>(null);

  if (lowering.status === "loading") {
    return (
      <Frame label="Dataview query">
        <div role="status" aria-busy="true" className="px-3 py-2 text-[12px] text-text-muted">
          Running query
        </div>
      </Frame>
    );
  }
  if (lowering.status === "failed") {
    return (
      <Frame label="Dataview query">
        <div className="flex items-start gap-2 px-3 py-2 text-[12px] text-[var(--danger)]">
          <span role="alert" data-dataview-error className="min-w-0 flex-1">
            {lowering.message}
          </span>
          <EditButton onEdit={onEdit} />
        </div>
      </Frame>
    );
  }
  const { lowered } = lowering;
  if (lowered.error || !lowered.liveText) {
    const e = lowered.error;
    return (
      <Frame label="Dataview query">
        <div className="flex items-start gap-2 px-3 py-2 text-[12px]">
          <div className="min-w-0 flex-1">
            <div role="alert" data-dataview-error className="text-[var(--danger)]">
              {e ? `Line ${e.line}, column ${e.col}: ${e.message}` : "The query cannot run"}
            </div>
            {e ? (
              <pre className="overflow-x-auto pt-1 font-mono text-[11px] text-text-muted">
                {errorContext(source, e.line, e.col)}
              </pre>
            ) : null}
          </div>
          <EditButton onEdit={onEdit} />
        </div>
      </Frame>
    );
  }
  const why = lowered.unmapped.map((u) => `${u.clause}: ${u.reason}`).join("\n");
  const convert = async () => {
    try {
      setConverted({ path: await dqlConvert(source, notePath) });
    } catch (e) {
      setConverted({ error: e instanceof Error ? e.message : String(e) });
    }
  };
  return (
    <div data-dataview-query className="flex min-w-0 flex-col gap-1">
      {Embedded === "off" ? (
        <Frame label="Dataview query">
          <div className="flex items-center gap-2 px-3 py-2 text-[12px] text-text-muted">
            <span className="min-w-0 flex-1">Bases is turned off</span>
            <EditButton onEdit={onEdit} />
          </div>
        </Frame>
      ) : Embedded ? (
        <Embedded
          embed={{ kind: "block", text: lowered.liveText }}
          notePath={notePath}
          onEdit={onEdit}
        />
      ) : null}
      <div className="flex items-center gap-1 px-1 text-[12px] text-text-muted">
        {converted && "path" in converted ? (
          <>
            <span data-dataview-converted className="min-w-0 truncate">
              Saved as {converted.path}
            </span>
            <button
              type="button"
              data-dataview-replace
              className={buttonClass}
              onClick={() => onReplace(`![[${converted.path}]]`)}
              {...holdEditorFocus}
            >
              Replace block
            </button>
            <button
              type="button"
              className={buttonClass}
              onClick={() => setConverted(null)}
              {...holdEditorFocus}
            >
              Keep
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              data-dataview-convert
              disabled={!lowered.convertible}
              title={lowered.convertible ? "Write this query as a base" : why}
              className={buttonClass}
              onClick={() => void convert()}
              {...holdEditorFocus}
            >
              Convert to Base
            </button>
            {!lowered.convertible && lowered.unmapped[0] ? (
              <span data-dataview-unmapped className="min-w-0 truncate">
                {lowered.unmapped[0].clause} has no base form
              </span>
            ) : null}
            {converted && "error" in converted ? (
              <span
                role="alert"
                data-dataview-convert-error
                className="min-w-0 truncate text-[var(--danger)]"
              >
                {converted.error}
              </span>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

/** A ```dataview or ```dataviewjs block in a note. */
export function DataviewBlockView(props: DataviewBlockProps) {
  const { block } = props;
  // a different block starts with fresh state; typing in one keeps it
  return block.kind === "js" ? (
    <JsPlaceholder key={blockKey(block)} source={block.source} onEdit={props.onEdit} />
  ) : (
    <Query
      key="query"
      source={block.source}
      notePath={props.notePath}
      onEdit={props.onEdit}
      onReplace={props.onReplace}
    />
  );
}
