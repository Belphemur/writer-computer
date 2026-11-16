import { useId, useMemo, useState, type KeyboardEvent } from "react";
import { useFrontmatter } from "@/hooks/use-frontmatter";
import { usePropertiesPanel } from "@/hooks/use-properties-panel";
import {
  addProperty,
  appendListItem,
  initialValue,
  isBlank,
  NEW_PROPERTY_LABELS,
  NEW_PROPERTY_TYPES,
  newTypeFromIndex,
  parseProperties,
  removeListItem,
  removeProperty,
  renameProperty,
  setScalar,
  setTagString,
  summaryTags,
  type EditResult,
  type NewPropertyType,
} from "@/lib/frontmatter-properties";
import { PropertyKey, PropertyValue, type PropertyActions } from "./property-value";
import { useVaultPropertyKeys } from "./use-vault-property-keys";

interface PropertiesPanelProps {
  filePath: string;
}

const SUMMARY_TAGS = 3;
const BUTTON =
  "rounded px-1.5 py-0.5 text-[12px] leading-[1.3] text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-border)]";

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      aria-hidden="true"
      className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
    >
      <path
        d="M3.5 1.5L7 5l-3.5 3.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function focusOnMount(el: HTMLInputElement | null) {
  el?.focus();
}

interface AddRowProps {
  onAdd: (key: string, type: NewPropertyType) => boolean;
  onClose?: () => void;
  autoFocus: boolean;
}

/** Name (with the vault's known names as suggestions) and type of a new property. */
function AddPropertyRow({ onAdd, onClose, autoFocus }: AddRowProps) {
  const listId = useId();
  const vaultKeys = useVaultPropertyKeys();
  const [key, setKey] = useState("");
  const [picked, setPicked] = useState<NewPropertyType | null>(null);
  const known = vaultKeys.find((p) => p.key === key.trim());
  const type = picked ?? (known ? newTypeFromIndex(known.types, known.key) : "text");

  const submit = () => {
    if (key.trim() === "") return;
    if (onAdd(key, type)) {
      setKey("");
      setPicked(null);
      onClose?.();
    }
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      setKey("");
      onClose?.();
    }
  };
  return (
    <div className="flex items-center gap-2 pt-1">
      <input
        ref={autoFocus ? focusOnMount : undefined}
        type="text"
        list={listId}
        aria-label="New property name"
        placeholder="Property name"
        value={key}
        spellCheck={false}
        onChange={(e) => setKey(e.target.value)}
        onKeyDown={onKeyDown}
        className="min-w-0 flex-1 rounded bg-transparent px-1 -mx-1 text-[13px] leading-[1.4] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] placeholder:opacity-70 focus-visible:bg-[var(--surface-subtle)]"
      />
      <datalist id={listId}>
        {vaultKeys.slice(0, 200).map((p) => (
          <option key={p.key} value={p.key} />
        ))}
      </datalist>
      <select
        aria-label="New property type"
        value={type}
        onChange={(e) => setPicked(e.target.value as NewPropertyType)}
        className="rounded bg-transparent text-[12px] text-[var(--text-muted)] outline-none focus-visible:bg-[var(--surface-subtle)]"
      >
        {NEW_PROPERTY_TYPES.map((t) => (
          <option key={t} value={t}>
            {NEW_PROPERTY_LABELS[t]}
          </option>
        ))}
      </select>
      <button type="button" onClick={submit} disabled={key.trim() === ""} className={BUTTON}>
        Add
      </button>
    </div>
  );
}

/**
 * The note's properties as a collapsible panel above the editor. The frontmatter text in the
 * store is the source of truth: every edit is a byte-minimal splice of it
 * (`lib/frontmatter-properties.ts`), and the Source view edits the raw text. Collapsed, it is
 * one row (name, count, a few tags); expanded, its height is capped and scrolls inside.
 */
