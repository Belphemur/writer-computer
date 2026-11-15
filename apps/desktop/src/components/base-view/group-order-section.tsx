import { useId, useRef } from "react";
import {
  groupOrderAdd,
  groupOrderMove,
  groupOrderRemove,
  groupOrderReset,
} from "@/lib/bases/base-yaml";
import { entryId, entryIsPresent, entryLabel, groupCandidates } from "@/lib/bases/group-order";
import type { MenuContext } from "./menu-context";
import { FIELD, SMALL_BUTTON } from "./toolbar-menu";

/**
 * Group order of the active view: automatic (by key, in the direction above) or an explicit list
 * (`groupOrder`) whose entries come first. Move up / down buttons (or Alt+Arrow on a row), Remove
 * (or Delete), Add value from the groups present, Reset to automatic. Every change is an
 * entry-based edit of the `.base` (`groupOrder*` in `base-yaml.ts`), serialized with the other
 * config writes, so quick clicks never act on a stale index.
 */
export function GroupOrderSection({ ctx }: { ctx: MenuContext }) {
  const headingId = useId();
  const listed = Array.isArray(ctx.view.groupOrder) ? ctx.view.groupOrder : [];
  const groups = ctx.result?.groups ?? null;
  const { addable, blocked } = groupCandidates(groups, listed);
  // The row to refocus once the write has reloaded the list (a move reorders the DOM).
  const refocus = useRef<string | null>(null);
  const run = (edit: Parameters<MenuContext["apply"]>[0]) => void ctx.apply(edit);

  const move = (entry: unknown, delta: number) => {
    refocus.current = entryId(entry);
    run((t) => groupOrderMove(t, ctx.viewIndex, entry, delta));
  };

  return (
    <section aria-labelledby={headingId} data-group-order className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <h3 id={headingId} className="text-[12px] font-medium text-text-secondary">
          Group order
        </h3>
        <span data-group-order-mode className="text-[11px] text-text-muted">
          {listed.length === 0
            ? `Automatic (${ctx.view.groupBy?.direction === "DESC" ? "descending" : "ascending"})`
            : "Manual"}
        </span>
      </div>
      {listed.length > 0 ? (
        <>
          <ul
            role="list"
            aria-label="Group order"
            className="m-0 flex list-none flex-col gap-1 p-0"
          >
            {listed.map((entry, i) => {
              const id = entryId(entry);
              const label = entryLabel(entry);
              const present = entryIsPresent(groups, entry);
              return (
                <li key={id} data-group-order-row={id} className="flex items-center gap-1.5">
                  <span
                    tabIndex={0}
                    ref={(el) => {
                      if (el && refocus.current === id) {
                        refocus.current = null;
                        el.focus();
                      }
                    }}
                    aria-label={`${label}, position ${i + 1} of ${listed.length}`}
                    aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown Delete"
                    onKeyDown={(e) => {
                      if (e.altKey && e.key === "ArrowUp") {
                        e.preventDefault();
                        if (i > 0) move(entry, -1);
                      } else if (e.altKey && e.key === "ArrowDown") {
                        e.preventDefault();
                        if (i < listed.length - 1) move(entry, 1);
                      } else if (e.key === "Delete" || e.key === "Backspace") {
                        e.preventDefault();
                        run((t) => groupOrderRemove(t, ctx.viewIndex, entry));
                      }
                    }}
                    title={present ? undefined : "No group has this value in the current results"}
                    className={`min-w-0 flex-1 truncate rounded-sm px-1 outline-none focus-visible:ring-1 focus-visible:ring-[var(--focus-border)] ${
                      present ? "" : "text-text-muted italic"
                    }`}
                  >
                    {label}
                  </span>
                  <button
                    type="button"
                    aria-label={`Move ${label} up`}
                    disabled={i === 0}
                    className={SMALL_BUTTON}
                    onClick={() => move(entry, -1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    aria-label={`Move ${label} down`}
                    disabled={i === listed.length - 1}
                    className={SMALL_BUTTON}
                    onClick={() => move(entry, 1)}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove ${label} from the order`}
                    className={SMALL_BUTTON}
                    onClick={() => run((t) => groupOrderRemove(t, ctx.viewIndex, entry))}
                  >
                    ×
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="m-0 text-[11px] text-text-muted">
            Listed values come first; the other groups follow in automatic order.
          </p>
        </>
      ) : null}
      <select
        aria-label="Add group value"
        value=""
        disabled={addable.length === 0}
        onChange={(e) => {
          const picked = addable[Number(e.target.value)];
          if (picked) run((t) => groupOrderAdd(t, ctx.viewIndex, picked.entry));
        }}
        className={FIELD}
      >
        <option value="">{addable.length === 0 ? "No more values to add" : "Add value…"}</option>
        {addable.map((c, i) => (
          <option key={entryId(c.entry)} value={String(i)}>
            {c.label}
          </option>
        ))}
      </select>
      {blocked.length > 0 ? (
        <p data-group-order-blocked className="m-0 text-[11px] text-text-muted">
          Not listable: {blocked.map((b) => `${b.label} (${b.reason})`).join("; ")}
        </p>
      ) : null}
      {listed.length > 0 ? (
        <button
          type="button"
          className={`${SMALL_BUTTON} self-start`}
          onClick={() => run((t) => groupOrderReset(t, ctx.viewIndex))}
        >
          Reset to automatic
        </button>
      ) : null}
    </section>
  );
}
