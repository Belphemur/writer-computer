import { itemText } from "@/lib/bases/cells";
import type { Cell, CellValue } from "@/lib/bases/types";
import type { ViewActions } from "@/lib/bases/view-registry";

/** What opening a link or file cell does; the one shape every view takes (`ViewActions`). */
export type CellActions = ViewActions;

const ERROR_TEXT = "text-[var(--danger,#e5484d)]";
const LINK_CLASS =
  "cursor-pointer truncate text-link underline-offset-2 hover:underline focus-visible:underline";

function ErrorBadge({ message }: { message: string }) {
  return (
    <span
      data-cell-error
      title={message}
      className={`inline-flex max-w-full items-center gap-1 truncate rounded-sm bg-[color-mix(in_srgb,var(--danger,#e5484d)_14%,transparent)] px-1.5 text-[11px] font-medium ${ERROR_TEXT}`}
    >
      <span aria-hidden="true">!</span>
      <span className="truncate">Error: {message}</span>
    </span>
  );
}

function Link({
  label,
  unresolved,
  onOpen,
}: {
  label: string;
  unresolved: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      tabIndex={-1}
      data-cell-link
      data-unresolved={unresolved || undefined}
      title={unresolved ? `${label} (not found in the vault)` : label}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
      className={`${LINK_CLASS} ${unresolved ? "opacity-70" : ""} bg-transparent p-0 text-left`}
    >
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

function ListItem({ item, actions }: { item: CellValue; actions: CellActions }) {
  if (item.type === "link") {
    return (
      <Chip>
        <Link
          label={item.value.display ?? item.value.target}
          unresolved={item.value.resolved === null}
          onOpen={() => actions.openLink(item.value)}
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
          onOpen={() => actions.openLink(cell.value)}
        />
      );
    case "file":
      return (
        <Link label={cell.display} unresolved={false} onOpen={() => actions.openFile(cell.value)} />
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
          <Link label={cell.display} unresolved={false} onOpen={() => actions.openFile(rowPath)} />
        );
      return <span className="truncate">{cell.display}</span>;
  }
}
