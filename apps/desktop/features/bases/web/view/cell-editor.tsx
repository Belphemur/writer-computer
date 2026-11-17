import { useRef, useState } from "react";
import { PropertyEnumSelect } from "@/components/editor-area/enum-select";
import { typeKey } from "@/lib/property-types";
import { usePropertyTypesStore } from "@/stores/property-types-store";
import { rawToEditText, rawToListItems, type EditKind } from "../lib/cells";

interface Props {
  /** The note property behind the column: an enum property edits as the core dropdown. */
  property: string;
  kind: EditKind;
  /** Raw frontmatter value the editor starts from (`undefined`: the key is absent). */
  raw: unknown;
  /** Commit; returns `false` when the value is invalid and the editor must stay open. */
  onCommit: (value: { text: string } | { items: string[] }) => boolean;
  onCancel: () => void;
}

const INPUT_CLASS =
  "h-full w-full min-w-0 bg-[var(--surface-input)] px-2 text-[13px] text-text-primary outline-none ring-1 ring-inset ring-[var(--focus-border)]";

function inputTypeOf(kind: EditKind): string {
  if (kind === "date") return "date";
  if (kind === "datetime") return "datetime-local";
  return "text";
}

/** Initial text of a single-line editor; native date inputs need `YYYY-MM-DD[THH:mm]`. */
function initialText(kind: EditKind, raw: unknown): string {
  const text = rawToEditText(kind, raw);
  if (kind === "date") return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : "";
  if (kind === "datetime")
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text) ? text.slice(0, 16) : "";
  return text;
}

function TextEditor({ kind, raw, onCommit, onCancel }: Props) {
  const [text, setText] = useState(() => initialText(kind, raw));
  // Escape and Enter finish the edit themselves; the blur that follows must not commit again.
  const finished = useRef(false);

  const commit = () => {
    if (finished.current) return;
    // Set before committing: the commit moves focus away, and that blur must not commit again.
    finished.current = true;
    if (!onCommit({ text })) finished.current = false;
  };

  return (
    <input
      // eslint-disable-next-line jsx-a11y/no-autofocus
      autoFocus
      aria-label="Edit cell"
      type={inputTypeOf(kind)}
      inputMode={kind === "number" ? "decimal" : undefined}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          finished.current = true;
          onCancel();
        }
      }}
      className={INPUT_CLASS}
    />
  );
}

function ListEditor({ raw, onCommit, onCancel }: Props) {
  const [items, setItems] = useState(() => rawToListItems(raw));
  const [draft, setDraft] = useState("");
  const finished = useRef(false);

  const allItems = () => {
    const d = draft.trim();
    return d ? [...items, d] : items;
  };
  const commit = () => {
    if (finished.current) return;
    finished.current = true;
    if (!onCommit({ items: allItems() })) finished.current = false;
  };
  const addDraft = () => {
    const d = draft.trim();
    if (!d) return;
    setItems((cur) => [...cur, d]);
    setDraft("");
  };

  return (
    <div
      role="group"
      aria-label="Edit list"
      className="flex h-full w-full min-w-0 items-center gap-1 overflow-hidden bg-[var(--surface-input)] px-1 ring-1 ring-inset ring-[var(--focus-border)]"
      onBlur={(e) => {
        // Focus moving between the chip buttons and the input stays inside the editor.
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        commit();
      }}
    >
      {items.map((item, i) => (
        <span
          key={`${item}-${i}`}
          data-cell-chip
          className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[var(--surface-subtle)] px-2 text-[11px] leading-[18px] text-text-secondary"
        >
          {item}
          <button
            type="button"
            tabIndex={-1}
            aria-label={`Remove ${item}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setItems((cur) => cur.filter((_, j) => j !== i))}
            className="cursor-pointer bg-transparent p-0 text-text-muted hover:text-text-primary"
          >
            ×
          </button>
        </span>
      ))}
      <input
        // eslint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
        aria-label="Add item"
        value={draft}
        onChange={(e) => {
          const value = e.target.value;
          if (value.endsWith(",")) {
            const d = value.slice(0, -1).trim();
            if (d) setItems((cur) => [...cur, d]);
            setDraft("");
          } else {
            setDraft(value);
          }
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") {
            e.preventDefault();
            if (draft.trim()) addDraft();
            else commit();
          } else if (e.key === "Backspace" && draft === "" && items.length > 0) {
            e.preventDefault();
            setItems((cur) => cur.slice(0, -1));
          } else if (e.key === "Escape") {
            e.preventDefault();
            finished.current = true;
            onCancel();
          }
        }}
        className="h-full min-w-[6ch] flex-1 bg-transparent text-[13px] text-text-primary outline-none"
      />
    </div>
  );
}

/** The enum dropdown of a text cell (the one `EnumSelect` of the properties panel): a pick commits
 *  at once, "No value" clears the cell, closing the list cancels. */
function EnumEditor({ property, raw, onCommit, onCancel }: Props) {
  return (
    <PropertyEnumSelect
      name={property}
      value={raw === undefined || raw === null ? null : String(raw)}
      defaultOpen
      onSelect={(v) => {
        onCommit({ text: v ?? "" });
      }}
      onDismiss={onCancel}
      className="h-full bg-[var(--surface-input)] px-2 ring-1 ring-inset ring-[var(--focus-border)]"
    />
  );
}

/** The editor of one cell, by kind. Checkboxes never get one: they toggle in place. */
export function CellEditor(props: Props) {
  const isEnum =
    usePropertyTypesStore((s) => s.byKey[typeKey(props.property)]?.type) === "enum" &&
    props.kind === "text";
  if (isEnum) return <EnumEditor {...props} />;
  return props.kind === "list" ? <ListEditor {...props} /> : <TextEditor {...props} />;
}
