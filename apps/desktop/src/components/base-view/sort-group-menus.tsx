import { setGroupBy, setSort } from "@/lib/bases/base-yaml";
import type { BaseSortKey, SortDirection } from "@/lib/bases/types";
import type { MenuContext } from "./menu-context";
import { GroupOrderSection } from "./group-order-section";
import { PropertySelect, useVaultProperties } from "./property-select";
import { FIELD, SMALL_BUTTON, ToolbarMenu } from "./toolbar-menu";

function DirectionSelect({
  value,
  label,
  onChange,
}: {
  value: SortDirection;
  label: string;
  onChange: (d: SortDirection) => void;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value as SortDirection)}
      className={FIELD}
    >
      <option value="ASC">Ascending</option>
      <option value="DESC">Descending</option>
    </select>
  );
}

function SortBody({ ctx }: { ctx: MenuContext }) {
  const { properties: vault, error } = useVaultProperties();
  const keys = ctx.view.sort;
  const write = (next: BaseSortKey[]) => void ctx.apply((t) => setSort(t, ctx.viewIndex, next));
  return (
    <div className="flex flex-col gap-2">
      {error ? (
        <div role="alert" className="text-[12px] text-[var(--danger)]">
          {error}
        </div>
      ) : null}
      {keys.length === 0 ? <div className="text-text-muted">Not sorted</div> : null}
      {keys.map((k, i) => (
        <div key={`${k.property}:${i}`} className="flex items-center gap-1.5" data-sort-row>
          <PropertySelect
            label={`Sort property ${i + 1}`}
            value={k.property}
            document={ctx.document}
            vault={vault}
            onChange={(id) => write(keys.map((x, j) => (j === i ? { ...x, property: id } : x)))}
          />
          <DirectionSelect
            label={`Sort direction ${i + 1}`}
            value={k.direction}
            onChange={(d) => write(keys.map((x, j) => (j === i ? { ...x, direction: d } : x)))}
          />
          <button
            type="button"
            aria-label={`Remove sort ${i + 1}`}
            className={SMALL_BUTTON}
            onClick={() => write(keys.filter((_, j) => j !== i))}
          >
            ×
          </button>
        </div>
      ))}
      <PropertySelect
        label="Add sort"
        value=""
        none="Add sort…"
        document={ctx.document}
        vault={vault}
        onChange={(id) => id && write([...keys, { property: id, direction: "ASC" }])}
      />
    </div>
  );
}

/** Sort menu: an ordered list of `property + direction`, persisted as the view's `sort`. */
export function SortMenu({ ctx }: { ctx: MenuContext }) {
  return (
    <ToolbarMenu label="Sort" badge={ctx.view.sort.length || null}>
      {() => <SortBody ctx={ctx} />}
    </ToolbarMenu>
  );
}

function GroupBody({ ctx }: { ctx: MenuContext }) {
  const { properties: vault, error } = useVaultProperties();
  const group = ctx.view.groupBy;
  return (
    <div className="flex flex-col gap-2">
      {error ? (
        <div role="alert" className="text-[12px] text-[var(--danger)]">
          {error}
        </div>
      ) : null}
      <PropertySelect
        label="Group by"
        value={group?.property ?? ""}
        none="No grouping"
        document={ctx.document}
        vault={vault}
        onChange={(id) =>
          void ctx.apply((t) =>
            setGroupBy(
              t,
              ctx.viewIndex,
              id ? { property: id, direction: group?.direction ?? "ASC" } : null,
            ),
          )
        }
      />
      {group ? (
        <DirectionSelect
          label="Group direction"
          value={group.direction}
          onChange={(direction) =>
            void ctx.apply((t) =>
              setGroupBy(t, ctx.viewIndex, { property: group.property, direction }),
            )
          }
        />
      ) : null}
      {group ? <GroupOrderSection ctx={ctx} /> : null}
    </div>
  );
}

/** Group menu: one `groupBy` property and direction, and the group order. */
export function GroupMenu({ ctx }: { ctx: MenuContext }) {
  return (
    <ToolbarMenu label="Group" badge={ctx.view.groupBy ? 1 : null}>
      {() => <GroupBody ctx={ctx} />}
    </ToolbarMenu>
  );
}
