import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { type PropertyRow } from "@/lib/frontmatter-properties";
import { isWikiLink } from "@/lib/wiki-links";
import { linkHandlers } from "@/lib/link-activation";
import { openPropertyUrl } from "./property-links";
import { CHIP, ChipRemove, Chevron, FIELD, RemoveRowButton } from "./property-chip";
import { useWikiSuggest, WikiLinkButton } from "./property-wikilink";
import { RelationshipsField } from "./relationships-field";
import { UrlField } from "./url-field";
import { isUrlRow } from "@/lib/url-property";
import { PropertyEnumSelect } from "./enum-select";
import type { SearchResult } from "@/types/fs";
import type { PropertyType } from "@/lib/property-types";
import type { NestedPath, NestedValue } from "@/lib/frontmatter-nested";

/** Edits of one key inside a property's map, by path (`["metadata", "version"]`). */
export interface NestedActions {
  set: (path: NestedPath, value: NestedValue) => boolean;
  add: (path: NestedPath, value: NestedValue) => boolean;
  remove: (path: NestedPath) => boolean;
  rename: (path: NestedPath, to: string) => boolean;
}

/** What a row can do to the frontmatter text. Each returns whether the edit was applied. For the
 *  keys of an object property the same shape is scoped to the map (`scopeActions`): `key` is then
 *  the key inside it and `path` the names above it. */
export interface PropertyActions {
  /** The property names above the rows these actions edit (empty for top-level rows). */
  path: readonly string[];
  nested: NestedActions;
  setValue: (key: string, value: string | number | boolean | null) => boolean;
  rename: (key: string, to: string) => boolean;
  remove: (key: string) => void;
  appendItem: (key: string, item: string) => boolean;
  removeItem: (key: string, index: number) => boolean;
  setTags: (key: string, tags: string[]) => boolean;
  /** Relationships: add the picked note as a link (single stays single, a second makes a list). */
  addLink: (row: PropertyRow, file: SearchResult) => Promise<boolean>;
  removeLink: (row: PropertyRow, index: number) => boolean;
  /** URL: add the typed text as another address (as written; single stays single, a second makes a list). */
  addUrl: (row: PropertyRow, url: string) => boolean;
  removeUrl: (row: PropertyRow, index: number) => boolean;
}

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

/** The row's accessible name: its key, with the names above it for a key inside an object. */
export function rowLabel(row: PropertyRow, actions: PropertyActions): string {
  return [...actions.path, row.key].join(".");
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
  const suggest = useWikiSuggest();
  const keys = commitKeys(commit);
  return (
    <>
      <input
        key={stored}
        type={type}
        step={step}
        aria-label={`${rowLabel(row, actions)} value`}
        defaultValue={stored}
        placeholder="empty"
        spellCheck={false}
        onInput={type === "text" ? suggest.onInput : undefined}
        onBlur={(e) => commit(e.currentTarget)}
        onKeyDown={(e) => !suggest.onKeyDown(e) && keys(e)}
        className={`${FIELD} ${row.placeholder ? "font-mono" : ""}`}
      />
      {suggest.menu}
    </>
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
      aria-label={`${rowLabel(row, actions)} value`}
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
      aria-label={`${rowLabel(row, actions)} value`}
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
  const suggest = useWikiSuggest();
  const value = String(row.value ?? "");
  const isUrl = row.kind === "url";
  if (editing) {
    return (
      <>
        <input
          ref={focusOnMount}
          type="text"
          aria-label={`${rowLabel(row, actions)} value`}
          defaultValue={value}
          spellCheck={false}
          onInput={suggest.onInput}
          onBlur={(e) => {
            if (e.currentTarget.value !== value)
              actions.setValue(
                row.key,
                e.currentTarget.value === "" ? null : e.currentTarget.value,
              );
            setEditing(false);
          }}
          onKeyDown={(e) => {
            if (suggest.onKeyDown(e)) return;
            e.stopPropagation();
            if (e.key === "Enter") e.currentTarget.blur();
            else if (e.key === "Escape") {
              e.currentTarget.value = value;
              e.currentTarget.blur();
            }
          }}
          className={FIELD}
        />
        {suggest.menu}
      </>
    );
  }
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      {isUrl ? (
        <button
          type="button"
          {...linkHandlers({ kind: "custom", open: () => void openPropertyUrl(value) })}
          onMouseDown={(e) => e.preventDefault()}
          title={value}
          className="min-w-0 truncate text-left text-[13px] leading-[1.4] text-[var(--accent)] underline-offset-2 hover:underline"
        >
          {value}
        </button>
      ) : (
        <WikiLinkButton value={value} />
      )}
      <button
        type="button"
        aria-label={`Edit ${rowLabel(row, actions)}`}
        onClick={() => setEditing(true)}
        className="shrink-0 rounded px-1 text-[12px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
      >
        Edit
      </button>
    </span>
  );
}

function ChipsField({ row, actions, after }: FieldProps & { after?: ReactNode }) {
  const input = useRef<HTMLInputElement>(null);
  const suggest = useWikiSuggest();
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
          {isWikiLink(item) ? (
            <WikiLinkButton value={item} />
          ) : (
            <span className="min-w-0 break-words">{item}</span>
          )}
          <ChipRemove label={item} onRemove={() => remove(i)} />
        </span>
      ))}
      {after}
      <input
        ref={input}
        type="text"
        aria-label={`Add to ${rowLabel(row, actions)}`}
        placeholder={row.items.length === 0 ? "add" : "+"}
        spellCheck={false}
        onInput={suggest.onInput}
        onBlur={(e) => add(e.currentTarget)}
        onKeyDown={(e) => {
          if (suggest.onKeyDown(e)) return;
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
      {suggest.menu}
    </span>
  );
}

