import { useRef, useState, type KeyboardEvent } from "react";
import type { PropertyRow } from "@/lib/frontmatter-properties";
import { openPropertyUrl, openPropertyWikilink } from "./property-links";

/** What a row can do to the frontmatter text. Each returns whether the edit was applied. */
export interface PropertyActions {
  setValue: (key: string, value: string | number | boolean | null) => boolean;
  rename: (key: string, to: string) => boolean;
  remove: (key: string) => void;
  appendItem: (key: string, item: string) => boolean;
  removeItem: (key: string, index: number) => boolean;
  setTags: (key: string, tags: string[]) => boolean;
}

const FIELD =
  "min-w-0 flex-1 rounded bg-transparent px-1 -mx-1 text-[13px] leading-[1.4] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] placeholder:opacity-70 focus-visible:bg-[var(--surface-subtle)]";
const CHIP =
  "inline-flex max-w-full items-center gap-1 rounded-full bg-[var(--surface-subtle)] px-2 py-0.5 text-[12px] leading-[1.3] text-[var(--text-primary)]";

/** Enter commits, Escape reverts, and neither reaches the editor's key handlers. */
function commitKeys(commit: (el: HTMLInputElement) => void) {
  return (e: KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      commit(e.currentTarget);
      e.currentTarget.blur();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.currentTarget.value = e.currentTarget.defaultValue;
      e.currentTarget.blur();
    }
  };
}

interface FieldProps {
  row: PropertyRow;
  actions: PropertyActions;
}

/** A single-line field committed on blur/Enter. Keyed by the stored value so an outside change
 *  (reload, source edit) replaces the draft. */
function TextField({
  row,
  actions,
  type = "text",
  step,
}: FieldProps & { type?: string; step?: number }) {
  const stored = row.value === null ? "" : String(row.value);
  const commit = (el: HTMLInputElement) => {
    if (el.value === el.defaultValue) return;
    if (type === "number") {
      const n = Number(el.value);
      if (el.value.trim() === "" || !Number.isFinite(n)) {
        el.value = el.defaultValue;
        return;
      }
      if (!actions.setValue(row.key, n)) el.value = el.defaultValue;
      return;
    }
    const value = el.value === "" ? null : el.value;
    if (!actions.setValue(row.key, value)) el.value = el.defaultValue;
  };
  return (
    <input
      key={stored}
      type={type}
      step={step}
      aria-label={`${row.key} value`}
      defaultValue={stored}
      placeholder="empty"
      spellCheck={false}
      onBlur={(e) => commit(e.currentTarget)}
      onKeyDown={commitKeys(commit)}
      className={`${FIELD} ${row.placeholder ? "font-mono" : ""}`}
    />
  );
}

function DateField({ row, actions, time }: FieldProps & { time: boolean }) {
  const stored = String(row.value ?? "");
  const spaced = / /.test(stored);
  const seconds = /:\d{2}:\d{2}$/.test(stored);
  const shown = time ? stored.replace(" ", "T") : stored;
  return (
    <input
      key={stored}
      type={time ? "datetime-local" : "date"}
      step={time && seconds ? 1 : undefined}
      aria-label={`${row.key} value`}
      defaultValue={shown}
      onChange={(e) => {
        const v = e.currentTarget.value;
        if (v === "") return;
        actions.setValue(row.key, time && spaced ? v.replace("T", " ") : v);
      }}
      onKeyDown={(e) => e.stopPropagation()}
      className={`${FIELD} flex-none`}
    />
  );
}

function CheckboxField({ row, actions }: FieldProps) {
  return (
    <input
      type="checkbox"
      aria-label={`${row.key} value`}
      checked={row.value === true}
      onChange={(e) => actions.setValue(row.key, e.currentTarget.checked)}
      onKeyDown={(e) => e.stopPropagation()}
      className="h-3.5 w-3.5 accent-[var(--accent)]"
    />
  );
}

function focusOnMount(el: HTMLInputElement | null) {
  el?.focus();
}

function LinkField({ row, actions }: FieldProps) {
  const [editing, setEditing] = useState(false);
  const value = String(row.value ?? "");
  const label =
    value
      .replace(/^\[\[|\]\]$/g, "")
      .split("|")
      .pop() ?? value;
  const isUrl = row.kind === "url";
  if (editing) {
    return (
      <input
        ref={focusOnMount}
        type="text"
        aria-label={`${row.key} value`}
        defaultValue={value}
        spellCheck={false}
        onBlur={(e) => {
          if (e.currentTarget.value !== value)
            actions.setValue(row.key, e.currentTarget.value === "" ? null : e.currentTarget.value);
          setEditing(false);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") e.currentTarget.blur();
          else if (e.key === "Escape") {
            e.currentTarget.value = value;
            e.currentTarget.blur();
          }
        }}
        className={FIELD}
      />
    );
  }
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => void (isUrl ? openPropertyUrl(value) : openPropertyWikilink(value))}
        title={value}
        className="min-w-0 truncate text-left text-[13px] leading-[1.4] text-[var(--accent)] underline-offset-2 hover:underline"
      >
        {label}
      </button>
      <button
        type="button"
        aria-label={`Edit ${row.key}`}
        onClick={() => setEditing(true)}
        className="shrink-0 rounded px-1 text-[12px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
      >
        Edit
      </button>
    </span>
  );
}

