import { getFileStem } from "@/lib/paths";
import { useEffect, useId, useMemo, useState } from "react";
import { useFrontmatter } from "@/hooks/use-frontmatter";
import { usePropertiesPanel } from "@/hooks/use-properties-panel";
import {
  addProperty,
  appendListItem,
  initialValue,
  isBlank,
  parseProperties,
  removeListItem,
  removeProperty,
  renameProperty,
  setScalar,
  setTagString,
  summaryTags,
  type EditResult,
  type PropertyRow,
} from "@/lib/frontmatter-properties";
import { addNested, removeNested, renameNested, setNested } from "@/lib/frontmatter-nested";
import { convertProperty, plainLinkCandidates } from "@/lib/property-conversion";
import {
  addRelationship,
  linkForNote,
  removeRelationship,
  resolveLinkNames,
} from "@/lib/relationships";
import * as tauri from "@/lib/tauri";
import {
  PROPERTY_TYPES,
  rowFitsType,
  typeKey,
  typeOfRow,
  type PropertyType,
} from "@/lib/property-types";
import { usePropertyTypesStore } from "@/stores/property-types-store";
import { AddPropertyRow } from "./add-property-row";
import { PropertyTypeControl } from "./property-type-control";
import { Chevron, RemoveRowButton } from "./property-chip";
import { PropertyKey, PropertyValue, type PropertyActions } from "./property-value";

interface PropertiesPanelProps {
  filePath: string;
}

const SUMMARY_TAGS = 3;
const BUTTON =
  "rounded px-1.5 py-0.5 text-[12px] leading-[1.3] text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-border)]";

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
  const typeInfo = usePropertyTypesStore((s) => s.byKey);
  const loadTypes = usePropertyTypesStore((s) => s.load);
  const setType = usePropertyTypesStore((s) => s.setType);
  useEffect(() => {
    if (hasFrontmatter) void loadTypes().catch(() => {}); // no index yet: types are inferred per row
  }, [hasFrontmatter, loadTypes]);

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
    path: [],
    nested: {
      set: (path, value) => apply(setNested(frontmatter, path, value)),
      add: (path, value) => apply(addNested(frontmatter, path, value)),
      remove: (path) => apply(removeNested(frontmatter, path)),
      rename: (path, to) => apply(renameNested(frontmatter, path, to)),
    },
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
    addLink: async (row, file) => {
      const link = await linkForNote(file, tauri.fuzzySearch);
      return apply(addRelationship(frontmatter, row, link));
    },
    removeLink: (row, index) => apply(removeRelationship(frontmatter, row, index)),
  };

  /** The row's type: the declared one (Writer's or Obsidian's record), else what its own value is;
   *  `mixed` counts the other notes that use a different type. */
  const typeOf = (row: PropertyRow): { type: PropertyType; mixed: number } => {
    const info = typeInfo[typeKey(row.key)];
    if (info && info.source !== "inferred") return { type: info.type, mixed: info.mismatched };
    return { type: typeOfRow(row), mixed: info?.mismatched ?? 0 };
  };

  /** Record the type vault-wide, and convert THIS note's value as one frontmatter update (one undo
   *  step). A value that cannot be converted is left as it is and shows as not fitting the type. */
  const changeType = async (row: PropertyRow, to: PropertyType) => {
    // plain text becomes a link only when it resolves by file name (the one async step)
    const linkNames =
      to === "relationships"
        ? await resolveLinkNames(plainLinkCandidates(row), (t) =>
            tauri.resolveWikiLinkTarget(t, null),
          )
        : undefined;
    const result = convertProperty(frontmatter, row, to, linkNames);
    if (result.ok) {
      setError(null);
      if (result.text !== frontmatter) updateFrontmatter(result.text);
    }
    setType(row.key, to).catch((e) =>
      setError(
        `Could not save the type of "${row.key}": ${e instanceof Error ? e.message : String(e)}`,
      ),
    );
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
                {rows.map((row) => {
                  const { type, mixed } = typeOf(row);
                  const fits = rowFitsType(row, type);
                  return (
                    <li
                      key={row.key}
                      className="group -mx-3 flex items-baseline gap-4 rounded-lg px-3 py-1 focus-within:bg-[var(--surface-subtle)]"
                    >
                      <span className="-mr-2.5 flex self-center">
                        <PropertyTypeControl
                          name={row.key}
                          type={type}
                          fits={fits}
                          mismatched={mixed}
                          onChange={(t) => void changeType(row, t)}
                        />
                      </span>
                      <PropertyKey row={row} actions={actions} />
                      <PropertyValue row={row} actions={actions} type={type} />
                      {!fits && (
                        <span
                          role="status"
                          className="shrink-0 self-center text-[12px] leading-[1.3] text-[var(--warning)]"
                        >
                          {PROPERTY_TYPES[type].warning}
                        </span>
                      )}
                      <RemoveRowButton
                        label={`Remove property ${row.key}`}
                        onRemove={() => actions.remove(row.key)}
                      />
                    </li>
                  );
                })}
              </ul>
              {rows.some((row) => row.key === "title") && (
                <p className="pt-1 text-[12px] leading-[1.4] text-[var(--text-muted)]">
                  title overrides the displayed name of this note. The file name stays{" "}
                  {getFileStem(filePath)}.
                </p>
              )}
              {adding || rows.length === 0 ? (
                <AddPropertyRow
                  autoFocus
                  onClose={rows.length === 0 ? undefined : () => setAdding(false)}
                  onAdd={(key, type, picked) => {
                    const added = apply(addProperty(frontmatter, key, initialValue(type)));
                    if (added && picked) void setType(key, type).catch(() => {});
                    return added;
                  }}
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
