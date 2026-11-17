import { memo, useMemo, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getWorkspaceRoot } from "@/hooks/workspace-api";
import {
  CARD_GAP,
  CARD_PADDING,
  GROUP_HEADER_HEIGHT,
  cardHeight,
  cardImage,
  cardItems,
  cardOptions,
  cardsPerRow,
  sectionsOf,
  type CardImage,
  type CardItem,
  type CardOptions,
} from "../lib/collections";
import { canonicalPropertyKey } from "../lib/cells";
import { toAbsolutePath } from "../lib/paths";
import type { Cell, Column } from "../lib/types";
import type { BaseViewProps, ViewActions } from "../lib/view-registry";
import { CellView } from "./cell-view";
import { GroupHeader } from "./group-header";
import { useGroupCollapse } from "./use-group-collapse";
import { WindowedList } from "./windowed-list";

const NOOP = () => {};
const READ_ONLY = "Edit cells in the table view";

/**
 * Vault image -> URL the webview can load: the same Tauri asset URL the markdown renderer uses
 * (`convertFileSrc` over the absolute path). Throws without a workspace (shown by the caller).
 */
function vaultImageSrc(relativePath: string): string {
  const root = getWorkspaceRoot();
  if (!root) throw new Error("No workspace is open");
  return convertFileSrc(toAbsolutePath(root, relativePath));
}

function ImageBox({
  image,
  options,
  name,
}: {
  image: CardImage;
  options: CardOptions;
  name: string;
}) {
  const [failed, setFailed] = useState(false);
  const height = Math.round(options.size * options.aspectRatio);
  const frame =
    "flex w-full items-center justify-center overflow-hidden bg-[var(--surface-subtle)] text-[11px] text-text-muted";
  let src: string | null = null;
  let problem: string | null = null;
  if (image.kind === "url") src = image.url;
  else if (image.kind === "file") {
    try {
      src = vaultImageSrc(image.path);
    } catch (e) {
      problem = e instanceof Error ? e.message : String(e);
    }
  } else if (image.kind === "blocked") problem = image.reason;

  if (image.kind === "color")
    return (
      <div
        data-card-image="color"
        className={frame}
        style={{ height, backgroundColor: image.color }}
      />
    );
  if (src !== null && !failed)
    return (
      <div data-card-image={image.kind} className={frame} style={{ height }}>
        <img
          src={src}
          alt={name}
          loading="lazy"
          draggable={false}
          onError={() => setFailed(true)}
          className="size-full"
          style={{ objectFit: options.fit }}
        />
      </div>
    );
  const text = failed ? "Image could not be loaded" : problem;
  return (
    <div
      data-card-image={text ? "problem" : "empty"}
      title={text ?? undefined}
      className={frame}
      style={{ height }}
    >
      {text ? <span className="truncate px-2">{text}</span> : null}
    </div>
  );
}

interface CardProps {
  rowPath: string;
  cells: readonly Cell[];
  columns: readonly Column[];
  imageCell: Cell | undefined;
  options: CardOptions;
  actions: ViewActions;
  height: number;
}

const Card = memo(function Card({
  rowPath,
  cells,
  columns,
  imageCell,
  options,
  actions,
  height,
}: CardProps) {
  const title = cells[0];
  return (
    <div
      role="article"
      tabIndex={0}
      data-card-path={rowPath}
      onClick={() => actions.openFile(rowPath)}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && e.key === "Enter") actions.openFile(rowPath);
      }}
      style={{ width: options.size, height }}
      className="shrink-0 cursor-pointer overflow-hidden rounded-lg border border-border bg-surface-primary hover:bg-[var(--item-hover-bg)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--focus-border)]"
    >
      {options.image ? (
        <ImageBox image={cardImage(imageCell)} options={options} name={title?.display ?? ""} />
      ) : null}
      <div className="px-3 py-2">
        <div className="flex h-6 items-center overflow-hidden text-[13px] font-medium text-text-primary">
          {title ? (
            <CellView
              cell={title}
              columnKey={columns[0]!.key}
              rowPath={rowPath}
              readOnlyReason={READ_ONLY}
              actions={actions}
              onToggle={NOOP}
            />
          ) : null}
        </div>
        {columns.slice(1).map((column, i) => {
          const cell = cells[i + 1];
          return (
            <div
              key={column.key}
              className="flex h-5 items-center gap-1.5 overflow-hidden text-[12px]"
            >
              <span className="shrink-0 text-text-muted">{column.displayName}</span>
              {cell ? (
                <CellView
                  cell={cell}
                  columnKey={column.key}
                  rowPath={rowPath}
                  readOnlyReason={READ_ONLY}
                  actions={actions}
                  onToggle={NOOP}
                />
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
});

/** The registered `cards` view: a windowed grid of cards with optional cover images and groups. */
export function CardsView({ result, shown, view, actions, label }: BaseViewProps) {
  const options = useMemo(() => cardOptions(view), [view]);
  const [width, setWidth] = useState(800);
  const { collapsed, toggle } = useGroupCollapse(view?.name ?? "");
  const columns = useMemo(
    () => result.columns.slice(0, Math.max(1, shown)),
    [result.columns, shown],
  );
  const imageIndex = useMemo(() => {
    if (!options.image) return -1;
    const want = canonicalPropertyKey(options.image);
    return result.columns.findIndex((c) => c.key === want);
  }, [options.image, result.columns]);
  const perRow = cardsPerRow(width, options.size);
  const height = cardHeight(options, columns.length);

  const layout = useMemo(() => {
    try {
      const sections = sectionsOf(result);
      return { items: cardItems(sections, perRow, collapsed) };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }, [result, perRow, collapsed]);

  if ("error" in layout)
    return (
      <div role="alert" data-base-error className="px-4 py-3 text-[13px] text-[var(--danger)]">
        The query result could not be displayed: {layout.error}
      </div>
    );
  if (layout.items.length === 0)
    return (
      <div data-empty className="px-3 py-6 text-[13px] text-text-muted">
        No results
      </div>
    );

  return (
    <WindowedList<CardItem>
      items={layout.items}
      label={label}
      marker="data-base-cards"
      onWidth={setWidth}
      heightOf={(item) => (item.kind === "group" ? GROUP_HEADER_HEIGHT : height + CARD_GAP)}
      keyOf={(item, i) => (item.kind === "group" ? `g:${item.key}` : `c:${item.rows[0]}:${i}`)}
      render={(item) =>
        item.kind === "group" ? (
          <GroupHeader item={item} onToggle={toggle} />
        ) : (
          <div
            className="flex"
            style={{ gap: CARD_GAP, padding: `0 ${CARD_PADDING}px`, paddingTop: 0 }}
          >
            {item.rows.map((r) => {
              const row = result.rows[r]!;
              return (
                <Card
                  key={row.path}
                  rowPath={row.path}
                  cells={row.cells}
                  columns={columns}
                  imageCell={imageIndex >= 0 ? row.cells[imageIndex] : undefined}
                  options={options}
                  actions={actions}
                  height={height}
                />
              );
            })}
          </div>
        )
      }
    />
  );
}
