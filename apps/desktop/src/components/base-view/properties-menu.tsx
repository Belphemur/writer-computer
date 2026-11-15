import { useState } from "react";
import { setDisplayName, setOrder } from "@/lib/bases/base-yaml";
import { canonicalPropertyKey } from "@/lib/bases/cells";
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
    </div>
  );
}

/** Properties menu: visible columns (`order`), their order and display names. */
export function PropertiesMenu({ ctx }: { ctx: MenuContext }) {
  return <ToolbarMenu label="Properties">{() => <PropertiesBody ctx={ctx} />}</ToolbarMenu>;
}
