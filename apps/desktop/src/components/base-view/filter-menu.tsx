import { useEffect, useRef, useState } from "react";
import { setFilters } from "@/lib/bases/base-yaml";
import {
  FILTER_MODE_LABELS,
  FILTER_OPERATORS,
  compileRow,
  filterOf,
  isLeaf,
  modelOf,
  parseRow,
  validationBase,
  type FilterMode,
  type FilterModel,
  type FilterOperator,
  type FilterRow,
} from "@/lib/bases/filter-builder";
import { baseQueryText } from "@/lib/bases/ipc";
import type { BaseFilter } from "@/lib/bases/types";
import type { MenuContext } from "./menu-context";
import { PropertySelect, useVaultProperties } from "./property-select";
import { FIELD, SMALL_BUTTON, ToolbarMenu } from "./toolbar-menu";
import { errorMessage } from "./use-base-query";

type Scope = "view" | "base";

/** Validation state of one expression: `null` valid, a message invalid; no entry means pending. */
type Check = string | null;

const DEBOUNCE_MS = 250;

/**
 * Live validation of expressions through `base_query_text`: each distinct expression is checked
 * once (debounced), stale answers are dropped by a generation counter. Returns the check state per
 * expression; an expression with no answer yet has no entry.
 */
function useExpressionChecks(path: string, expressions: readonly string[]): Map<string, Check> {
  const [checks, setChecks] = useState<Map<string, Check>>(new Map());
  const generation = useRef(0);
  const key = JSON.stringify(expressions);

  useEffect(() => {
    const todo = [...new Set(expressions)].filter((e) => !checks.has(e));
    if (todo.length === 0) return;
    const gen = ++generation.current;
    const timer = setTimeout(() => {
      for (const expr of todo) {
        if (expr.trim() === "") {
          setChecks((c) => new Map(c).set(expr, "The expression is empty"));
          continue;
        }
        baseQueryText({
          text: validationBase(expr),
          thisPath: path,
          nowOffsetMinutes: -new Date().getTimezoneOffset(),
        }).then(
          (r) => {
            if (gen !== generation.current) return;
            setChecks((c) => new Map(c).set(expr, r.error ? r.error.message : null));
          },
          (e) => {
            if (gen !== generation.current) return;
            setChecks((c) => new Map(c).set(expr, errorMessage(e)));
          },
        );
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // `checks` is read to skip known expressions; `key` is the real trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, path]);

  return checks;
}

function RowEditor({
  row,
  ctx,
  vault,
  onChange,
}: {
  row: FilterRow;
  ctx: MenuContext;
  vault: ReturnType<typeof useVaultProperties>["properties"];
  onChange: (row: FilterRow) => void;
}) {
  const def = FILTER_OPERATORS.find((o) => o.id === row.operator)!;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <PropertySelect
        label="Filter property"
        value={row.property}
        document={ctx.document}
        vault={vault}
        onChange={(property) => onChange({ ...row, property })}
      />
      <select
        aria-label="Filter operator"
        value={row.operator}
        onChange={(e) => onChange({ ...row, operator: e.target.value as FilterOperator })}
        className={FIELD}
      >
        {FILTER_OPERATORS.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
      {def.needsValue ? (
        <input
          aria-label="Filter value"
          value={row.value}
          onChange={(e) => onChange({ ...row, value: e.target.value })}
          className={`${FIELD} w-28`}
        />
      ) : null}
    </div>
  );
}

function FilterBody({ ctx, close }: { ctx: MenuContext; close: () => void }) {
  const { properties: vault, error } = useVaultProperties();
  const [scope, setScope] = useState<Scope>("view");
  const initial = (s: Scope) => modelOf(s === "view" ? ctx.view.filters : ctx.document.filters);
  const [model, setModel] = useState<FilterModel>(() => initial("view"));
  /** Leaves the user chose to edit as raw expressions (by index). */
  const [raw, setRaw] = useState<ReadonlySet<number>>(new Set());

  const leaves = model.items.filter(isLeaf);
  const checks = useExpressionChecks(ctx.path, leaves);
  const status = (expr: string): Check | undefined => checks.get(expr);
  const blocked = leaves.some((e) => status(e) !== null);

  const setItems = (items: BaseFilter[]) => setModel((m) => ({ ...m, items }));
  const replace = (i: number, item: BaseFilter) =>
    setItems(model.items.map((x, j) => (j === i ? item : x)));

  const save = async () => {
    const ok = await ctx.apply((t) =>
      setFilters(t, scope === "view" ? ctx.viewIndex : "base", filterOf(model)),
    );
    if (ok) close();
  };

  return (
    <div className="flex flex-col gap-2.5">
      {error ? (
        <div role="alert" className="text-[12px] text-[var(--danger,#e5484d)]">
          {error}
        </div>
      ) : null}
      <div role="group" aria-label="Filter scope" className="flex gap-1.5">
        {(["view", "base"] as const).map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={scope === s}
            onClick={() => {
              setScope(s);
              setModel(initial(s));
              setRaw(new Set());
            }}
            className={`${SMALL_BUTTON} ${scope === s ? "bg-[var(--surface-selected)]" : ""}`}
          >
            {s === "view" ? "This view" : "All views"}
          </button>
        ))}
      </div>
      <select
        aria-label="Combine filters"
        value={model.mode}
        onChange={(e) => setModel((m) => ({ ...m, mode: e.target.value as FilterMode }))}
        className={FIELD}
      >
        {(Object.keys(FILTER_MODE_LABELS) as FilterMode[]).map((m) => (
          <option key={m} value={m}>
            {FILTER_MODE_LABELS[m]}
          </option>
        ))}
      </select>

      {model.items.length === 0 ? <div className="text-text-muted">No filters</div> : null}
      {model.items.map((item, i) => {
        if (!isLeaf(item)) {
          return (
            <div
              key={i}
              data-filter-nested
              className="flex items-center gap-1.5 text-text-secondary"
            >
              <span className="min-w-0 flex-1">
                A nested group (kept as is; edit the YAML to change it)
              </span>
              <button
                type="button"
                aria-label={`Remove filter ${i + 1}`}
                className={SMALL_BUTTON}
                onClick={() => setItems(model.items.filter((_, j) => j !== i))}
              >
                ×
              </button>
            </div>
          );
        }
        const parsed = parseRow(item);
        const asRaw = raw.has(i) || parsed === null;
        const state = status(item);
        return (
          <div key={i} data-filter-row className="flex flex-col gap-1">
            <div className="flex items-start gap-1.5">
              <div className="min-w-0 flex-1">
                {asRaw ? (
                  <textarea
                    aria-label="Filter expression"
                    rows={2}
                    value={item}
                    onChange={(e) => replace(i, e.target.value)}
                    className={`${FIELD} w-full font-mono`}
                  />
                ) : (
                  <RowEditor
                    row={parsed!}
                    ctx={ctx}
                    vault={vault}
                    onChange={(row) => replace(i, compileRow(row))}
                  />
                )}
              </div>
              {parsed !== null ? (
                <button
                  type="button"
                  aria-pressed={asRaw}
                  title="Edit as expression"
                  className={SMALL_BUTTON}
                  onClick={() =>
                    setRaw((s) => {
                      const next = new Set(s);
                      if (next.has(i)) next.delete(i);
                      else next.add(i);
                      return next;
                    })
                  }
                >
                  {"{ }"}
                </button>
              ) : null}
              <button
                type="button"
                aria-label={`Remove filter ${i + 1}`}
                className={SMALL_BUTTON}
                onClick={() => {
                  setItems(model.items.filter((_, j) => j !== i));
                  setRaw(new Set());
                }}
              >
                ×
              </button>
            </div>
            {!asRaw ? (
              <code className="truncate text-[11px] text-text-muted" title={item}>
                {item}
              </code>
            ) : null}
            {state !== null && state !== undefined ? (
              <div
                role="alert"
                data-filter-error
                className="text-[12px] text-[var(--danger,#e5484d)]"
              >
                {state}
              </div>
            ) : null}
            {state === undefined ? (
              <div data-filter-checking className="text-[11px] text-text-muted">
                Checking…
              </div>
            ) : null}
          </div>
        );
      })}

      <div className="flex items-center gap-1.5">
        <button
          type="button"
          className={SMALL_BUTTON}
          onClick={() =>
            setItems([
              ...model.items,
              compileRow({ property: "file.name", operator: "contains", value: "" }),
            ])
          }
        >
          Add filter
        </button>
        <button
          type="button"
          className={SMALL_BUTTON}
          onClick={() => setItems([...model.items, ""])}
        >
          Add expression
        </button>
        <span className="flex-1" />
        <button
          type="button"
          disabled={blocked}
          title={blocked ? "Fix the invalid expressions first" : undefined}
          onClick={() => void save()}
          className={SMALL_BUTTON}
        >
          Apply
        </button>
      </div>
    </div>
  );
}

/** Filter menu: the simple builder plus raw expressions, for this view or the whole base. */
export function FilterMenu({ ctx }: { ctx: MenuContext }) {
  const active =
    modelOf(ctx.view.filters).items.length + modelOf(ctx.document.filters).items.length || null;
  return (
    <ToolbarMenu label="Filter" badge={active} align="left">
      {(close) => <FilterBody ctx={ctx} close={close} />}
    </ToolbarMenu>
  );
}