export function PropertiesPanel({ filePath }: PropertiesPanelProps) {
  const { frontmatter, hasFrontmatter, updateFrontmatter, removeFrontmatter } =
    useFrontmatter(filePath);
  const parsed = useMemo(() => parseProperties(frontmatter), [frontmatter]);
  const lines = frontmatter.trim() === "" ? 0 : frontmatter.split("\n").length;
  const { collapsed, toggleCollapsed, source, toggleSource } = usePropertiesPanel(filePath, {
    count: parsed.count,
    lines,
  });
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const bodyId = useId();

  if (!hasFrontmatter) return null;

  const apply = (result: EditResult): boolean => {
    if (!result.ok) {
      setError(result.error);
      return false;
    }
    setError(null);
    if (result.text !== frontmatter) updateFrontmatter(result.text);
    return true;
  };

  const actions: PropertyActions = {
    setValue: (key, value) => apply(setScalar(frontmatter, key, value)),
    rename: (key, to) => apply(renameProperty(frontmatter, key, to)),
    remove: (key) => {
      const result = removeProperty(frontmatter, key);
      if (result.ok && isBlank(result.text)) {
        setError(null);
        removeFrontmatter();
        return;
      }
      apply(result);
    },
    appendItem: (key, item) => apply(appendListItem(frontmatter, key, item)),
    removeItem: (key, index) => apply(removeListItem(frontmatter, key, index)),
    setTags: (key, tags) => apply(setTagString(frontmatter, key, tags)),
  };

  const rows = parsed.ok ? parsed.rows : [];
  const tags = summaryTags(rows);
  const showSource = source || !parsed.ok;

  return (
    <section data-frontmatter aria-label="Properties" className="pb-4">
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          onClick={toggleCollapsed}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded py-1 text-left text-[13px] leading-[1.3] text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-border)]"
        >
          <Chevron open={!collapsed} />
          <span className="shrink-0">Properties ({parsed.count})</span>
          {collapsed && tags.length > 0 && (
            <span className="flex min-w-0 items-center gap-1 overflow-hidden">
              {tags.slice(0, SUMMARY_TAGS).map((t, i) => (
                <span
                  key={`${i}:${t}`}
                  className="max-w-[10rem] truncate rounded-full bg-[var(--surface-subtle)] px-2 py-0.5 text-[12px] text-[var(--text-primary)]"
                >
                  {t}
                </span>
              ))}
              {tags.length > SUMMARY_TAGS && (
                <span className="shrink-0 text-[12px]">+{tags.length - SUMMARY_TAGS}</span>
              )}
            </span>
          )}
        </button>
        {!collapsed && parsed.ok && (
          <button
            type="button"
            aria-pressed={source}
            onClick={toggleSource}
            className={BUTTON}
            title="Edit the raw YAML"
          >
            Source
          </button>
        )}
      </div>

      {!collapsed && (
        <div id={bodyId} className="mt-1 max-h-[40vh] overflow-y-auto pr-1">
          {!parsed.ok && (
            <p role="alert" className="pb-1 text-[12px] leading-[1.4] text-[var(--text-muted)]">
              {parsed.message}
            </p>
          )}
          {error && (
            <p role="alert" className="pb-1 text-[12px] leading-[1.4] text-[var(--text-muted)]">
              {error}
            </p>
          )}
          {showSource ? (
            <textarea
              aria-label="Frontmatter source"
              value={frontmatter}
              rows={Math.min(Math.max(lines + 1, 3), 16)}
              spellCheck={false}
              onChange={(e) => {
                setError(null);
                updateFrontmatter(e.target.value);
              }}
              onKeyDown={(e) => e.stopPropagation()}
              className="block w-full resize-none rounded bg-[var(--surface-subtle)] p-2 font-mono text-[12px] leading-[1.5] text-[var(--text-primary)] outline-none focus-visible:ring-1 focus-visible:ring-[var(--focus-border)]"
            />
          ) : (
            <>
              <ul className="flex flex-col">
                {rows.map((row) => (
                  <li
                    key={row.key}
                    className="group -mx-3 flex items-baseline gap-4 rounded-lg px-3 py-1 focus-within:bg-[var(--surface-subtle)]"
                  >
                    <PropertyKey row={row} actions={actions} />
                    <PropertyValue row={row} actions={actions} />
                    <button
                      type="button"
                      aria-label={`Remove property ${row.key}`}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => actions.remove(row.key)}
                      className="flex h-5 w-5 shrink-0 items-center justify-center self-center rounded text-[var(--text-icon-muted)] opacity-0 transition-opacity hover:text-[var(--text-primary)] focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100"
                    >
                      <svg
                        width="10"
                        height="10"
                        viewBox="0 0 10 10"
                        fill="none"
                        aria-hidden="true"
                      >
                        <path
                          d="M2 2l6 6M8 2l-6 6"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                        />
                      </svg>
                    </button>
                  </li>
                ))}
              </ul>
              {adding || rows.length === 0 ? (
                <AddPropertyRow
                  autoFocus
                  onClose={rows.length === 0 ? undefined : () => setAdding(false)}
                  onAdd={(key, type) => apply(addProperty(frontmatter, key, initialValue(type)))}
                />
              ) : (
                <button type="button" onClick={() => setAdding(true)} className={`${BUTTON} mt-1`}>
                  + Add property
                </button>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
