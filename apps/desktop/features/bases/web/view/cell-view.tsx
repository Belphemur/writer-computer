import { EnumValueIcon } from "@/components/icon-picker/enum-value-icon";
import { IconGlyph } from "@/components/icon-picker/icon-glyph";
import { useFileIcon } from "@/lib/file-icons";
import { UrlChip } from "@/components/url-chip";
import { linkHandlers, type LinkIntent } from "@/lib/link-activation";
import { typeKey } from "@/lib/property-types";
import { usePropertyTypesStore } from "@/stores/property-types-store";
import { itemText, notePropertyName, propertyNamespace } from "../lib/cells";
import type { Cell, CellValue } from "../lib/types";
import type { ViewActions } from "../lib/view-registry";

/** What opening a link or file cell does; the one shape every view takes (`ViewActions`). */
export type CellActions = ViewActions;

const ERROR_TEXT = "text-[var(--danger)]";
const LINK_CLASS =
  "cursor-pointer truncate text-link underline-offset-2 hover:underline focus-visible:underline";

function ErrorBadge({ message }: { message: string }) {
  return (
    <span
      data-cell-error
      title={message}
      className={`inline-flex max-w-full items-center gap-1 truncate rounded-sm bg-[color-mix(in_srgb,var(--danger)_14%,transparent)] px-1.5 text-[11px] font-medium ${ERROR_TEXT}`}
    >
      <span aria-hidden="true">!</span>
      <span className="truncate">Error: {message}</span>
    </span>
  );
}

function Link({
  label,
  unresolved,
  path,
  onOpen,
}: {
  label: string;
  unresolved: boolean;
  /** The vault path the link points to: its icon (if any) shows before the label. */
  path?: string | null;
  onOpen: (intent: LinkIntent) => void;
}) {
  const link = linkHandlers({ kind: "custom", open: onOpen });
  const icon = useFileIcon(path);
  return (
    <button
      type="button"
      tabIndex={-1}
      data-cell-link
      data-unresolved={unresolved || undefined}
      title={unresolved ? `${label} (not found in the vault)` : label}
      {...link}
      // the cell must not start a selection or edit from a press on its link
      onMouseDown={(e) => {
        link.onMouseDown(e);
        e.stopPropagation();
      }}
      className={`${LINK_CLASS} ${unresolved ? "opacity-70" : ""} bg-transparent p-0 text-left`}
    >
      {icon ? (
        <IconGlyph
          value={icon.icon}
          color={icon.color}
          size={13}
          className="mr-1 align-[-0.15em]"
        />
      ) : null}
      {label}
    </button>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span
      data-cell-chip
      className="inline-flex max-w-[16ch] shrink-0 items-center truncate rounded-full bg-[var(--surface-subtle)] px-2 text-[11px] leading-[18px] text-text-secondary"
    >
      {children}
    </span>
  );
}

const URL_CHIP_CLASS =
  "inline-flex max-w-[16ch] shrink-0 items-center rounded-full bg-[var(--surface-subtle)] px-2 text-[11px] leading-[18px] text-text-secondary";

/** A text or a list of texts: the values a URL column shows as chips (anything else keeps its look). */
function isUrlCell(cell: Cell): boolean {
  if (cell.type === "string") return cell.value !== "";
  return (
    cell.type === "list" && cell.value.length > 0 && cell.value.every((i) => i.type === "string")
  );
}

/** The cell of a `url` property: each address as the core link chip (one shared component). */
function UrlCell({ cell }: { cell: Cell }) {
  const items = cell.type === "list" ? cell.value : [cell];
  return (
    <span className="flex min-w-0 items-center gap-1 overflow-hidden">
      {items.map((item, i) => (
        <UrlChip key={i} value={itemText(item)} className={URL_CHIP_CLASS} tabbable={false} />
      ))}
    </span>
  );
}

/** Whether the column is a note property the vault types as `url`. */
function useIsUrlColumn(columnKey: string): boolean {
  const property = propertyNamespace(columnKey) === "note" ? notePropertyName(columnKey) : null;
  return usePropertyTypesStore(
    (s) => property !== null && s.byKey[typeKey(property)]?.type === "url",
  );
}

function ListItem({ item, actions }: { item: CellValue; actions: CellActions }) {
  if (item.type === "link") {
    return (
      <Chip>
        <Link
          label={item.value.display ?? item.value.target}
          unresolved={item.value.resolved === null}
          path={item.value.resolved}
          onOpen={(intent) => actions.openLink(item.value, intent)}
        />
      </Chip>
    );
  }
  if (item.type === "error") {
    return (
      <Chip>
        <span data-cell-error title={item.value.message} className={ERROR_TEXT}>
          Error
        </span>
      </Chip>
    );
  }
  return <Chip>{itemText(item)}</Chip>;
}

interface Props {
  cell: Cell;
  /** Column key (`file.name` opens the row's file). */
  columnKey: string;
  rowPath: string;
  /** Why the cell cannot be edited, `null` when it can. */
  readOnlyReason: string | null;
  actions: CellActions;
  onToggle: () => void;
}

/** Display renderer of one cell. Never injects raw HTML: `html` values show their text. */
export function CellView({ cell, columnKey, rowPath, readOnlyReason, actions, onToggle }: Props) {
  const isUrl = useIsUrlColumn(columnKey);
  if (isUrl && isUrlCell(cell)) return <UrlCell cell={cell} />;
  switch (cell.type) {
    case "null":
      return null;
    case "error":
      return <ErrorBadge message={cell.value.message} />;
    case "boolean":
      return (
        <input
          type="checkbox"
          checked={cell.value}
          disabled={readOnlyReason !== null}
          title={readOnlyReason ?? undefined}
          aria-label={cell.value ? "Checked" : "Unchecked"}
          tabIndex={-1}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          onChange={onToggle}
          className="size-3.5 cursor-pointer accent-[var(--accent)] disabled:cursor-default"
        />
      );
    case "link":
      return (
        <Link
          label={cell.display}
          unresolved={cell.value.resolved === null}
          path={cell.value.resolved}
          onOpen={(intent) => actions.openLink(cell.value, intent)}
        />
      );
    case "file":
      return (
        <Link
          label={cell.display}
          unresolved={false}
          path={cell.value}
          onOpen={(intent) => actions.openFile(cell.value, intent)}
        />
      );
    case "list":
      return (
        <span className="flex min-w-0 items-center gap-1 overflow-hidden">
          {cell.value.map((item, i) => (
            <ListItem key={i} item={item} actions={actions} />
          ))}
        </span>
      );
    case "number":
      return <span className="truncate tabular-nums">{cell.display}</span>;
    default:
      if (columnKey === "file.name")
        return (
          <Link
            label={cell.display}
            unresolved={false}
            path={rowPath}
            onOpen={(intent) => actions.openFile(rowPath, intent)}
          />
        );
      return (
        <>
          {cell.type === "string" && propertyNamespace(columnKey) === "note" ? (
            <EnumValueIcon
              property={notePropertyName(columnKey)}
              value={cell.display}
              className="mr-1.5"
            />
          ) : null}
          <span className="truncate">{cell.display}</span>
        </>
      );
  }
}