/** The actions of the keys of `row` (an object): each edit is a nested edit under its path. */
function scopeActions(actions: PropertyActions, row: PropertyRow): PropertyActions {
  const path = [...actions.path, row.key];
  const at = (key: string) => [...path, key];
  const items = (key: string) => row.entries.find((e) => e.key === key)?.items ?? [];
  const { nested } = actions;
  return {
    path,
    nested,
    setValue: (key, value) => nested.set(at(key), value),
    rename: (key, to) => nested.rename(at(key), to),
    remove: (key) => void nested.remove(at(key)),
    appendItem: (key, item) => nested.set(at(key), [...items(key), item]),
    removeItem: (key, index) =>
      nested.set(
        at(key),
        items(key).filter((_, i) => i !== index),
      ),
    // keys inside an object are never tags or relationships
    setTags: () => false,
    addLink: () => Promise.resolve(false),
    removeLink: () => false,
    addUrl: () => false,
    removeUrl: () => false,
  };
}

/** The name of a key being added to an object: Enter adds it with an empty value, Escape cancels. */
function AddKeyRow({ onAdd }: { onAdd: (name: string) => boolean }) {
  const [adding, setAdding] = useState(false);
  if (!adding)
    return (
      <button
        type="button"
        onClick={() => setAdding(true)}
        className="rounded px-1 text-[12px] leading-[1.4] text-[var(--text-muted)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-border)]"
      >
        + Add key
      </button>
    );
  return (
    <input
      ref={focusOnMount}
      type="text"
      aria-label="New key name"
      placeholder="key"
      spellCheck={false}
      onBlur={() => setAdding(false)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          const name = e.currentTarget.value.trim();
          if (name !== "" && onAdd(name)) setAdding(false);
        } else if (e.key === "Escape") {
          e.preventDefault();
          setAdding(false);
        }
      }}
      className={`${FIELD} flex-none`}
    />
  );
}

/** A map (two levels) as indented key/value rows. Each key is a row of its own, edited in place
 *  by the same fields as a property; a level-2 map nests the same block again. */
function ObjectField({ row, actions }: FieldProps) {
  const [open, setOpen] = useState(true);
  const scoped = scopeActions(actions, row);
  const count = row.entries.length;
  const name = rowLabel(row, actions);
  return (
    <div className="min-w-0 flex-1">
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${name} keys`}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 rounded text-left text-[12px] leading-[1.4] text-[var(--text-muted)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-border)]"
      >
        <Chevron open={open} />
        {count === 0 ? "Empty" : `${count} ${count === 1 ? "key" : "keys"}`}
      </button>
      {open && (
        <ul className="mt-0.5 ml-1 border-l border-[var(--border-color)] pl-3">
          {row.entries.map((entry) => (
            <li key={entry.key} className="group flex items-baseline gap-3 py-0.5">
              <PropertyKey row={entry} actions={scoped} />
              <PropertyValue row={entry} actions={scoped} />
              <RemoveRowButton
                label={`Remove ${rowLabel(entry, scoped)}`}
                onRemove={() => scoped.remove(entry.key)}
              />
            </li>
          ))}
          <li className="py-0.5">
            <AddKeyRow onAdd={(key) => scoped.nested.add([...scoped.path, key], null)} />
          </li>
        </ul>
      )}
    </div>
  );
}

function ReadOnlyField({ row }: { row: PropertyRow }) {
  return (
    <span className="min-w-0 flex-1">
      <span
        title="Edit this value in Source"
        className="block whitespace-pre-wrap break-words font-mono text-[12px] leading-[1.4] text-[var(--text-primary)]"
      >
        {row.source}
      </span>
      {row.kind === "object" && (
        <span className="text-[12px] text-[var(--text-muted)]">Edit in Source</span>
      )}
    </span>
  );
}

/** The value cell of one row, chosen by the row's kind. `afterChips` (the tags row only): read-only
 *  chips shown after the row's own chips. */
export function PropertyValue({
  row,
  actions,
  type,
  afterChips,
}: FieldProps & { type?: PropertyType; afterChips?: ReactNode }) {
  if (
    type === "relationships" &&
    (row.kind === "link" || row.kind === "empty" || (row.kind === "list" && row.editable))
  )
    return <RelationshipsField row={row} actions={actions} />;
  if (type === "url" && isUrlRow(row)) return <UrlField row={row} actions={actions} />;
  if (type === "enum" && (row.kind === "text" || row.kind === "empty"))
    return (
      <PropertyEnumSelect
        name={row.key}
        value={row.value === null ? null : String(row.value)}
        onSelect={(v) => actions.setValue(row.key, v)}
      />
    );
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
      return <ChipsField row={row} actions={actions} after={afterChips} />;
    case "object":
      return row.editable ? (
        <ObjectField row={row} actions={actions} />
      ) : (
        <ReadOnlyField row={row} />
      );
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
      aria-label={`Property name ${rowLabel(row, actions)}`}
      defaultValue={row.key}
      spellCheck={false}
      onBlur={(e) => commit(e.currentTarget)}
      onKeyDown={commitKeys(commit)}
      className="w-[clamp(5rem,28%,10rem)] shrink-0 truncate rounded bg-transparent px-1 -mx-1 text-[13px] leading-[1.4] text-[var(--text-muted)] outline-none focus-visible:bg-[var(--surface-subtle)]"
    />
  );
}
