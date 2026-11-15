import { useState } from "react";
import { addFormula, setDisplayName, setOrder } from "@/lib/bases/base-yaml";
import { canonicalPropertyKey } from "@/lib/bases/cells";
import { ExpressionInput } from "./expression-input";
import type { MenuContext } from "./menu-context";
import { PropertySelect, useVaultProperties } from "./property-select";
import { FIELD, SMALL_BUTTON, ToolbarMenu } from "./toolbar-menu";

function NameField({
  id,
  value,
  onCommit,
}: {
  id: string;
  value: string;
  onCommit: (v: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const commit = () => {
    if (draft !== value) onCommit(draft.trim());
  };
  return (
    <input
      aria-label={`Display name of ${id}`}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") setDraft(value);
      }}
      className={`${FIELD} flex-1`}
    />
  );
}

/** Name and expression of a new formula; Add writes `formulas.<name>` and shows it as a column. */
function AddFormula({
  ctx,
  vault,
  ids,
}: {
  ctx: MenuContext;
  vault: ReturnType<typeof useVaultProperties>["properties"];
  ids: readonly string[];
}) {
  const [name, setName] = useState("");
  const [expression, setExpression] = useState("");
  const add = async () => {
    const id = name.trim();
    // One edit: define the formula and append its column. An invalid name or a duplicate is
    // refused by `addFormula`; the write path raises that as the error notice and nothing is written.
    const ok = await ctx.apply((t) =>
      setOrder(addFormula(t, id, expression), ctx.viewIndex, [...ids, `formula.${id}`]),
    );
    if (ok) {
      setName("");
      setExpression("");
    }
  };
  return (
    <fieldset
      data-add-formula
      className="flex flex-col gap-1.5 rounded-md border border-border p-2"
    >
      <legend className="px-1 text-[11px] text-text-muted">Add formula</legend>
      <input
        aria-label="Formula name"
        placeholder="name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className={FIELD}
      />
      <ExpressionInput
        multiline
        label="Formula expression"
        placeholder='expression, for example if(due, due.relative(), "")'
        value={expression}
        vault={vault}
        formulas={ctx.document.formulas}
        onChange={setExpression}
      />
      <button type="button" className={`${SMALL_BUTTON} self-start`} onClick={() => void add()}>
        Add formula
      </button>
    </fieldset>
  );
}

function PropertiesBody({ ctx }: { ctx: MenuContext }) {
  const { properties: vault, error } = useVaultProperties();
  const columns = (ctx.result?.columns ?? []).slice(0, ctx.shown);
  const ids = columns.map((c) => c.id);
  const writeOrder = (next: string[]) => void ctx.apply((t) => setOrder(t, ctx.viewIndex, next));
  const shown = new Set(ids.map(canonicalPropertyKey));
  const hidden = new Set([...shown, ...ids]);

  return (
    <div className="flex flex-col gap-2">
      {error ? (
        <div role="alert" className="text-[12px] text-[var(--danger,#e5484d)]">
          {error}
        </div>
      ) : null}
      {columns.map((c, i) => (
        <div key={c.key} data-property-row={c.id} className="flex items-center gap-1.5">
          <button
            type="button"
            aria-label={`Hide ${c.displayName}`}
            title="Hide"
            disabled={columns.length === 1}
            className={SMALL_BUTTON}
            onClick={() => writeOrder(ids.filter((_, j) => j !== i))}
          >
            ✓
          </button>
          <NameField
            id={c.id}
            value={c.displayName}
            onCommit={(name) =>
              void ctx.apply((t) => setDisplayName(t, c.id, name === "" ? null : name))
            }
          />
          <button
            type="button"
            aria-label={`Move ${c.displayName} up`}
            disabled={i === 0}
            className={SMALL_BUTTON}
            onClick={() => {
              const next = [...ids];
              [next[i - 1], next[i]] = [next[i]!, next[i - 1]!];
              writeOrder(next);
            }}
          >
            ↑
          </button>
          <button
            type="button"
            aria-label={`Move ${c.displayName} down`}
            disabled={i === columns.length - 1}
            className={SMALL_BUTTON}
            onClick={() => {
              const next = [...ids];
              [next[i], next[i + 1]] = [next[i + 1]!, next[i]!];
              writeOrder(next);
            }}
          >
            ↓
          </button>
        </div>
      ))}
      <PropertySelect
        label="Add property"
        value=""
        none="Add property…"
        exclude={hidden}
        document={ctx.document}
        vault={vault}
        onChange={(id) => id && writeOrder([...ids, id])}
      />
      <AddFormula ctx={ctx} vault={vault} ids={ids} />
    </div>
  );
}

/** Properties menu: visible columns (`order`), their order and display names. */
export function PropertiesMenu({ ctx }: { ctx: MenuContext }) {
  return <ToolbarMenu label="Properties">{() => <PropertiesBody ctx={ctx} />}</ToolbarMenu>;
}