function ChipRemove({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <button
      type="button"
      aria-label={`Remove ${label}`}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onRemove}
      className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full text-[var(--text-icon-muted)] hover:text-[var(--text-primary)]"
    >
      <svg width="8" height="8" viewBox="0 0 10 10" fill="none" aria-hidden="true">
        <path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    </button>
  );
}

function ChipsField({ row, actions }: FieldProps) {
  const input = useRef<HTMLInputElement>(null);
  const tagString = row.kind === "tagString";
  const add = (el: HTMLInputElement) => {
    const raw = el.value.trim();
    if (raw === "") return;
    const ok = tagString
      ? actions.setTags(row.key, [...row.items, ...raw.replace(/^#/, "").split(/[\s,]+/)])
      : actions.appendItem(row.key, row.kind === "tags" ? raw.replace(/^#/, "") : raw);
    if (ok) el.value = "";
  };
  const remove = (i: number) =>
    tagString
      ? actions.setTags(
          row.key,
          row.items.filter((_, j) => j !== i),
        )
      : actions.removeItem(row.key, i);
  return (
    <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
      {row.items.map((item, i) => (
        <span key={`${i}:${item}`} className={CHIP}>
          <span className="min-w-0 break-words">{item}</span>
          <ChipRemove label={item} onRemove={() => remove(i)} />
        </span>
      ))}
      <input
        ref={input}
        type="text"
        aria-label={`Add to ${row.key}`}
        placeholder={row.items.length === 0 ? "add" : "+"}
        spellCheck={false}
        onBlur={(e) => add(e.currentTarget)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            add(e.currentTarget);
          } else if (
            e.key === "Backspace" &&
            e.currentTarget.value === "" &&
            row.items.length > 0
          ) {
            remove(row.items.length - 1);
          }
        }}
        className={`${FIELD} min-w-[3.5rem] flex-none`}
      />
    </span>
  );
}

function ReadOnlyField({ row }: { row: PropertyRow }) {
  if (row.kind === "map") {
    return (
      <dl className="min-w-0 flex-1 space-y-0.5 text-[13px] leading-[1.4]">
        {row.nested.map((n, i) => (
          <div key={`${i}:${n.key}`} className="flex gap-2">
            <dt className="shrink-0 text-[var(--text-muted)]">{n.key}</dt>
            <dd className="min-w-0 whitespace-pre-wrap break-words text-[var(--text-primary)]">
              {n.text}
            </dd>
          </div>
        ))}
        <p className="text-[12px] text-[var(--text-muted)]">Edit nested properties in Source.</p>
      </dl>
    );
  }
  return (
    <span
      title="Edit this value in Source"
      className="min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-[12px] leading-[1.4] text-[var(--text-primary)]"
    >
      {row.source}
    </span>
  );
}

/** The value cell of one row, chosen by the row's kind. */
export function PropertyValue({ row, actions }: FieldProps) {
  switch (row.kind) {
    case "checkbox":
      return <CheckboxField row={row} actions={actions} />;
    case "date":
      return <DateField row={row} actions={actions} time={false} />;
    case "datetime":
      return <DateField row={row} actions={actions} time />;
    case "link":
    case "url":
      return <LinkField row={row} actions={actions} />;
    case "list":
    case "tags":
    case "tagString":
      return <ChipsField row={row} actions={actions} />;
    case "number":
      return row.editable ? (
        <TextField row={row} actions={actions} type="number" />
      ) : (
        <ReadOnlyField row={row} />
      );
    case "text":
    case "empty":
      return <TextField row={row} actions={actions} />;
    default:
      return <ReadOnlyField row={row} />;
  }
}

/** The key cell: renamed on blur/Enter. */
export function PropertyKey({ row, actions }: FieldProps) {
  const commit = (el: HTMLInputElement) => {
    if (el.value === el.defaultValue) return;
    if (!actions.rename(row.key, el.value)) el.value = el.defaultValue;
  };
  return (
    <input
      key={row.key}
      type="text"
      aria-label={`Property name ${row.key}`}
      defaultValue={row.key}
      spellCheck={false}
      onBlur={(e) => commit(e.currentTarget)}
      onKeyDown={commitKeys(commit)}
      className="w-[clamp(5rem,28%,10rem)] shrink-0 truncate rounded bg-transparent px-1 -mx-1 text-[13px] leading-[1.4] text-[var(--text-muted)] outline-none focus-visible:bg-[var(--surface-subtle)]"
    />
  );
}
